#import "NativeDSP.hpp"
#import <CoreAudio/CoreAudio.h>
#import <AudioToolbox/AudioToolbox.h>
#include <mach/mach_time.h>
#include <sys/resource.h>
#include <algorithm>
#include <array>
#include <atomic>
#include <cmath>
#include <cstring>
#include <os/lock.h>
#include <vector>

namespace {

constexpr double kPi = 3.14159265358979323846;
constexpr double kTwoPi = 2.0 * kPi;

inline float clampf(float v, float lo, float hi) {
    return std::max(lo, std::min(hi, v));
}

inline double midiToHz(int note, double centsOffset = 0.0) {
    return 440.0 * std::pow(2.0, ((note - 69) + centsOffset / 100.0) / 12.0);
}

inline float paramTimeSec(double v) {
    return static_cast<float>(0.002 + v * v * 4.0);
}

inline float fastTanh(float x) {
    if (x < -3.0f) return -1.0f;
    if (x > 3.0f) return 1.0f;
    const float x2 = x * x;
    return x * (27.0f + x2) / (27.0f + 9.0f * x2);
}

constexpr int kSineTableSize = 2048;
constexpr int kSineTableMask = kSineTableSize - 1;

struct SineTable {
    float data[kSineTableSize + 1];
    SineTable() {
        for (int i = 0; i <= kSineTableSize; ++i) {
            data[i] = static_cast<float>(std::sin(kTwoPi * static_cast<double>(i) / static_cast<double>(kSineTableSize)));
        }
    }
    inline float lookup(double phase01) const {
        const double pos = phase01 * static_cast<double>(kSineTableSize);
        const int ipos = static_cast<int>(pos);
        const int idx = ipos & kSineTableMask;
        const float frac = static_cast<float>(pos - static_cast<double>(ipos));
        const float a = data[idx];
        return a + (data[idx + 1] - a) * frac;
    }
};

static const SineTable kSineTable;

// PolyBLEP anti-aliasing residual
inline float polyBlep(double t, double dt) {
    if (t < dt) {
        t /= dt;
        return static_cast<float>(t + t - t * t - 1.0);
    }
    if (t > 1.0 - dt) {
        t = (t - 1.0) / dt;
        return static_cast<float>(t * t + t + t + 1.0);
    }
    return 0.0f;
}

// Two-pole state-variable filter (Zavalishin TPT SVF) with cached coefficients
struct SVFStage {
    float ic1eq = 0.0f;
    float ic2eq = 0.0f;
    float lastCutoff = -1.0f;
    float lastQ = -1.0f;
    double lastSR = 0.0;
    float a1 = 0.0f;
    float a2 = 0.0f;
    float a3 = 0.0f;

    void reset() {
        ic1eq = 0.0f;
        ic2eq = 0.0f;
        lastCutoff = -1.0f;
    }

    inline float processLowpass(float x, float cutoffHz, float q, double sampleRate) {
        const float fc = clampf(cutoffHz, 20.0f, static_cast<float>(sampleRate * 0.45));
        if (std::fabs(fc - lastCutoff) > 0.5f || std::fabs(q - lastQ) > 0.01f || sampleRate != lastSR) {
            lastCutoff = fc;
            lastQ = q;
            lastSR = sampleRate;
            const float g = std::tan(static_cast<float>(kPi) * fc / static_cast<float>(sampleRate));
            const float k = 1.0f / std::max(0.5f, q);
            a1 = 1.0f / (1.0f + g * (g + k));
            a2 = g * a1;
            a3 = g * a2;
        }
        const float v3 = x - ic2eq;
        const float v1 = a1 * ic1eq + a2 * v3;
        const float v2 = ic2eq + a2 * ic1eq + a3 * v3;
        ic1eq = 2.0f * v1 - ic1eq;
        ic2eq = 2.0f * v2 - ic2eq;
        return v2;
    }
};

enum class SynthOscType {
    Sawtooth = 0,
    Square = 1,
    Triangle = 2,
    Supersaw = 3,
    Sample = 4
};

struct SynthParams {
    SynthOscType osc = SynthOscType::Sawtooth;
    float detune = 0.3f;
    float cutoff = 0.55f;
    float reso = 0.2f;
    float fenv = 0.4f;
    float attack = 0.05f;
    float decay = 0.4f;
    float sustain = 0.7f;
    float release = 0.3f;
    float bendSemis = 0.0f;
    float modWheel = 0.0f;
    float layerGain = 1.0f;
};

struct SynthVoice {
    bool active = false;
    bool held = false;
    bool sustained = false;
    int note = 60;
    double baseHz = 261.625565;
    float keytrack = 1.0f;
    float velocity = 1.0f;
    uint64_t age = 0;

    enum class EnvStage { Idle, Attack, Decay, Sustain, Release };
    EnvStage stage = EnvStage::Idle;
    float envVal = 0.0f;
    float releaseStart = 0.0f;
    float releasePos = 0.0f;

    std::array<double, 5> phases{};
    std::array<double, 5> triStates{};
    SVFStage f1;
    SVFStage f2;

    void reset(int n, int vel, uint64_t voiceAge) {
        active = true;
        held = true;
        sustained = false;
        note = n;
        baseHz = midiToHz(n);
        keytrack = std::pow(2.0f, ((n - 60) / 12.0f) * 0.5f);
        velocity = clampf(static_cast<float>(vel) / 127.0f, 0.01f, 1.0f);
        age = voiceAge;
        stage = EnvStage::Attack;
        envVal = 0.0f;
        releasePos = 0.0f;
        f1.reset();
        f2.reset();
        for (size_t i = 0; i < phases.size(); ++i) {
            phases[i] = std::fmod(static_cast<double>(i) * 0.2173 + static_cast<double>(n) * 0.071, 1.0);
            triStates[i] = 0.0;
        }
    }
};

constexpr int kMaxSynthVoices = 24;

struct SynthLayerEngine {
    SynthParams params;
    std::array<SynthVoice, kMaxSynthVoices> voices{};
    uint64_t nextAge = 1;
    bool pedalDown = false;
    double vibPhase = 0.0;
    double pwmPhase = 0.0;

    int voiceLimit(bool studioMode) const {
        return studioMode ? 20 : 12;
    }

    void noteOn(int note, int vel, bool studioMode) {
        if (params.osc == SynthOscType::Sample) return;

        SynthVoice *slot = nullptr;
        for (auto &v : voices) {
            if (v.active && v.note == note) {
                slot = &v;
                break;
            }
        }
        const int limit = voiceLimit(studioMode);
        if (!slot) {
            int activeCount = 0;
            SynthVoice *oldestRel = nullptr;
            SynthVoice *oldestAny = nullptr;
            for (auto &v : voices) {
                if (!v.active) {
                    if (!slot) slot = &v;
                } else {
                    activeCount++;
                    if (v.stage == SynthVoice::EnvStage::Release) {
                        if (!oldestRel || v.age < oldestRel->age) oldestRel = &v;
                    }
                    if (!oldestAny || v.age < oldestAny->age) oldestAny = &v;
                }
            }
            if (!slot || activeCount >= limit) {
                slot = oldestRel ? oldestRel : oldestAny;
            }
        }
        if (slot) slot->reset(note, vel, nextAge++);
    }

    void noteOff(int note) {
        for (auto &v : voices) {
            if (v.active && v.note == note && v.held) {
                v.held = false;
                if (pedalDown) {
                    v.sustained = true;
                } else {
                    v.stage = SynthVoice::EnvStage::Release;
                    v.releaseStart = v.envVal;
                    v.releasePos = 0.0f;
                }
            }
        }
    }

