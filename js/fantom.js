// Converte pacotes multisample do Roland Fantom (.svz, ZEN-Core) para SoundFont (.sf2) no
// navegador, sem servidor. O formato está em amostralab/documentacao/roland-fantom-svz.md;
// os offsets do tom seguem converter/svz_writer.py, mas relativos a cada tom do PATa.
//
// O que vira SF2: os partials ligados que tocam um multisample do próprio arquivo, cada um
// com sua faixa de teclas e de velocity. Partials que usam ondas da ROM do teclado ficam de fora
// (não estão no arquivo) e são listados em `skipped`.

import { layoutSf2 } from "./nord.js";

const TONE_SIZE = 1632;
const PARTIALS = 4;
const P_SWITCH = 0x98; // u32, +12 por partial: partial ligado
const P_KEYS = 0x9c;   // lo, hi
const P_VELS = 0xa0;   // lo, hi
const P_WAVE = 0xe0;   // +0x7C por partial: grupo u16, multisample L u16, R u16
const P_STRIDE = 0x7c;
// Grupos de onda que apontam para os multisamples do arquivo. 8 nos .svz do Fantom (KY019),
// 0 nos gravados por firmwares MI09x; 11001 aparece nas camadas de "falls" exportadas junto.
const USER_GROUPS = new Set([0, 8, 11001]);
const RELEASE = 0.6; // s; o envelope do tom (TVA) ainda não foi decifrado

function cstr(bytes, at, len) {
  let s = "";
  for (let i = 0; i < len; i++) {
    const c = bytes[at + i];
    if (!c) break;
    s += c < 128 ? String.fromCharCode(c) : "�";
  }
  return s.trim();
}

function ticker(onProgress) {
  let last = Date.now();
  return async (fraction) => {
    if (Date.now() - last < 30) return;
    if (onProgress) onProgress(Math.min(1, Math.max(0, fraction)));
    await new Promise((r) => setTimeout(r, 0));
    last = Date.now();
  };
}

export function isFantomFile(bytes) {
  return !!bytes && bytes.length >= 0x60 && String.fromCharCode(...bytes.subarray(0, 4)) === "SVZa";
}

// TOC: 5 entradas de 16 bytes em 0x10 (tag, 'ZCOR', offset, tamanho).
function toc(dv, bytes) {
  const t = {};
  for (let i = 0; i < 5; i++) {
    const o = 0x10 + 16 * i;
    t[String.fromCharCode(...bytes.subarray(o, o + 4))] = { off: dv.getUint32(o + 8, true), size: dv.getUint32(o + 12, true) };
  }
  for (const tag of ["PATa", "USPa", "MSPa", "USDa"]) if (!t[tag]) throw new Error(`.svz sem a seção ${tag}`);
  return t;
}

// Cabeçalho comum das tabelas: [quantidade, tamanho da entrada, início das entradas, 0].
const table = (dv, off) => ({ count: dv.getUint32(off, true), size: dv.getUint32(off + 4, true), first: off + dv.getUint32(off + 8, true) });

/**
 * Lê só a estrutura (tons, multisamples, samples), sem PCM. Basta o começo do arquivo até
 * o fim da tabela do USDa; com o arquivo inteiro também lê o cabeçalho de cada SMPd.
 */
