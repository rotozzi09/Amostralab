// Leitor de SoundFont 2 (.sf2) que não carrega o arquivo inteiro.
// Lê só os cabeçalhos RIFF, o INFO e o pdta (alguns KB) por File.slice; as amostras
// (sdta/smpl, centenas de MB nos pianos XL) ficam no disco até alguém pedir uma.

const GEN = {
  startAddrsOffset: 0, endAddrsOffset: 1, startloopAddrsOffset: 2, endloopAddrsOffset: 3,
  startAddrsCoarseOffset: 4, endAddrsCoarseOffset: 12, pan: 17,
  startloopAddrsCoarseOffset: 45, endloopAddrsCoarseOffset: 50,
  instrument: 41, keyRange: 43, velRange: 44, initialAttenuation: 48,
  coarseTune: 51, fineTune: 52, sampleID: 53, sampleModes: 54, overridingRootKey: 58,
};

const SAMPLE_TYPE = { 1: "mono", 2: "direito", 4: "esquerdo", 8: "linked" };

async function readBytes(file, start, length) {
  return new DataView(await file.slice(start, start + length).arrayBuffer());
}

function fourcc(view, at) {
  return String.fromCharCode(view.getUint8(at), view.getUint8(at + 1), view.getUint8(at + 2), view.getUint8(at + 3));
}

function cstr(view, at, len) {
  let s = "";
  for (let i = 0; i < len; i++) {
    const c = view.getUint8(at + i);
    if (!c) break;
    s += String.fromCharCode(c);
  }
  return s.trim();
}

// Percorre as subseções de um LIST, lendo só o cabeçalho de cada uma.
async function listChunks(file, start, end) {
  const out = {};
  let at = start;
  while (at + 8 <= end) {
    const h = await readBytes(file, at, 8);
    const id = fourcc(h, 0);
    const size = h.getUint32(4, true);
    out[id] = { offset: at + 8, size };
    at += 8 + size + (size & 1);
  }
  return out;
}

function records(view, size, fn) {
  const out = [];
  for (let at = 0; at + size <= view.byteLength; at += size) out.push(fn(view, at));
  return out;
}

function parseGens(view) {
  return records(view, 4, (v, at) => ({ oper: v.getUint16(at, true), lo: v.getUint8(at + 2), hi: v.getUint8(at + 3), amount: v.getInt16(at + 2, true) }));
}

// Zonas de um instrumento/preset: lista de {gens: Map oper→gen}, com a zona global separada.
function zonesOf(bags, gens, first, last, terminal) {
  const zones = [];
  let global = null;
  for (let b = first; b < last; b++) {
    const map = new Map();
    for (let g = bags[b]; g < bags[b + 1]; g++) map.set(gens[g].oper, gens[g]);
    if (!map.has(terminal)) {
      if (b === first) global = map;
      continue;
    }
    zones.push(map);
  }
  return { global, zones };
}

function pick(zone, global, oper) {
  return zone.get(oper) ?? global?.get(oper);
}

function range(zone, global, oper) {
  const g = pick(zone, global, oper);
  return g ? [g.lo, g.hi] : [0, 127];
}