    void setSustain(bool down) {
        pedalDown = down;
        if (!down) {
            for (auto &v : voices) {
                if (v.active && !v.held && v.sustained) {
                    v.sustained = false;
                    v.stage = SynthVoice::EnvStage::Release;
                    v.releaseStart = v.envVal;
                    v.releasePos = 0.0f;
                }
            }
        }
    }

    void allOff() {
        pedalDown = false;
        for (auto &v : voices) {
            if (v.active) {
                v.held = false;
                v.sustained = false;
                v.stage = SynthVoice::EnvStage::Release;
                v.releaseStart = v.envVal;
                v.releasePos = 0.0f;
            }
        }
    }

    void render(float *outL, float *outR, int frames, double sampleRate, float sectionGain, bool studioMode) {
        if (params.osc == SynthOscType::Sample || sectionGain <= 0.0001f || params.layerGain <= 0.0001f) {
            return;
        }
        bool anyVoice = false;
        for (const auto &v : voices) {
            if (v.active) { anyVoice = true; break; }
        }
        if (!anyVoice) return;

        const float masterScale = sectionGain * params.layerGain * 0.24f;
        const float atkRate = 1.0f / std::max(1.0f, paramTimeSec(params.attack) * static_cast<float>(sampleRate));
        const float decCoeff = std::exp(-3.0f / std::max(1.0f, paramTimeSec(params.decay) * static_cast<float>(sampleRate)));
        const float relSamples = std::max(4.0f, paramTimeSec(params.release) * static_cast<float>(sampleRate));

        const double vibInc = 5.5 / sampleRate;
        const double pwmInc = 0.45 / sampleRate;

        const SynthOscType oscType = params.osc;
        const bool isSuper = (oscType == SynthOscType::Supersaw);
        const bool isSquare = (oscType == SynthOscType::Square);
        const bool isSaw = (oscType == SynthOscType::Sawtooth || isSuper);
        const int oscCount = isSuper ? (studioMode ? 5 : 3) : 2;
        static constexpr float kSuper5[5] = {-1.0f, -0.48f, 0.0f, 0.48f, 1.0f};
        static constexpr float kSuper3[3] = {-1.0f, 0.0f, 1.0f};
        static constexpr float kDual[2] = {-0.5f, 0.5f};

        const float normOsc = 1.0f / std::sqrt(static_cast<float>(oscCount));
        const float width = isSuper ? 0.85f : 0.35f;
        const float spreadCents = params.detune * 40.0f;
        const float q = 0.7f + params.reso * 15.0f;
        const float vibDepthCents = params.modWheel * params.modWheel * 40.0f;
        const float bendCents = params.bendSemis * 100.0f;
        const bool hasPitchMod = (vibDepthCents > 0.001f || std::fabs(bendCents) > 0.001f);
        const float baseCutFactor = 40.0f * std::pow(2.0f, params.cutoff * 9.0f);
        const float fenvScale = params.fenv * 6.0f;

        double oscDetuneRatio[5];
        float panL[5];
        float panR[5];
        for (int i = 0; i < oscCount; ++i) {
            const float off = isSuper ? (studioMode ? kSuper5[i] : kSuper3[i]) : kDual[i];
            const float pan = oscCount > 1
                ? (static_cast<float>(i) / static_cast<float>(oscCount - 1)) * 2.0f * width - width
                : 0.0f;
            oscDetuneRatio[i] = std::pow(2.0, static_cast<double>(off * spreadCents) / 1200.0);
            panL[i] = std::sqrt(0.5f * (1.0f - pan));
            panR[i] = std::sqrt(0.5f * (1.0f + pan));
        }

        constexpr int kChunk = 256;
        double pitchMultBuf[kChunk];
        float pulseWidthBuf[kChunk];

        int offset = 0;
        while (offset < frames) {
            const int nFrames = std::min(kChunk, frames - offset);
            float *dstL = outL + offset;
            float *dstR = outR + offset;

            if (hasPitchMod) {
                for (int s = 0; s < nFrames; ++s) {
                    vibPhase += vibInc;
                    if (vibPhase >= 1.0) vibPhase -= 1.0;
                    const float vibCents = vibDepthCents * kSineTable.lookup(vibPhase);
                    pitchMultBuf[s] = std::pow(2.0, static_cast<double>(bendCents + vibCents) / 1200.0);
                }
            } else {
                vibPhase += vibInc * static_cast<double>(nFrames);
                if (vibPhase >= 1.0) vibPhase -= std::floor(vibPhase);
            }

            if (isSquare) {
                for (int s = 0; s < nFrames; ++s) {
                    pwmPhase += pwmInc;
                    if (pwmPhase >= 1.0) pwmPhase -= 1.0;
                    pulseWidthBuf[s] = 0.5f + 0.15f * kSineTable.lookup(pwmPhase);
                }
            } else {
                pwmPhase += pwmInc * static_cast<double>(nFrames);
                if (pwmPhase >= 1.0) pwmPhase -= std::floor(pwmPhase);
            }

            for (auto &v : voices) {
                if (!v.active) continue;

                const float vBaseCut = std::min(18000.0f, baseCutFactor * v.keytrack);
                const float vPeakCut = std::min(19500.0f, vBaseCut * std::pow(2.0f, fenvScale * (0.4f + v.velocity * 0.6f)));
                const float cutSpan = vPeakCut - vBaseCut;
                const float invCutDenom = 0.35f / std::max(100.0f, vBaseCut + vPeakCut);
                const float velGain = (0.3f + v.velocity * 0.7f) * masterScale;

                double baseDt[5];
                for (int i = 0; i < oscCount; ++i) {
                    baseDt[i] = (v.baseHz * oscDetuneRatio[i]) / sampleRate;
                }

                for (int s = 0; s < nFrames; ++s) {
                    switch (v.stage) {
                        case SynthVoice::EnvStage::Attack:
                            v.envVal += atkRate;
                            if (v.envVal >= 1.0f) {
                                v.envVal = 1.0f;
                                v.stage = SynthVoice::EnvStage::Decay;
                            }
                            break;
                        case SynthVoice::EnvStage::Decay:
                            v.envVal = params.sustain + (v.envVal - params.sustain) * decCoeff;
                            if (std::fabs(v.envVal - params.sustain) < 1e-4f) {
                                v.envVal = params.sustain;
                                v.stage = SynthVoice::EnvStage::Sustain;
                            }
                            break;
                        case SynthVoice::EnvStage::Sustain:
                            v.envVal = params.sustain;
                            break;
                        case SynthVoice::EnvStage::Release:
                            v.releasePos += 1.0f;
                            v.envVal = v.releaseStart * std::exp(-4.0f * (v.releasePos / relSamples));
                            if (v.releasePos >= relSamples * 1.35f || v.envVal < 1e-4f) {
                                v.active = false;
                                v.stage = SynthVoice::EnvStage::Idle;
                                break;
                            }
                            break;
                        case SynthVoice::EnvStage::Idle:
                            v.active = false;
                            break;
                    }
                    if (!v.active) break;

                    const double pMult = hasPitchMod ? pitchMultBuf[s] : 1.0;
                    const float pulseWidth = isSquare ? pulseWidthBuf[s] : 0.5f;

                    float mixL = 0.0f;
                    float mixR = 0.0f;

                    for (int i = 0; i < oscCount; ++i) {
                        const double dt = std::min(0.45, baseDt[i] * pMult);
                        double ph = v.phases[i] + dt;
                        if (ph >= 1.0) ph -= 1.0;
                        v.phases[i] = ph;

                        float sample = 0.0f;
                        if (isSaw) {
                            sample = static_cast<float>(2.0 * ph - 1.0) - polyBlep(ph, dt);
                        } else if (isSquare) {
                            sample = (ph < pulseWidth) ? 1.0f : -1.0f;
                            sample += polyBlep(ph, dt);
                            double shifted = ph - pulseWidth;
                            if (shifted < 0.0) shifted += 1.0;
                            sample -= polyBlep(shifted, dt);
                        } else {
                            float sq = (ph < 0.5) ? 1.0f : -1.0f;
                            sq += polyBlep(ph, dt);
                            double halfPh = ph + 0.5;
                            if (halfPh >= 1.0) halfPh -= 1.0;
                            sq -= polyBlep(halfPh, dt);
                            v.triStates[i] = dt * sq + (1.0 - dt) * v.triStates[i];
                            sample = static_cast<float>(v.triStates[i]) * 4.0f;
                        }

                        mixL += sample * panL[i];
                        mixR += sample * panR[i];
                    }

                    mixL *= normOsc;
                    mixR *= normOsc;
                    const float mono = 0.5f * (mixL + mixR);
                    const float driven = fastTanh(mono * 1.5f);

                    const float cut = vBaseCut + cutSpan * v.envVal;
                    const float flt1 = v.f1.processLowpass(driven, cut, 0.54f, sampleRate);
                    const float flt2 = v.f2.processLowpass(flt1, cut, q, sampleRate);

                    const float side = (mixL - mixR) * cut * invCutDenom;
                    const float amp = v.envVal * velGain;
                    dstL[s] += (flt2 + side) * amp;
                    dstR[s] += (flt2 - side) * amp;
                }
            }

            offset += nFrames;
        }
    }
};

// ---------------- Organ Tonewheel Engine (B3 / Vox / Farf) ----------------

enum class OrganModel { B3 = 0, Vox = 1, Farf = 2 };

struct OrganVoice {
    bool active = false;
    bool releasing = false;
    int manual = 0;
    int note = 60;
    float env = 0.0f;
    std::array<double, 9> phases{};
    std::array<double, 9> freqs{};
    std::array<float, 9> gains{};

