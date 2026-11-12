// Converte arquivos WAV (.wav) para SoundFont (.sf2) no navegador,
// mapeando o áudio como instrumento de teclado tocável em todas as 88 teclas.
import { layoutSf2, writePcm } from "./nord.js";

const TARGET_PEAK = 29000;

function ascii(bytes, at, len) {
  let s = "";
  for (let i = 0; i < len; i++) s += String.fromCharCode(bytes[at + i]);
  return s;
}

/** Verifica se os bytes contêm cabeçalho RIFF/WAVE */
export function isWavFile(bytes) {
  if (!bytes || bytes.length < 12) return false;
  return ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WAVE";
}

/** Decodifica o áudio de um arquivo WAV em canais Float32Array */
export function decodeWav(bytes) {
  if (!isWavFile(bytes)) throw new Error("Não é um arquivo WAV válido (RIFF/WAVE)");
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  let pos = 12;
  let fmt = null;
  let dataChunk = null;
  let smplChunk = null;

  while (pos + 8 <= bytes.length) {
    const chunkId = ascii(bytes, pos, 4);
    const chunkSize = dv.getUint32(pos + 4, true);
    const chunkPayload = pos + 8;
    if (chunkId === "fmt ") {
      fmt = {
        format: dv.getUint16(chunkPayload, true),
        channels: dv.getUint16(chunkPayload + 2, true),
        rate: dv.getUint32(chunkPayload + 4, true),
        bits: dv.getUint16(chunkPayload + 14, true),
      };
    } else if (chunkId === "data") {
      dataChunk = { offset: chunkPayload, size: Math.min(chunkSize, bytes.length - chunkPayload) };
    } else if (chunkId === "smpl") {
      smplChunk = { offset: chunkPayload, size: chunkSize };
    }
    pos += 8 + chunkSize + (chunkSize & 1);
  }

  if (!fmt || !dataChunk) throw new Error("WAV sem chunk fmt ou data");

  const channels = Math.min(2, Math.max(1, fmt.channels));
  const rate = fmt.rate >= 8000 && fmt.rate <= 192000 ? fmt.rate : 44100;
  const bytesPerSample = Math.floor(fmt.bits / 8);
  const blockAlign = bytesPerSample * fmt.channels;
  const totalFrames = Math.floor(dataChunk.size / blockAlign);

  const chans = Array.from({ length: channels }, () => new Float32Array(totalFrames));
  const p = dataChunk.offset;

  if (fmt.format === 1) {
    // PCM inteiro
    if (fmt.bits === 16) {
      for (let i = 0; i < totalFrames; i++) {
        for (let ch = 0; ch < channels; ch++) {
          chans[ch][i] = dv.getInt16(p + i * blockAlign + ch * 2, true) / 32768.0;
        }
      }
    } else if (fmt.bits === 24) {
      for (let i = 0; i < totalFrames; i++) {
        for (let ch = 0; ch < channels; ch++) {
          const at = p + i * blockAlign + ch * 3;
          let val = (bytes[at] | (bytes[at + 1] << 8) | (bytes[at + 2] << 16));
          if (val & 0x800000) val |= ~0xffffff;
          chans[ch][i] = val / 8388608.0;
        }
      }
    } else if (fmt.bits === 32) {
      for (let i = 0; i < totalFrames; i++) {
        for (let ch = 0; ch < channels; ch++) {
          chans[ch][i] = dv.getInt32(p + i * blockAlign + ch * 4, true) / 2147483648.0;
        }
      }
    } else if (fmt.bits === 8) {
      for (let i = 0; i < totalFrames; i++) {
        for (let ch = 0; ch < channels; ch++) {
          chans[ch][i] = (bytes[p + i * blockAlign + ch] - 128) / 128.0;
        }
      }
    } else {
      throw new Error(`Profundidade de bits WAV não suportada: ${fmt.bits} bits`);
    }
  } else if (fmt.format === 3 && fmt.bits === 32) {
    // IEEE 32-bit float
    for (let i = 0; i < totalFrames; i++) {
      for (let ch = 0; ch < channels; ch++) {
        chans[ch][i] = dv.getFloat32(p + i * blockAlign + ch * 4, true);
      }
    }
  } else {
    throw new Error(`Formato de codificação WAV não suportado (formato 0x${fmt.format.toString(16)})`);
  }

  // Pontos de loop e nota raiz do smpl chunk
  let root = 60; // C4 padrão
  let loop = null;
  if (smplChunk && smplChunk.size >= 36) {
    const sp = smplChunk.offset;
    const midiUnityNote = dv.getUint32(sp + 12, true);
    if (midiUnityNote >= 0 && midiUnityNote <= 127) root = midiUnityNote;
    const numLoops = dv.getUint32(sp + 28, true);
    if (numLoops > 0 && smplChunk.size >= 36 + 24) {
      const lStart = dv.getUint32(sp + 36 + 8, true);
      const lEnd = dv.getUint32(sp + 36 + 12, true);
      if (lEnd > lStart && lEnd <= totalFrames) {
        loop = [lStart, lEnd];
      }
    }
  }

  return { channels: chans, rate, frames: totalFrames, root, loop };
}

