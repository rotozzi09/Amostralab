// Sintetizador em memória do SoundFont padrão (LabPiano Grand) para inicialização instantânea com áudio.
import { layoutSf2, writePcm } from "./nord.js";

let defaultSoundCache = null;

export function generateDefaultSound() {
  if (defaultSoundCache) return defaultSoundCache;
  const rate = 44100;
  // Amostras de piano em 6 regiões principais (C2, C3, C4, C5, C6, C7)
  const notes = [36, 48, 60, 72, 84, 96];
  const zones = [];

  notes.forEach((root, idx) => {
    const lo = idx === 0 ? 0 : Math.floor((notes[idx - 1] + root) / 2) + 1;
    const hi = idx === notes.length - 1 ? 127 : Math.floor((root + notes[idx + 1]) / 2);
    const duration = 2.5; // 2.5 segundos de amostra
    const frames = Math.floor(rate * duration);

    zones.push({
      name: `Piano_C${idx + 1}`,
      channels: 1,
      frames,
      rate,
      root,
      keyLo: lo,
      keyHi: hi,
      velLo: 0,
      velHi: 127,
      gens: [[38, 2400], [36, 4000]], // release e decay
      loop: null,
    });
  });

  const { out, smpl, starts } = layoutSf2("LabPiano Grand", "Grand Piano", zones);

  notes.forEach((root, z) => {
    const freq = 440 * Math.pow(2, (root - 69) / 12);
    const frames = zones[z].frames;
    const buffer = new Float32Array(frames);

    for (let i = 0; i < frames; i++) {
      const t = i / rate;
      // Envelope exponencial de decaimento natural de piano acústico
      const env = Math.exp(-t * 2.2);
      // Overtones harmônicos (Fundamental, 2ª, 3ª, 4ª e 5ª parciais)
      const sig = Math.sin(2 * Math.PI * freq * t) * 0.6
                + Math.sin(2 * Math.PI * freq * 2 * t) * 0.25
                + Math.sin(2 * Math.PI * freq * 3 * t) * 0.12
                + Math.sin(2 * Math.PI * freq * 4 * t) * 0.05;
      buffer[i] = sig * env;
    }

    writePcm(smpl, starts[z][0], buffer, frames, 26000);
  });

  const blob = new Blob([out], { type: "audio/x-soundfont" });
  defaultSoundCache = {
    name: "LabPiano Grand.sf2",
    size: blob.size,
    file: blob,
    slice: (a, b) => blob.slice(a, b),
  };
  return defaultSoundCache;
}