    bool percActive = false;
    double percPhase = 0.0;
    double percFreq = 0.0;
    float percEnv = 0.0f;
    float clickEnv = 0.0f;
};

struct OrganEngine {
    std::array<std::array<int, 9>, 2> bars = {{
        {{8, 8, 8, 0, 0, 0, 0, 0, 0}},
        {{8, 3, 8, 0, 0, 0, 0, 0, 0}}
    }};
    std::array<OrganModel, 2> models = {OrganModel::B3, OrganModel::B3};
    std::array<float, 2> manualGains = {1.0f, 1.0f};

    bool percOn = false;
    bool percThird = false;
    bool percFast = false;
    int vibMode = 0;
    float drive = 0.3f;
    int rotaryMode = 0;

    std::array<OrganVoice, 32> voices{};
    uint32_t rng = 0x12345678u;

    double vibLfoPhase = 0.0;
    std::array<float, 1024> vibBuf{};
    int vibWrite = 0;

    double hornPhase = 0.0;
    double drumPhase = 0.0;
    float hornFreq = 0.83f;
    float drumFreq = 0.67f;

    float lpState1 = 0.0f;
    float lpState2 = 0.0f;

    static constexpr int kWheelOffset[9] = {-12, 7, 0, 12, 19, 24, 28, 31, 36};
    static constexpr double kHarmRatio[9] = {0.5, 1.5, 1.0, 2.0, 3.0, 4.0, 5.0, 6.0, 8.0};

    inline float nextNoise() {
        rng = rng * 1664525u + 1013904223u;
        return (static_cast<int32_t>(rng) / 2147483648.0f);
    }

    void recomputeGainsForVoice(OrganVoice &v, bool studioMode) {
        const auto &b = bars[v.manual];
        const OrganModel m = models[v.manual];
        const float leak = (studioMode && m == OrganModel::B3) ? std::pow(10.0f, -50.0f / 20.0f) : 0.0f;
        for (int i = 0; i < 9; ++i) {
            int lvl = b[i];
            if (percOn && m == OrganModel::B3 && i == 8) lvl = 0;
            const float amp = lvl > 0 ? std::pow(10.0f, ((lvl - 8) * 3.0f) / 20.0f) : 0.0f;
            v.gains[i] = amp + leak;
        }
    }

    void recomputeAllGains(bool studioMode) {
        for (auto &v : voices) {
            if (v.active) recomputeGainsForVoice(v, studioMode);
        }
    }

    void noteOn(int manual, int note, bool studioMode) {
        manual = (manual != 0) ? 1 : 0;
        bool anyHeld = false;
        const int maxVoices = studioMode ? 32 : 24;
        int activeCount = 0;
        OrganVoice *freeSlot = nullptr;
        OrganVoice *releasingSlot = nullptr;

        for (int idx = 0; idx < maxVoices; ++idx) {
            auto &v = voices[idx];
            if (v.active) {
                activeCount++;
                if (!v.releasing) anyHeld = true;
                else if (!releasingSlot) releasingSlot = &v;
                if (v.manual == manual && v.note == note) return;
            } else if (!freeSlot) {
                freeSlot = &v;
            }
        }
        OrganVoice *slot = freeSlot ? freeSlot : (releasingSlot ? releasingSlot : &voices[0]);

        slot->active = true;
        slot->releasing = false;
        slot->manual = manual;
        slot->note = note;
        slot->env = 0.0f;
        slot->clickEnv = (models[manual] == OrganModel::B3) ? 0.32f : 0.0f;

        const double baseHz = midiToHz(note);
        const int w8 = note - 36 + 13;
        for (int i = 0; i < 9; ++i) {
            int w = w8 + kWheelOffset[i];
            double mult = kHarmRatio[i];
            while (w < 1) { w += 12; mult *= 2.0; }
            while (w > 91) { w -= 12; mult *= 0.5; }
            slot->freqs[i] = baseHz * mult;
            slot->phases[i] = static_cast<double>(i) * 0.11;
        }
        recomputeGainsForVoice(*slot, studioMode);

        if (percOn && !anyHeld) {
            slot->percActive = true;
            slot->percFreq = baseHz * (percThird ? 3.0 : 2.0);
            slot->percPhase = 0.0;
            slot->percEnv = 0.85f;
        } else {
            slot->percActive = false;
        }
    }

    void noteOff(int manual, int note) {
        manual = (manual != 0) ? 1 : 0;
        for (auto &v : voices) {
            if (v.active && v.manual == manual && v.note == note) {
                v.releasing = true;
            }
        }
    }

    void allOff() {
        for (auto &v : voices) {
            if (v.active) v.releasing = true;
        }
    }

