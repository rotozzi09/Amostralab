// Grafo de áudio: barramentos das seções → Layer Effects → limitador → saída.
// Organ e Synth são Web Audio puros; o Piano é o FluidSynth (piano.js) ligado em `pianoIn` (layer A) e `pianoInB` (layer B).
// Constantes e algoritmos documentados em ../../docs/motores-web.md (o app nativo usa os mesmos).

export const ctx = new AudioContext({ latencyHint: "interactive" });

const db = (x) => Math.pow(10, x / 20);
const midiHz = (n) => 440 * Math.pow(2, (n - 69) / 12);
const SR = ctx.sampleRate;

function lfo(freq, depth, target, type = "sine") {
  const osc = new OscillatorNode(ctx, { type, frequency: freq });
  const amt = new GainNode(ctx, { gain: depth });
  osc.connect(amt).connect(target);
  osc.start();
  return { osc, amt };
}

// Ruído branco compartilhado (clique de tecla do órgão).
const noise = (() => {
  const buf = ctx.createBuffer(1, SR, SR);
  const d = buf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  return buf;
})();

const set = (param, v, tc = 0.02) => param.setTargetAtTime(v, ctx.currentTime, tc);

// ---------- Reverb: respostas ao impulso sintetizadas ----------
// Pré-delay + reflexões iniciais (taps do RoomReverb do LoopLabs/LabGuitar, espaçados pelo
// tamanho) + cauda de ruído descorrelacionado com decaimento exponencial e um passa-baixa que
// escurece ao longo da cauda (o agudo morre antes do grave). A mola tem um chirp dispersivo
// que se repete a cada ida e volta na mola, como o "boing" de um tanque de reverb.
const ER_L = [7.1, 11.3, 19.7, 23.9, 31.1, 43.3];
const ER_R = [8.3, 13.1, 17.9, 26.3, 34.7, 47.1];
const ER_G = [0.9, 0.72, 0.58, 0.44, 0.32, 0.22];

const REVERBS = {
  room: { decay: 1.1, pre: 0.008, er: 0.55, erScale: 0.7, fade: 0.01, fcStart: 9000, fcEnd: 1500 },
  stage: { decay: 1.8, pre: 0.015, er: 0.5, erScale: 1.0, fade: 0.02, fcStart: 11000, fcEnd: 1800 },
  hall: { decay: 3.0, pre: 0.028, er: 0.4, erScale: 1.6, fade: 0.04, fcStart: 10000, fcEnd: 1600 },
  plate: { decay: 2.3, pre: 0.004, er: 0, erScale: 1, fade: 0.003, fcStart: 14000, fcEnd: 4000 },
  spring: { decay: 1.7, pre: 0.003, er: 0, erScale: 1, fade: 0.004, fcStart: 4500, fcEnd: 2500, spring: true },
};

function reverbImpulse(type, size) {
  const p = REVERBS[type] ?? REVERBS.stage;
  const decay = p.decay * (0.5 + size * 1.1);
  const len = Math.floor(SR * (p.pre + decay * 1.1));
  const buf = ctx.createBuffer(2, len, SR);
  const pre = Math.floor(p.pre * SR);
  const erScale = p.erScale * (0.6 + size * 0.8);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    if (p.er) {
      (ch ? ER_R : ER_L).forEach((ms, i) => {
        const at = pre + Math.floor(((ms * erScale) / 1000) * SR);
        if (at < len) d[at] += ER_G[i] * (i % 2 ? -p.er : p.er);
      });
    }
    const tailStart = pre + Math.floor((p.er ? 0.02 * erScale : 0) * SR);
    let lp = 0;
    let hp = 0;
    for (let i = tailStart; i < len; i++) {
      const t = (i - tailStart) / SR;
      const env = Math.pow(0.001, t / decay) * Math.min(1, t / p.fade);
      const fc = p.fcEnd + (p.fcStart - p.fcEnd) * Math.exp((-t * 3) / decay);
      const a = 1 - Math.exp((-2 * Math.PI * fc) / SR);
      lp += a * (Math.random() * 2 - 1 - lp);
      let x = lp * env * 0.5;
      if (p.spring) {
        hp += 0.04 * (x - hp); // tira o grave: mola não reproduz graves
        x = (x - hp) * 0.7;
      }
      d[i] += x;
    }
    if (p.spring) {
      // Chirp descendente (5 kHz → 400 Hz em 25 ms) a cada ida e volta: 29 ms em L e 37 ms em R.
      const period = ch ? 0.037 : 0.029;
      for (let k = 0; ; k++) {
        const t0 = k * period;
        if (t0 > decay) break;
        const start = pre + Math.floor(t0 * SR);
        const amp = 0.35 * Math.pow(0.001, t0 / decay);
        let ph = 0;
        for (let j = 0; j < 0.025 * SR && start + j < len; j++) {
          const tt = j / SR;
          const f = 400 + 4600 * Math.exp(-tt / 0.006);
          ph += (2 * Math.PI * f) / SR;
          d[start + j] += Math.sin(ph) * amp * Math.exp(-tt / 0.01);
        }
      }
    }
  }
  return buf;
}

// ---------- Layer Effects (globais) ----------
const input = ctx.createGain();
const bass = new BiquadFilterNode(ctx, { type: "lowshelf", frequency: 180 });
const mid = new BiquadFilterNode(ctx, { type: "peaking", frequency: 1200, Q: 0.8 });
const treble = new BiquadFilterNode(ctx, { type: "highshelf", frequency: 4500 });
// Compressor soft-knee feed-forward (valores do VocalPrep do LabVoice).
const comp = new DynamicsCompressorNode(ctx, { threshold: 0, ratio: 1, knee: 6, attack: 0.008, release: 0.12 });
const makeup = ctx.createGain();

// Chorus: duas linhas moduladas em fases opostas, cruzadas no estéreo (estilo Dimension).
const chorusDry = ctx.createGain();
const chorusWet = new GainNode(ctx, { gain: 0 });
const chorusL = new DelayNode(ctx, { delayTime: 0.014 });
const chorusR = new DelayNode(ctx, { delayTime: 0.0165 });
const chorusMerge = new ChannelMergerNode(ctx, { numberOfInputs: 2 });
const chorusHp = new BiquadFilterNode(ctx, { type: "highpass", frequency: 120 });
lfo(0.55, 0.0026, chorusL.delayTime);
lfo(0.55 * 0.97, -0.0026, chorusR.delayTime);