export function readSvz(bytes) {
  if (bytes instanceof ArrayBuffer) bytes = new Uint8Array(bytes);
  if (!isFantomFile(bytes)) throw new Error("Não é um .svz do Fantom");
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const t = toc(dv, bytes);

  const usp = table(dv, t.USPa.off);
  const samples = [];
  for (let i = 0; i < usp.count; i++) {
    const e = usp.first + 64 * i;
    // Pontos da edição de sample do Fantom, em frames a partir do início do PCM. Modo de loop no
    // byte 20: 0 = loop para frente, 1 = one-shot (o SVZ Sample Converter grava 0 quando o SF2 tem loop).
    samples.push({
      name: cstr(bytes, e, 16), root: bytes[e + 25], loopMode: bytes[e + 20],
      start: dv.getUint32(e + 28, true), loopStart: dv.getUint32(e + 32, true), end: dv.getUint32(e + 36, true),
    });
  }

  const msp = table(dv, t.MSPa.off);
  const multisamples = [];
  for (let k = 0; k < msp.count; k++) {
    const b = msp.first + msp.size * k;
    const keys = new Array(128);
    for (let key = 0; key < 128; key++) keys[key] = dv.getUint16(b + 16 + 8 * key, true); // 1-based; 0 = vazio
    multisamples.push({ name: cstr(bytes, b, 16), keys });
  }

  const pat = table(dv, t.PATa.off);
  if (pat.size !== TONE_SIZE) throw new Error(`Tom do .svz com ${pat.size} bytes (esperado ${TONE_SIZE})`);
  const tones = [];
  for (let n = 0; n < pat.count; n++) {
    const b = pat.first + TONE_SIZE * n;
    const partials = [];
    for (let i = 0; i < PARTIALS; i++) {
      const w = b + P_WAVE + P_STRIDE * i;
      const p = {
        on: dv.getUint32(b + P_SWITCH + 12 * i, true) !== 0,
        keyLo: bytes[b + P_KEYS + 12 * i], keyHi: bytes[b + P_KEYS + 12 * i + 1],
        velLo: bytes[b + P_VELS + 12 * i], velHi: bytes[b + P_VELS + 12 * i + 1],
        group: dv.getUint16(w, true), waveL: dv.getUint16(w + 2, true), waveR: dv.getUint16(w + 4, true),
      };
      const inFile = (m) => m >= 1 && m <= multisamples.length;
      p.user = USER_GROUPS.has(p.group) && inFile(p.waveL);
      if (!p.user || !inFile(p.waveR)) p.waveR = 0;
      partials.push(p);
    }
    tones.push({ index: n, name: cstr(bytes, b, 16), partials, playable: partials.some((p) => p.on && p.user) });
  }

  // USDa: [n, 0, início, 0] + n × (índice, offset relativo ao USDa, tamanho do bloco, id).
  const usd = t.USDa.off;
  const n = usd + 16 <= bytes.length ? dv.getUint32(usd, true) : 0;
  for (let i = 0; i < Math.min(n, samples.length) && usd + 32 + 16 * i <= bytes.length; i++) {
    const at = usd + dv.getUint32(usd + 16 + 16 * i + 4, true);
    samples[i].at = at;
    if (at + 96 > bytes.length) continue;
    if (String.fromCharCode(...bytes.subarray(at, at + 4)) !== "SMPd") throw new Error(`Sample ${i + 1} do .svz sem cabeçalho SMPd`);
    // u32@4 = frames × 2 sempre; o último dígito das flags é o nº de canais (1 mono, 2 estéreo).
    const flags = dv.getUint32(at + 8, true);
    samples[i].channels = (flags & 0xf) === 1 ? 1 : 2;
    const total = dv.getUint32(at + 4, true) >>> 1;
    samples[i].rate = dv.getUint32(at + 12, true) || 44100;
    // Toca de Start a End (End = fim do loop); sem pontos válidos, o PCM inteiro.
    const s = samples[i];
    const end = s.end > s.start && s.end <= total ? s.end : total;
    s.offset = s.start < end ? s.start : 0;
    s.frames = end - s.offset;
    s.loop = s.loopMode === 0 && s.loopStart >= s.offset && end - s.loopStart >= 8 ? [s.loopStart - s.offset, s.frames] : null;
  }
  return { tones, multisamples, samples };
}

