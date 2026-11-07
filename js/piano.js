// Seção Piano: FluidSynth (libfluidsynth 2.4.6 em WebAssembly, via js-synthesizer) num AudioWorklet.
// Layers A e B: cada uma é um FluidSynth próprio com um SF2 (carregar num sintetizador que está
// tocando travaria o áudio dele). A B só é criada quando recebe o primeiro SF2.
// Trocar de SF2 descarrega o anterior daquela layer.
import { ctx, pianoIn, pianoInB } from "./audio.js";

const CH = 0;
let worklet = null;

// Registra os módulos do worklet (só pode uma vez por página; o sampler.js também usa).
export function registerWorklet() {
  worklet ??= (async () => {
    await ctx.audioWorklet.addModule("vendor/libfluidsynth-2.4.6.js");
    await ctx.audioWorklet.addModule("vendor/js-synthesizer.worklet.min.js");
  })();
  return worklet;
}

// Lê o arquivo inteiro com progresso (os SF2 dos pianos XL passam de 300 MB).
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

function createPiano(output) {
  let synth = null;
  let ready = null;
  let current = null; // { id, source }
  const api = {
    init() {
      ready ??= (async () => {
        await registerWorklet();
        synth = new JSSynth.AudioWorkletNodeSynthesizer();
        synth.init(ctx.sampleRate);
        // Reverb e chorus ficam nos Layer Effects (Web Audio), iguais para as três seções.
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
    // Descarrega o SF2 (layer B vazia, como "pianoB" vazio no nativo).
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

// Layer A: as funções de sempre (import * as piano). Layer B: piano.B, com a mesma API.
const A = createPiano(pianoIn);
export const B = createPiano(pianoInB);
export const { init, load, unload, loaded, noteOn, noteOff, sustain, pitchBend, allOff, modWheel } = A;