// Delay: mono, ping-pong ou fita. Realimentação: HP 100 Hz → LP → saturação (só na fita) → ganho.
const delaySend = new GainNode(ctx, { gain: 0 });
const delayL = new DelayNode(ctx, { maxDelayTime: 2, delayTime: 0.4 });
const delayR = new DelayNode(ctx, { maxDelayTime: 2, delayTime: 0.4 });
const delayHp = new BiquadFilterNode(ctx, { type: "highpass", frequency: 100, Q: 0.5 });
const delayLp = new BiquadFilterNode(ctx, { type: "lowpass", frequency: 3800, Q: 0.5 });
const delaySat = new WaveShaperNode(ctx);
const delayFb = new GainNode(ctx, { gain: 0.4 });
const delayMerge = new ChannelMergerNode(ctx, { numberOfInputs: 2 });
const delayOut = new GainNode(ctx, { gain: 0.8 });
const tapeCurve = (() => {
  const n = 1024;
  const c = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    c[i] = Math.tanh(x * 1.25) * 0.9; // a mesma do TapeDelay do LabGuitar
  }
  return c;
})();
// Wow (0,6 Hz, ±0,6 ms) e flutter (6 Hz, ±0,15 ms): só ligados no modo fita.
const wow = lfo(0.6, 0, delayL.delayTime);
const flutter = lfo(6, 0, delayL.delayTime);
delayHp.connect(delayLp).connect(delaySat).connect(delayFb);
delayMerge.connect(delayOut);

// Reverb: dois convolvers em crossfade para trocar tipo/tamanho sem clique.
const reverbSend = new GainNode(ctx, { gain: 0 });
const revA = new ConvolverNode(ctx);
const revB = new ConvolverNode(ctx);
const revGainA = new GainNode(ctx, { gain: 1 });
const revGainB = new GainNode(ctx, { gain: 0 });
const reverbHp = new BiquadFilterNode(ctx, { type: "highpass", frequency: 120, Q: 0.6 });
const reverbLp = new BiquadFilterNode(ctx, { type: "lowpass", frequency: 9000, Q: 0.6 });
reverbSend.connect(revA).connect(revGainA).connect(reverbHp);
reverbSend.connect(revB).connect(revGainB).connect(reverbHp);
reverbHp.connect(reverbLp);

// Master: limitador (−1,5 dB, ataque 1 ms) seguido de soft clip transparente abaixo de 0,98.
const master = new GainNode(ctx, { gain: 1 });
const limiter = new DynamicsCompressorNode(ctx, { threshold: -1.5, knee: 0, ratio: 20, attack: 0.001, release: 0.1 });
const safety = new WaveShaperNode(ctx, {
  curve: (() => {
    const n = 4096;
    const c = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * 4 - 2; // −2…+2
      const a = Math.abs(x);
      c[i] = Math.sign(x) * (a < 0.98 ? a : 0.98 + 0.02 * Math.tanh((a - 0.98) / 0.02));
    }
    return c;
  })(),
});
const safetyIn = new GainNode(ctx, { gain: 0.5 }); // a curva cobre ±2 de entrada: s entra como s/2 e sai em até ±1
const safetyOut = new GainNode(ctx, { gain: 1 });
export const analyser = new AnalyserNode(ctx, { fftSize: 1024 });

input.connect(bass).connect(mid).connect(treble).connect(comp).connect(makeup);
makeup.connect(chorusDry).connect(master);
makeup.connect(chorusL).connect(chorusMerge, 0, 0);
makeup.connect(chorusR).connect(chorusMerge, 0, 1);
chorusMerge.connect(chorusHp).connect(chorusWet).connect(master);
makeup.connect(delaySend).connect(delayL);
delayOut.connect(master);
makeup.connect(reverbSend);
reverbLp.connect(master);
master.connect(limiter).connect(safetyIn).connect(safety).connect(safetyOut).connect(analyser).connect(ctx.destination);

export const buses = {
  organ: new GainNode(ctx, { gain: 1 }),
  piano: new GainNode(ctx, { gain: 1 }),
  synth: new GainNode(ctx, { gain: 1 }),
  strings: new GainNode(ctx, { gain: 1 }),
};
export const stringsIn = new GainNode(ctx, { gain: 0.7 });
export const stringsInB = new GainNode(ctx, { gain: 0.7 });

// ---------- Faixa por seção: Amp → Mod (insert) → Layer Effects ----------
// Amp: pré HP → curva com 4× de oversampling → gabinete (HP, corpo, presença, LP).
const AMPS = {
  clean: { gain: (d) => 1.2 + d * 2, asym: 0.02, hp: 80, body: [140, 1.5], presence: [2200, 2], lp: 7500, trim: 1 },
  crunch: { gain: (d) => 4 + d * 14, asym: 0.08, hp: 90, body: [110, 2.5], presence: [2500, 4], lp: 5200, trim: 0.25 },
  tube: { gain: (d) => 1.25 + d * 7.2, asym: 0.025, hp: 70, body: [120, 3], presence: [2800, 3], lp: 6000, trim: 0.55 },
};
function ampCurve(kind, drive) {
  const a = AMPS[kind];
  const g = a.gain(drive);
  const norm = Math.tanh((1 - a.asym) * g);
  const n = 2048;
  const c = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const y = (i / (n - 1)) * 2 - 1;
    c[i] = (Math.tanh((y - a.asym * y * y) * g) / norm) * 0.92;
  }
  return c;
}

// Mod: um tipo para as três seções, cada seção com o seu processador e o seu envio.
const MOD_RATE = { tremolo: [0.5, 12], pan: [0.2, 8], chorus: [0.1, 3], flanger: [0.05, 2], phaser: [0.1, 6] };
const modRateHz = (type, r) => { const [lo, hi] = MOD_RATE[type]; return lo * Math.pow(hi / lo, r); };