    void render(float *outL, float *outR, int frames, double sampleRate, float sectionGain) {
        if (sectionGain <= 0.0001f) return;
        bool anyVoice = false;
        for (const auto &v : voices) {
            if (v.active) { anyVoice = true; break; }
        }
        if (!anyVoice) return;

        const float atkStep = 1.0f / std::max(1.0f, 0.004f * static_cast<float>(sampleRate));
        const float relCoeff = std::exp(-1.0f / std::max(1.0f, 0.006f * static_cast<float>(sampleRate)));
        const float clickDecay = std::exp(-1.0f / std::max(1.0f, 0.002f * static_cast<float>(sampleRate)));
        const float percDecay = std::exp(-1.0f / std::max(1.0f, (percFast ? 0.08f : 0.28f) * static_cast<float>(sampleRate)));
        const float percDropGain = (percOn && models[0] == OrganModel::B3) ? 0.707f : 1.0f;
        const float driveGain = 1.25f + drive * 6.5f;
        const float driveNorm = 1.0f / std::max(0.5f, fastTanh(driveGain));

        const float targetHorn = rotaryMode == 2 ? 6.75f : 0.83f;
        const float targetDrum = rotaryMode == 2 ? 5.90f : 0.67f;
        const float hornRamp = 1.0f / std::max(1.0f, (rotaryMode == 2 ? 0.45f : 0.75f) * static_cast<float>(sampleRate));
        const float drumRamp = 1.0f / std::max(1.0f, (rotaryMode == 2 ? 1.50f : 1.80f) * static_cast<float>(sampleRate));
        const float xoAlpha = 1.0f - std::exp(-kTwoPi * 800.0f / static_cast<float>(sampleRate));

        constexpr int kChunk = 256;
        float dryBuf[kChunk];
        const double invSR = 1.0 / sampleRate;

        int offset = 0;
        while (offset < frames) {
            const int nFrames = std::min(kChunk, frames - offset);
            std::memset(dryBuf, 0, sizeof(float) * static_cast<size_t>(nFrames));

            for (auto &v : voices) {
                if (!v.active) continue;

                const OrganModel m = models[v.manual];
                const float mGain = manualGains[v.manual] * 0.14f;
                const double percInc = v.percFreq * invSR;
                double barIncs[9];
                for (int i = 0; i < 9; ++i) {
                    barIncs[i] = v.freqs[i] * invSR;
                }

                for (int s = 0; s < nFrames; ++s) {
                    if (!v.releasing) {
                        v.env = std::min(1.0f, v.env + atkStep);
                    } else {
                        v.env *= relCoeff;
                        if (v.env < 1e-4f) {
                            v.active = false;
                            break;
                        }
                    }

                    float tone = 0.0f;
                    for (int i = 0; i < 9; ++i) {
                        const float g = v.gains[i];
                        if (g <= 1e-4f) continue;
                        double ph = v.phases[i] + barIncs[i];
                        if (ph >= 1.0) ph -= std::floor(ph);
                        v.phases[i] = ph;

                        float oscOut = kSineTable.lookup(ph);
                        if (m == OrganModel::Vox) {
                            oscOut = fastTanh(oscOut * 2.4f) * 0.75f;
                        } else if (m == OrganModel::Farf) {
                            double ph2 = ph * 2.0;
                            ph2 -= std::floor(ph2);
                            double ph3 = ph * 3.0;
                            ph3 -= std::floor(ph3);
                            oscOut = (oscOut + 0.45f * kSineTable.lookup(ph2) + 0.25f * kSineTable.lookup(ph3)) * 0.65f;
                        }
                        tone += oscOut * g;
                    }

                    float voiceOut = tone * v.env * mGain;
                    if (v.clickEnv > 1e-4f) {
                        voiceOut += nextNoise() * v.clickEnv * 0.18f;
                        v.clickEnv *= clickDecay;
                    }
                    if (v.percActive) {
                        v.percPhase += percInc;
                        if (v.percPhase >= 1.0) v.percPhase -= 1.0;
                        voiceOut += kSineTable.lookup(v.percPhase) * v.percEnv * 0.22f;
                        v.percEnv *= percDecay;
                        if (v.percEnv < 1e-4f) v.percActive = false;
                    }

                    dryBuf[s] += voiceOut;
                }
            }

            float *dstL = outL + offset;
            float *dstR = outR + offset;

            for (int s = 0; s < nFrames; ++s) {
                float drySample = dryBuf[s] * percDropGain;

                vibBuf[vibWrite] = drySample;
                if (vibMode > 0) {
                    vibLfoPhase += 6.9 * invSR;
                    if (vibLfoPhase >= 1.0) vibLfoPhase -= 1.0;
                    const double modSamples = (0.0012 + 0.00042 * kSineTable.lookup(vibLfoPhase)) * sampleRate;
                    const int dInt = static_cast<int>(modSamples);
                    const float frac = static_cast<float>(modSamples - dInt);
                    const int idx0 = (vibWrite - dInt + 1024) & 1023;
                    const int idx1 = (idx0 - 1 + 1024) & 1023;
                    const float delayed = vibBuf[idx0] * (1.0f - frac) + vibBuf[idx1] * frac;
                    drySample = (vibMode == 1) ? delayed : (0.65f * drySample + 0.65f * delayed);
                }
                vibWrite = (vibWrite + 1) & 1023;

                const float preamped = fastTanh((drySample - 0.025f * drySample * drySample) * driveGain) * driveNorm * 0.92f;

                float outSampleL = preamped;
                float outSampleR = preamped;
                if (rotaryMode > 0) {
                    hornFreq += (targetHorn - hornFreq) * hornRamp;
                    drumFreq += (targetDrum - drumFreq) * drumRamp;
                    hornPhase += hornFreq * invSR;
                    if (hornPhase >= 1.0) hornPhase -= 1.0;
                    drumPhase += drumFreq * invSR;
                    if (drumPhase >= 1.0) drumPhase -= 1.0;

                    lpState1 += xoAlpha * (preamped - lpState1);
                    lpState2 += xoAlpha * (lpState1 - lpState2);
                    const float drumSig = lpState2;
                    const float hornSig = preamped - drumSig;

                    const float hSin = kSineTable.lookup(hornPhase);
                    const float dSin = kSineTable.lookup(drumPhase);
                    outSampleL = hornSig * (0.58f + 0.42f * hSin) + drumSig * (0.82f + 0.18f * dSin);
                    outSampleR = hornSig * (0.58f - 0.42f * hSin) + drumSig * (0.82f - 0.18f * dSin);
                }

                dstL[s] += outSampleL * sectionGain;
                dstR[s] += outSampleR * sectionGain;
            }

            offset += nFrames;
        }
    }
};

// ---------------- Test Chime Synthesizer ----------------

struct TestChime {
    bool active = false;
    int pos = 0;

    void trigger() {
        pos = 0;
        active = true;
    }

    void render(float *outL, float *outR, int frames, double sampleRate) {
        if (!active) return;
        static constexpr double kNotesHz[3] = {523.25, 659.25, 783.99};
        const int sr = static_cast<int>(sampleRate);
        const int totalSamples = static_cast<int>(1.1 * sampleRate);

        for (int s = 0; s < frames; ++s) {
            if (pos >= totalSamples) {
                active = false;
                break;
            }
            float mix = 0.0f;
            for (int n = 0; n < 3; ++n) {
                const int start = static_cast<int>(n * 0.08 * sr);
                if (pos >= start) {
                    const double t = static_cast<double>(pos - start) / sampleRate;
                    if (t < 0.9) {
                        const double env = (t < 0.02 ? (t / 0.02) : std::exp(-(t - 0.02) / 0.22));
                        const double p = std::fmod(t * kNotesHz[n], 1.0);
                        const double tri = 1.0 - 4.0 * std::fabs(std::round(p - 0.25) - (p - 0.25));
                        mix += static_cast<float>(tri * env * 0.18);
                    }
                }
            }
            outL[s] += mix;
            outR[s] += mix;
            pos++;
        }
    }
};

// ---------------- Continuous Ambient Drone Pad ----------------

struct ContinuousPadEngine {
    struct Slot {
        bool active = false;
        bool releasing = false;
        int key = 0;
        int octave = 0;
        float env = 0.0f;
        double phases[6] = {};
        double lfoPhase = 0.0;
        double audioPos = 0.0;
        SVFStage fL;
        SVFStage fR;

        void start(int k, int oct) {
            active = true;
            releasing = false;
            key = std::max(0, std::min(11, k));
            octave = (oct != 0) ? 1 : 0;
            env = 0.0f;
            audioPos = 0.0;
            lfoPhase = 0.12 * static_cast<double>(key);
            fL.reset();
            fR.reset();
            for (int i = 0; i < 6; ++i) {
                phases[i] = std::fmod(0.173 * static_cast<double>(i) + 0.061 * static_cast<double>(key), 1.0);
            }
        }
    };

