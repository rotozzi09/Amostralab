// Seção Strings: FluidSynth (via js-synthesizer) com camadas A e B independentes,
// idêntico à arquitetura do Piano e do Synth no modo Sample.
import { ctx, stringsIn, stringsInB } from "./audio.js";
import { registerWorklet } from "./piano.js";

const CH = 0;

async function readAll(source, onProgress) {
  if (source.url) {
    const res = await fetch(source.url);
    if (!res.ok) throw new Error(`HTTP ${res.status} em ${source.name}`);
    const total = Number(res.headers.get("content-length")) || source.size;
    const out = new Uint8Array(total);
    const reader = res.body.getReader();
    let at = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      out.set(value, at);
      at += value.length;
      onProgress(at / total);
    }
    return out.buffer;
  }
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    fr.onload = () => resolve(fr.result);
    fr.onerror = () => reject(fr.error);
    fr.readAsArrayBuffer(source.file);
  });
}

function createStrings(output) {
  let synth = null;
  let ready = null;
  let current = null; // { id, source }
  const api = {
    init() {
      ready ??= (async () => {
        await registerWorklet();
        synth = new JSSynth.AudioWorkletNodeSynthesizer();
        synth.init(ctx.sampleRate);
        const node = synth.createAudioNode(ctx, { reverbActive: false, chorusActive: false, polyphony: 512, initialGain: 0.5 });
        node.connect(output);
      })();
      return ready;
    },
    async load(source, onProgress = () => {}, bank = 0, preset = 0) {
      await api.init();
      if (current?.source === source) return current.id;
      synth.midiAllSoundsOff(CH);
      if (current) {
        await synth.unloadSFontAsync(current.id);
        current = null;
      }
      const bin = await readAll(source, (p) => onProgress(p * 0.8));
      onProgress(0.85);
      const id = await synth.loadSFont(bin);
      let targetBank = bank;
      let targetPreset = preset;
      try {
        const { readSf2 } = await import("./sf2reader.js");
        const sfSource = { size: bin.byteLength, slice: (a, b) => ({ arrayBuffer: async () => bin.slice(a, b) }) };
        const sf = await readSf2(sfSource);
        if (sf.presets && sf.presets.length > 0) {
          const match = sf.presets.find((p) => p.bank === bank && p.preset === preset);
          if (match) {
            targetBank = match.bank;
            targetPreset = match.preset;
          } else {
            targetBank = sf.presets[0].bank;
            targetPreset = sf.presets[0].preset;
          }
        }
      } catch {
        // Mantém bank e preset iniciais
      }
      synth.midiProgramSelect(CH, id, targetBank, targetPreset);
      current = { id, source, bank: targetBank, preset: targetPreset };
      onProgress(1);
      return id;
    },
    async unload() {
      if (!current) return;
      synth.midiAllSoundsOff(CH);
      await synth.unloadSFontAsync(current.id);
      current = null;
    },
    loaded: () => current?.source ?? null,
    noteOn: (note, vel) => current && synth.midiNoteOn(CH, note, vel),
    noteOff: (note) => current && synth.midiNoteOff(CH, note),
    sustain: (down) => synth?.midiControl(CH, 64, down ? 127 : 0),
    pitchBend: (v) => synth?.midiPitchBend(CH, v),
    allOff: () => synth?.midiAllNotesOff(CH),
    modWheel: (v) => synth?.midiControl(CH, 1, Math.round(v * 127)),
  };
  return api;
}

const A = createStrings(stringsIn);
export const B = createStrings(stringsInB);
export const { init, load, unload, loaded, noteOn, noteOff, sustain, pitchBend, allOff, modWheel } = A;