function buildMod(type, rate, amount) {
  const inp = ctx.createGain();
  const out = ctx.createGain();
  const osc = new OscillatorNode(ctx, { frequency: modRateHz(type, rate) });
  osc.start();
  const nodes = [inp, out, osc];
  const add = (n) => { nodes.push(n); return n; };
  let setAmount;
  if (type === "tremolo") {
    const g = add(new GainNode(ctx, { gain: 1 }));
    const depth = add(new GainNode(ctx, { gain: 0 }));
    osc.connect(depth).connect(g.gain);
    inp.connect(g).connect(out);
    setAmount = (v) => { set(g.gain, 1 - v / 2); set(depth.gain, v / 2); };
  } else if (type === "pan") {
    const pan = add(new StereoPannerNode(ctx));
    const depth = add(new GainNode(ctx, { gain: 0 }));
    osc.connect(depth).connect(pan.pan);
    inp.connect(pan).connect(out);
    setAmount = (v) => set(depth.gain, v * 0.9);
  } else if (type === "chorus") {
    const merge = add(new ChannelMergerNode(ctx, { numberOfInputs: 2 }));
    const dl = add(new DelayNode(ctx, { delayTime: 0.012 }));
    const dr = add(new DelayNode(ctx, { delayTime: 0.015 }));
    const dpl = add(new GainNode(ctx, { gain: 0 }));
    const dpr = add(new GainNode(ctx, { gain: 0 }));
    osc.connect(dpl).connect(dl.delayTime);
    osc.connect(dpr).connect(dr.delayTime);
    const mono = add(new GainNode(ctx, { gain: 0.5, channelCount: 1, channelCountMode: "explicit" }));
    inp.connect(mono);
    mono.connect(dl).connect(merge, 0, 0);
    mono.connect(dr).connect(merge, 0, 1);
    const dry = add(new GainNode(ctx, { gain: 0.7 }));
    inp.connect(dry).connect(out);
    merge.connect(add(new GainNode(ctx, { gain: 1.2 }))).connect(out);
    setAmount = (v) => { set(dpl.gain, 0.0005 + v * 0.0035); set(dpr.gain, -(0.0005 + v * 0.0035)); };
  } else if (type === "flanger") {
    // Filtro em pente: entrada + cópia atrasada de 0,3 a 4 ms (sem realimentação: um laço no
    // Web Audio teria no mínimo 128 amostras de atraso, longo demais para flanger).
    const d = add(new DelayNode(ctx, { delayTime: 0.0022 }));
    const depth = add(new GainNode(ctx, { gain: 0 }));
    osc.connect(depth).connect(d.delayTime);
    const half = add(new GainNode(ctx, { gain: 0.6 }));
    inp.connect(half).connect(out);
    inp.connect(d).connect(add(new GainNode(ctx, { gain: 0.6 }))).connect(out);
    setAmount = (v) => set(depth.gain, 0.0004 + v * 0.0017);
  } else {
    // Phaser: 4 passa-tudo de 2ª ordem varrendo de ~150 Hz a ~2,5 kHz, somados ao seco.
    let last = inp;
    const sweeps = [];
    for (let i = 0; i < 4; i++) {
      const ap = add(new BiquadFilterNode(ctx, { type: "allpass", frequency: 700, Q: 0.6 }));
      const depth = add(new GainNode(ctx, { gain: 0 }));
      osc.connect(depth).connect(ap.frequency);
      sweeps.push(depth);
      last = last.connect(ap);
    }
    inp.connect(add(new GainNode(ctx, { gain: 0.6 }))).connect(out);
    last.connect(add(new GainNode(ctx, { gain: 0.6 }))).connect(out);
    setAmount = (v) => sweeps.forEach((g) => set(g.gain, 100 + v * 550));
  }
  setAmount(amount);
  return {
    inp, out,
    setRate: (r) => set(osc.frequency, modRateHz(type, r), 0.05),
    setAmount,
    dispose() { try { osc.stop(); } catch { /* já parado */ } nodes.forEach((n) => n.disconnect()); },
  };
}

const STRIP_KEYS = ["organ", "piano", "synth:A", "synth:B", "strings:A", "strings:B"];
const strips = {};
function makeStrip(name) {
  const s = { name, ampType: "off", ampDrive: 0.4, send: 0 };
  s.in = ctx.createGain();
  s.ampDry = new GainNode(ctx, { gain: 1 });
  s.ampWet = new GainNode(ctx, { gain: 0 });
  s.ampHp = new BiquadFilterNode(ctx, { type: "highpass", frequency: 80, Q: 0.6 });
  s.shaper = new WaveShaperNode(ctx, { oversample: "2x" });
  s.cabHp = new BiquadFilterNode(ctx, { type: "highpass", frequency: 80, Q: 0.7 });
  s.body = new BiquadFilterNode(ctx, { type: "peaking", frequency: 120, Q: 1, gain: 0 });
  s.presence = new BiquadFilterNode(ctx, { type: "peaking", frequency: 2500, Q: 0.9, gain: 0 });
  s.cabLp = new BiquadFilterNode(ctx, { type: "lowpass", frequency: 6000, Q: 0.7 });
  s.trim = new GainNode(ctx, { gain: 1 });
  s.modIn = ctx.createGain();
  s.modDry = new GainNode(ctx, { gain: 1 });
  s.modWet = new GainNode(ctx, { gain: 0 });
  s.out = ctx.createGain();
  s.in.connect(s.ampDry).connect(s.modIn);
  s.in.connect(s.ampHp).connect(s.shaper).connect(s.cabHp).connect(s.body).connect(s.presence).connect(s.cabLp).connect(s.trim).connect(s.ampWet).connect(s.modIn);
  s.modIn.connect(s.modDry).connect(s.out);
  s.modWet.connect(s.out);
  s.out.connect(input);
  return s;
}
STRIP_KEYS.forEach((n) => { strips[n] = makeStrip(n); });
buses.organ.connect(strips.organ.in);
buses.piano.connect(strips.piano.in);

function applyAmp(s) {
  const on = s.ampType !== "off" && AMPS[s.ampType];
  if (on) {
    const a = AMPS[s.ampType];
    s.shaper.curve = ampCurve(s.ampType, s.ampDrive);
    s.ampHp.frequency.value = a.hp;
    s.cabHp.frequency.value = a.hp;
    [s.body.frequency.value, s.body.gain.value] = a.body;
    [s.presence.frequency.value, s.presence.gain.value] = a.presence;
    s.cabLp.frequency.value = a.lp;
    set(s.trim.gain, a.trim / (1 + s.ampDrive * 0.6));
  }
  set(s.ampDry.gain, on ? 0 : 1, 0.015);
  set(s.ampWet.gain, on ? 1 : 0, 0.015);
}

const state = {
  reverbType: "stage", reverbSize: 0.5, reverbTone: 0.5,
  mod1Type: "chorus", mod1Rate: 0.35, mod1Amount: 0.5,
  modSend: { organ: 0, piano: 0, "synth:A": 0, "synth:B": 0, "strings:A": 0, "strings:B": 0 },
  delayMode: "pingpong", delayFeedback: 0.4,
  amp: {
    organ: { type: "off", drive: 0.4 },
    piano: { type: "off", drive: 0.4 },
    "synth:A": { type: "off", drive: 0.4 },
    "synth:B": { type: "off", drive: 0.4 },
    "strings:A": { type: "off", drive: 0.4 },
    "strings:B": { type: "off", drive: 0.4 },
  },
};