    bool playing = false;
    int currentKey = 0;
    int currentOctave = 0;
    int activeSlot = 0;
    std::array<Slot, 2> slots{};

    bool useCustomAudio = false;
    double customAudioSR = 44100.0;
    std::vector<float> customL;
    std::vector<float> customR;

    void swapCustomAudio(std::vector<float> &nextL, std::vector<float> &nextR, double sr) {
        customL.swap(nextL);
        customR.swap(nextR);
        customAudioSR = sr > 0.0 ? sr : 44100.0;
        useCustomAudio = !customL.empty() && customL.size() == customR.size();
        for (auto &s : slots) {
            s.audioPos = 0.0;
        }
    }

    void clearCustomAudio(std::vector<float> &oldL, std::vector<float> &oldR) {
        useCustomAudio = false;
        oldL.swap(customL);
        oldR.swap(customR);
        customL.clear();
        customR.clear();
    }

    void setState(bool shouldPlay, int key, int octave) {
        const int k = std::max(0, std::min(11, key));
        const int oct = (octave != 0) ? 1 : 0;
        if (!shouldPlay) {
            playing = false;
            for (auto &s : slots) {
                if (s.active) s.releasing = true;
            }
            return;
        }
        if (playing && slots[activeSlot].active && !slots[activeSlot].releasing && currentKey == k && currentOctave == oct) {
            return;
        }
        if (slots[activeSlot].active) {
            slots[activeSlot].releasing = true;
        }
        activeSlot = 1 - activeSlot;
        playing = true;
        currentKey = k;
        currentOctave = oct;
        slots[activeSlot].start(k, oct);
    }

    static inline float warmWave(double ph) {
        // Blended fundamental + soft even/odd warmth without harsh buzz
        const float s1 = kSineTable.lookup(ph);
        double ph2 = ph * 2.0;
        if (ph2 >= 1.0) ph2 -= std::floor(ph2);
        const float s2 = kSineTable.lookup(ph2);
        const float tri = 1.0f - 4.0f * static_cast<float>(std::fabs(std::round(ph - 0.25) - (ph - 0.25)));
        return 0.55f * s1 + 0.25f * tri + 0.14f * s2;
    }

    void render(float *outL, float *outR, int frames, double sampleRate) {
        if (!slots[0].active && !slots[1].active) return;

        const double invSR = 1.0 / sampleRate;
        const float atkStep = 1.0f / std::max(1.0f, (useCustomAudio ? 0.25f : 0.75f) * static_cast<float>(sampleRate));
        const float relCoeff = std::exp(-1.0f / std::max(1.0f, (useCustomAudio ? 0.25f : 0.48f) * static_cast<float>(sampleRate)));

        if (useCustomAudio && !customL.empty()) {
            const size_t total = customL.size();
            const double lenD = static_cast<double>(total);
            const size_t xfade = (total > 8192) ? std::min<size_t>(2048, total / 8) : 0;
            const double xfadeStart = static_cast<double>(total - xfade);

            for (auto &sl : slots) {
                if (!sl.active) continue;
                const double semis = static_cast<double>(sl.key + sl.octave * 12);
                const double step = std::pow(2.0, semis / 12.0) * (customAudioSR / sampleRate);

                for (int s = 0; s < frames; ++s) {
                    if (!sl.releasing) {
                        sl.env = std::min(1.0f, sl.env + atkStep);
                    } else {
                        sl.env *= relCoeff;
                        if (sl.env < 1e-4f) {
                            sl.active = false;
                            break;
                        }
                    }

                    double pos = sl.audioPos;
                    if (pos >= lenD) pos = std::fmod(pos, lenD);
                    const size_t i0 = static_cast<size_t>(pos) % total;
                    const size_t i1 = (i0 + 1) % total;
                    const float frac = static_cast<float>(pos - std::floor(pos));
                    float smpL = customL[i0] + (customL[i1] - customL[i0]) * frac;
                    float smpR = customR[i0] + (customR[i1] - customR[i0]) * frac;

                    if (xfade > 0 && pos >= xfadeStart) {
                        const float t = clampf(static_cast<float>((pos - xfadeStart) / static_cast<double>(xfade)), 0.0f, 1.0f);
                        const double headPos = pos - xfadeStart;
                        const size_t h0 = static_cast<size_t>(headPos) % total;
                        const size_t h1 = (h0 + 1) % total;
                        const float hFrac = static_cast<float>(headPos - std::floor(headPos));
                        const float headL = customL[h0] + (customL[h1] - customL[h0]) * hFrac;
                        const float headR = customR[h0] + (customR[h1] - customR[h0]) * hFrac;
                        smpL = smpL * (1.0f - t) + headL * t;
                        smpR = smpR * (1.0f - t) + headR * t;
                    }

                    sl.audioPos = pos + step;
                    if (sl.audioPos >= lenD) sl.audioPos -= lenD;

                    const float e = sl.env * sl.env * (3.0f - 2.0f * sl.env);
                    const float gain = e * 0.85f;
                    outL[s] += smpL * gain;
                    outR[s] += smpR * gain;
                }
            }
            return;
        }

        const double lfoInc = 0.085 * invSR;
        static constexpr double kDetuneMinus8 = 0.9953898; // 2^(-8/1200)
        static constexpr double kDetunePlus8 = 1.0046315;  // 2^(+8/1200)
        static constexpr double kDetuneMinus5 = 0.9971160; // 2^(-5/1200)
        static constexpr double kDetunePlus5 = 1.0028924;  // 2^(+5/1200)

        for (auto &sl : slots) {
            if (!sl.active) continue;

            const double rootHz = midiToHz(36 + sl.key + (sl.octave * 12)); // C2..B2 (ou C3..B3 com +1)
            const double incs[6] = {
                rootHz * invSR,
                (rootHz * 2.0 * kDetuneMinus8) * invSR,
                (rootHz * 2.0 * kDetunePlus8) * invSR,
                (rootHz * 3.0 * kDetuneMinus5) * invSR,
                (rootHz * 3.0 * kDetunePlus5) * invSR,
                (rootHz * 4.0) * invSR
            };

            for (int s = 0; s < frames; ++s) {
                if (!sl.releasing) {
                    sl.env = std::min(1.0f, sl.env + atkStep);
                } else {
                    sl.env *= relCoeff;
                    if (sl.env < 1e-4f) {
                        sl.active = false;
                        break;
                    }
                }

                for (int i = 0; i < 6; ++i) {
                    double ph = sl.phases[i] + incs[i];
                    if (ph >= 1.0) ph -= std::floor(ph);
                    sl.phases[i] = ph;
                }

                sl.lfoPhase += lfoInc;
                if (sl.lfoPhase >= 1.0) sl.lfoPhase -= 1.0;
                const float lfo = kSineTable.lookup(sl.lfoPhase);

                const float sub = kSineTable.lookup(sl.phases[0]) * 0.42f;
                const float octL = warmWave(sl.phases[1]);
                const float octR = warmWave(sl.phases[2]);
                const float fifthL = warmWave(sl.phases[3]);
                const float fifthR = warmWave(sl.phases[4]);
                const float air = kSineTable.lookup(sl.phases[5]) * 0.14f;

                const float rawL = sub + 0.34f * octL + 0.12f * octR + 0.22f * fifthL + 0.08f * fifthR + air;
                const float rawR = sub + 0.34f * octR + 0.12f * octL + 0.22f * fifthR + 0.08f * fifthL + air;

                const float cutoff = 820.0f + 260.0f * lfo;
                const float fltL = sl.fL.processLowpass(rawL, cutoff, 0.72f, sampleRate);
                const float fltR = sl.fR.processLowpass(rawR, cutoff, 0.72f, sampleRate);

                // Smooth S-curve envelope
                const float e = sl.env * sl.env * (3.0f - 2.0f * sl.env);
                const float gain = e * 0.20f;
                outL[s] += fltL * gain;
                outR[s] += fltR * gain;
            }
        }
    }
};

} // namespace