/** Tons de um .svz (File/Blob) lendo só o começo do arquivo: [{index, name, playable}]. */
export async function listSvzTones(file) {
  const head = new Uint8Array(await file.slice(0, 0x60).arrayBuffer());
  if (!isFantomFile(head)) throw new Error("Não é um .svz do Fantom");
  const t = toc(new DataView(head.buffer), head);
  const bytes = new Uint8Array(await file.slice(0, t.USDa.off).arrayBuffer());
  return readSvz(bytes).tones.map(({ index, name, playable }) => ({ index, name, playable }));
}

function timecents(seconds) {
  return Math.round(1200 * Math.log2(seconds));
}

// Zonas de um tom: em cada partial, as teclas seguidas que usam o mesmo sample viram uma zona.
function toneZones(svz, tone) {
  const zones = [];
  const skipped = [];
  tone.partials.forEach((p, i) => {
    if (!p.on) return;
    if (!p.user) {
      const why = USER_GROUPS.has(p.group) ? "multisample do teclado que não veio no arquivo" : "onda da ROM do teclado";
      skipped.push(`P${i + 1}: ${why} (grupo ${p.group}, nº ${p.waveL})`);
      return;
    }
    const sides = p.waveR ? [[p.waveL, -500], [p.waveR, 500]] : [[p.waveL, 0]];
    for (const [ms, pan] of sides) {
      const keys = svz.multisamples[ms - 1].keys;
      for (let key = p.keyLo; key <= p.keyHi; key++) {
        const idx = keys[key];
        if (!idx || idx > svz.samples.length) continue;
        let hi = key;
        while (hi < p.keyHi && keys[hi + 1] === idx) hi++;
        const s = svz.samples[idx - 1];
        const gens = [[38, timecents(RELEASE)]];
        if (pan && s.channels === 1) gens.push([17, pan]);
        zones.push({
          name: s.name || `Smp${idx}`, channels: s.channels, frames: s.frames, rate: s.rate, root: s.root,
          keyLo: key, keyHi: hi, velLo: Math.max(0, p.velLo), velHi: p.velHi, gens, loop: s.loop,
          sample: pan && s.channels === 1 ? `${idx}:${pan}` : idx, src: s,
        });
        key = hi;
      }
    }
  });
  return { zones, skipped };
}

/**
 * Converte um tom do .svz em SF2 (preset 0). `tone` = índice no PATa; por omissão o primeiro
 * que toca algum multisample do arquivo.
 */
export async function fantomToSf2(bytes, { tone, name, onProgress } = {}) {
  if (bytes instanceof ArrayBuffer) bytes = new Uint8Array(bytes);
  const svz = readSvz(bytes);
  const tick = ticker(onProgress);
  const t = tone !== undefined ? svz.tones[tone] : svz.tones.find((x) => x.playable);
  if (!t || !t.playable) throw new Error("Este .svz não tem um tom que use os multisamples do arquivo");
  const { zones, skipped } = toneZones(svz, t);
  if (!zones.length) throw new Error("Os partials do tom não cobrem nenhuma tecla");
  const title = name || t.name || "Fantom";
  const { out, smpl, starts } = layoutSf2(title, title, zones);

  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const done = new Set();
  for (let z = 0; z < zones.length; z++) {
    if (done.has(zones[z].sample)) continue;
    done.add(zones[z].sample);
    const s = zones[z].src;
    const pcm = s.at + 96 + s.offset * s.channels * 2;
    if (pcm + s.frames * s.channels * 2 > bytes.length) throw new Error(`Sample "${s.name}" cortado: o arquivo está incompleto`);
    for (let ch = 0; ch < s.channels; ch++) {
      const dst = starts[z][ch];
      for (let f = 0, src = pcm + 2 * ch; f < s.frames; f++, src += 2 * s.channels) smpl[dst + f] = dv.getInt16(src, true);
    }
    await tick((z + 1) / zones.length);
  }
  if (onProgress) onProgress(1);
  return { name: title, sf2: out, kind: "svz", tone: t.index, skipped };
}