function rebuildMods() {
  for (const s of Object.values(strips)) {
    const old = s.mod;
    s.mod = buildMod(state.mod1Type, state.mod1Rate, state.mod1Amount);
    s.modIn.connect(s.mod.inp);
    s.mod.out.connect(s.modWet);
    if (old) setTimeout(() => old.dispose(), 60);
  }
}

function applySend(s) {
  const v = state.modSend[s.name];
  set(s.modDry.gain, 1 - v, 0.015);
  set(s.modWet.gain, v, 0.015);
}

let revActiveA = true;
let revTimer = 0;
function renderReverb(immediate = false) {
  clearTimeout(revTimer);
  const go = () => {
    const buf = reverbImpulse(state.reverbType, state.reverbSize);
    const [conv, gIn, gOut] = revActiveA ? [revB, revGainB, revGainA] : [revA, revGainA, revGainB];
    conv.buffer = buf;
    set(gIn.gain, 1, 0.05);
    set(gOut.gain, 0, 0.05);
    revActiveA = !revActiveA;
  };
  if (immediate) go();
  else revTimer = setTimeout(go, 120); // knob de tamanho: espera parar de girar para gerar a IR
}

function applyDelayMode() {
  [delayL, delayR, delayFb].forEach((n) => n.disconnect());
  const tape = state.delayMode === "tape";
  if (state.delayMode === "pingpong") {
    delayL.connect(delayMerge, 0, 0);
    delayL.connect(delayR);
    delayR.connect(delayMerge, 0, 1);
    delayR.connect(delayHp);
  } else {
    delayL.connect(delayMerge, 0, 0);
    delayL.connect(delayMerge, 0, 1);
    delayL.connect(delayHp);
  }
  delayFb.connect(delayL);
  delaySat.curve = tape ? tapeCurve : null;
  set(delayLp.frequency, tape ? 2500 : 3800);
  set(wow.amt.gain, tape ? 0.0006 : 0);
  set(flutter.amt.gain, tape ? 0.00015 : 0);
}

const reverbTone = (v) => {
  set(reverbLp.frequency, 3000 * Math.pow(14000 / 3000, v));
  set(reverbHp.frequency, 180 - v * 100);
};

rebuildMods();
Object.values(strips).forEach((s) => { applyAmp(s); applySend(s); });
renderReverb(true);
reverbTone(state.reverbTone);
applyDelayMode();
set(delayFb.gain, state.delayFeedback * 0.88);

// Synth no modo Sample: um segundo FluidSynth (sampler.js) toca o SF2 escolhido neste barramento.
export const synthSampleIn = new GainNode(ctx, { gain: 0.7 });

// Pads de sample (layout Workstation): entram direto no Layer Effects, sem Amp/Mod de seção.
export const padIn = new GainNode(ctx, { gain: 0.9 });
padIn.connect(input);

// Piano: Timbre (filtro fixo por posição) antes do nível.
const timbre = new BiquadFilterNode(ctx, { type: "allpass" });
export const pianoIn = ctx.createGain(); // layer A (piano.js)
export const pianoInB = ctx.createGain(); // layer B
timbre.connect(buses.piano);

const SECTIONS = new Set(["organ", "piano", "synth", "strings"]);

export const fx = {
  master: (v) => set(master.gain, v * v * 1.2),
  bass: (v) => set(bass.gain, (v - 0.5) * 30),
  mid: (v) => set(mid.gain, (v - 0.5) * 24),
  treble: (v) => set(treble.gain, (v - 0.5) * 30),
  comp: (v) => {
    // Um knob: limiar −3 → −24 dB e razão 1 → 4:1; makeup compensa ~metade da redução.
    set(comp.threshold, v ? -3 - v * 21 : 0);
    set(comp.ratio, 1 + v * 3);
    set(makeup.gain, db(v * 9));
  },
  chorus: (v) => { set(chorusWet.gain, v * 0.9); set(chorusDry.gain, 1 - v * 0.3); },
  delay: (v) => set(delaySend.gain, v * 0.7),
  delayTime: (v) => {
    const t = 0.08 + v * 0.92;
    set(delayL.delayTime, t, 0.09); // ~90 ms de glide, como o TapeDelay
    set(delayR.delayTime, t, 0.09);
  },
  delayMode(m) {
    if (!["mono", "pingpong", "tape"].includes(m) || m === state.delayMode) return;
    state.delayMode = m;
    applyDelayMode();
  },
  delayFeedback(v) { state.delayFeedback = v; set(delayFb.gain, v * 0.88); },
  reverb: (v) => set(reverbSend.gain, v * 0.85),
  reverbType(t) {
    if (!REVERBS[t] || t === state.reverbType) return;
    state.reverbType = t;
    renderReverb(true);
  },
  reverbSize(v) { state.reverbSize = v; renderReverb(); },
  reverbTone(v) { state.reverbTone = v; reverbTone(v); },
  mod1Type(t) {
    if (!MOD_RATE[t] || t === state.mod1Type) return;
    state.mod1Type = t;
    rebuildMods();
  },
  mod1Rate(v) { state.mod1Rate = v; Object.values(strips).forEach((s) => s.mod.setRate(v)); },
  mod1Amount(v) { state.mod1Amount = v; Object.values(strips).forEach((s) => s.mod.setAmount(v)); },
  modSend(section, v) {
    if (section === "synth") { this.modSend("synth:A", v); this.modSend("synth:B", v); return; }
    if (section === "strings") { this.modSend("strings:A", v); this.modSend("strings:B", v); return; }
    if (!strips[section]) return;
    state.modSend[section] = v;
    applySend(strips[section]);
  },
  ampType(section, t) {
    if (section === "synth") { this.ampType("synth:A", t); this.ampType("synth:B", t); return; }
    if (section === "strings") { this.ampType("strings:A", t); this.ampType("strings:B", t); return; }
    if (!strips[section] || !(t === "off" || AMPS[t])) return;
    if (!state.amp[section]) state.amp[section] = { type: "off", drive: 0.4 };
    state.amp[section].type = t;
    strips[section].ampType = t;
    applyAmp(strips[section]);
  },
  ampDrive(section, v) {
    if (section === "synth") { this.ampDrive("synth:A", v); this.ampDrive("synth:B", v); return; }
    if (section === "strings") { this.ampDrive("strings:A", v); this.ampDrive("strings:B", v); return; }
    if (!strips[section]) return;
    if (!state.amp[section]) state.amp[section] = { type: "off", drive: 0.4 };
    state.amp[section].drive = v;
    strips[section].ampDrive = v;
    applyAmp(strips[section]);
  },
  // Programas: o que os setters acima guardam, para gravar e restaurar de uma vez.
  state: () => JSON.parse(JSON.stringify(state)),
  restore(s) {
    if (!s) return;
    if (s.reverbType) this.reverbType(s.reverbType);
    if (typeof s.reverbSize === "number") this.reverbSize(s.reverbSize);
    if (typeof s.reverbTone === "number") this.reverbTone(s.reverbTone);
    if (s.mod1Type) this.mod1Type(s.mod1Type);
    if (typeof s.mod1Rate === "number") this.mod1Rate(s.mod1Rate);
    if (typeof s.mod1Amount === "number") this.mod1Amount(s.mod1Amount);
    for (const sec of ["organ", "piano", "synth:A", "synth:B", "strings:A", "strings:B", "synth", "strings"]) {
      if (typeof s.modSend?.[sec] === "number") this.modSend(sec, s.modSend[sec]);
      if (s.amp?.[sec]) {
        if (typeof s.amp[sec].drive === "number") this.ampDrive(sec, s.amp[sec].drive);
        if (s.amp[sec].type) this.ampType(sec, s.amp[sec].type);
      }
    }
    if (s.delayMode) this.delayMode(s.delayMode);
    if (typeof s.delayFeedback === "number") this.delayFeedback(s.delayFeedback);
  },
  timbre(mode) {
    const p = [
      { type: "allpass", frequency: 1000, gain: 0 },
      { type: "highshelf", frequency: 2500, gain: -9 },
      { type: "peaking", frequency: 1600, gain: 5, Q: 0.7 },
      { type: "highshelf", frequency: 3800, gain: 7 },
    ][mode];
    timbre.type = p.type;
    timbre.frequency.value = p.frequency;
    timbre.gain.value = p.gain;
    if (p.Q) timbre.Q.value = p.Q;
  },
  stringsCutoff(layerOrVal, v) {
    if (typeof layerOrVal === "number" || (typeof layerOrVal === "string" && !isNaN(layerOrVal))) {
      const val = Number(layerOrVal);
      set(stringsFilterA.frequency, Math.min(20000, 80 * Math.pow(2, val * 8)), 0.02);
      set(stringsFilterB.frequency, Math.min(20000, 80 * Math.pow(2, val * 8)), 0.02);
      return;
    }
    const flt = layerOrVal === "B" ? stringsFilterB : stringsFilterA;
    set(flt.frequency, Math.min(20000, 80 * Math.pow(2, v * 8)), 0.02);
  },
  level: (section, v) => set(buses[section].gain, v * v * 1.4),
};

