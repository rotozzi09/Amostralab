// Motor de estado leve + ponte direta para o motor nativo macOS (CoreAudio + CoreMIDI + libc++).
// Zero AudioContext / zero nós Web Audio no renderer WKWebView para consumo mínimo de CPU e RAM no MacBook.
import { nativeBridge } from "./native-bridge.js";

export function readPerfMode() {
  try {
    const raw = JSON.parse(localStorage.getItem("labpiano.audiosetup") || "{}");
    return raw.perfMode === "studio" ? "studio" : "live";
  } catch {
    return "live";
  }
}

const state = {
  reverbType: "stage",
  reverbSize: 0.5,
  reverbTone: 0.5,
  mod1Type: "chorus",
  mod1Rate: 0.35,
  mod1Amount: 0.5,
  modSend: { organ: 0, piano: 0, "synth:A": 0, "synth:B": 0, "strings:A": 0, "strings:B": 0 },
  delayMode: "pingpong",
  delayFeedback: 0.4,
  amp: {
    organ: { type: "off", drive: 0.4 },
    piano: { type: "off", drive: 0.4 },
    "synth:A": { type: "off", drive: 0.4 },
    "synth:B": { type: "off", drive: 0.4 },
    "strings:A": { type: "off", drive: 0.4 },
    "strings:B": { type: "off", drive: 0.4 },
  },
};

const VALID_MODS = new Set(["tremolo", "pan", "chorus", "flanger", "phaser"]);
const VALID_AMPS = new Set(["off", "clean", "crunch", "tube"]);
const VALID_REVERBS = new Set(["room", "stage", "hall", "plate", "spring"]);
const VALID_DELAYS = new Set(["mono", "pingpong", "tape"]);

export const fx = {
  master: (v) => nativeBridge.send("fx", { param: "master", value: v }),
  bass: (v) => nativeBridge.send("fx", { param: "bass", value: v }),
  mid: (v) => nativeBridge.send("fx", { param: "mid", value: v }),
  treble: (v) => nativeBridge.send("fx", { param: "treble", value: v }),
  comp: (v) => nativeBridge.send("fx", { param: "comp", value: v }),
  chorus: (v) => nativeBridge.send("fx", { param: "chorus", value: v }),
  delay: (v) => nativeBridge.send("fx", { param: "delay", value: v }),
  delayTime: (v) => nativeBridge.send("fx", { param: "delayTime", value: v }),
  delayMode(m) {
    if (!VALID_DELAYS.has(m) || m === state.delayMode) return;
    state.delayMode = m;
    nativeBridge.send("fx", { param: "delayMode", value: m });
  },
  delayFeedback(v) {
    state.delayFeedback = v;
    nativeBridge.send("fx", { param: "delayFeedback", value: v });
  },
  reverb: (v) => nativeBridge.send("fx", { param: "reverb", value: v }),
  setReverbEngine(engine) {
    const mode = engine === "conv" ? "studio" : "live";
    nativeBridge.send("fx", { param: "perfMode", value: mode });
  },
  reverbType(t) {
    if (!VALID_REVERBS.has(t) || t === state.reverbType) return;
    state.reverbType = t;
    nativeBridge.send("fx", { param: "reverbType", value: t });
  },
  reverbSize(v) {
    state.reverbSize = v;
    nativeBridge.send("fx", { param: "reverbSize", value: v });
  },
  reverbTone(v) {
    state.reverbTone = v;
    nativeBridge.send("fx", { param: "reverbTone", value: v });
  },
  mod1Type(t) {
    if (!VALID_MODS.has(t) || t === state.mod1Type) return;
    state.mod1Type = t;
    nativeBridge.send("fx", { param: "mod1Type", value: t });
  },
  mod1Rate(v) {
    state.mod1Rate = v;
    nativeBridge.send("fx", { param: "mod1Rate", value: v });
  },
  mod1Amount(v) {
    state.mod1Amount = v;
    nativeBridge.send("fx", { param: "mod1Amount", value: v });
  },
  modSend(section, v) {
    if (section === "synth") { this.modSend("synth:A", v); this.modSend("synth:B", v); return; }
    if (section === "strings") { this.modSend("strings:A", v); this.modSend("strings:B", v); return; }
    if (!(section in state.modSend)) return;
    state.modSend[section] = v;
    nativeBridge.send("fx", { param: "modSend", section, value: v });
  },
  ampType(section, t) {
    if (section === "synth") { this.ampType("synth:A", t); this.ampType("synth:B", t); return; }
    if (section === "strings") { this.ampType("strings:A", t); this.ampType("strings:B", t); return; }
    if (!VALID_AMPS.has(t)) return;
    state.amp[section] ??= { type: "off", drive: 0.4 };
    state.amp[section].type = t;
    nativeBridge.send("fx", { param: "ampType", section, value: t });
  },
  ampDrive(section, v) {
    if (section === "synth") { this.ampDrive("synth:A", v); this.ampDrive("synth:B", v); return; }
    if (section === "strings") { this.ampDrive("strings:A", v); this.ampDrive("strings:B", v); return; }
    state.amp[section] ??= { type: "off", drive: 0.4 };
    state.amp[section].drive = v;
    nativeBridge.send("fx", { param: "ampDrive", section, value: v });
  },
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
  timbre: (mode) => nativeBridge.send("fx", { param: "timbre", value: mode }),
  stringsCutoff(layerOrVal, v) {
    if (typeof layerOrVal === "number" || (typeof layerOrVal === "string" && !isNaN(layerOrVal))) {
      const val = Number(layerOrVal);
      nativeBridge.send("fx", { param: "stringsCutoff", layer: "A", value: val });
      nativeBridge.send("fx", { param: "stringsCutoff", layer: "B", value: val });
      return;
    }
    nativeBridge.send("fx", { param: "stringsCutoff", layer: layerOrVal, value: v });
  },
  level: (section, v) => nativeBridge.send("fx", { param: "sectionLevel", section, value: v }),
};