/**
 * Converte um arquivo ou buffer WAV para SF2 (preset 0).
 */
export async function wavToSf2(bytes, { name = "Wav Piano", onProgress = () => {} } = {}) {
  if (bytes instanceof ArrayBuffer) bytes = new Uint8Array(bytes);
  let decoded = null;
  try {
    decoded = decodeWav(bytes);
  } catch (err) {
    // Se o parser nativo falhar e estivermos em navegador com AudioContext:
    if (typeof AudioContext !== "undefined" || typeof webkitAudioContext !== "undefined") {
      try {
        const AudioCtx = window.AudioContext || window.webkitAudioContext;
        const actx = new AudioCtx();
        const copyBuf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
        const audioBuf = await actx.decodeAudioData(copyBuf);
        actx.close?.();
        const channels = Math.min(2, audioBuf.numberOfChannels);
        const chans = Array.from({ length: channels }, (_, c) => audioBuf.getChannelData(c));
        decoded = {
          channels: chans,
          rate: audioBuf.sampleRate,
          frames: audioBuf.length,
          root: 60,
          loop: null,
        };
      } catch {
        throw err;
      }
    } else {
      throw err;
    }
  }

  onProgress(0.3);
  const { channels, rate, frames, root, loop } = decoded;
  const cleanName = Array.from(name.replace(/[^\p{L}\p{N}_]+/gu, "_")).slice(0, 16).join("") || "WAV_Sample";

  // Medir pico para normalização
  let peak = 0;
  for (let ch = 0; ch < channels.length; ch++) {
    const c = channels[ch];
    for (let i = 0; i < frames; i++) {
      const v = Math.abs(c[i]);
      if (v > peak) peak = v;
    }
  }
  const gain = peak > 0 ? TARGET_PEAK / peak : 1.0;

  // Envelope: se tiver loop, sustain ativo; se não, decaimento natural longo (~3s) com release
  const gens = [
    [38, 1200], // Release ~2 segundos
  ];
  if (!loop) {
    gens.push([36, 6000]); // Decay
  }

  const zones = [{
    name: cleanName.slice(0, 12),
    channels: channels.length,
    frames,
    rate,
    root,
    keyLo: 0,
    keyHi: 127,
    velLo: 0,
    velHi: 127,
    gens,
    loop,
  }];

  onProgress(0.6);
  const { out, smpl, starts } = layoutSf2(cleanName, cleanName, zones);

  for (let ch = 0; ch < channels.length; ch++) {
    writePcm(smpl, starts[0][ch], channels[ch], frames, gain);
  }

  onProgress(1.0);
  return { name: cleanName, sf2: out };
}