@implementation WorkestraNativeDSP {
    os_unfair_lock _lock;
    double _sampleRate;
    bool _studioMode;
    float _synthSectionLevel;
    float _organSectionLevel;
    SynthLayerEngine _synthA;
    SynthLayerEngine _synthB;
    OrganEngine _organ;
    TestChime _chime;
    ContinuousPadEngine _contPad;
    std::atomic<float> _meterPeak;
    std::atomic<float> _dspCpuLoad;
    mach_timebase_info_data_t _timebaseInfo;
    os_unfair_lock _cpuStatLock;
    uint64_t _lastWallTicks;
    uint64_t _lastCpuUs;
}

- (instancetype)initWithSampleRate:(double)sampleRate {
    self = [super init];
    if (self) {
        _lock = OS_UNFAIR_LOCK_INIT;
        _sampleRate = sampleRate > 0 ? sampleRate : 44100.0;
        _studioMode = false;
        _synthSectionLevel = 0.85f;
        _organSectionLevel = 0.85f;
        _meterPeak.store(0.0f, std::memory_order_relaxed);
        _dspCpuLoad.store(0.0f, std::memory_order_relaxed);
        mach_timebase_info(&_timebaseInfo);
        if (_timebaseInfo.denom == 0) {
            _timebaseInfo.numer = 1;
            _timebaseInfo.denom = 1;
        }
        _cpuStatLock = OS_UNFAIR_LOCK_INIT;
        _lastWallTicks = mach_absolute_time();
        struct rusage ru{};
        if (getrusage(RUSAGE_SELF, &ru) == 0) {
            _lastCpuUs = static_cast<uint64_t>(ru.ru_utime.tv_sec) * 1000000ULL + static_cast<uint64_t>(ru.ru_utime.tv_usec)
                       + static_cast<uint64_t>(ru.ru_stime.tv_sec) * 1000000ULL + static_cast<uint64_t>(ru.ru_stime.tv_usec);
        } else {
            _lastCpuUs = 0;
        }

        // Match defaults in js/audio.js
        _synthA.params = {SynthOscType::Sawtooth, 0.3f, 0.55f, 0.2f, 0.4f, 0.05f, 0.4f, 0.7f, 0.3f, 0.0f, 0.0f, 1.0f};
        _synthB.params = {SynthOscType::Supersaw, 0.4f, 0.45f, 0.1f, 0.2f, 0.3f, 0.5f, 0.8f, 0.5f, 0.0f, 0.0f, 1.0f};
    }
    return self;
}

- (void)setSampleRate:(double)sampleRate {
    os_unfair_lock_lock(&_lock);
    _sampleRate = sampleRate > 0.0 ? sampleRate : 44100.0;
    _organ.recomputeAllGains(_studioMode);
    os_unfair_lock_unlock(&_lock);
}

- (void)setPerfModeStudio:(BOOL)studio {
    os_unfair_lock_lock(&_lock);
    _studioMode = (studio == YES);
    _organ.recomputeAllGains(_studioMode);
    os_unfair_lock_unlock(&_lock);
}

- (void)setSectionLevel:(NSString *)section value:(float)value {
    const float g = value * value * 1.4f;
    os_unfair_lock_lock(&_lock);
    if ([section isEqualToString:@"synth"]) _synthSectionLevel = g;
    else if ([section isEqualToString:@"organ"]) _organSectionLevel = g;
    os_unfair_lock_unlock(&_lock);
}

- (void)setLayerLevel:(NSString *)section layer:(NSString *)layer value:(float)value {
    const float clamped = clampf(value, 0.0f, 1.0f);
    const float g = (clamped / 0.8f) * (clamped / 0.8f);
    const int idx = [layer isEqualToString:@"B"] ? 1 : 0;
    os_unfair_lock_lock(&_lock);
    if ([section isEqualToString:@"synth"]) {
        if (idx == 0) _synthA.params.layerGain = g;
        else _synthB.params.layerGain = g;
    } else if ([section isEqualToString:@"organ"]) {
        _organ.manualGains[idx] = g;
    }
    os_unfair_lock_unlock(&_lock);
}

- (void)setSynthLayer:(int)layer param:(NSString *)param numberValue:(double)value stringValue:(nullable NSString *)strValue {
    os_unfair_lock_lock(&_lock);
    SynthLayerEngine &eng = (layer == 1) ? _synthB : _synthA;
    if ([param isEqualToString:@"osc"] && strValue != nil) {
        if ([strValue isEqualToString:@"square"]) eng.params.osc = SynthOscType::Square;
        else if ([strValue isEqualToString:@"triangle"]) eng.params.osc = SynthOscType::Triangle;
        else if ([strValue isEqualToString:@"super"]) eng.params.osc = SynthOscType::Supersaw;
        else if ([strValue isEqualToString:@"sample"]) eng.params.osc = SynthOscType::Sample;
        else eng.params.osc = SynthOscType::Sawtooth;
    } else if ([param isEqualToString:@"detune"]) eng.params.detune = static_cast<float>(value);
    else if ([param isEqualToString:@"cutoff"]) eng.params.cutoff = static_cast<float>(value);
    else if ([param isEqualToString:@"reso"]) eng.params.reso = static_cast<float>(value);
    else if ([param isEqualToString:@"fenv"]) eng.params.fenv = static_cast<float>(value);
    else if ([param isEqualToString:@"attack"]) eng.params.attack = static_cast<float>(value);
    else if ([param isEqualToString:@"decay"]) eng.params.decay = static_cast<float>(value);
    else if ([param isEqualToString:@"sustain"]) eng.params.sustain = static_cast<float>(value);
    else if ([param isEqualToString:@"release"]) eng.params.release = static_cast<float>(value);
    os_unfair_lock_unlock(&_lock);
}

- (void)synthNoteOn:(int)layer note:(int)note velocity:(int)vel {
    os_unfair_lock_lock(&_lock);
    SynthLayerEngine &eng = (layer == 1) ? _synthB : _synthA;
    eng.noteOn(note, vel, _studioMode);
    os_unfair_lock_unlock(&_lock);
}

- (void)synthNoteOff:(int)layer note:(int)note {
    os_unfair_lock_lock(&_lock);
    SynthLayerEngine &eng = (layer == 1) ? _synthB : _synthA;
    eng.noteOff(note);
    os_unfair_lock_unlock(&_lock);
}

- (void)synthSustain:(int)layer down:(BOOL)down {
    os_unfair_lock_lock(&_lock);
    SynthLayerEngine &eng = (layer == 1) ? _synthB : _synthA;
    eng.setSustain(down == YES);
    os_unfair_lock_unlock(&_lock);
}

- (void)synthBend:(int)layer semitones:(double)semis {
    os_unfair_lock_lock(&_lock);
    SynthLayerEngine &eng = (layer == 1) ? _synthB : _synthA;
    eng.params.bendSemis = static_cast<float>(semis);
    os_unfair_lock_unlock(&_lock);
}

- (void)synthMod:(int)layer value:(double)value {
    os_unfair_lock_lock(&_lock);
    SynthLayerEngine &eng = (layer == 1) ? _synthB : _synthA;
    eng.params.modWheel = static_cast<float>(value);
    os_unfair_lock_unlock(&_lock);
}

- (void)synthAllOff:(int)layer {
    os_unfair_lock_lock(&_lock);
    if (layer < 0) {
        _synthA.allOff();
        _synthB.allOff();
    } else if (layer == 1) {
        _synthB.allOff();
    } else {
        _synthA.allOff();
    }
    os_unfair_lock_unlock(&_lock);
}

