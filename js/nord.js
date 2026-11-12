// Converte arquivos Nord para SoundFont (.sf2) no navegador, sem servidor.
// Porte de converter/npno_to_sf2.py (pianos .npno, Piano Library v5 e v6) e
// converter/nord_to_sf2.py (amostras .nsmp4) do AmostraLab; o SF2 segue o
// write_sf2_bank de converter/svz_to_sf2.py. Só o preset 0 (som principal).
//
// Memória: duas passadas como no Python (mede, depois grava). O PCM vai direto
// para um único Uint8Array já com o tamanho final do SF2.

// -------------------- comum --------------------

const TARGET_PEAK = 29000;

function ascii(bytes, at, len) {
  let s = "";
  for (let i = 0; i < len; i++) s += String.fromCharCode(bytes[at + i]);
  return s;
}

// Texto C até o primeiro zero; bytes fora do ASCII viram U+FFFD (decode "replace").
function cstr(bytes, at, len) {
  let s = "";
  for (let i = 0; i < len; i++) {
    const c = bytes[at + i];
    if (!c) break;
    s += c < 128 ? String.fromCharCode(c) : "�";
  }
  return s.trim();
}

// Arredonda meio para o par, como round()/np.rint do Python.
function rint(x) {
  const r = Math.round(x);
  return r - x === 0.5 && r & 1 ? r - 1 : r;
}

function median(values) {
  const v = values.slice().sort((a, b) => a - b);
  const m = v.length >> 1;
  return v.length & 1 ? v[m] : (v[m - 1] + v[m]) / 2;
}

// Soma em pares do numpy (np.add.reduce em float64), para medir igual ao Python.
function pairwiseSum(a, off, n) {
  if (n < 8) {
    let res = -0.0;
    for (let i = 0; i < n; i++) res += a[off + i];
    return res;
  }
  if (n <= 128) {
    let r0 = a[off], r1 = a[off + 1], r2 = a[off + 2], r3 = a[off + 3];
    let r4 = a[off + 4], r5 = a[off + 5], r6 = a[off + 6], r7 = a[off + 7];
    let i = 8;
    for (; i < n - (n % 8); i += 8) {
      r0 += a[off + i]; r1 += a[off + i + 1]; r2 += a[off + i + 2]; r3 += a[off + i + 3];
      r4 += a[off + i + 4]; r5 += a[off + i + 5]; r6 += a[off + i + 6]; r7 += a[off + i + 7];
    }
    let res = ((r0 + r1) + (r2 + r3)) + ((r4 + r5) + (r6 + r7));
    for (; i < n; i++) res += a[off + i];
    return res;
  }
  let n2 = Math.floor(n / 2);
  n2 -= n2 % 8;
  return pairwiseSum(a, off, n2) + pairwiseSum(a, off + n2, n - n2);
}

// Devolve o controle ao navegador de tempos em tempos e informa o progresso (0..1).
function ticker(onProgress) {
  let last = Date.now();
  return async (fraction) => {
    if (Date.now() - last < 30) return;
    if (onProgress) onProgress(Math.min(1, Math.max(0, fraction)));
    await new Promise((r) => setTimeout(r, 0));
    last = Date.now();
  };
}

