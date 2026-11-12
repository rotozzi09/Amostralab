// Synth no modo Sample: um segundo FluidSynth (o mesmo WebAssembly do Piano, outra instância)
// toca um SF2 escolhido pelo usuário (pads, strings, choirs…) no barramento do Synth.
// Os knobs do Synth agem sobre o preset por NRPN do SoundFont 2.01: são deslocamentos sobre
// os valores do próprio preset, então no valor padrão do knob ele soa como foi feito.
import { ctx, synthSampleIn, synthApi } from "./audio.js";
import { registerWorklet } from "./piano.js";

const CH = 0;
let synth = null;
let ready = null;
let current = null; // { id, source, name, presets, preset }

// Valores padrão dos knobs do Synth (data-value no index.html): ali o deslocamento é zero.
const DEFAULT = { attack: 0.05, decay: 0.4, sustain: 0.7, release: 0.3, cutoff: 0.55, reso: 0.2 };
const knobs = { ...DEFAULT };
const time = (v) => 0.002 + v * v * 4; // mesma curva de tempo do synth (audio.js)

// Tempo do knob (attack/decay/release): abaixo do padrão encurta em proporção ao preset; acima
// garante pelo menos o tempo absoluto do knob, senão um preset com release de 1 ms continuaria seco.
// O valor típico do preset (timecents, mediana das zonas) vem do próprio SF2 (presetEnvelopes).
function timeOffset(param, v) {
  const rel = 1200 * Math.log2(time(v) / time(DEFAULT[param]));
  if (v <= DEFAULT[param]) return rel;
  const preset = current?.env?.[GEN[param].gen] ?? -12000;
  return Math.max(rel, 1200 * Math.log2(time(v)) - preset);
}

// Geradores SF2 e o deslocamento de cada knob na unidade do gerador.
// scale = unidades por passo de NRPN no FluidSynth (fluid_gen_info.nrpn_scale).
const GEN = {
  attack: { gen: 34, scale: 2, offset: (v) => timeOffset("attack", v) }, // timecents
  decay: { gen: 36, scale: 2, offset: (v) => timeOffset("decay", v) },
  release: { gen: 38, scale: 2, offset: (v) => timeOffset("release", v) },
  sustain: { gen: 37, scale: 1, offset: (v) => (DEFAULT.sustain - v) * 600 }, // cB de atenuação
  cutoff: { gen: 8, scale: 2, offset: (v) => (v - DEFAULT.cutoff) * 9 * 1200 }, // cents (9 oitavas, como o synth)
  reso: { gen: 9, scale: 1, offset: (v) => (v - DEFAULT.reso) * 300 }, // cB de pico
};

function nrpn(gen, offset, scale) {
  const data = Math.max(0, Math.min(16383, Math.round(8192 + offset / scale)));
  synth.midiControl(CH, 99, 120); // NRPN MSB 120 = gerador SF2
  synth.midiControl(CH, 98, gen);
  synth.midiControl(CH, 38, data & 127); // data entry LSB antes do MSB: o FluidSynth aplica no MSB
  synth.midiControl(CH, 6, data >> 7);
}

function applyKnob(param) {
  const g = GEN[param];
  if (g && synth && current) nrpn(g.gen, g.offset(knobs[param]), g.scale);
}
const applyAll = () => Object.keys(GEN).forEach(applyKnob);

export function init() {
  ready ??= (async () => {
    await registerWorklet(); // módulos do worklet (só pode uma vez por página)
    synth = new JSSynth.AudioWorkletNodeSynthesizer();
    synth.init(ctx.sampleRate);
    const node = synth.createAudioNode(ctx, { reverbActive: false, chorusActive: false, polyphony: 256, initialGain: 0.5 });
    node.connect(synthSampleIn);
    Object.assign(knobs, pick(synthApi.params()));
    synthApi.attachSampler({
      noteOn: (note, vel) => current && synth.midiNoteOn(CH, note, vel),
      noteOff: (note) => current && synth.midiNoteOff(CH, note),
      param(param, v) {
        if (!(param in GEN)) return;
        knobs[param] = v;
        applyKnob(param);
      },
      bend: (semis) => synth.midiPitchBend(CH, Math.max(0, Math.min(16383, Math.round(8192 + (semis / 2) * 8192)))),
      mod: (v) => synth.midiControl(CH, 1, Math.round(v * 127)),
      sustain: (down) => synth.midiControl(CH, 64, down ? 127 : 0),
      allOff: () => synth.midiAllNotesOff(CH),
    });
  })();
  return ready;
}

function pick(p) {
  const out = {};
  for (const k of Object.keys(DEFAULT)) if (typeof p[k] === "number") out[k] = p[k];
  return out;
}