// ---------- Organ: tonewheel com foldback ----------
// Drawbars em relação à nota de 16': 16' 5⅓' 8' 4' 2⅔' 2' 1⅗' 1⅓' 1'
export const DRAWBARS = [
  { name: "16'", h: 1, color: "brown" }, { name: "5⅓'", h: 3, color: "brown" },
  { name: "8'", h: 2, color: "white" }, { name: "4'", h: 4, color: "white" },
  { name: "2⅔'", h: 6, color: "black" }, { name: "2'", h: 8, color: "white" },
  { name: "1⅗'", h: 10, color: "black" }, { name: "1⅓'", h: 12, color: "black" },
  { name: "1'", h: 16, color: "white" },
];
// Roda de cada drawbar em semitons acima da roda do 8' (B3: rodas 1…91, a do 8' em C2 é a 13).
const WHEEL_OFF = [-12, 7, 0, 12, 19, 24, 28, 31, 36];
const LEAK = db(-50); // vazamento entre rodas: cada drawbar soa baixinho mesmo puxado a zero

// Dois manuais (layers A e B), cada um com drawbars, modelo e ganho próprios. Percussão,
// vibrato, preamp e Leslie são da seção. Vozes indexadas por "manual:nota".
const organ = {
  manuals: [
    { bars: [8, 8, 8, 0, 0, 0, 0, 0, 0], model: "b3" },
    { bars: [8, 3, 8, 0, 0, 0, 0, 0, 0], model: "b3" },
  ],
  perc: { on: false, third: false, fast: false },
  waves: new Map(),
  voices: new Map(),
};
const percOn = () => organ.perc.on && organ.manuals[0].model === "b3"; // o −3 dB segue o modelo do A

// Harmônico de cada drawbar para a nota, sobre uma fundamental de 1/4 da nota (16' = 2).
// Fora das rodas 1…91 o B3 repete a oitava: embaixo sobe uma oitava, em cima desce.
function foldPattern(note) {
  const w8 = note - 36 + 13;
  return DRAWBARS.map((d, i) => {
    let w = w8 + WHEEL_OFF[i];
    let h = d.h * 2;
    while (w < 1) { w += 12; h *= 2; }
    while (w > 91) { w -= 12; h /= 2; }
    return h;
  });
}

function waveFor(pattern, manual) {
  const key = `${manual}:${pattern.join(",")}`;
  let wave = organ.waves.get(key);
  if (wave) return wave;
  const { bars: mbars, model } = organ.manuals[manual];
  const n = 128;
  const real = new Float32Array(n + 1);
  const imag = new Float32Array(n + 1);
  // A percussão do B3 rouba o drawbar de 1' dos dois manuais.
  const bars = mbars.map((lvl, i) => (organ.perc.on && model === "b3" && i === 8 ? 0 : lvl));
  bars.forEach((lvl, i) => {
    const h = pattern[i];
    const amp = lvl ? db((lvl - 8) * 3) : 0;
    if (model === "b3") {
      imag[h] += amp + LEAK;
    } else if (amp) {
      // Vox: cada drawbar soa como quadrada (parciais ímpares); Farf: dente de serra mais brilhante.
      for (let k = 1; h * k <= n; k++) {
        if (model === "vox" && k % 2 === 0) continue;
        imag[h * k] += (amp / k) * (model === "farf" ? 0.8 : 0.7);
      }
    }
  });
  wave = ctx.createPeriodicWave(real, imag, { disableNormalization: true });
  organ.waves.set(key, wave);
  return wave;
}

function rebuildWaves() {
  organ.waves.clear();
  for (const v of organ.voices.values()) v.osc.setPeriodicWave(waveFor(v.pattern, v.manual));
}