// CRC-32 (zlib), fatiado de 8 em 8 bytes.
let CRC_T = null;
function crcTables() {
  if (CRC_T) return CRC_T;
  const t = new Uint32Array(8 * 256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  for (let n = 0; n < 256; n++) {
    for (let k = 1; k < 8; k++) t[k * 256 + n] = (t[(k - 1) * 256 + n] >>> 8) ^ t[t[(k - 1) * 256 + n] & 255];
  }
  return (CRC_T = t);
}

function crc32Update(crc, d, start, end) {
  const T = crcTables();
  let c = ~crc;
  let i = start;
  for (; end - i >= 8; i += 8) {
    c ^= d[i] | (d[i + 1] << 8) | (d[i + 2] << 16) | (d[i + 3] << 24);
    c = T[1792 + (c & 255)] ^ T[1536 + ((c >>> 8) & 255)] ^ T[1280 + ((c >>> 16) & 255)] ^ T[1024 + (c >>> 24)]
      ^ T[768 + d[i + 4]] ^ T[512 + d[i + 5]] ^ T[256 + d[i + 6]] ^ T[d[i + 7]];
  }
  for (; i < end; i++) c = T[(c ^ d[i]) & 255] ^ (c >>> 8);
  return ~c >>> 0;
}

/** Tipo do arquivo Nord pelo cabeçalho CBIN: "npno", "nsmp" ou null. */
export function isNordFile(bytes) {
  if (!bytes || bytes.length < 12 || ascii(bytes, 0, 4) !== "CBIN") return null;
  const kind = ascii(bytes, 8, 4);
  if (kind === "npno") return "npno";
  if (kind === "nsmp" || kind === "nsm3" || kind === "nsm4") return "nsmp";
  return null;
}

// -------------------- SF2 --------------------

class Bytes {
  constructor() { this.a = []; }
  u8(v) { this.a.push(v & 255); return this; }
  i8(v) { return this.u8(v); }
  u16(v) { this.a.push(v & 255, (v >>> 8) & 255); return this; }
  u32(v) { this.a.push(v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255); return this; }
  str(s) { for (let i = 0; i < s.length; i++) this.a.push(s.charCodeAt(i)); return this; }
  bytes(b) { for (let i = 0; i < b.length; i++) this.a.push(b[i]); return this; }
  get length() { return this.a.length; }
}

// Texto em ASCII com "?" no lugar do que não for ASCII (encode "replace").
function asciiBytes(s) {
  return Array.from(s, (ch) => (ch.codePointAt(0) < 128 ? ch.codePointAt(0) : 63));
}

function name20(s) {
  const b = asciiBytes(s).slice(0, 20);
  while (b.length < 20) b.push(0);
  return b;
}

function chunk(tag, payload) {
  const w = new Bytes().str(tag).u32(payload.length).bytes(payload);
  if (payload.length % 2) w.u8(0);
  return w.a;
}

function listChunk(type, payload) {
  return new Bytes().str("LIST").u32(4 + payload.length).str(type).bytes(payload).a;
}

// Strings do INFO: terminadas em zero e com tamanho par já contado no chunk (spec SF2).
function zstr(text) {
  const raw = asciiBytes(text).slice(0, 255);
  raw.push(0);
  if (raw.length % 2) raw.push(0);
  return raw;
}

const PAD = 46; // amostras de silêncio depois de cada sample

/**
 * Monta o SF2 (um instrumento, preset 0) com o smpl ainda vazio.
 * Zona: {name, channels, frames, rate, root, keyLo, keyHi, velLo, velHi, gens, loop, sample}.
 * `sample` (opcional): zonas com o mesmo valor usam o mesmo PCM, gravado uma vez só.
 * Devolve o arquivo e, por zona, onde começa o PCM de cada canal (Int16Array `smpl`).
 */
export function layoutSf2(bankName, instName, zones) {
  const shdr = [];
  const bags = [];
  const starts = [];
  const shared = new Map(); // sample → índices no shdr
  let pos = 0; // em amostras dentro do smpl

  const appendMono = (name, frames, rate, root, type, link, loop) => {
    const start = pos;
    pos += frames + PAD;
    const [ls, le] = loop ? [start + loop[0], start + loop[1]] : [start, start + 1];
    shdr.push({ name, start, end: pos, ls, le, rate, root, link, type });
    return shdr.length - 1;
  };

  for (const z of zones) {
    const base = Array.from(z.name.replace(/[^\p{L}\p{N}_]+/gu, "_")).slice(0, 12).join("") || "smp";
    const range = [[43, (z.keyHi << 8) | z.keyLo], [44, (z.velHi << 8) | z.velLo]];
    // Geradores extras da zona (envelope) e, com loop, sampleModes = 1.
    const mode = (z.gens || []).slice();
    if (z.loop) mode.push([54, 1]);
    // Ordem exigida pelo SF2: keyRange, velRange, ... e sampleID por último.
    const reuse = z.sample !== undefined ? shared.get(z.sample) : undefined;
    if (z.channels === 1) {
      const si = reuse ? reuse[0] : appendMono(Array.from(base).slice(0, 20).join(""), z.frames, z.rate, z.root, 1, 0, z.loop);
      if (z.sample !== undefined) shared.set(z.sample, [si]);
      bags.push([...range, ...mode, [53, si]]);
      starts.push([shdr[si].start]);
    } else {
      const [li, ri] = reuse || [
        appendMono(`${base}_L`, z.frames, z.rate, z.root, 4, 0, z.loop),
        appendMono(`${base}_R`, z.frames, z.rate, z.root, 2, 0, z.loop),
      ];
      if (z.sample !== undefined) shared.set(z.sample, [li, ri]);
      shdr[li].link = ri;
      shdr[ri].link = li;
      for (const [si, pan] of [[li, -500], [ri, 500]]) bags.push([...range, [17, pan & 0xffff], ...mode, [53, si]]);
      starts.push([shdr[li].start, shdr[ri].start]);
    }
  }
  shdr.push({ name: "EOS", start: 0, end: 0, ls: 0, le: 0, rate: 44100, root: 60, link: 0, type: 0 });

  const igen = new Bytes();
  const ibag = new Bytes();
  for (const gens of bags) {
    ibag.u16(igen.length / 4).u16(0);
    for (const [op, amount] of gens) igen.u16(op).u16(amount & 0xffff);
  }
  ibag.u16(igen.length / 4).u16(0);
  igen.u16(0).u16(0);

  // instName null = banco sem instrumento (grupo sem zonas, como no Python).
  const instruments = instName === null ? [] : [{ name: instName }];
  const inst = new Bytes();
  const pgen = new Bytes();
  const pbag = new Bytes();
  const phdr = new Bytes();
  instruments.forEach((ins, i) => {
    const nm = Array.from(ins.name || bankName || "Instrument").slice(0, 20).join("");
    inst.bytes(name20(nm)).u16(0);
    phdr.bytes(name20(nm)).u16(0).u16(0).u16(i).u32(0).u32(0).u32(0);
    pbag.u16(pgen.length / 4).u16(0);
    pgen.u16(41).u16(i);
  });
  inst.bytes(name20("EOI")).u16(ibag.length / 4 - 1);
  phdr.bytes(name20("EOP")).u16(0).u16(0).u16(instruments.length).u32(0).u32(0).u32(0);
  pbag.u16(pgen.length / 4).u16(0);
  pgen.u16(0).u16(0);
  const zeros10 = new Array(10).fill(0);

  const sh = new Bytes();
  for (const r of shdr) {
    sh.bytes(name20(r.name)).u32(r.start).u32(r.end).u32(r.ls).u32(r.le).u32(r.rate)
      .u8(r.root).i8(0).u16(r.link).u16(r.type);
  }

  const info = [
    ...chunk("ifil", new Bytes().u16(2).u16(1).a),
    ...chunk("isng", zstr("EMU8000")),
    ...chunk("INAM", zstr(bankName || "Converted")),
    ...chunk("ICRD", zstr("2026")),
    ...chunk("ISFT", zstr("AmostraLab")),
  ];
  const pdta = [
    ...chunk("phdr", phdr.a), ...chunk("pbag", pbag.a), ...chunk("pmod", zeros10), ...chunk("pgen", pgen.a),
    ...chunk("inst", inst.a), ...chunk("ibag", ibag.a), ...chunk("imod", zeros10), ...chunk("igen", igen.a),
    ...chunk("shdr", sh.a),
  ];
  const infoList = listChunk("INFO", info);
  const pdtaList = listChunk("pdta", pdta);
  const smplSize = pos * 2; // sempre par
  const sdtaHead = new Bytes().str("LIST").u32(4 + 8 + smplSize).str("sdta").str("smpl").u32(smplSize).a;
  const riffSize = 4 + infoList.length + sdtaHead.length + smplSize + pdtaList.length;

  const out = new Uint8Array(8 + riffSize);
  const head = new Bytes().str("RIFF").u32(riffSize).str("sfbk").bytes(infoList).bytes(sdtaHead).a;
  out.set(head, 0);
  const smplAt = head.length; // par: todos os chunks têm tamanho par
  out.set(pdtaList, smplAt + smplSize);
  // PCM de 16 bits little-endian: a vista Int16Array assume plataforma LE (todas as atuais).
  const smpl = new Int16Array(out.buffer, out.byteOffset + smplAt, pos);
  return { out, smpl, starts };
}

// Grava canais inteiros em PCM 16 bits com ganho, arredondando como o np.rint.
export function writePcm(smpl, at, src, frames, scale) {
  for (let i = 0; i < frames; i++) {
    const x = src[i] * scale;
    let r = Math.round(x);
    if (r - x === 0.5 && r & 1) r -= 1;
    smpl[at + i] = r > 32767 ? 32767 : r < -32768 ? -32768 : r;
  }
}

if (new Uint8Array(new Uint16Array([1]).buffer)[0] !== 1) {
  throw new Error("nord.js precisa de plataforma little-endian");
}

// -------------------- .npno (pianos) --------------------

const CNSP = 0x2c;
const RECORD = 0x76;
const RATE = 44100;
const OVERLAP = 64;
const HISTORY = 4;
// As gravações soam 4 semitons acima da raiz do mapa quando tocadas a 44,1 kHz.
const ROOT_OFFSET = 4;
// Dentro do loop o instrumento multiplica o nível pelo fator de +0x2E 22.050 vezes por segundo.
const ENVELOPE_RATE = 22050;
// Soltar a tecla: abafado onde o piano grava som de release, longo onde não grava.
const RELEASE_DAMPED = 0.3;
const RELEASE_UNDAMPED = 1.5;
// Janela de medição do volume: o ataque (20 a 200 ms).
const MEASURE = [Math.trunc(0.02 * RATE), Math.trunc(0.2 * RATE)];
const LEVEL_MIN_DB = 3;
const NEIGHBORS = 6;

// Confere tamanho mínimo e formato do arquivo .npno; tolera variações de checksum.
async function checkFile(data, tick) {
  if (data.length <= 0x2c) throw new Error("Arquivo .npno corrompido ou incompleto: tamanho insuficiente.");
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let crc = 0;
  const step = 16 << 20;
  for (let at = 0x2c; at < data.length; at += step) {
    crc = crc32Update(crc, data, at, Math.min(data.length, at + step));
    await tick(0.05 * (at / data.length));
  }
  const expLE = dv.getUint32(0x18, true);
  const expBE = dv.getUint32(0x18, false);
  if (crc !== expLE && crc !== expBE) {
    console.warn(`[Nord] Checksum do .npno (0x${crc.toString(16)}) não coincide com o cabeçalho (LE: 0x${expLE.toString(16)}, BE: 0x${expBE.toString(16)}). Prosseguindo com a leitura do arquivo...`);
  }
  const version = dv.getUint32(0x14, true);
  const versionBE = dv.getUint32(0x14, false);
  const validVer = (version >= 500 && version < 700) || (versionBE >= 500 && versionBE < 700);
  if (!validVer) {
    console.warn(`[Nord] Versão do cabeçalho (${version} / ${versionBE}) fora de v5..v6. Prosseguindo com a leitura dos blocos...`);
  }
}

function readIndex(data) {
  if (ascii(data, 0, 4) !== "CBIN" || ascii(data, 8, 4) !== "npno") {
    throw new Error("Não é um piano Nord .npno (CBIN/npno)");
  }
  let cnsp = CNSP;
  if (ascii(data, cnsp, 4) !== "CNSP") {
    for (let o = 12; o < Math.min(data.length - 4, 512); o++) {
      if (ascii(data, o, 4) === "CNSP") {
        cnsp = o;
        break;
      }
    }
  }
  if (ascii(data, cnsp, 4) !== "CNSP") {
    throw new Error("Arquivo .npno não contém o bloco CNSP de amostras de piano");
  }
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const version = dv.getUint16(cnsp + 0x61c);
  const channels = dv.getUint16(cnsp + 0x61e);
  const count = dv.getUint16(cnsp + 0x620);
  if ((channels !== 1 && channels !== 2) || !count) {
    throw new Error(`Cabeçalho .npno inesperado (versão 0x${version.toString(16)}, ${channels} canais)`);
  }
  const perRoot = [];
  for (let r = 0; r < 128; r++) perRoot.push(dv.getUint16(cnsp + 0x622 + 2 * r));
  if (perRoot.reduce((a, b) => a + b, 0) !== count) throw new Error("Tabela de strokes do .npno inconsistente");
  const keymap = Array.from(data.subarray(cnsp + 0x8c, cnsp + 0x8c + 128));
  // "Astoria Grand#Stw O     XL": nome, modelo gravado e tamanho da versão.
  const text = cstr(data, cnsp + 0x1c, 0x24);
  const hash = text.indexOf("#");
  const title = hash < 0 ? text : text.slice(0, hash);
  const rest = (hash < 0 ? "" : text.slice(hash + 1)).split(/\s+/).filter(Boolean);
  const name = title.trim() || "Nord Piano";
  const variant = rest.length ? rest[rest.length - 1] : "";

  const blockWords = 511 * channels;
  // A curva de velocity conta em passos de 0,2 dB. O byte da v6 já vem assim;
  // o da v5 (fluxo 0x450) vale 1 dB.
  const floorStep = version >= 0x464 ? 1 : 5;
  const strokes = [];
  let i = 0;
  for (let root = 0; root < 128; root++) {
    for (let k = 0; k < perRoot[root]; k++) {
      const at = cnsp + 0x732 + i * RECORD;
      const off = dv.getUint32(at);
      const blocks = dv.getUint16(at + 0x0a);
      // Histórico inicial: 4 × i16 do mais antigo ao mais recente; guardado do mais recente primeiro.
      const history = [0x0c, 0x14].slice(0, channels).map((h) => [3, 2, 1, 0].map((j) => dv.getInt16(at + h + 2 * j)));
      const loopStart = dv.getUint32(at + 0x1c);
      const loopLen = dv.getUint32(at + 0x20);
      const loopDecay = dv.getUint32(at + 0x2e) / 2 ** 23;
      const stroke = {
        index: i,
        root,
        flags: data[at + 4] & 3,
        floor: data[at + 5] * floorStep,
        offset: cnsp + off,
        frames: dv.getUint32(at + 6),
        blocks,
        history,
        loop: loopLen ? [loopStart, loopLen] : null,
        loopDecay: loopLen && loopDecay > 0 && loopDecay < 1 ? loopDecay : null,
      };
      if (stroke.offset + blocks * blockWords * 2 > data.length) throw new Error(`Stroke ${i} do .npno passa do fim do arquivo`);
      strokes.push(stroke);
      i++;
    }
  }
  return { name, variant, channels, blockWords, keymap, strokes };
}

// Decodificador com buffers reaproveitados entre strokes (nada por amostra em objetos JS).
function npnoDecoder(data, nf) {
  const { channels, blockWords } = nf;
  const maxValues = (blockWords - 1) * 16;
  const res = new Int32Array(maxValues);
  const tmp = Array.from({ length: channels }, () => new Int32Array(Math.floor(maxValues / channels) + 1));
  const expected = Array.from({ length: channels }, () => new Int32Array(OVERLAP));
  const maxFrames = nf.strokes.reduce((m, s) => Math.max(m, s.frames), 0);
  const outs = Array.from({ length: channels }, () => new Int32Array(maxFrames));
  const size = blockWords * 2;

  // Resíduos com sinal de `width` bits, LSB primeiro sobre palavras de 16 bits (BE no arquivo).
  function residuals(base, width, count) {
    let wp = base + 2;
    if (width <= 16) {
      const mask = (1 << width) - 1;
      const half = 1 << (width - 1);
      const full = 1 << width;
      let acc = 0, nb = 0;
      for (let i = 0; i < count; i++) {
        if (nb < width) {
          acc |= ((data[wp] << 8) | data[wp + 1]) << nb;
          wp += 2;
          nb += 16;
        }
        const v = acc & mask;
        acc >>>= width;
        nb -= width;
        res[i] = v >= half ? v - full : v;
      }
    } else {
      const half = 2 ** (width - 1);
      const full = 2 ** width;
      let acc = 0, nb = 0;
      for (let i = 0; i < count; i++) {
        while (nb < width) {
          acc += ((data[wp] << 8) | data[wp + 1]) * 2 ** nb;
          wp += 2;
          nb += 16;
        }
        const v = acc % full;
        acc = (acc - v) / full;
        nb -= width;
        res[i] = v >= half ? v - full : v;
      }
    }
  }

  // Preditor binomial de ordem `order`: N somas acumuladas partindo das diferenças do histórico.
  function integrate(ch, n, order, hist, dst) {
    let h0 = hist[0], h1 = hist[1], h2 = hist[2], h3 = hist[3];
    const s = [0, 0, 0, 0];
    for (let k = 0; k < order; k++) {
      s[k] = h0;
      h0 -= h1; h1 -= h2; h2 -= h3;
    }
    const st = channels;
    let a0 = s[0], a1 = s[1], a2 = s[2], a3 = s[3];
    switch (order) {
      case 0: for (let i = 0, j = ch; i < n; i++, j += st) dst[i] = res[j]; break;
      case 1: for (let i = 0, j = ch; i < n; i++, j += st) { a0 += res[j]; dst[i] = a0; } break;
      case 2: for (let i = 0, j = ch; i < n; i++, j += st) { a1 += res[j]; a0 += a1; dst[i] = a0; } break;
      case 3: for (let i = 0, j = ch; i < n; i++, j += st) { a2 += res[j]; a1 += a2; a0 += a1; dst[i] = a0; } break;
      default: for (let i = 0, j = ch; i < n; i++, j += st) { a3 += res[j]; a2 += a3; a1 += a2; a0 += a1; dst[i] = a0; }
    }
  }

  /**
   * Decodifica um stroke em `outs` e confere cada emenda de blocos: os 64 frames de
   * sobreposição têm de ser iguais aos 64 primeiros do bloco seguinte.
   */
  function decode(stroke) {
    const hist = stroke.history.map((h) => h.slice());
    let hasExpected = false;
    let left = stroke.frames;
    let pos = 0;
    for (let b = 0; b < stroke.blocks; b++) {
      const base = stroke.offset + b * size;
      const header = (data[base] << 8) | data[base + 1];
      const width = header & 0x1f;
      const order = (header >> 5) & 7;
      if (!width || order > 4) {
        throw new Error(`Bloco ${b} do stroke ${stroke.index} com cabeçalho inválido (0x${header.toString(16)})`);
      }
      const own = Math.min(left, Math.floor(((blockWords - 1) * 16) / (width * channels)) - OVERLAP);
      const last = left === own;
      const n = last ? own : own + OVERLAP;
      residuals(base, width, n * channels);
      for (let ch = 0; ch < channels; ch++) integrate(ch, n, order, hist[ch], tmp[ch]);
      if (hasExpected) {
        const m = Math.min(OVERLAP, own);
        for (let ch = 0; ch < channels; ch++) {
          const e = expected[ch], t = tmp[ch];
          for (let i = 0; i < m; i++) {
            if (e[i] !== t[i]) throw new Error(`Stroke ${stroke.index}: a emenda do bloco ${b} não confere`);
          }
        }
      }
      hasExpected = !last;
      for (let ch = 0; ch < channels; ch++) {
        const t = tmp[ch];
        outs[ch].set(t.subarray(0, own), pos);
        if (!last) expected[ch].set(t.subarray(own, own + OVERLAP));
        const h = hist[ch];
        const k = Math.min(own, HISTORY);
        // Histórico: os últimos frames, do mais recente para o mais antigo.
        const next = [];
        for (let i = 0; i < k; i++) next.push(t[own - 1 - i]);
        for (let i = 0; next.length < HISTORY; i++) next.push(h[i]);
        hist[ch] = next;
      }
      pos += own;
      left -= own;
    }
    if (left) throw new Error(`Stroke ${stroke.index}: faltaram ${left} frames`);
    return outs;
  }

  return decode;
}

/** Velocity → atenuação em 0,2 dB (lei 40·log10(v/127)). */
function floorFromVelocity(velocity) {
  return Math.min(200.0, -200 * Math.log10(Math.max(1, Math.min(127, velocity)) / 127));
}

// Faixa de velocity de cada camada (pisos em ordem crescente); camada inalcançável → null.
function velocityRanges(floors) {
  const sw = [0];
  for (let i = 1; i < floors.length; i++) {
    const p = floors[i - 1], f = floors[i];
    sw.push(f - Math.floor((f - p) / 2));
  }
  const hits = new Map();
  for (let v = 1; v < 128; v++) {
    const att = floorFromVelocity(v);
    let layer = -1;
    sw.forEach((s, i) => { if (s <= att) layer = Math.max(layer, i); });
    if (!hits.has(layer)) hits.set(layer, []);
    hits.get(layer).push(v);
  }
  return floors.map((_, i) => {
    const vs = hits.get(i);
    return vs ? [vs.includes(1) ? 0 : Math.min(...vs), Math.max(...vs)] : null;
  });
}

function timecents(seconds) {
  return rint(1200 * Math.log2(Math.max(seconds, 0.001)));
}

// Envelope de volume da zona (35 hold, 36 decay, 37 sustain, 38 release).
function volumeEnvelope(stroke, damped) {
  let gens = [[38, timecents(damped ? RELEASE_DAMPED : RELEASE_UNDAMPED)]];
  if (stroke.loop && stroke.loopDecay) {
    const dbPerSecond = -20 * Math.log10(stroke.loopDecay) * ENVELOPE_RATE;
    if (dbPerSecond > 0.05) {
      gens = [
        [35, Math.min(5000, timecents(stroke.loop[0] / RATE))],
        [36, Math.min(8000, timecents(96 / dbPerSecond))],
        [37, 960],
        ...gens,
      ];
    }
  }
  return gens;
}

// Faixa de teclas de cada nota raiz, a partir do mapa nota → raiz do arquivo.
function keyRanges(keymap) {
  const out = new Map();
  keymap.forEach((root, key) => {
    if (root === 255) return;
    const [lo, hi] = out.get(root) || [key, key];
    out.set(root, [Math.min(lo, key), Math.max(hi, key)]);
  });
  return out;
}

// Pico e RMS (dB) de um stroke no ataque (20 a 200 ms).
const measureBuf = new Float64Array(MEASURE[1]);
function measure(chans, nch, frames) {
  let peak = 0;
  for (let ch = 0; ch < nch; ch++) {
    const c = chans[ch];
    for (let i = 0; i < frames; i++) {
      const v = c[i] < 0 ? -c[i] : c[i];
      if (v > peak) peak = v;
    }
  }
  const [a0, b0] = frames >= MEASURE[1] ? MEASURE : [0, frames];
  const n = b0 - a0;
  for (let i = 0; i < n; i++) {
    let m = 0;
    for (let ch = 0; ch < nch; ch++) m += chans[ch][a0 + i];
    m /= nch;
    measureBuf[i] = m * m;
  }
  const mean = (0 + pairwiseSum(measureBuf, 0, n)) / n;
  return { peak, rmsDb: 20 * Math.log10(Math.sqrt(mean) + 1e-9) };
}

// Ganho (dB) por raiz quando ela toda destoa das vizinhas (±6 semitons, mediana dos desvios).
function levelCorrections(strokes, meas) {
  const byRoot = new Map();
  for (const s of strokes) {
    if (!byRoot.has(s.root)) byRoot.set(s.root, []);
    byRoot.get(s.root).push(s);
  }
  const out = new Map();
  for (const [root, layers] of byRoot) {
    const others = [];
    for (const [r2, l2] of byRoot) if (r2 !== root && Math.abs(r2 - root) <= NEIGHBORS) others.push(l2);
    if (others.length < 3) continue;
    const devs = [];
    for (const s of layers) {
      const ref = others.map((l2) => {
        let best = l2[0];
        for (const x of l2) if (Math.abs(x.floor - s.floor) < Math.abs(best.floor - s.floor)) best = x;
        return meas.get(best.index).rmsDb;
      });
      devs.push(meas.get(s.index).rmsDb - median(ref));
    }
    const dev = median(devs);
    if (Math.abs(dev) > LEVEL_MIN_DB) for (const s of layers) out.set(s.index, Math.max(-12.0, Math.min(12.0, -dev)));
  }
  return out;
}

async function npnoToSf2(data, name, tick) {
  await checkFile(data, tick);
  const nf = readIndex(data);
  if (name) nf.name = name;
  if (!nf.strokes.some((s) => s.flags === 0)) throw new Error("Nenhum stroke de som principal no .npno");
  const keys = keyRanges(nf.keymap);
  // Raízes com som de release gravado são as que têm abafador.
  const damped = new Set(nf.strokes.filter((s) => s.flags === 2).map((s) => s.root));

  // Camadas do som principal que alguma velocity alcança, com a faixa de cada uma.
  const byRoot = new Map();
  for (const s of nf.strokes) {
    if (s.flags === 0 && keys.has(s.root)) {
      if (!byRoot.has(s.root)) byRoot.set(s.root, []);
      byRoot.get(s.root).push(s);
    }
  }
  const zones = [];
  for (const root of [...byRoot.keys()].sort((a, b) => a - b)) {
    const layers = byRoot.get(root).sort((a, b) => a.floor - b.floor);
    velocityRanges(layers.map((x) => x.floor)).forEach((vel, i) => {
      if (vel) zones.push({ s: layers[i], keys: keys.get(root), vel });
    });
  }
  // O SF2 guarda 20 caracteres.
  const instName = zones.length ? Array.from(nf.name).slice(0, 20).join("").trimEnd() : null;
  const decode = npnoDecoder(data, nf);
  const total = zones.reduce((t, z) => t + z.s.frames, 0) || 1;

  // 1ª passada: mede cada stroke.
  const meas = new Map();
  let done = 0;
  for (const { s } of zones) {
    meas.set(s.index, measure(decode(s), nf.channels, s.frames));
    done += s.frames;
    await tick(0.05 + 0.45 * (done / total));
  }
  const fix = levelCorrections(zones.map((z) => z.s), meas);
  // Ganho único para o banco; o pico de referência é o do banco sem os reforços.
  let peak = 0;
  for (const [i, m] of meas) {
    const p = m.peak * 10 ** (Math.min(fix.has(i) ? fix.get(i) : 0.0, 0.0) / 20);
    if (p > peak) peak = p;
  }
  peak = peak || 1;
  for (const [i, g] of fix) {
    if (g > 0) fix.set(i, Math.min(g, 20 * Math.log10(peak / Math.max(meas.get(i).peak, 1))));
  }
  const gain = TARGET_PEAK / peak;

  const sf2Zones = zones.map(({ s, keys: [keyLo, keyHi], vel: [velLo, velHi] }) => ({
    name: `${s.root}_${s.floor}`,
    channels: nf.channels,
    frames: s.frames,
    rate: RATE,
    root: Math.min(127, s.root + ROOT_OFFSET),
    keyLo, keyHi, velLo, velHi,
    gens: volumeEnvelope(s, damped.has(s.root)),
    loop: s.loop ? [s.loop[0], s.loop[0] + s.loop[1]] : null,
  }));
  const { out, smpl, starts } = layoutSf2(nf.name, instName, sf2Zones);

  // 2ª passada: decodifica de novo e grava o PCM direto no smpl.
  done = 0;
  for (let z = 0; z < zones.length; z++) {
    const s = zones[z].s;
    const chans = decode(s);
    const scale = gain * 10 ** ((fix.has(s.index) ? fix.get(s.index) : 0.0) / 20);
    for (let ch = 0; ch < nf.channels; ch++) writePcm(smpl, starts[z][ch], chans[ch], s.frames, scale);
    done += s.frames;
    await tick(0.5 + 0.5 * (done / total));
  }
  return { name: nf.name, sf2: out };
}

// -------------------- .nsmp4 (amostras) --------------------

const DEFAULT_RATE = 44100;
const BOUND = 2 ** 26; // reconstruções de 16 bits ficam bem abaixo disso

function parseSections(data) {
  const cbin = ascii(data, 0, 4);
  const tag = ascii(data, 8, 4);
  if (cbin !== "CBIN" || (tag !== "nsmp" && tag !== "nsm3" && tag !== "nsm4")) throw new Error("Não é um arquivo Nord .nsmp (CBIN/nsmp)");
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let pos = 0x3c; // CBIN 0x2c + NSMP 16
  const out = [];
  const isAlpha = (c) => (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
  while (pos + 12 <= data.length) {
    if (!(isAlpha(data[pos + 1]) && isAlpha(data[pos + 2]) && isAlpha(data[pos + 3]))) break;
    const tag = ascii(data, pos + 1, 3);
    const version = dv.getUint32(pos + 4);
    const size = dv.getUint32(pos + 8);
    if (pos + 12 + size > data.length) throw new Error(`Seção '${tag}' excede o arquivo`);
    out.push({ tag, version, payload: pos + 12, size, end: pos + 12 + size });
    pos += 12 + size;
  }
  return out;
}

// Bloco: bits 0-13 nº de amostras · 14-17 ordem · 19-22 largura-1 · 23 modo linear.
function blockHeader(word) {
  return [word & 0x3fff, (word >>> 14) & 0xf, ((word >>> 19) & 0xf) + 1, (word >>> 23) & 1];
}

// O encadeamento de blocos a partir de `start` termina num bloco de parada?
function chainReachesEnd(dv, start, end, channels, minBlocks = 3) {
  let pos = start, blocks = 0;
  while (pos + 4 <= end) {
    const [count, order, width] = blockHeader(dv.getUint32(pos));
    pos += 4;
    if (order === 0 && width === 1) return blocks >= minBlocks; // bloco de parada
    if (count === 0) continue;
    if (order > 7) return false;
    const perCh = Math.floor(count / channels);
    pos += Math.ceil((perCh * width) / 32) * channels * 4;
    blocks++;
  }
  return false;
}

// Resíduos MSB primeiro sobre o fluxo de palavras de 32 bits do canal `ch`.
function unpackResiduals(dv, pos, channels, ch, count, width, wordsPerCh, dst) {
  if (count * width > wordsPerCh * 32) throw new Error("Bloco .nsmp com resíduos além das palavras do canal");
  const half = 2 ** (width - 1), full = 2 ** width;
  const word = (k) => dv.getUint32(pos + 4 * (k * channels + ch));
  let bit = 0;
  for (let i = 0; i < count; i++, bit += width) {
    const k = bit >>> 5, off = bit & 31;
    let v;
    if (off + width <= 32) {
      v = Math.floor(word(k) / 2 ** (32 - off - width)) % full;
    } else {
      const hiBits = 32 - off, lo = width - hiBits;
      v = (word(k) % 2 ** hiBits) * 2 ** lo + Math.floor(word(k + 1) / 2 ** (32 - lo));
    }
    dst[i] = v >= half ? v - full : v;
  }
}

// Preditor polinomial fixo de ordem `order` sobre a história (mais antiga primeiro).
function predict(residual, n, order, history) {
  const out = new Float64Array(n);
  if (order === 0) {
    out.set(residual.subarray(0, n));
    return out;
  }
  let cur = Array.from(history.slice(-(order + 1)));
  const diffs = [];
  for (let k = 0; k < order; k++) {
    diffs.push(cur[cur.length - 1]);
    cur = cur.slice(1).map((v, i) => v - cur[i]);
  }
  const acc = diffs.slice();
  for (let i = 0; i < n; i++) {
    acc[order - 1] += residual[i];
    for (let k = order - 2; k >= 0; k--) acc[k] += acc[k + 1];
    out[i] = acc[0];
  }
  return out;
}

function concat(parts) {
  const out = new Float64Array(parts.reduce((t, p) => t + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

function decodeStrokeStream(dv, start, end, channels) {
  let hist = Array.from({ length: channels }, () => new Float64Array(8));
  const outs = Array.from({ length: channels }, () => []);
  let pos = start;
  while (pos + 4 <= end) {
    const [count, order, width] = blockHeader(dv.getUint32(pos));
    pos += 4;
    if (order === 0 && width === 1) break; // bloco de parada
    if (count === 0) continue;
    if (order > 7) break;
    const perCh = Math.floor(count / channels);
    const wordsPerCh = Math.ceil((perCh * width) / 32);
    if (pos + wordsPerCh * channels * 4 > end) break;
    for (let ch = 0; ch < channels; ch++) {
      const n = ch < channels - 1 ? perCh : count - perCh * (channels - 1);
      const res = new Float64Array(n);
      unpackResiduals(dv, pos, channels, ch, n, width, wordsPerCh, res);
      const sig = predict(res, n, order, hist[ch]);
      outs[ch].push(sig);
      hist[ch] = concat([hist[ch], sig]).slice(-8);
    }
    pos += wordsPerCh * channels * 4;
  }
  return outs.map(concat);
}

function absPeak(chans) {
  let peak = 0;
  for (const c of chans) for (let i = 0; i < c.length; i++) { const v = Math.abs(c[i]); if (v > peak) peak = v; }
  return peak;
}

function decodeNsmpStroke(data, dv, sec) {
  const p = sec.payload;
  const gid = dv.getUint32(p);
  const root = data[p + 5];
  const baseRate = dv.getUint16(p + 6);
  const hint = data[p + 8];
  const channelOptions = hint === 1 || hint === 2 ? [hint] : [2, 1];
  let best = null;
  // O fluxo não tem offset fixo: um stroke abre com bloco de ordem 0 em modo linear.
  for (let start = p + 0x31; start < Math.min(p + 0x260, sec.end - 4); start++) {
    const word = dv.getUint32(start);
    if (((word >>> 23) & 1) === 0 || ((word >>> 14) & 0xf) !== 0) continue;
    for (const ch of channelOptions) {
      if (!chainReachesEnd(dv, start, sec.end, ch)) continue;
      const chans = decodeStrokeStream(dv, start, sec.end, ch);
      if (!chans[0].length) continue;
      const peak = absPeak(chans);
      if (peak < BOUND && (best === null || peak < best.peak)) best = { peak, chans };
    }
    if (best && best.peak < 2 ** 14) break;
  }
  if (!best) throw new Error(`Não achei o fluxo de áudio do stroke 0x${gid.toString(16)}`);
  const rate = baseRate >= 8000 && baseRate <= 96000 ? baseRate : DEFAULT_RATE;
  return { gid, root, rate, channels: best.chans, peak: best.peak };
}

// Faixa de teclas por stroke: cada nota vai para a raiz mais próxima (pontos médios).
function tileKeyRanges(roots) {
  const order = roots.map((_, i) => i).sort((a, b) => roots[a] - roots[b]);
  const ranges = roots.map(() => [0, 127]);
  order.forEach((i, n) => {
    const lo = n === 0 ? 0 : Math.floor((roots[order[n - 1]] + roots[i]) / 2) + 1;
    const hi = n === order.length - 1 ? 127 : Math.floor((roots[i] + roots[order[n + 1]]) / 2);
    ranges[i] = [lo, Math.max(lo, hi)];
  });
  return ranges;
}

async function nsmpToSf2(data, name, tick) {
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const sections = parseSections(data);
  let nfName = "Nord Sample";
  const hdr = sections.find((s) => s.tag === "hdr");
  if (hdr) nfName = cstr(data, hdr.payload + 10, Math.max(0, Math.min(16, data.length - hdr.payload - 10))) || nfName;
  if (name) nfName = name;
  const stks = sections.filter((s) => s.tag === "stk");
  const strokes = [];
  for (let i = 0; i < stks.length; i++) {
    strokes.push(decodeNsmpStroke(data, dv, stks[i]));
    await tick(0.9 * ((i + 1) / stks.length));
  }
  if (!strokes.length) throw new Error("Nenhum stroke de áudio no arquivo");
  const ranges = tileKeyRanges(strokes.map((s) => s.root));
  const zones = strokes.map((s, i) => ({
    name: `${Array.from(nfName).slice(0, 6).join("")}_${s.root}`,
    channels: s.channels.length,
    frames: s.channels[0].length,
    rate: s.rate,
    root: s.root,
    keyLo: ranges[i][0], keyHi: ranges[i][1], velLo: 0, velHi: 127,
    gens: [],
    loop: null,
  }));
  const { out, smpl, starts } = layoutSf2(nfName, nfName, zones);
  strokes.forEach((s, z) => {
    // Os strokes vêm em escalas arbitrárias: leva cada um a ~-1 dBFS.
    const gain = s.peak ? TARGET_PEAK / s.peak : 1.0;
    s.channels.forEach((c, ch) => writePcm(smpl, starts[z][ch], c, zones[z].frames, gain));
  });
  return { name: nfName, sf2: out };
}

// -------------------- API --------------------

/**
 * Converte um piano Nord (.npno) ou amostra Nord (.nsmp4) em SF2 (preset 0).
 * `name` substitui o nome lido do arquivo (como o instrument_name do Python).
 */
export async function nordToSf2(bytes, { name, onProgress } = {}) {
  if (bytes instanceof ArrayBuffer) bytes = new Uint8Array(bytes);
  const kind = isNordFile(bytes);
  if (!kind) throw new Error("Não é um arquivo Nord (.npno / .nsmp3 / .nsmp4)");
  const tick = ticker(onProgress);
  const r = kind === "npno" ? await npnoToSf2(bytes, name, tick) : await nsmpToSf2(bytes, name, tick);
  if (onProgress) onProgress(1);
  return { ...r, kind };
}