async function readAll(source, onProgress) {
  if (source.url) {
    const res = await fetch(source.url);
    if (!res.ok) throw new Error(`HTTP ${res.status} em ${source.name}`);
    const total = Number(res.headers.get("content-length")) || source.size || 0;
    const chunks = [];
    let at = 0;
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      at += value.length;
      if (total) onProgress(at / total);
    }
    const out = new Uint8Array(at);
    let pos = 0;
    for (const c of chunks) { out.set(c, pos); pos += c.length; }
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

// Valores típicos de envelope e filtro de cada preset, direto do pdta do SF2:
// instrumento (zona ou global, senão o padrão da norma) + preset (zona ou global), mediana das zonas.
const ENV_GENS = [8, 9, 34, 36, 37, 38];
const GEN_DEFAULT = { 8: 13500, 9: 0, 34: -12000, 36: -12000, 37: 0, 38: -12000 };

function presetEnvelopes(bin) {
  const v = new DataView(bin);
  const tag = (a) => String.fromCharCode(v.getUint8(a), v.getUint8(a + 1), v.getUint8(a + 2), v.getUint8(a + 3));
  const sub = {};
  for (let a = 12; a + 8 <= v.byteLength;) {
    const size = v.getUint32(a + 4, true);
    if (tag(a) === "LIST" && tag(a + 8) === "pdta") {
      for (let b = a + 12; b + 8 <= a + 8 + size;) {
        const n = v.getUint32(b + 4, true);
        sub[tag(b)] = [b + 8, n];
        b += 8 + n + (n & 1);
      }
      break;
    }
    a += 8 + size + (size & 1);
  }
  if (!sub.phdr || !sub.pbag || !sub.pgen || !sub.inst || !sub.ibag || !sub.igen) return {};
  const recs = (name, size, fn) => {
    const [at, n] = sub[name];
    return Array.from({ length: Math.floor(n / size) }, (_, i) => fn(at + i * size));
  };
  const gens = (name) => recs(name, 4, (a) => ({ oper: v.getUint16(a, true), amount: v.getInt16(a + 2, true), u: v.getUint16(a + 2, true) }));
  const bags = (name) => recs(name, 4, (a) => v.getUint16(a, true));
  const phdr = recs("phdr", 38, (a) => ({ preset: v.getUint16(a + 20, true), bank: v.getUint16(a + 22, true), bag: v.getUint16(a + 24, true) }));
  const inst = recs("inst", 22, (a) => v.getUint16(a + 20, true));
  const pbag = bags("pbag");
  const pgen = gens("pgen");
  const ibag = bags("ibag");
  const igen = gens("igen");
  // Zonas [first, last): Map oper → gen. A primeira zona sem o gerador terminal é a global.
  const zones = (bagList, genList, first, last, terminal) => {
    let global = null;
    const out = [];
    for (let b = first; b < last; b++) {
      const m = new Map();
      for (let g = bagList[b]; g < bagList[b + 1]; g++) m.set(genList[g].oper, genList[g]);
      if (!m.has(terminal)) { if (b === first) global = m; continue; }
      out.push(m);
    }
    return { global, out };
  };
  const median = (a) => { a.sort((x, y) => x - y); return a[a.length >> 1]; };
  const result = {};
  phdr.slice(0, -1).forEach((p, i) => {
    const pz = zones(pbag, pgen, p.bag, phdr[i + 1].bag, 41);
    const vals = Object.fromEntries(ENV_GENS.map((g) => [g, []]));
    for (const z of pz.out) {
      const ii = z.get(41).u;
      if (ii + 1 >= inst.length) continue;
      const iz = zones(ibag, igen, inst[ii], inst[ii + 1], 53);
      for (const zone of iz.out) {
        for (const g of ENV_GENS) {
          const base = zone.get(g)?.amount ?? iz.global?.get(g)?.amount ?? GEN_DEFAULT[g];
          vals[g].push(base + (z.get(g)?.amount ?? pz.global?.get(g)?.amount ?? 0));
        }
      }
    }
    if (vals[38].length) result[`${p.bank}:${p.preset}`] = Object.fromEntries(ENV_GENS.map((g) => [g, median(vals[g])]));
  });
  return result;
}

async function listPresets(id, bin) {
  if (bin) {
    try {
      const { readSf2 } = await import("./sf2reader.js");
      const sfSource = { size: bin.byteLength, slice: (a, b) => ({ arrayBuffer: async () => bin.slice(a, b) }) };
      const sf = await readSf2(sfSource);
      if (sf.presets && sf.presets.length > 0) {
        return sf.presets.map((p) => ({ bank: p.bank, num: p.preset, name: p.name.trim() || `Preset ${p.preset}` }));
      }
    } catch {
      /* fallback */
    }
  }
  try {
    const sfont = await synth.getSFontObject(id);
    const it = await sfont.getPresetIterable();
    const presets = [...it].map((p) => ({ bank: p.bankNum, num: p.num, name: p.name.trim() || `Preset ${p.num}` }));
    if (presets.length) return presets.sort((a, b) => a.bank - b.bank || a.num - b.num);
  } catch {
    /* fallback */
  }
  return [{ bank: 0, num: 0, name: "Preset 0" }];
}

// Carrega um SF2 no Synth (substitui o anterior) e escolhe o primeiro preset.
export async function load(source, onProgress = () => {}) {
  await init();
  if (current?.source === source) return info();
  synth.midiAllSoundsOff(CH);
  if (current) {
    await synth.unloadSFontAsync(current.id);
    current = null;
  }
  const bin = await readAll(source, (p) => onProgress(p * 0.8));
  onProgress(0.85);
  let envs = {};
  try { envs = presetEnvelopes(bin); } catch { /* SF2 fora do padrão: os knobs ficam só relativos */ }
  const id = await synth.loadSFont(bin);
  const presets = await listPresets(id, bin);
  current = { id, source, name: (source.name || "SF2").replace(/\.sf2$/i, ""), presets, preset: null, envs, env: null };
  if (presets.length) selectPreset(presets[0].bank, presets[0].num);
  onProgress(1);
  return info();
}

export function selectPreset(bank, num) {
  if (!current) return;
  synth.midiAllNotesOff(CH);
  synth.midiProgramSelect(CH, current.id, bank, num);
  current.preset = current.presets.find((p) => p.bank === bank && p.num === num) ?? { bank, num, name: "" };
  current.env = current.envs[`${bank}:${num}`] ?? null;
  applyAll(); // os deslocamentos dos knobs valem para o canal; reaplica no preset novo
}

const info = () => current && { name: current.name, presets: current.presets, preset: current.preset };
export const loaded = () => current?.source ?? null;
export const state = () => info();