// Cadeia: manuais (ganho da layer) → scanner (vibrato/chorus) → preamp valvulado → Leslie → barramento.
const organIn = new GainNode(ctx, { gain: 0.26 });
const manualOut = [0, 1].map(() => {
  const g = new GainNode(ctx, { gain: 1 });
  g.connect(organIn);
  return g;
});
const percGain = new GainNode(ctx, { gain: 1 }); // percussão ligada baixa o volume normal (−3 dB)
organIn.connect(percGain);

// Scanner: linha de atraso modulada a 6,9 Hz, ±0,42 ms (~±30 cents, perto do V3/C3),
// com o lowpass de ~7 kHz da linha de atraso do Hammond no caminho molhado.
const vibDry = ctx.createGain();
const vibWet = ctx.createGain();
const vibDelay = new DelayNode(ctx, { delayTime: 0.0012 });
const vibLp = new BiquadFilterNode(ctx, { type: "lowpass", frequency: 7000, Q: 0.5 });
const vibLfo = lfo(6.9, 0, vibDelay.delayTime);
percGain.connect(vibDry);
percGain.connect(vibDelay).connect(vibLp).connect(vibWet);

// Preamp: HP 60 Hz → curva valvulada assimétrica ("Vintage Combo" do LabGuitar) com 4× de
// oversampling → DC block → LP 6,5 kHz (amplificador do Leslie).
const preHp = new BiquadFilterNode(ctx, { type: "highpass", frequency: 60, Q: 0.6 });
const drive = new WaveShaperNode(ctx, { oversample: "2x" });
const dcBlock = new BiquadFilterNode(ctx, { type: "highpass", frequency: 12, Q: 0.6 });
const ampLp = new BiquadFilterNode(ctx, { type: "lowpass", frequency: 6500, Q: 0.6 });
vibDry.connect(preHp);
vibWet.connect(preHp);
preHp.connect(drive).connect(dcBlock).connect(ampLp);

// Leslie: crossover de 800 Hz em 24 dB (duas biquads), corneta e tambor girando com Doppler
// (atraso modulado) e AM, captados por dois microfones a 180°: L e R em fases opostas.
const rotDry = ctx.createGain();
const rotWet = ctx.createGain();
const rotMerge = new ChannelMergerNode(ctx, { numberOfInputs: 2 });
const split = (type) => {
  const a = new BiquadFilterNode(ctx, { type, frequency: 800, Q: Math.SQRT1_2 });
  const b = new BiquadFilterNode(ctx, { type, frequency: 800, Q: Math.SQRT1_2 });
  a.connect(b);
  return [a, b];
};
const [hornIn, hornOut] = split("highpass");
const [drumIn, drumOut] = split("lowpass");
function rotor(source, { am, doppler, base }) {
  const osc = new OscillatorNode(ctx, { frequency: 0.8 });
  osc.start();
  [0, 1].forEach((side) => {
    const sign = side ? -1 : 1;
    const delay = new DelayNode(ctx, { delayTime: base });
    const amp = new GainNode(ctx, { gain: 1 - am });
    source.connect(delay).connect(amp).connect(rotMerge, 0, side);
    osc.connect(new GainNode(ctx, { gain: sign * doppler })).connect(delay.delayTime);
    osc.connect(new GainNode(ctx, { gain: sign * am })).connect(amp.gain);
  });
  return osc;
}
const horn = rotor(hornOut, { am: 0.42, doppler: 0.00034, base: 0.0012 });
const drum = rotor(drumOut, { am: 0.18, doppler: 0.00012, base: 0.0012 });
ampLp.connect(rotDry).connect(buses.organ);
ampLp.connect(hornIn);
ampLp.connect(drumIn);
rotMerge.connect(rotWet).connect(buses.organ);

function driveCurve(amount) {
  const g = 1.25 + amount * 7.2;
  const n = 2048;
  const c = new Float32Array(n);
  const norm = Math.tanh((1 - 0.025) * g);
  for (let i = 0; i < n; i++) {
    const y = (i / (n - 1)) * 2 - 1;
    c[i] = (Math.tanh((y - 0.025 * y * y) * g) / norm) * 0.92;
  }
  return c;
}

// Clique de tecla: rajada curta de ruído em banda (2–5 kHz), mais forte no apertar.
function keyClick(t, level) {
  const src = new AudioBufferSourceNode(ctx, { buffer: noise });
  const bp = new BiquadFilterNode(ctx, { type: "bandpass", frequency: 2600 + Math.random() * 1800, Q: 0.8 });
  const g = new GainNode(ctx, { gain: 0 });
  g.gain.setValueAtTime(level, t);
  g.gain.setTargetAtTime(0, t, 0.0015);
  src.connect(bp).connect(g).connect(organIn);
  src.start(t, Math.random() * 0.9, 0.02);
}