- (void)setOrganBar:(int)manual index:(int)index level:(int)level {
    if (index < 0 || index >= 9) return;
    const int m = (manual != 0) ? 1 : 0;
    os_unfair_lock_lock(&_lock);
    _organ.bars[m][index] = std::max(0, std::min(8, level));
    _organ.recomputeAllGains(_studioMode);
    os_unfair_lock_unlock(&_lock);
}

- (void)setOrganModel:(int)manual model:(NSString *)model {
    const int m = (manual != 0) ? 1 : 0;
    OrganModel next = OrganModel::B3;
    if ([model isEqualToString:@"vox"]) next = OrganModel::Vox;
    else if ([model isEqualToString:@"farf"]) next = OrganModel::Farf;
    os_unfair_lock_lock(&_lock);
    _organ.models[m] = next;
    _organ.recomputeAllGains(_studioMode);
    os_unfair_lock_unlock(&_lock);
}

- (void)setOrganPercOn:(BOOL)on third:(BOOL)third fast:(BOOL)fast {
    os_unfair_lock_lock(&_lock);
    _organ.percOn = (on == YES);
    _organ.percThird = (third == YES);
    _organ.percFast = (fast == YES);
    _organ.recomputeAllGains(_studioMode);
    os_unfair_lock_unlock(&_lock);
}

- (void)setOrganVibMode:(int)mode {
    os_unfair_lock_lock(&_lock);
    _organ.vibMode = mode;
    os_unfair_lock_unlock(&_lock);
}

- (void)setOrganDrive:(double)value {
    os_unfair_lock_lock(&_lock);
    _organ.drive = static_cast<float>(value);
    os_unfair_lock_unlock(&_lock);
}

- (void)setOrganRotaryMode:(int)mode {
    os_unfair_lock_lock(&_lock);
    _organ.rotaryMode = mode;
    os_unfair_lock_unlock(&_lock);
}

- (void)organNoteOn:(int)manual note:(int)note {
    os_unfair_lock_lock(&_lock);
    _organ.noteOn(manual, note, _studioMode);
    os_unfair_lock_unlock(&_lock);
}

- (void)organNoteOff:(int)manual note:(int)note {
    os_unfair_lock_lock(&_lock);
    _organ.noteOff(manual, note);
    os_unfair_lock_unlock(&_lock);
}

- (void)organAllOff {
    os_unfair_lock_lock(&_lock);
    _organ.allOff();
    os_unfair_lock_unlock(&_lock);
}

- (void)triggerTestChime {
    os_unfair_lock_lock(&_lock);
    _chime.trigger();
    os_unfair_lock_unlock(&_lock);
}

- (void)setContinuousPadPlaying:(BOOL)playing key:(int)key octave:(int)octave {
    os_unfair_lock_lock(&_lock);
    _contPad.setState(playing == YES, key, octave);
    os_unfair_lock_unlock(&_lock);
}

- (void)setContinuousPadAudioSamplesLeft:(const float *)left right:(const float *)right frameCount:(int)frames sampleRate:(double)sampleRate {
    if (left == nullptr || right == nullptr || frames <= 0) {
        [self clearContinuousPadAudioSamples];
        return;
    }
    const size_t count = static_cast<size_t>(frames);
    std::vector<float> nextL(left, left + count);
    std::vector<float> nextR(right, right + count);
    os_unfair_lock_lock(&_lock);
    _contPad.swapCustomAudio(nextL, nextR, sampleRate);
    os_unfair_lock_unlock(&_lock);
    // nextL / nextR now hold old buffers and are freed outside _lock
}

- (void)clearContinuousPadAudioSamples {
    std::vector<float> oldL;
    std::vector<float> oldR;
    os_unfair_lock_lock(&_lock);
    _contPad.clearCustomAudio(oldL, oldR);
    os_unfair_lock_unlock(&_lock);
    // oldL / oldR freed outside _lock
}

- (void)renderLeft:(float *)left right:(float *)right frameCount:(int)frames sampleRate:(double)sampleRate {
    const uint64_t tStart = mach_absolute_time();
    std::memset(left, 0, sizeof(float) * static_cast<size_t>(frames));
    std::memset(right, 0, sizeof(float) * static_cast<size_t>(frames));

    if (!os_unfair_lock_trylock(&_lock)) {
        return;
    }
    const double sr = sampleRate > 0 ? sampleRate : _sampleRate;
    _synthA.render(left, right, frames, sr, _synthSectionLevel, _studioMode);
    _synthB.render(left, right, frames, sr, _synthSectionLevel, _studioMode);
    _organ.render(left, right, frames, sr, _organSectionLevel);
    _contPad.render(left, right, frames, sr);
    _chime.render(left, right, frames, sr);
    os_unfair_lock_unlock(&_lock);

    float peak = 0.0f;
    for (int i = 0; i < frames; ++i) {
        peak = std::max(peak, std::max(std::fabs(left[i]), std::fabs(right[i])));
    }
    float cur = _meterPeak.load(std::memory_order_relaxed);
    if (peak > cur) {
        _meterPeak.store(peak, std::memory_order_relaxed);
    }

    const uint64_t tEnd = mach_absolute_time();
    if (tEnd > tStart && frames > 0) {
        const double renderNs = static_cast<double>(tEnd - tStart) * static_cast<double>(_timebaseInfo.numer) / static_cast<double>(_timebaseInfo.denom);
        const double budgetNs = (static_cast<double>(frames) / std::max(8000.0, sr)) * 1e9;
        const float loadPct = clampf(static_cast<float>((renderNs / budgetNs) * 100.0), 0.0f, 100.0f);
        float prev = _dspCpuLoad.load(std::memory_order_relaxed);
        while (loadPct > prev && !_dspCpuLoad.compare_exchange_weak(prev, loadPct, std::memory_order_relaxed)) {}
    }
}

- (float)consumeMeterPeak {
    return _meterPeak.exchange(0.0f, std::memory_order_relaxed);
}

- (float)consumeCpuLoad {
    const float dspPct = _dspCpuLoad.exchange(0.0f, std::memory_order_relaxed);
    float procPct = 0.0f;
    os_unfair_lock_lock(&_cpuStatLock);
    const uint64_t nowTicks = mach_absolute_time();
    const double elapsedNs = (nowTicks > _lastWallTicks)
        ? (static_cast<double>(nowTicks - _lastWallTicks) * static_cast<double>(_timebaseInfo.numer) / static_cast<double>(_timebaseInfo.denom))
        : 0.0;
    if (elapsedNs >= 50000000.0) {
        struct rusage ru{};
        if (getrusage(RUSAGE_SELF, &ru) == 0) {
            const uint64_t nowCpuUs = static_cast<uint64_t>(ru.ru_utime.tv_sec) * 1000000ULL + static_cast<uint64_t>(ru.ru_utime.tv_usec)
                                    + static_cast<uint64_t>(ru.ru_stime.tv_sec) * 1000000ULL + static_cast<uint64_t>(ru.ru_stime.tv_usec);
            const double elapsedWallUs = elapsedNs / 1000.0;
            const double elapsedCpuUs = (nowCpuUs >= _lastCpuUs) ? static_cast<double>(nowCpuUs - _lastCpuUs) : 0.0;
            procPct = clampf(static_cast<float>((elapsedCpuUs / elapsedWallUs) * 100.0), 0.0f, 100.0f);
            _lastCpuUs = nowCpuUs;
        }
        _lastWallTicks = nowTicks;
    }
    os_unfair_lock_unlock(&_cpuStatLock);
    return std::max(dspPct, procPct);
}

// ---------------- CoreAudio HAL Device Helpers ----------------