export async function readSf2(file) {
  const head = await readBytes(file, 0, 12);
  if (fourcc(head, 0) !== "RIFF" || fourcc(head, 8) !== "sfbk") throw new Error("Não é um SoundFont 2 (RIFF/sfbk)");

  const top = {};
  let at = 12;
  while (at + 12 <= file.size) {
    const h = await readBytes(file, at, 12);
    const size = h.getUint32(4, true);
    if (fourcc(h, 0) === "LIST") top[fourcc(h, 8)] = { start: at + 12, end: at + 8 + size };
    at += 8 + size + (size & 1);
  }
  if (!top.pdta || !top.sdta) throw new Error("SF2 sem pdta/sdta");

  const info = {};
  if (top.INFO) {
    for (const [id, c] of Object.entries(await listChunks(file, top.INFO.start, top.INFO.end))) {
      const v = await readBytes(file, c.offset, c.size);
      info[id] = id === "ifil" ? `${v.getUint16(0, true)}.${v.getUint16(2, true)}` : cstr(v, 0, c.size);
    }
  }

  const sdta = await listChunks(file, top.sdta.start, top.sdta.end);
  const smpl = sdta.smpl;
  const pdta = await listChunks(file, top.pdta.start, top.pdta.end);
  const blob = await readBytes(file, top.pdta.start, top.pdta.end - top.pdta.start);
  const sub = (id) => new DataView(blob.buffer, pdta[id].offset - top.pdta.start, pdta[id].size);

  const phdr = records(sub("phdr"), 38, (v, a) => ({ name: cstr(v, a, 20), preset: v.getUint16(a + 20, true), bank: v.getUint16(a + 22, true), bag: v.getUint16(a + 24, true) }));
  const pbag = records(sub("pbag"), 4, (v, a) => v.getUint16(a, true));
  const pgen = parseGens(sub("pgen"));
  const inst = records(sub("inst"), 22, (v, a) => ({ name: cstr(v, a, 20), bag: v.getUint16(a + 20, true) }));
  const ibag = records(sub("ibag"), 4, (v, a) => v.getUint16(a, true));
  const igen = parseGens(sub("igen"));
  const shdr = records(sub("shdr"), 46, (v, a) => ({
    name: cstr(v, a, 20),
    start: v.getUint32(a + 20, true), end: v.getUint32(a + 24, true),
    loopStart: v.getUint32(a + 28, true), loopEnd: v.getUint32(a + 32, true),
    rate: v.getUint32(a + 36, true), pitch: v.getUint8(a + 40), correction: v.getInt8(a + 41),
    link: v.getUint16(a + 42, true), type: v.getUint16(a + 44, true),
  }));

  const samples = shdr.slice(0, -1).map((s, id) => ({ ...s, id, typeName: SAMPLE_TYPE[s.type & 15] ?? `tipo ${s.type}`, rom: !!(s.type & 0x8000) }));

  const instruments = inst.slice(0, -1).map((ins, i) => {
    const { global, zones } = zonesOf(ibag, igen, ins.bag, inst[i + 1].bag, GEN.sampleID);
    return {
      name: ins.name,
      zones: zones.map((z) => {
        const sample = samples[z.get(GEN.sampleID).amount];
        const root = pick(z, global, GEN.overridingRootKey);
        const off = (fine, coarse) => (pick(z, global, fine)?.amount ?? 0) + 32768 * (pick(z, global, coarse)?.amount ?? 0);
        const loopStart = sample.loopStart + off(GEN.startloopAddrsOffset, GEN.startloopAddrsCoarseOffset);
        const loopEnd = sample.loopEnd + off(GEN.endloopAddrsOffset, GEN.endloopAddrsCoarseOffset);
        const modes = pick(z, global, GEN.sampleModes)?.amount ?? 0;
        return {
          key: range(z, global, GEN.keyRange),
          vel: range(z, global, GEN.velRange),
          root: root && root.amount >= 0 ? root.amount : sample.pitch,
          tune: (pick(z, global, GEN.coarseTune)?.amount ?? 0) * 100 + (pick(z, global, GEN.fineTune)?.amount ?? 0) + sample.correction,
          attenuation: (pick(z, global, GEN.initialAttenuation)?.amount ?? 0) / 10,
          pan: (pick(z, global, GEN.pan)?.amount ?? 0) / 10,
          loops: (modes & 3) === 1 || (modes & 3) === 3,
          loopStart, loopEnd,
          sample,
        };
      }),
    };
  });

  const presets = phdr.slice(0, -1).map((p, i) => {
    const { zones } = zonesOf(pbag, pgen, p.bag, phdr[i + 1].bag, GEN.instrument);
    return { ...p, instruments: zones.map((z) => instruments[z.get(GEN.instrument).amount]) };
  }).sort((a, b) => a.bank - b.bank || a.preset - b.preset);

  return { file, info, presets, instruments, samples, smpl };
}

// Zonas que tocam numa tecla/velocity (para acender no mapa).
export function zonesAt(preset, key, vel) {
  return preset.instruments.flatMap((ins) => ins.zones).filter((z) => key >= z.key[0] && key <= z.key[1] && vel >= z.vel[0] && vel <= z.vel[1]);
}

// PCM 16 bits de uma amostra, lido direto do arquivo (só aquele trecho).
export async function readSample(sf, sample, from = sample.start, to = sample.end) {
  const a = Math.max(sample.start, from), b = Math.min(sample.end, to);
  const buf = await sf.file.slice(sf.smpl.offset + a * 2, sf.smpl.offset + b * 2).arrayBuffer();
  return new Int16Array(buf);
}

// Salto na emenda do loop, em relação à inclinação típica perto dela (1 ≈ emenda limpa).
export async function loopSeam(sf, zone) {
  const { sample, loopStart, loopEnd } = zone;
  if (!zone.loops || loopEnd <= loopStart) return null;
  const tail = await readSample(sf, sample, loopEnd - 32, loopEnd);
  const head = await readSample(sf, sample, loopStart, loopStart + 32);
  if (tail.length < 32 || head.length < 32) return null;
  let slope = 0;
  for (let i = 1; i < 32; i++) slope += Math.abs(tail[i] - tail[i - 1]) + Math.abs(head[i] - head[i - 1]);
  slope /= 62;
  const jump = Math.abs(head[0] - tail[31]);
  return { jump, slope, ratio: jump / Math.max(1, slope), length: loopEnd - loopStart };
}

const NOTES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
export const noteName = (n) => `${NOTES[n % 12]}${Math.floor(n / 12) - 1}`;