// manual: 0 = layer A (padrão), 1 = layer B.
export const organApi = {
  setBar(i, level, manual = 0) { organ.manuals[manual].bars[i] = level; rebuildWaves(); },
  setModel(m, manual = 0) { organ.manuals[manual].model = m; this.setPerc({}); },
  bars: (manual = 0) => [...organ.manuals[manual].bars],
  model: (manual = 0) => organ.manuals[manual].model,
  setPerc(p) {
    Object.assign(organ.perc, p);
    set(percGain.gain, percOn() ? db(-3) : 1, 0.01);
    rebuildWaves(); // a percussão do B3 rouba o drawbar de 1'
  },
  setVib(mode) { // 0 off · 1 vibrato · 2 chorus
    set(vibLfo.amt.gain, mode ? 0.00042 : 0);
    set(vibDry.gain, mode === 1 ? 0 : 1);
    set(vibWet.gain, mode === 0 ? 0 : mode === 1 ? 1 : 0.85);
  },
  setDrive(v) { drive.curve = driveCurve(v); },
  setRotary(mode) { // 0 off · 1 slow · 2 fast; a corneta acelera e freia antes do tambor
    const t = ctx.currentTime;
    set(rotDry.gain, mode ? 0 : 1);
    set(rotWet.gain, mode ? 0.85 : 0);
    const fast = mode === 2;
    horn.frequency.setTargetAtTime(fast ? 6.75 : 0.83, t, fast ? 0.35 : 0.6);
    drum.frequency.setTargetAtTime(fast ? 5.9 : 0.67, t, fast ? 1.6 : 1.9);
  },
  noteOn(note, manual = 0) {
    const id = `${manual}:${note}`;
    if (organ.voices.has(id)) return;
    const t = ctx.currentTime;
    const pattern = foldPattern(note);
    const osc = new OscillatorNode(ctx, { frequency: midiHz(note) / 4 });
    osc.setPeriodicWave(waveFor(pattern, manual));
    const env = new GainNode(ctx, { gain: 0 });
    env.gain.setTargetAtTime(1, t, 0.0012);
    osc.connect(env).connect(manualOut[manual]);
    osc.start(t);
    if (organ.manuals[manual].model === "b3") keyClick(t, 0.5); // clique só nos manuais B3
    const voice = { osc, env, pattern, manual, note };
    // Percussão single-trigger: só dispara com os dois manuais soltos, com nota de qualquer um.
    if (organ.perc.on && organ.voices.size === 0) {
      const p = new OscillatorNode(ctx, { type: "sine", frequency: midiHz(note) * (organ.perc.third ? 3 : 2) });
      const pe = new GainNode(ctx, { gain: 1.1 });
      pe.gain.setTargetAtTime(0, t, organ.perc.fast ? 0.07 : 0.25);
      p.connect(pe).connect(organIn);
      p.start(t);
      p.stop(t + 3);
    }
    organ.voices.set(id, voice);
  },
  noteOff(note, manual = 0) {
    const id = `${manual}:${note}`;
    const v = organ.voices.get(id);
    if (!v) return;
    const t = ctx.currentTime;
    v.env.gain.cancelScheduledValues(t);
    v.env.gain.setTargetAtTime(0, t, 0.005);
    v.osc.stop(t + 0.08);
    if (organ.manuals[manual].model === "b3") keyClick(t, 0.18);
    organ.voices.delete(id);
  },
  allOff() { for (const v of [...organ.voices.values()]) this.noteOff(v.note, v.manual); },
};

// ---------- Synth subtrativo ----------
// Duas instâncias (layers A e B) com knobs próprios; vibrato e PWM são compartilhados.
// O modo Sample (sampler.js) existe só na layer A.
const time = (v) => 0.002 + v * v * 4;
// Mod wheel: vibrato compartilhado por todas as vozes do synth (5,5 Hz, até ±40 cents).
const synthVib = lfo(5.5, 0, ctx.createGain());
// PWM: LFO lento compartilhado que varia a largura do pulso (±15 % do período).
const pwmLfo = lfo(0.45, 1, ctx.createGain());
const filterDrive = (() => {
  const n = 1024;
  const c = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    c[i] = Math.tanh(x * 1.6) / Math.tanh(1.6);
  }
  return c;
})();

// Pulso sem aliasing: serra − serra atrasada de (largura × período). O atraso é modulado pelo
// LFO de PWM. As duas serras vêm do OscillatorNode, que já é limitado em banda.
function pulseOsc(freq, detune, out) {
  const a = new OscillatorNode(ctx, { type: "sawtooth", frequency: freq, detune });
  const d = new DelayNode(ctx, { maxDelayTime: 0.1, delayTime: 0.5 / freq });
  const inv = new GainNode(ctx, { gain: -1 });
  const pw = new GainNode(ctx, { gain: 0.15 / freq });
  pwmLfo.amt.connect(pw).connect(d.delayTime);
  a.connect(out);
  a.connect(d).connect(inv).connect(out);
  a.cleanup = () => { pwmLfo.amt.disconnect(pw); };
  return a;
}

const SYNTH_PARAMS = ["osc", "detune", "cutoff", "reso", "fenv", "attack", "decay", "sustain", "release"];

function makeSynth(out, defaults) {
  const synth = { ...defaults, voices: new Map(), bend: 0 }; // bend em cents (pitch stick / pitch bend MIDI)
  // Modo Sample: sampler.js registra aqui o motor que toca o SF2 (noteOn, noteOff, param, bend, mod, sustain, allOff).
  let sampler = null;
  const isSample = () => synth.osc === "sample" && sampler;
  return {
    attachSampler(handler) { sampler = handler; },
    params: () => Object.fromEntries(SYNTH_PARAMS.map((k) => [k, synth[k]])),
    set(param, v) {
      if (param === "osc" && synth.osc === "sample" && v !== "sample") sampler?.allOff();
      synth[param] = v;
      if (param !== "osc") sampler?.param(param, v);
    },
    sustain(down) { sampler?.sustain(down); },
    bend(semis) {
      sampler?.bend(semis);
      synth.bend = semis * 100;
      for (const v of synth.voices.values()) v.oscs.forEach((o) => set(o.detune, o.spread + synth.bend));
    },
    mod(v) { set(synthVib.amt.gain, v * v * 40); sampler?.mod(v); },
    noteOn(note, vel) {
      if (isSample()) { sampler.noteOn(note, vel); return; }
      this.kill(note);
      const t = ctx.currentTime;
      const f = midiHz(note);
      const cents = synth.detune * 40;
      const sup = synth.osc === "super";
      // Supersaw: 7 serras abertas no estéreo; nos outros modos, um par ±detune com abertura leve.
      const offsets = sup ? [-1, -0.62, -0.3, 0, 0.3, 0.62, 1] : [-0.5, 0.5];
      const width = sup ? 0.85 : 0.35;
      const mix = new GainNode(ctx, { gain: 1 / Math.sqrt(offsets.length) });
      const oscs = offsets.map((o, i) => {
        const pan = new StereoPannerNode(ctx, { pan: offsets.length > 1 ? (i / (offsets.length - 1)) * 2 * width - width : 0 });
        pan.connect(mix);
        const detune = o * cents + synth.bend;
        const osc = synth.osc === "square"
          ? pulseOsc(f, detune, pan)
          : new OscillatorNode(ctx, { type: sup ? "sawtooth" : synth.osc, frequency: f, detune });
        if (synth.osc !== "square") osc.connect(pan);
        osc.spread = o * cents;
        synthVib.amt.connect(osc.detune);
        osc.onended = () => { synthVib.amt.disconnect(osc.detune); osc.cleanup?.(); };
        osc.start(t);
        return osc;
      });
      // Filtro de 24 dB: drive tanh → duas lowpass em cascata (a 1ª sem pico, a 2ª com a ressonância).
      // Corte acompanha a tecla em 50 % (meia oitava por oitava a partir do C4).
      const keytrack = Math.pow(2, ((note - 60) / 12) * 0.5);
      const base = Math.min(18000, 40 * Math.pow(2, synth.cutoff * 9) * keytrack);
      const peak = Math.min(20000, base * Math.pow(2, synth.fenv * 6 * (0.4 + (vel / 127) * 0.6)));
      const shaper = new WaveShaperNode(ctx, { curve: filterDrive, oversample: "2x" });
      const f1 = new BiquadFilterNode(ctx, { type: "lowpass", frequency: base, Q: 0.54 });
      const f2 = new BiquadFilterNode(ctx, { type: "lowpass", frequency: base, Q: 0.7 + synth.reso * 16 });
      for (const flt of [f1, f2]) {
        flt.frequency.setValueAtTime(base, t);
        flt.frequency.linearRampToValueAtTime(peak, t + time(synth.attack));
        flt.frequency.setTargetAtTime(base + (peak - base) * synth.sustain, t + time(synth.attack), time(synth.decay) / 3);
      }
      const amp = new GainNode(ctx, { gain: 0 });
      const level = 0.12 * (0.3 + (vel / 127) * 0.7);
      amp.gain.setValueAtTime(0, t);
      amp.gain.linearRampToValueAtTime(level, t + time(synth.attack));
      amp.gain.setTargetAtTime(level * synth.sustain, t + time(synth.attack), time(synth.decay) / 3);
      mix.connect(shaper).connect(f1).connect(f2).connect(amp).connect(out);
      synth.voices.set(note, { oscs, amp });
    },
    noteOff(note) {
      sampler?.noteOff(note);
      const v = synth.voices.get(note);
      if (!v) return;
      const t = ctx.currentTime;
      const r = time(synth.release);
      v.amp.gain.cancelScheduledValues(t);
      v.amp.gain.setValueAtTime(v.amp.gain.value, t);
      v.amp.gain.setTargetAtTime(0, t, r / 4);
      v.oscs.forEach((o) => o.stop(t + r * 1.5 + 0.05));
      synth.voices.delete(note);
    },
    kill(note) {
      const v = synth.voices.get(note);
      if (!v) return;
      v.oscs.forEach((o) => o.stop());
      synth.voices.delete(note);
    },
    allOff() { sampler?.allOff(); for (const n of [...synth.voices.keys()]) this.noteOff(n); },
  };
}