export const DRAWBARS = [
  { name: "16'", h: 1, color: "brown" }, { name: "5⅓'", h: 3, color: "brown" },
  { name: "8'", h: 2, color: "white" }, { name: "4'", h: 4, color: "white" },
  { name: "2⅔'", h: 6, color: "black" }, { name: "2'", h: 8, color: "white" },
  { name: "1⅗'", h: 10, color: "black" }, { name: "1⅓'", h: 12, color: "black" },
  { name: "1'", h: 16, color: "white" },
];

const organ = {
  manuals: [
    { bars: [8, 8, 8, 0, 0, 0, 0, 0, 0], model: "b3" },
    { bars: [8, 3, 8, 0, 0, 0, 0, 0, 0], model: "b3" },
  ],
  perc: { on: false, third: false, fast: false },
};

export const organApi = {
  setBar(i, level, manual = 0) {
    organ.manuals[manual].bars[i] = level;
    nativeBridge.send("organ", { action: "bar", manual, index: i, level });
  },
  setModel(m, manual = 0) {
    organ.manuals[manual].model = m;
    nativeBridge.send("organ", { action: "model", manual, model: m });
    this.setPerc({});
  },
  bars: (manual = 0) => [...organ.manuals[manual].bars],
  model: (manual = 0) => organ.manuals[manual].model,
  setPerc(p) {
    Object.assign(organ.perc, p);
    nativeBridge.send("organ", { action: "perc", perc: organ.perc });
  },
  setVib: (mode) => nativeBridge.send("organ", { action: "vib", mode }),
  setDrive: (v) => nativeBridge.send("organ", { action: "drive", value: v }),
  setRotary: (mode) => nativeBridge.send("organ", { action: "rotary", mode }),
  noteOn: (note, manual = 0) => nativeBridge.send("noteOn", { section: "organ", layer: manual ? "B" : "A", note, vel: 100 }),
  noteOff: (note, manual = 0) => nativeBridge.send("noteOff", { section: "organ", layer: manual ? "B" : "A", note }),
  allOff: () => nativeBridge.send("allOff", { section: "organ" }),
};

const SYNTH_PARAMS = ["osc", "detune", "cutoff", "reso", "fenv", "attack", "decay", "sustain", "release"];

function makeSynth(defaults, layerName = "A") {
  const synth = { ...defaults };
  return {
    attachSampler() {},
    setQuality(mode) {
      nativeBridge.send("fx", { param: "perfMode", value: mode === "studio" ? "studio" : "live" });
    },
    params: () => Object.fromEntries(SYNTH_PARAMS.map((k) => [k, synth[k]])),
    set(param, v) {
      synth[param] = v;
      nativeBridge.send("synthParam", { layer: layerName, param, value: v });
    },
    sustain: (down) => nativeBridge.send("sustain", { section: "synth", layer: layerName, down }),
    bend: (semis) => nativeBridge.send("pitchBend", { section: "synth", layer: layerName, semis }),
    mod: (v) => nativeBridge.send("modWheel", { section: "synth", layer: layerName, value: v }),
    noteOn: (note, vel) => nativeBridge.send("noteOn", { section: "synth", layer: layerName, note, vel, sample: synth.osc === "sample" }),
    noteOff: (note) => nativeBridge.send("noteOff", { section: "synth", layer: layerName, note }),
    kill: (note) => nativeBridge.send("noteOff", { section: "synth", layer: layerName, note }),
    allOff: () => nativeBridge.send("allOff", { section: "synth", layer: layerName }),
  };
}

export const synthApi = makeSynth({
  osc: "sawtooth", detune: 0.3, cutoff: 0.55, reso: 0.2, fenv: 0.4, attack: 0.05, decay: 0.4, sustain: 0.7, release: 0.3,
}, "A");
export const synthApiB = makeSynth({
  osc: "super", detune: 0.4, cutoff: 0.45, reso: 0.1, fenv: 0.2, attack: 0.3, decay: 0.5, sustain: 0.8, release: 0.5,
}, "B");

const LAYER_SECTIONS = ["organ", "piano", "synth", "strings"];
const ZONES = ["all", "lower", "upper"];
const layerState = {
  split: 60,
  ...Object.fromEntries(LAYER_SECTIONS.map((s) => [s, {
    A: { on: true, level: 0.8, octave: 0, zone: "all" },
    B: { on: false, level: 0.8, octave: 0, zone: "all" },
  }])),
};

export const layers = {
  get: (section, layer) => ({ ...layerState[section][layer] }),
  set(section, layer, patch) {
    const l = layerState[section]?.[layer];
    if (!l) return;
    if (typeof patch.on === "boolean") l.on = patch.on;
    if (typeof patch.level === "number") l.level = Math.max(0, Math.min(1, patch.level));
    if (Number.isInteger(patch.octave)) l.octave = Math.max(-2, Math.min(2, patch.octave));
    if (ZONES.includes(patch.zone)) l.zone = patch.zone;
    nativeBridge.send("layer", { section, layer, patch });
  },
  split: () => layerState.split,
  setSplit(note) {
    layerState.split = Math.max(36, Math.min(96, Math.round(note)));
    nativeBridge.send("split", { note: layerState.split });
  },
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