+ (NSArray<NSDictionary<NSString *, NSString *> *> *)listOutputDevices {
    NSMutableArray *result = [NSMutableArray array];
    AudioObjectPropertyAddress prop = {
        kAudioHardwarePropertyDevices,
        kAudioObjectPropertyScopeGlobal,
        kAudioObjectPropertyElementMain
    };
    UInt32 dataSize = 0;
    if (AudioObjectGetPropertyDataSize(kAudioObjectSystemObject, &prop, 0, nullptr, &dataSize) != noErr || dataSize == 0) {
        return result;
    }
    UInt32 count = dataSize / sizeof(AudioDeviceID);
    std::vector<AudioDeviceID> devices(count);
    if (AudioObjectGetPropertyData(kAudioObjectSystemObject, &prop, 0, nullptr, &dataSize, devices.data()) != noErr) {
        return result;
    }

    for (AudioDeviceID dev : devices) {
        AudioObjectPropertyAddress streamProp = {
            kAudioDevicePropertyStreams,
            kAudioDevicePropertyScopeOutput,
            kAudioObjectPropertyElementMain
        };
        UInt32 streamSize = 0;
        if (AudioObjectGetPropertyDataSize(dev, &streamProp, 0, nullptr, &streamSize) != noErr || streamSize == 0) {
            continue; // Not an output device
        }

        CFStringRef nameRef = nullptr;
        UInt32 nameSize = sizeof(CFStringRef);
        AudioObjectPropertyAddress nameProp = {
            kAudioObjectPropertyName,
            kAudioObjectPropertyScopeGlobal,
            kAudioObjectPropertyElementMain
        };
        AudioObjectGetPropertyData(dev, &nameProp, 0, nullptr, &nameSize, &nameRef);
        NSString *name = nameRef ? CFBridgingRelease(nameRef) : @"CoreAudio Output";

        CFStringRef uidRef = nullptr;
        UInt32 uidSize = sizeof(CFStringRef);
        AudioObjectPropertyAddress uidProp = {
            kAudioDevicePropertyDeviceUID,
            kAudioObjectPropertyScopeGlobal,
            kAudioObjectPropertyElementMain
        };
        AudioObjectGetPropertyData(dev, &uidProp, 0, nullptr, &uidSize, &uidRef);
        NSString *uid = uidRef ? CFBridgingRelease(uidRef) : [NSString stringWithFormat:@"%u", (unsigned int)dev];

        [result addObject:@{ @"id": uid, @"name": name }];
    }
    return result;
}

+ (unsigned int)defaultOutputDeviceID {
    AudioDeviceID devID = kAudioObjectUnknown;
    UInt32 size = sizeof(AudioDeviceID);
    AudioObjectPropertyAddress prop = {
        kAudioHardwarePropertyDefaultOutputDevice,
        kAudioObjectPropertyScopeGlobal,
        kAudioObjectPropertyElementMain
    };
    AudioObjectGetPropertyData(kAudioObjectSystemObject, &prop, 0, nullptr, &size, &devID);
    return static_cast<unsigned int>(devID);
}

+ (unsigned int)deviceIDForUID:(nullable NSString *)uid {
    if (uid == nil || [uid isEqualToString:@"default"] || uid.length == 0) {
        return [self defaultOutputDeviceID];
    }
    AudioDeviceID devID = kAudioObjectUnknown;
    CFStringRef cfUID = (__bridge CFStringRef)uid;
    AudioValueTranslation translation;
    translation.mInputData = &cfUID;
    translation.mInputDataSize = sizeof(CFStringRef);
    translation.mOutputData = &devID;
    translation.mOutputDataSize = sizeof(AudioDeviceID);
    UInt32 size = sizeof(AudioValueTranslation);
    AudioObjectPropertyAddress prop = {
        kAudioHardwarePropertyTranslateUIDToDevice,
        kAudioObjectPropertyScopeGlobal,
        kAudioObjectPropertyElementMain
    };
    if (AudioObjectGetPropertyData(kAudioObjectSystemObject, &prop, 0, nullptr, &size, &translation) != noErr || devID == kAudioObjectUnknown) {
        return [self defaultOutputDeviceID];
    }
    return static_cast<unsigned int>(devID);
}

+ (int)bufferFrameSizeForDevice:(unsigned int)deviceID {
    if (deviceID == kAudioObjectUnknown) return 256;
    UInt32 frames = 256;
    UInt32 size = sizeof(UInt32);
    AudioObjectPropertyAddress prop = {
        kAudioDevicePropertyBufferFrameSize,
        kAudioDevicePropertyScopeOutput,
        kAudioObjectPropertyElementMain
    };
    if (AudioObjectGetPropertyData(static_cast<AudioDeviceID>(deviceID), &prop, 0, nullptr, &size, &frames) != noErr) {
        prop.mScope = kAudioObjectPropertyScopeGlobal;
        AudioObjectGetPropertyData(static_cast<AudioDeviceID>(deviceID), &prop, 0, nullptr, &size, &frames);
    }
    return frames > 0 ? static_cast<int>(frames) : 256;
}

+ (int)setBufferFrameSize:(int)frames forDevice:(unsigned int)deviceID {
    if (deviceID == kAudioObjectUnknown) return frames;
    AudioDeviceID dev = static_cast<AudioDeviceID>(deviceID);
    int current = [self bufferFrameSizeForDevice:deviceID];
    int desired = std::max(32, std::min(4096, frames));

    AudioObjectPropertyAddress rangeProp = {
        kAudioDevicePropertyBufferFrameSizeRange,
        kAudioDevicePropertyScopeOutput,
        kAudioObjectPropertyElementMain
    };
    AudioValueRange range = { 32.0, 4096.0 };
    UInt32 rangeSize = sizeof(AudioValueRange);
    if (AudioObjectGetPropertyData(dev, &rangeProp, 0, nullptr, &rangeSize, &range) == noErr && range.mMaximum >= range.mMinimum) {
        int minF = std::max(32, static_cast<int>(std::ceil(range.mMinimum)));
        int maxF = std::min(4096, static_cast<int>(std::floor(range.mMaximum)));
        if (minF <= maxF) {
            desired = std::max(minF, std::min(maxF, desired));
        }
    }

    if (current == desired) {
        return current;
    }

    AudioObjectPropertyAddress prop = {
        kAudioDevicePropertyBufferFrameSize,
        kAudioDevicePropertyScopeOutput,
        kAudioObjectPropertyElementMain
    };
    Boolean settable = false;
    if (AudioObjectIsPropertySettable(dev, &prop, &settable) != noErr || !settable) {
        return current;
    }

    UInt32 target = static_cast<UInt32>(desired);
    AudioObjectSetPropertyData(dev, &prop, 0, nullptr, sizeof(UInt32), &target);
    return [self bufferFrameSizeForDevice:deviceID];
}

+ (double)sampleRateForDevice:(unsigned int)deviceID {
    if (deviceID == kAudioObjectUnknown) return 44100.0;
    Float64 sr = 0.0;
    UInt32 size = sizeof(Float64);
    AudioObjectPropertyAddress prop = {
        kAudioDevicePropertyNominalSampleRate,
        kAudioObjectPropertyScopeGlobal,
        kAudioObjectPropertyElementMain
    };
    if (AudioObjectGetPropertyData(static_cast<AudioDeviceID>(deviceID), &prop, 0, nullptr, &size, &sr) != noErr || sr <= 0.0) {
        prop.mScope = kAudioDevicePropertyScopeOutput;
        AudioObjectGetPropertyData(static_cast<AudioDeviceID>(deviceID), &prop, 0, nullptr, &size, &sr);
    }
    return sr > 0.0 ? sr : 44100.0;
}

@end