// ---------- Layers A/B (docs/efeitos-layers.md §3) ----------
// Ganho de cada layer: (level / 0,8)², depois do nível da seção. 0,8 = ganho 1.
const layerGain = (v) => (v / 0.8) ** 2;
const synthLayerOut = [0, 1].map((i) => {
  const g = new GainNode(ctx, { gain: 1 });
  g.connect(strips[i === 1 ? "synth:B" : "synth:A"].in);
  return g;
});
synthSampleIn.connect(synthLayerOut[0]);
const pianoLayerOut = [pianoIn, pianoInB].map((inp) => {
  const g = new GainNode(ctx, { gain: 1 });
  inp.connect(g).connect(timbre); // o Timbre vale para as duas layers do piano
  return g;
});

export const stringsFilterA = new BiquadFilterNode(ctx, { type: "lowpass", frequency: 20000, Q: 0.7 });
export const stringsFilterB = new BiquadFilterNode(ctx, { type: "lowpass", frequency: 20000, Q: 0.7 });
export const stringsFilter = stringsFilterA;

const stringsLayerOut = [stringsIn, stringsInB].map((inp, i) => {
  const g = new GainNode(ctx, { gain: 1 });
  const flt = i === 1 ? stringsFilterB : stringsFilterA;
  const strKey = i === 1 ? "strings:B" : "strings:A";
  inp.connect(g).connect(flt).connect(strips[strKey].in);
  return g;
});

export const synthApi = makeSynth(synthLayerOut[0], {
  osc: "sawtooth", detune: 0.3, cutoff: 0.55, reso: 0.2, fenv: 0.4, attack: 0.05, decay: 0.4, sustain: 0.7, release: 0.3,
});
export const synthApiB = makeSynth(synthLayerOut[1], { // padrão de pad, como o synth.B.* do nativo
  osc: "super", detune: 0.4, cutoff: 0.45, reso: 0.1, fenv: 0.2, attack: 0.3, decay: 0.5, sustain: 0.8, release: 0.5,
});

const LAYER_SECTIONS = ["organ", "piano", "synth", "strings"];
const ZONES = ["all", "lower", "upper"];
const layerState = {
  split: 60,
  ...Object.fromEntries(LAYER_SECTIONS.map((s) => [s, {
    A: { on: true, level: 0.8, octave: 0, zone: "all" },
    B: { on: false, level: 0.8, octave: 0, zone: "all" },
  }])),
};
const layerOut = { organ: manualOut, piano: pianoLayerOut, synth: synthLayerOut, strings: stringsLayerOut };

export const layers = {
  get: (section, layer) => ({ ...layerState[section][layer] }),
  // patch: { on?, level?, octave?, zone? }. Desligar não corta as notas que já soam (como no nativo).
  set(section, layer, patch) {
    const l = layerState[section]?.[layer];
    if (!l) return;
    if (typeof patch.on === "boolean") l.on = patch.on;
    if (typeof patch.level === "number") {
      l.level = Math.max(0, Math.min(1, patch.level));
      set(layerOut[section][layer === "B" ? 1 : 0].gain, layerGain(l.level), 0.03);
    }
    if (Number.isInteger(patch.octave)) l.octave = Math.max(-2, Math.min(2, patch.octave));
    if (ZONES.includes(patch.zone)) l.zone = patch.zone;
  },
  split: () => layerState.split,
  setSplit(note) { layerState.split = Math.max(36, Math.min(96, Math.round(note))); },
  // Nota que a layer toca para a tecla (null = não toca), como o layerTarget do nativo:
  // zona em relação ao split (lower = abaixo, upper = a partir dele), oitava da layer somada a `note`,
  // que já vem com transpose e oitava da seção. Seção ligada fica a cargo de quem chama.
  target(section, layer, key, note) {
    const l = layerState[section][layer];
    if (!l.on) return null;
    if ((l.zone === "lower" && key >= layerState.split) || (l.zone === "upper" && key < layerState.split)) return null;
    const n = note + l.octave * 12;
    return n >= 0 && n <= 127 ? n : null;
  },
  state: () => JSON.parse(JSON.stringify(layerState)),
  restore(s) {
    if (!s) return;
    if (typeof s.split === "number") this.setSplit(s.split);
    for (const sec of LAYER_SECTIONS) for (const l of ["A", "B"]) if (s[sec]?.[l]) this.set(sec, l, s[sec][l]);
  },
};