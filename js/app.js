if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js?v=6").catch(() => {});
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    window.location.reload();
  });
}
console.log("LabPiano App v6 loading...");

// Liga painel, motores e leitor. Programas (A:01–A:08) guardam o painel inteiro no navegador.
// Layers A/B, zonas, split, amp e efeitos seguem o app nativo (Source/PluginEditor.cpp).
import { ctx, analyser, fx, organApi, synthApi, synthApiB, layers, DRAWBARS } from "./audio.js";
import * as piano from "./piano.js";
import * as strings from "./strings.js";
import * as sampler from "./sampler.js";
import { readSf2, noteName } from "./sf2reader.js";
import { mountContinuous, mountSelector, mountDrawbars, mountKeyboard, mountSeg, mountWheels } from "./controls.js";
import { icon, mountIcons } from "./icons.js";
import { fetchAccess, lockBlock, lockedNotice } from "./access.js";
import { mountTabs, mountKeyNav } from "./mobile.js";
import { mountMidiLearn } from "./midilearn.js";
import { mountWorkstation } from "./workstation.js";
import { mountAudioMidi } from "./audiomidi.js";
import { checkCachedSf2, saveCachedSf2, getCachedSf2, setCachedSf2, getHashCacheKey, getCachedBlob, setCachedBlob } from "./soundcache.js";

const $ = (id) => document.getElementById(id);
let access = { full: true };
async function setup() {
  try {
    access = await fetchAccess();
    mountIcons();
    
    // Render lists and load initial sound
    renderPianoList();
    renderStringsList();
    renderSynthList();
    showSynthPreset();

    loadUrlParamSound().then((embedded) => {
      if (!embedded) loadServerSounds().then(() => {
        const lastIdx = (() => {
          try {
            const saved = localStorage.getItem("labpiano.last_program");
            if (saved !== null && programs[Number(saved)]) return Number(saved);
          } catch {}
          return programs[0] ? 0 : -1;
        })();

        if (lastIdx >= 0 && programs[lastIdx]) {
          state.program = lastIdx;
          recall(programs[lastIdx]);
          showProgram();
          oled(`Program ${lastIdx + 1}`, "Preset restaurado", layerSummary());
        } else if (pianoSounds.length && loadedIndex.A < 0) {
          selectPiano(0, "A");
        }
        if (!loading) loadNoticeDone();
      });
    });
    loadUrlParamSynth();
    if (!programs[0]) oled("WorkestraPiano", "Carregue um SoundFont", layerSummary());
  } catch (e) {
    console.error("Setup error:", e);
    loadNoticeDone();
  }
}

const SECTIONS = ["organ", "piano", "synth", "strings"];
const LAYERS = ["A", "B"];
const state = {
  on: { organ: false, piano: true, synth: false, strings: false },
  oct: { organ: 0, piano: 0, synth: 0, strings: 0 },
  focus: { organ: "A", piano: "A", synth: "A", strings: "A" }, // layer em edição em cada seção
  transpose: 0,
  curve: 1,
  sustain: false,
  program: 0,
  splitArmed: false,
};
const pianoSounds = [];
const synthSounds = [];
const stringsSounds = [];
const loadedIndex = { A: -1, B: -1 }; // piano carregado em cada layer
let loading = null;
let pending = null;
let synthLoading = null;
const synthOf = (L) => (L === "B" ? synthApiB : synthApi);
const pianoOf = (L) => (L === "B" ? piano.B : piano);
const stringsOf = (L) => (L === "B" ? strings.B : strings);

// Displays de 7 segmentos: programa (A:01), transpose, oitava de cada seção e de cada layer, split.
const segProg = mountSeg($("segNum"), 3, { colon: 1 });
const segTrans = mountSeg($("segTrans"), 3);
const segSplit = mountSeg($("segSplit"), 3);
const segOct = Object.fromEntries([...document.querySelectorAll("[data-octv]")].map((el) => [el.dataset.octv, mountSeg(el, 2)]));
const segLOct = Object.fromEntries([...document.querySelectorAll("[data-loctv]")].map((el) => [el.dataset.loctv, mountSeg(el, 2)]));
const signed = (v) => (v > 0 ? `+${v}` : String(v));
const segSigned = (v) => (v < 0 ? String(v) : ` ${v}`);


// ---------- Display ----------
let loadTicket = 0;
let loadNoticeTimeout = null;

function loadNotice(title, detail, progress) {
  const box = $("loadBanner");
  if (!box) return;
  loadTicket++;
  box.hidden = false;
  document.body.classList.add("is-loading-sound");
  if (title != null) $("loadBannerTitle").textContent = title;
  if (detail != null) $("loadBannerDetail").textContent = detail;
  const p = Math.max(0, Math.min(1, Number(progress) || 0));
  $("loadBannerBar").style.width = `${Math.round(p * 100)}%`;
  $("loadBannerPct").textContent = `${Math.round(p * 100)}%`;
  $("loadBannerClose").hidden = true;

  // Se demorar mais de 5 segundos, libera o botão de fechar para não travar o usuário
  clearTimeout(loadNoticeTimeout);
  loadNoticeTimeout = setTimeout(() => {
    $("loadBannerClose").hidden = false;
  }, 5000);
}

function loadNoticeDone() {
  const ticket = loadTicket;
  clearTimeout(loadNoticeTimeout);
  setTimeout(() => {
    if (ticket !== loadTicket) return;
    const box = $("loadBanner");
    if (box) box.hidden = true;
    document.body.classList.remove("is-loading-sound");
  }, 700);
}

function loadNoticeFail(message) {
  loadNotice("Não carregou", message || "Tente de novo", 0);
  clearTimeout(loadNoticeTimeout);
  $("loadBannerClose").hidden = false;
}
$("loadBannerClose")?.addEventListener("click", loadNoticeDone);

function oled(title, l1, l2, progress) {
  const t = $("oledTitle");
  if (title != null && t.textContent !== title) {
    t.textContent = title;
    t.classList.remove("swap");
    void t.offsetWidth; // reinicia a animação de troca de título
    t.classList.add("swap");
  }
  if (l1 != null) $("oledLine1").textContent = l1;
  if (l2 != null) $("oledLine2").textContent = l2;
  $("oledBar").style.width = `${Math.round((progress ?? 0) * 100)}%`;
}
// Linha de status do OLED: seções e layers ligadas, pedal e split (como no nativo).
function oledStatus() {
  const parts = SECTIONS.map((s) => {
    const ls = LAYERS.map((L) => `<b class="${state.on[s] && layers.get(s, L).on ? "on" : ""}">${L}</b>`).join("");
    return `<span class="st ${state.on[s] ? "on" : ""}">${icon({ organ: "drawbars", piano: "piano", synth: "synth", strings: "strings" }[s], { size: 11, stroke: 1.2 })}${ls}</span>`;
  });
  if (anySplit()) parts.push(`<span class="st on">${icon("split", { size: 11, stroke: 1.2 })}${noteName(layers.split())}</span>`);
  parts.push(`<span class="st ${state.sustain ? "on" : ""}">${icon("pedal", { size: 11, stroke: 1.2 })}</span>`);
  $("oledStatus").innerHTML = parts.join("");
}
function showProgram() {
  const num = String(state.program + 1).padStart(2, "0");
  segProg.set(`A:${num}`, `Programa A:${num}`);
  document.querySelectorAll("#programs .btn").forEach((b, i) => { b.classList.toggle("on", i === state.program); b.setAttribute("aria-pressed", i === state.program); });
}
function layerSummary() {
  return SECTIONS.filter((s) => state.on[s]).map((s) => {
    const ls = LAYERS.filter((L) => layers.get(s, L).on).join("+");
    return `${s[0].toUpperCase() + s.slice(1)} ${ls}`;
  }).join(" · ") || "Nenhuma seção ligada";
}

// ---------- Controles contínuos ----------
const FX = { master: "master", bass: "bass", mid: "mid", treble: "treble", comp: "comp", chorus: "chorus",
  delay: "delay", delayTime: "delayTime", delayFeedback: "delayFeedback", reverb: "reverb", reverbSize: "reverbSize",
  reverbTone: "reverbTone", modRate: "mod1Rate", modAmount: "mod1Amount", stringsCutoff: "stringsCutoff" };
const SYNTH = new Set(["detune", "cutoff", "reso", "fenv", "attack", "decay", "sustain", "release"]);
const knobs = mountContinuous(document, (param, v) => {
  const parts = param.split(".");
  const head = parts[0];

  if (head === "L" && parts[3] === "cutoff") {
    fx.stringsCutoff(parts[2], v);
    return;
  }
  if (head === "L") return layers.set(parts[1], parts[2], { level: v });          // L.<seção>.<A|B>.level

  if (head === "amp") {
    const key = parts.length === 4 ? `${parts[1]}:${parts[2]}` : parts[1];
    return fx.ampDrive(key, v);
  }

  if (head === "fx" && parts[1]) {
    const key = parts.length === 4 ? `${parts[1]}:${parts[2]}` : parts[1];
    return fx.modSend(key, v);
  }

  if (head === "B" && SYNTH.has(parts[1])) return synthApiB.set(parts[1], v);    // B.<param> = synth da layer B
  if (FX[param]) fx[FX[param]](v);
  else if (SYNTH.has(param)) synthApi.set(param, v);
  else if (param === "drive") organApi.setDrive(v);
  else if (param.endsWith("Level")) fx.level(param.replace("Level", ""), v);

  // Se aumentou o Amount do Mod e nenhuma seção está enviando som para o FX,
  // ativa automaticamente o envio na seção ativa para o efeito soar e o LED acender
  if (param === "modAmount" && v > 0.001 && panelReady) {
    const AMP_SEND_KEYS = ["organ", "piano", "synth:A", "synth:B", "strings:A", "strings:B"];
    const anySend = AMP_SEND_KEYS.some((k) => kv(`fx.${k}.send`) > 0.001);
    if (!anySend) {
      const targetSec = (state?.on?.piano ?? true) ? "piano" : (state?.on?.synth ? "synth.A" : (state?.on?.organ ? "organ" : "piano"));
      knobs.get(`fx.${targetSec}.send`)?.set(0.7);
    }
  }

  refreshFxLeds();
});

const drawbars = mountDrawbars($("drawbars"), DRAWBARS, [8, 8, 8, 0, 0, 0, 0, 0, 0], (i, lvl) => organApi.setBar(i, lvl, 0));
const drawbarsB = mountDrawbars($("drawbarsB"), DRAWBARS, [8, 3, 8, 0, 0, 0, 0, 0, 0], (i, lvl) => organApi.setBar(i, lvl, 1));
const selectors = {
  organModel: mountSelector($("organModel"), "model", (m) => organApi.setModel(m, 0)),
  organModelB: mountSelector($("organModelB"), "model", (m) => organApi.setModel(m, 1)),
  perc: mountSelector($("percSel"), "perc", (p) => organApi.setPerc(p)),
  vib: mountSelector($("vibSel"), "vib", (v) => organApi.setVib(+v)),
  rotary: mountSelector($("rotarySel"), "rotary", (v) => organApi.setRotary(+v)),
  curve: mountSelector($("curveSel"), "curve", (v) => (state.curve = +v)),
  timbre: mountSelector($("timbreSel"), "timbre", (v) => fx.timbre(+v)),
  osc: mountSelector($("oscSel"), "osc", (v) => synthApi.set("osc", v)),
  oscB: mountSelector($("oscSelB"), "osc", (v) => synthApiB.set("osc", v)),
  modType: mountSelector($("modType"), "mod", (v) => fx.mod1Type(v)),
  delayMode: mountSelector($("delayMode"), "dmode", (v) => fx.delayMode(v)),
  reverbType: mountSelector($("reverbType"), "rtype", (v) => fx.reverbType(v)),
  amp_organ: mountSelector($("amp_organ"), "amp", (t) => { fx.ampType("organ", t); refreshFxLeds(); }),
  amp_piano: mountSelector($("amp_piano"), "amp", (t) => { fx.ampType("piano", t); refreshFxLeds(); }),
  amp_synth_A: mountSelector($("amp_synth_A"), "amp", (t) => { fx.ampType("synth:A", t); refreshFxLeds(); }),
  amp_synth_B: mountSelector($("amp_synth_B"), "amp", (t) => { fx.ampType("synth:B", t); refreshFxLeds(); }),
  amp_strings_A: mountSelector($("amp_strings_A"), "amp", (t) => { fx.ampType("strings:A", t); refreshFxLeds(); }),
  amp_strings_B: mountSelector($("amp_strings_B"), "amp", (t) => { fx.ampType("strings:B", t); refreshFxLeds(); }),
};
selectors.amp_synth = selectors.amp_synth_A;
selectors.amp_strings = selectors.amp_strings_A;

organApi.setRotary(0);
organApi.setVib(0);

// LED "ativo" dos blocos de efeito e do Amp de cada seção (regras do nativo).
// Os callbacks dos controles já disparam durante a montagem, antes de knobs/selectors existirem:
// `var` (içada como undefined) evita o erro de TDZ até o painel ficar pronto.
var panelReady = false; // eslint-disable-line no-var
const kv = (p) => knobs.get(p)?.get() ?? 0;
function refreshFxLeds() {
  if (!panelReady) return;
  const AMP_SEND_KEYS = ["organ", "piano", "synth:A", "synth:B", "strings:A", "strings:B", "synth", "strings"];
  const anySend = AMP_SEND_KEYS.some((k) => kv(`fx.${k}.send`) > 0.001);
  const active = {
    mod: kv("modAmount") > 0.001 && anySend,
    delay: kv("delay") > 0.001,
    reverb: kv("reverb") > 0.001,
    eq: kv("chorus") > 0.001 || kv("comp") > 0.001 || ["bass", "mid", "treble"].some((p) => Math.abs(kv(p) - 0.5) > 0.01),
  };
  for (const [k, on] of Object.entries(active)) document.querySelector(`.fx-block[data-fx="${k}"]`)?.classList.toggle("on", on);
  document.querySelectorAll("[data-amp-head]").forEach((h) => {
    const key = h.dataset.ampHead;
    const selKey = key.includes(":") ? `amp_${key.replace(":", "_")}` : `amp_${key}`;
    const on = selectors[selKey]?.get() !== "off";
    h.classList.toggle("on", on);
  });
}
panelReady = true;

// Permite alternar o efeito clicando no título ou LED do bloco
const fxBlockToggles = {
  mod: () => {
    const anySend = SECTIONS.some((s) => kv(`fx.${s}.send`) > 0.001);
    const targetSec = (state?.on?.piano ?? true) ? "piano" : (state?.on?.synth ? "synth" : "organ");
    if (anySend && kv("modAmount") > 0.001) {
      SECTIONS.forEach((s) => knobs.get(`fx.${s}.send`)?.set(0));
    } else {
      if (kv("modAmount") < 0.05) knobs.get("modAmount")?.set(0.5);
      knobs.get(`fx.${targetSec}.send`)?.set(0.7);
    }
  },
  delay: () => {
    const cur = kv("delay");
    knobs.get("delay")?.set(cur > 0.001 ? 0 : 0.4);
  },
  reverb: () => {
    const cur = kv("reverb");
    knobs.get("reverb")?.set(cur > 0.001 ? 0 : 0.25);
  },
  eq: () => {
    const on = kv("chorus") > 0.001 || kv("comp") > 0.001 || ["bass", "mid", "treble"].some((p) => Math.abs(kv(p) - 0.5) > 0.01);
    if (on) {
      knobs.get("chorus")?.set(0);
      knobs.get("comp")?.set(0);
      knobs.get("bass")?.set(0.5);
      knobs.get("mid")?.set(0.5);
      knobs.get("treble")?.set(0.5);
    } else {
      knobs.get("bass")?.set(0.65);
      knobs.get("treble")?.set(0.65);
    }
  },
};
for (const [k, toggle] of Object.entries(fxBlockToggles)) {
  const head = document.querySelector(`.fx-block[data-fx="${k}"] .blk-h`);
  if (head) {
    head.style.cursor = "pointer";
    head.addEventListener("click", () => { toggle(); refreshFxLeds(); });
  }
}

// MIDI Learn (depois dos controles montados: usa os rótulos e os get/set deles).
const midiLearn = mountMidiLearn({ root: $("instrument"), button: $("midiBtn"), knobs, drawbars: { drawbars, drawbarsB }, notify: oled });

// ---------- Seções e layers ----------
function setOn(section, on) {
  console.log("setOn", section, on);
  state.on[section] = on;
  const btn = document.querySelector(`[data-on="${section}"]`);
  if (btn) {
    btn.classList.toggle("on", on);
    btn.setAttribute("aria-pressed", on);
  }
  const activeTab = document.querySelector(".syn-tab-btn.on")?.dataset.synTab || "synth";
  const secEl = document.querySelector(`[data-section="${section}"]`) || document.querySelector(`.m-synth`);
  if (secEl && (section === "synth" || section === "strings")) {
    secEl.classList.toggle("off", !state.on[activeTab]);
    document.querySelector('.syn-view-pane[data-tab-pane="synth"]')?.classList.toggle("off", !state.on.synth);
    document.querySelector('.syn-view-pane[data-tab-pane="strings"]')?.classList.toggle("off", !state.on.strings);
  } else if (secEl) {
    secEl.classList.toggle("off", !on);
  }
  if (!on) {
    if (section === "organ") organApi.allOff();
    else if (section === "synth") { synthApi.allOff(); synthApiB.allOff(); }
    else if (section === "strings") { strings.allOff(); strings.B.allOff(); }
    else { piano.allOff(); piano.B.allOff(); }
  }
  oled(null, null, layerSummary());
  refreshLayers();
}
document.querySelectorAll("[data-on]").forEach((b) => b.addEventListener("click", () => setOn(b.dataset.on, !state.on[b.dataset.on])));

// A/B: botão de outra layer passa a editá-la (e liga se estava desligada); o botão em foco liga/desliga.
function clickLayer(sec, L) {
  if (state.focus[sec] !== L) {
    state.focus[sec] = L;
    if (!layers.get(sec, L).on) layers.set(sec, L, { on: true });
  } else {
    layers.set(sec, L, { on: !layers.get(sec, L).on });
  }
  refreshLayers();
  if (sec === "piano") renderPianoList();
  if (sec === "strings") renderStringsList();
}
document.querySelectorAll(".lbtn").forEach((b) => b.addEventListener("click", () => clickLayer(b.dataset.lsec, b.dataset.layer)));

function setLayerOct(sec, L, v) {
  const o = Math.max(-2, Math.min(2, v));
  layers.set(sec, L, { octave: o });
  if (segLOct[`${sec}:${L}`]) segLOct[`${sec}:${L}`].set(segSigned(o), `Oitava da layer ${L} ${signed(o)}`);
}
document.querySelectorAll("[data-loct]").forEach((b) => b.addEventListener("click", () => {
  const [s, L, d] = b.dataset.loct.split(":");
  allNotesOff();
  setLayerOct(s, L, layers.get(s, L).octave + +d);
}));

function setZone(sec, L, z) {
  layers.set(sec, L, { zone: z });
  document.querySelectorAll(`[data-zone="${sec}:${L}"] button`).forEach((b) => {
    const on = b.dataset.z === z;
    b.classList.toggle("on", on);
    b.setAttribute("aria-checked", on);
  });
  refreshLayers();
}
document.querySelectorAll("[data-zone] button").forEach((b) => b.addEventListener("click", () => {
  const [s, L] = b.closest("[data-zone]").dataset.zone.split(":");
  allNotesOff();
  setZone(s, L, b.dataset.z);
}));

function refreshLayers() {
  for (const s of SECTIONS) {
    const el = document.querySelector(`[data-section="${s}"]`) || document.querySelector(`.m-synth`);
    if (!el) continue;
    el.dataset.focus = state.focus[s];
    el.querySelectorAll(`.lbtn[data-lsec="${s}"]`).forEach((b) => {
      const on = layers.get(s, b.dataset.layer).on;
      b.classList.toggle("on", on);
      b.classList.toggle("focus", b.dataset.layer === state.focus[s]);
      b.setAttribute("aria-pressed", on);
    });
  }
  $("loadLabel").textContent = state.focus.piano === "B" ? "Load (B)" : "Load";
  if ($("stringsLoadLabel")) $("stringsLoadLabel").textContent = state.focus.strings === "B" ? "Load (B)" : "Load";
  refreshSplit();
  oledStatus();
}

// ---------- Split ----------
const anySplit = () => SECTIONS.some((s) => state.on[s] && LAYERS.some((L) => layers.get(s, L).on && layers.get(s, L).zone !== "all"));
const MINI_LO = 24, MINI_HI = 107; // C1…B7, como o mini-teclado do nativo
function buildMiniKeys() {
  const el = $("miniKeys");
  let html = "";
  for (let n = MINI_LO; n <= MINI_HI; n++) html += `<i class="${[1, 3, 6, 8, 10].includes(n % 12) ? "b" : "w"}" data-n="${n}"></i>`;
  el.innerHTML = html + `<u class="mk-mark"></u>`;
  el.addEventListener("click", (e) => { const k = e.target.closest("[data-n]"); if (k) setSplit(+k.dataset.n); });
  el.addEventListener("keydown", (e) => {
    const d = { ArrowLeft: -1, ArrowRight: 1, ArrowDown: -1, ArrowUp: 1 }[e.key];
    if (d) { e.preventDefault(); setSplit(layers.split() + d); }
  });
}
function setSplit(n) {
  allNotesOff();
  layers.setSplit(n);
  armSplit(false);
  refreshSplit();
  oled(null, `Split em ${noteName(layers.split())}`, null, 0);
}
function armSplit(on) {
  state.splitArmed = on;
  $("splitSet").classList.toggle("armed", on);
  $("splitSet").classList.toggle("on", on);
}
function refreshSplit() {
  const n = layers.split();
  segSplit.set(String(n), `Split ${noteName(n)}`);
  const mk = $("miniKeys");
  mk.setAttribute("aria-valuenow", n);
  mk.setAttribute("aria-valuetext", noteName(n));
  mk.style.setProperty("--split", (n - MINI_LO) / (MINI_HI - MINI_LO + 1));
  mk.querySelectorAll("[data-n]").forEach((k) => k.classList.toggle("upper", +k.dataset.n >= n));
  // Marcador sobre o teclado grande: só quando alguma layer ligada usa zona.
  const mark = $("splitMark");
  const key = document.querySelector(`#keyboard [data-note="${n}"]`);
  mark.hidden = !anySplit() || !key;
  if (key) mark.style.left = `${key.offsetLeft}px`;
  oledStatus?.();
}
$("splitDown").addEventListener("click", () => setSplit(layers.split() - 1));
$("splitUp").addEventListener("click", () => setSplit(layers.split() + 1));
$("splitSet").addEventListener("click", () => { armSplit(!state.splitArmed); if (state.splitArmed) oled(null, "Toque a tecla do split", null, 0); });
buildMiniKeys();

// Oitava por seção e transpose global
function setOct(section, v) {
  state.oct[section] = Math.max(-3, Math.min(3, v));
  segOct[section].set(segSigned(state.oct[section]), `Oitava ${signed(state.oct[section])}`);
}
document.querySelectorAll("[data-oct]").forEach((b) => b.addEventListener("click", () => {
  const [s, d] = b.dataset.oct.split(":");
  allNotesOff();
  setOct(s, state.oct[s] + +d);
}));
function setTranspose(v) {
  allNotesOff();
  state.transpose = Math.max(-12, Math.min(12, v));
  segTrans.set(String(state.transpose), `Transpose ${signed(state.transpose)}`);
}
$("transDown").addEventListener("click", () => setTranspose(state.transpose - 1));
$("transUp").addEventListener("click", () => setTranspose(state.transpose + 1));
SECTIONS.forEach((s) => { setOct(s, 0); LAYERS.forEach((L) => setLayerOct(s, L, 0)); });
segTrans.set("0", "Transpose 0");

function setSustain(down) {
  state.sustain = down;
  $("sustainBtn").classList.toggle("on", down);
  $("sustainBtn").setAttribute("aria-pressed", down);
  piano.sustain(down);
  piano.B.sustain(down);
  synthApi.sustain(down); // pad com pedal faz muita diferença
  synthApiB.sustain(down);
  strings.sustain(down);
  strings.B.sustain(down);
  oledStatus();
}
$("sustainBtn").addEventListener("click", () => setSustain(!state.sustain));
$("panicBtn").addEventListener("click", () => {
  allNotesOff();
  setSustain(false);
  const b = $("panicBtn");
  b.classList.remove("flash");
  void b.offsetWidth;
  b.classList.add("flash"); // pisca o LED três vezes, como no nativo
});

// ---------- Notas ----------
const held = new Map(); // tecla física → [{ s, L, n }] enviadas
// Teclas físicas (tela, QWERTY, MIDI, pads) passam pelo arpejador / chord memory do layout Workstation.
let ws = null;
function keyOn(key, vel) { if (state.splitArmed || !ws) noteOn(key, vel); else ws.keyOn(key, vel); }
function keyOff(key) { if (!ws) noteOff(key); else ws.keyOff(key); }
const kb = mountKeyboard($("keyboard"), (n, v) => (v ? keyOn(n, v) : keyOff(n)));

function noteOn(key, rawVel) {
  if (ctx.state !== "running") ctx.resume();
  if (state.splitArmed) { setSplit(key); return; } // SPLIT + tecla
  noteOff(key);
  const vel = Math.max(1, Math.round(127 * Math.pow(rawVel / 127, state.curve)));
  const sent = [];
  for (const s of SECTIONS) {
    if (!state.on[s]) continue;
    for (const L of LAYERS) {
      const n = layers.target(s, L, key, key + state.transpose + state.oct[s] * 12);
      if (n == null || n < 0 || n > 127) continue;
      sent.push({ s, L, n });
      if (s === "organ") organApi.noteOn(n, L === "B" ? 1 : 0);
      else if (s === "synth") synthOf(L).noteOn(n, vel);
      else if (s === "strings") stringsOf(L).noteOn(n, vel);
      else {
        pianoOf(L).noteOn(n, vel);
      }
    }
  }
  held.set(key, sent);
  kb.show(key, true, vel);
  if (state.on.piano && !loading && !synthLoading) oled(null, `${noteName(key)} · vel ${vel}`, null, vel / 127);
}

function noteOff(key) {
  const sent = held.get(key);
  if (!sent) return;
  for (const { s, L, n } of sent) {
    if (s === "organ") organApi.noteOff(n, L === "B" ? 1 : 0);
    else if (s === "synth") synthOf(L).noteOff(n);
    else if (s === "strings") stringsOf(L).noteOff(n);
    else pianoOf(L).noteOff(n);
  }
  held.delete(key);
  kb.show(key, false);
}

function allNotesOff() {
  for (const k of [...held.keys()]) noteOff(k);
  organApi.allOff();
  synthApi.allOff();
  synthApiB.allOff();
  strings.allOff();
  strings.B.allOff();
  piano.allOff();
  piano.B.allOff();
}

// Teclado do computador: duas fileiras a partir de C3 e C4; setas mudam a oitava do teclado.
const QWERTY = { z: 0, s: 1, x: 2, d: 3, c: 4, v: 5, g: 6, b: 7, h: 8, n: 9, j: 10, m: 11, ",": 12,
  q: 12, 2: 13, w: 14, 3: 15, e: 16, r: 17, 5: 18, t: 19, 6: 20, y: 21, 7: 22, u: 23, i: 24 };
let qwertyBase = 48;
addEventListener("keydown", (e) => {
  if (e.target.closest("input, textarea, [role=slider], [role=radio]") || e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key === " " && e.target.closest("button")) return; // espaço aciona o botão focado, não o sustain
  if (e.key === " ") { e.preventDefault(); if (!e.repeat) setSustain(true); return; }
  if (e.key === "ArrowLeft" || e.key === "ArrowRight") { allNotesOff(); qwertyBase = Math.max(24, Math.min(84, qwertyBase + (e.key === "ArrowLeft" ? -12 : 12))); return; }
  const off = QWERTY[e.key.toLowerCase()];
  if (off == null || e.repeat) return;
  keyOn(qwertyBase + off, 96);
});
addEventListener("keyup", (e) => {
  if (e.key === " ") { if (!e.target.closest("button")) setSustain(false); return; }
  const off = QWERTY[e.key.toLowerCase()];
  if (off != null) keyOff(qwertyBase + off);
});

// Pitch stick e mod wheel (±2 semitons em piano e synth; mod = vibrato do synth + CC1 do piano), nas duas layers.
const BEND_RANGE = 2;
function setBend(x) {
  const v = Math.max(0, Math.min(16383, Math.round(8192 + x * 8191)));
  piano.pitchBend(v);
  piano.B.pitchBend(v);
  synthApi.bend(x * BEND_RANGE);
  synthApiB.bend(x * BEND_RANGE);
  strings.pitchBend(v);
  strings.B.pitchBend(v);
}
function setMod(m) {
  piano.modWheel(m);
  piano.B.modWheel(m);
  synthApi.mod(m);
  synthApiB.mod(m);
  strings.modWheel(m);
  strings.B.modWheel(m);
}
mountWheels($("wheels"), setBend, setMod);

// Gerenciamento completo de Áudio e MIDI: seleção de dispositivos, canais, roteamento,
// saída de áudio, quantidade de amostras / buffer e monitor em tempo real.
if (!navigator.requestMIDIAccess && $("midiBtn")) $("midiBtn").hidden = true;
mountAudioMidi({
  button: $("audioMidiBtn"),
  dialog: $("audioMidiModal"),
  midiLearn,
  keyOn,
  keyOff,
  setSustain,
  setMod,
  setBend,
  onProgramChange: (p) => {
    const btns = document.querySelectorAll("#programs .btn");
    if (btns[p]) btns[p].click();
  },
  allNotesOff,
  notify: oled
});

// ---------- Pianos (SF2 e arquivos Nord / Fantom / WAV) ----------
// Etiqueta = formato do arquivo (sem nome de marca na interface).
const tag = (s) => (s.fantom ? "SVZ" : s.wav ? "WAV" : s.nord ? (/\.nsmp4$/i.test(s.name) ? "NSMP4" : /\.nsmp3$/i.test(s.name) ? "NSMP3" : /\.nsmp$/i.test(s.name) ? "NSMP" : "NPNO") : "SF2");
const EXT = /\.(sf2|npno|nsmp|nsmp3|nsmp4|svz|wav)$/i;
function renderPianoList() {
  const ul = $("pianoList");
  const L = state.focus.piano;
  const cur = loadedIndex[L];
  const none = L === "B" ? `<li><button data-i="-1" class="${cur < 0 ? "on" : ""}"><span class="led"></span><span class="nm">Nenhum</span></button></li>` : "";
  if (!pianoSounds.length && !none) { ul.innerHTML = `<li class="empty">Solte .sf2, .npno, .nsmp3, .nsmp4 ou .wav aqui</li>`; return; }
  ul.innerHTML = none + pianoSounds.map((s, i) => `<li><button data-i="${i}" class="${i === cur ? "on" : ""}" title="${s.name.replace(EXT, "")}"><span class="led"></span><span class="nm">${s.name.replace(EXT, "")}</span></button></li>`).join("");
}
$("pianoList").addEventListener("click", (e) => { const b = e.target.closest("button[data-i]"); if (b) selectPiano(+b.dataset.i, state.focus.piano); });

// Um carregamento por vez; o pedido feito durante um carregamento (o último) roda em seguida.
async function selectPiano(i, L = "A") {
  if (loading) {
    pending = [i, L];
    oled(null, null, `Na fila: ${pianoSounds[i]?.name.replace(EXT, "") ?? "Nenhum"}`);
    return;
  }
  allNotesOff();
  if (i < 0) { // layer B: "Nenhum" descarrega
    piano.B.unload?.();
    loadedIndex.B = -1;
    renderPianoList();
    oled("Layer B sem piano", null, layerSummary(), 0);
    return;
  }
  const s = pianoSounds[i];
  const before = loadedIndex[L];
  loadedIndex[L] = i;
  renderPianoList();
  loading = (async () => {
    let failed = false;
    try {
      loadNotice(s.name.replace(EXT, ""), "Lendo o arquivo…", 0.04);
      const src = await getSf2Source(s);
      oled(src.name.replace(/\.sf2$/i, ""), "Lendo SF2…", null, 0);
      const sf = await readSf2(src);
      const firstPreset = sf.presets[0];
      const bank = firstPreset?.bank ?? 0;
      const preset = firstPreset?.preset ?? 0;
      const zones = firstPreset?.instruments.flatMap((x) => x.zones) ?? [];
      oled(null, "Carregando no FluidSynth…", `${zones.length} zonas · ${sf.samples.length} amostras`, 0);
      loadNotice(src.name.replace(EXT, ""), "Carregando o piano…", 0.08);
      await pianoOf(L).load(src, (p) => {
        const pct = Math.round(p * 100);
        oled(null, `Carregando no FluidSynth… ${pct}%`, null, p);
        loadNotice(null, `Carregando o piano… ${pct}%`, Math.max(0.08, p));
      }, bank, preset);
      // Camadas de velocity: as que cobrem uma mesma tecla (o máximo entre as notas gravadas).
      const perKey = new Map();
      for (const z of zones) {
        if (!perKey.has(z.root)) perKey.set(z.root, new Set());
        perKey.get(z.root).add(`${z.vel[0]}-${z.vel[1]}`);
      }
      const layersCount = Math.max(0, ...[...perKey.values()].map((v) => v.size));
      oled(null, `${perKey.size} notas · ${layersCount} camadas`, layerSummary(), 0);
      if (L === "A") state.pianoName = s.name;
      else state.pianoNameB = s.name;
    } catch (err) {
      console.error(err);
      loadedIndex[L] = before;
      renderPianoList();
      failed = true;
      oled(null, "Erro ao carregar", String(err.message || err), 0);
      loadNoticeFail(String(err.message || err));
    } finally {
      loading = null;
      if (pending) {
        const [pi, pl] = pending;
        pending = null;
        selectPiano(pi, pl);
      } else if (!failed) loadNoticeDone();
    }
  })();
}

// Obtém a fonte .sf2 para o FluidSynth: verifica o IndexedDB antes de processar/converter qualquer arquivo.
// Se o arquivo já foi convertido anteriormente e está salvo no cache, carrega-o diretamente do IndexedDB para economizar CPU.
async function getSf2Source(s) {
  if (s.converted) return s.converted;

  // 1. Verifica no IndexedDB se já existe o .sf2 em cache
  const cached = await checkCachedSf2(s);
  if (cached) {
    oled(s.name.replace(EXT, ""), "Carregado do cache", layerSummary(), 0.05);
    loadNotice(s.name.replace(EXT, ""), "Carregando do cache IndexedDB (zero CPU)…", 0.05);
    return cached;
  }

  // 2. Se for formato que necessita de conversão, executa o conversor específico
  if (s.nord) return await nordSource(s);
  if (s.fantom) return await fantomSource(s);
  if (s.wav) return await wavSource(s);

  // 3. Se for .sf2 original com Blob, salva no cache local para carregamento instantâneo futuro
  if (s.file && s.file instanceof Blob) {
    saveCachedSf2(s, s.file).catch(() => {});
  }
  return s;
}

// Arquivo Nord (.npno/.nsmp3/.nsmp4): convertido em SF2 com cache baseado em hash SHA-256 do conteúdo.
async function nordSource(s) {
  if (s.converted) return s.converted;
  const fileBytes = await (s.file ?? (await fetch(s.url))).arrayBuffer();
  const cacheKey = await getHashCacheKey("nord", fileBytes);
  const cachedBlob = await getCachedBlob(cacheKey);
  if (cachedBlob) {
    console.log(`[Cache] SF2 Nord recuperado do cache por hash (zero CPU): ${s.name}`);
    s.converted = { name: s.name.replace(/\.(npno|nsmp|nsmp3|nsmp4)$/i, ".sf2"), size: cachedBlob.size, file: cachedBlob, slice: (a, b) => cachedBlob.slice(a, b) };
    s.size = cachedBlob.size;
    return s.converted;
  }
  oled(s.name.replace(/\.(npno|nsmp|nsmp3|nsmp4)$/i, ""), "Convertendo Nord → SF2…", null, 0);
  loadNotice(s.name.replace(/\.(npno|nsmp|nsmp3|nsmp4)$/i, ""), "Convertendo o arquivo…", 0.05);
  const { nordToSf2 } = await import("./nord.js");
  const bytes = new Uint8Array(fileBytes);
  const out = await nordToSf2(bytes, { onProgress: (p) => {
    oled(null, `Convertendo Nord → SF2… ${Math.round(p * 100)}%`, null, p);
    loadNotice(null, `Convertendo o arquivo… ${Math.round(p * 100)}%`, p);
  } });
  const blob = new Blob([out.sf2], { type: "audio/x-soundfont" });
  await setCachedBlob(cacheKey, blob, s.name);
  s.converted = { name: `${out.name}.sf2`, size: blob.size, file: blob, slice: (a, b) => blob.slice(a, b) };
  s.size = blob.size;
  return s.converted;
}

// Arquivo WAV (.wav): convertido em SF2 com cache baseado em hash SHA-256 do conteúdo.
async function wavSource(s) {
  if (s.converted) return s.converted;
  const fileBytes = await (s.file ?? (await fetch(s.url))).arrayBuffer();
  const cacheKey = await getHashCacheKey("wav", fileBytes);
  const cachedBlob = await getCachedBlob(cacheKey);
  if (cachedBlob) {
    console.log(`[Cache] SF2 WAV recuperado do cache por hash (zero CPU): ${s.name}`);
    s.converted = { name: s.name.replace(/\.wav$/i, ".sf2"), size: cachedBlob.size, file: cachedBlob, slice: (a, b) => cachedBlob.slice(a, b) };
    s.size = cachedBlob.size;
    return s.converted;
  }
  oled(s.name.replace(/\.wav$/i, ""), "Convertendo WAV → SF2…", null, 0);
  loadNotice(s.name.replace(/\.wav$/i, ""), "Convertendo o áudio…", 0.05);
  const { wavToSf2 } = await import("./wav.js");
  const bytes = new Uint8Array(fileBytes);
  const out = await wavToSf2(bytes, { name: s.name.replace(/\.wav$/i, ""), onProgress: (p) => {
    oled(null, `Convertendo WAV → SF2… ${Math.round(p * 100)}%`, null, p);
    loadNotice(null, `Convertendo o áudio… ${Math.round(p * 100)}%`, p);
  } });
  const blob = new Blob([out.sf2], { type: "audio/x-soundfont" });
  await setCachedBlob(cacheKey, blob, s.name);
  s.converted = { name: `${out.name}.sf2`, size: blob.size, file: blob, slice: (a, b) => blob.slice(a, b) };
  s.size = blob.size;
  return s.converted;
}

// Multisample do Roland Fantom (.svz) com cache baseado em hash SHA-256 do conteúdo.
async function fantomSource(s) {
  if (s.converted) return s.converted;
  const res = s.file ?? (await fetch(s.url));
  if (!s.file && !res.ok) throw new Error(`HTTP ${res.status} ao baixar ${s.name}`);
  const fileBytes = await res.arrayBuffer();
  const cacheKey = await getHashCacheKey("svz", fileBytes, s.tone);
  const cachedBlob = await getCachedBlob(cacheKey);
  if (cachedBlob) {
    console.log(`[Cache] SF2 SVZ recuperado do cache por hash (zero CPU): ${s.name}`);
    s.converted = { name: s.name.replace(/\.svz$/i, ".sf2"), size: cachedBlob.size, file: cachedBlob, slice: (a, b) => cachedBlob.slice(a, b) };
    s.size = cachedBlob.size;
    return s.converted;
  }
  oled(s.name.replace(/\.svz$/i, ""), "Convertendo SVZ → SF2…", null, 0);
  loadNotice(s.name.replace(/\.svz$/i, ""), "Convertendo o arquivo…", 0.05);
  const { fantomToSf2 } = await import("./fantom.js");
  const bytes = new Uint8Array(fileBytes);
  const out = await fantomToSf2(bytes, { tone: s.tone, onProgress: (p) => {
    oled(null, `Convertendo SVZ → SF2… ${Math.round(p * 100)}%`, null, p);
    loadNotice(null, `Convertendo o arquivo… ${Math.round(p * 100)}%`, p);
  } });
  if (out.skipped.length) console.warn(`${s.name}: partials fora do SF2`, out.skipped);
  const blob = new Blob([out.sf2], { type: "audio/x-soundfont" });
  await setCachedBlob(cacheKey, blob, s.name);
  s.converted = { name: `${out.name}.sf2`, size: blob.size, file: blob, slice: (a, b) => blob.slice(a, b) };
  s.size = blob.size;
  return s.converted;
}

// Um item por tom que toque os multisamples do arquivo; se não der para ler, o arquivo inteiro.
async function fantomEntries(f) {
  const base = { size: f.size, file: f, fantom: true, slice: (a, b) => f.slice(a, b) };
  try {
    const { listSvzTones } = await import("./fantom.js");
    const tones = (await listSvzTones(f)).filter((t) => t.playable);
    if (tones.length > 1) return tones.map((t) => ({ ...base, name: `${f.name.replace(/\.svz$/i, "")} · ${t.name}.svz`, tone: t.index }));
  } catch (err) { console.warn(f.name, err); }
  return [{ ...base, name: f.name }];
}

const isNord = (name) => /\.(npno|nsmp|nsmp3|nsmp4)$/i.test(name);
const isFantom = (name) => /\.svz$/i.test(name);
const isWav = (name) => /\.wav$/i.test(name);
async function addFiles(files, module = "piano") {
  if (!access.full) { lockedNotice(access, "Abrir outros SF2"); return; }
  files = [...files]; // o FileList do drop/input pode esvaziar depois do primeiro await
  let first = -1; // o arquivo aberto (ou o primeiro de vários) vai para a layer em foco
  for (const f of files) {
    if (!/\.sf2$/i.test(f.name) && !isNord(f.name) && !isFantom(f.name) && !isWav(f.name)) continue;
    const entries = isFantom(f.name)
      ? await fantomEntries(f)
      : [{ name: f.name, size: f.size, file: f, nord: isNord(f.name), wav: isWav(f.name), slice: (a, b) => f.slice(a, b) }];
    for (const e of entries) {
      const targetList = module === "piano" ? pianoSounds : (module === "strings" ? stringsSounds : synthSounds);
      let i = targetList.findIndex((s) => s.name === e.name && s.file?.size === f.size);
      if (i < 0) {
        targetList.push({...e});
        i = targetList.length - 1;
      }
      if (first < 0) first = i;
    }
  }
  if (module === "piano") renderPianoList();
  else if (module === "strings") renderStringsList();
  else if (module === "synth") renderSynthList();
  if (first >= 0) {
    if (module === "piano") selectPiano(first, state.focus.piano);
    else if (module === "strings") selectStrings(first, state.focus.strings);
    else if (module === "synth") selectSynthSound(first);
  }
}

// Arquivos servidos pelo serve.mjs (pasta de SF2 configurada), lidos por Range sob demanda.
// O leitor só usa source.slice(a, b).arrayBuffer(), igual para File e para URL.
const urlSound = (name, size, url) => ({
  name, size, url, nord: isNord(name), fantom: isFantom(name), wav: isWav(name),
  slice: (a, b) => ({ arrayBuffer: () => fetch(url, { headers: { Range: `bytes=${a}-${b - 1}` } }).then((r) => r.arrayBuffer()) }),
});

async function loadServerSounds() {
  try {
    const res = await fetch("api/sounds");
    if (res.ok) {
      const list = await res.json();
      if (Array.isArray(list)) {
        for (const s of list) {
          if (!pianoSounds.some((x) => x.name === s.name)) {
            pianoSounds.push(urlSound(s.name, s.size, `sounds/${encodeURIComponent(s.name)}`));
          }
        }
      }
    }
  } catch { /* sem servidor de sons: usa default ou arrastar arquivos */ }
  if (!pianoSounds.length) {
    try {
      const { generateDefaultSound } = await import("./defaultSound.js");
      pianoSounds.push(generateDefaultSound());
    } catch (err) {
      console.warn("Erro ao gerar som padrão:", err);
    }
  }
  renderPianoList();
  renderStringsList();
  renderSynthList();
}

// Tamanho de um SF2 remoto: HEAD (Content-Length) ou GET Range bytes=0-0 (Content-Range ".../TOTAL").
async function remoteSize(url) {
  try {
    const h = await fetch(url, { method: "HEAD" });
    const n = Number(h.headers.get("content-length"));
    if (h.ok && n > 1) return n;
  } catch { /* tenta o Range */ }
  const r = await fetch(url, { headers: { Range: "bytes=0-0" } });
  const total = Number(r.headers.get("content-range")?.split("/")[1]);
  r.body?.cancel().catch(() => {});
  if (total > 0) return total;
  throw new Error(`não consegui o tamanho de ${url}`);
}

// ?sf2=<url>&name=<nome>: abre um SF2 específico (ex.: dentro do AmostraLab em /labpiano/).
async function loadUrlParamSound() {
  const q = new URLSearchParams(location.search);
  const url = q.get("sf2");
  if (!url) return false;
  if (!access.full) { lockedNotice(access, "Abrir outros SF2"); return false; }
  const file = decodeURIComponent(url.split(/[?#]/)[0].split("/").pop() || "piano.sf2");
  const name = q.get("name") || file;
  try {
    const sound = urlSound(name, await remoteSize(url), url);
    pianoSounds.unshift(sound);
    renderPianoList();
    selectPiano(0, "A");
  } catch (err) {
    oled(name, "Erro ao abrir o SF2", String(err.message || err), 0);
    loadNoticeFail(String(err.message || err));
  }
  return true;
}

// ---------- Synth no modo Sample: um SF2 do usuário (pads, cordas…) na layer A do Synth ----------
// A biblioteca é independente para cada módulo.
let synthIndex = -1;
let synthPresets = [];
let synthPreset = 0;

function synthLcd(name, sub, progress) {}
function renderSynthList() {
  const ul = $("synthList");
  if (!ul) return;
  const list = synthSounds.map((s, i) => [s, i]).filter(([s]) => !s.nord && !s.fantom);
  if (!list.length) { ul.innerHTML = `<li class="empty">Nenhum SF2</li>`; return; }
  ul.innerHTML = list.map(([s, i]) => `<li><button data-i="${i}" class="${i === synthIndex ? "on" : ""}"><span class="led"></span><span class="nm">${s.name.replace(/\.sf2$/i, "")}</span></button></li>`).join("");
}
function showSynthPreset() {
  const p = synthPresets[synthPreset];
}
function selectSynthSound(i) {
  if (synthLoading) return;
  const s = synthSounds[i];
  synthIndex = i;
  if (s) state.synthName = s.name;
  renderSynthList();
  synthLoading = (async () => {
    try {
      loadNotice(s.name.replace(EXT, ""), "Carregando o som…", 0.08);
      const src = await getSf2Source(s);
      const info = await sampler.load(src, (p) => {
        loadNotice(null, `Carregando o som… ${Math.round(p * 100)}%`, Math.max(0.08, p));
      });
      synthPresets = info.presets || [];
      synthPreset = Math.max(0, synthPresets.findIndex((p) => p.bank === info.preset?.bank && p.num === info.preset?.num));
      showSynthPreset();
      selectors.osc.set("sample");
      if (!state.on.synth) setOn("synth", true);
    } catch (err) {
      console.error(err);
      loadNoticeFail(String(err.message || err));
    } finally {
      synthLoading = null;
      if (!$("loadBannerClose") || $("loadBannerClose").hidden) loadNoticeDone();
    }
  })();
}
function stepSynthPreset(d) {
  if (synthPresets.length < 2) return;
  synthPreset = (synthPreset + d + synthPresets.length) % synthPresets.length;
  const p = synthPresets[synthPreset];
  sampler.selectPreset(p.bank, p.num);
  showSynthPreset();
}
$("synthLoadBtn").addEventListener("click", () => (access.full ? $("synthFileInput").click() : lockedNotice(access, "Abrir outros SF2")));
$("synthFileInput").addEventListener("change", (e) => {
  if (e.target.files.length) {
    addFiles(e.target.files, "synth");
    e.target.value = "";
  }
});

// ?synth=<url>&synthName=<nome>: abre um SF2 direto no Synth (ex.: um pad da biblioteca do AmostraLab).
async function loadUrlParamSynth() {
  const q = new URLSearchParams(location.search);
  const url = q.get("synth");
  if (!url || !access.full) return;
  const name = q.get("synthName") || decodeURIComponent(url.split(/[?#]/)[0].split("/").pop() || "synth.sf2");
  try {
    const sound = urlSound(name, await remoteSize(url), url);
    synthSounds.push(sound);
    renderSynthList();
    selectSynthSound(synthSounds.length - 1);
  } catch (err) {
    synthLcd(name, "Erro ao abrir o SF2", 0);
  }
}
renderSynthList();
showSynthPreset();

// ---------- Seção Strings: leitor de amostras e SF2 ----------
const loadedStringsIndex = { A: -1, B: -1 };
let stringsLoading = null;

function renderStringsList() {
  const ul = $("stringsList");
  if (!ul) return;
  const L = state.focus.strings || "A";
  const cur = loadedStringsIndex[L];
  const none = L === "B" ? `<li><button data-i="-1" class="${cur < 0 ? "on" : ""}"><span class="led"></span><span class="nm">Nenhum</span></button></li>` : "";
  if (!stringsSounds.length && !none) { ul.innerHTML = `<li class="empty">Solte .sf2, .npno, .nsmp3, .nsmp4 ou .wav aqui</li>`; return; }
  ul.innerHTML = none + stringsSounds.map((s, i) => `<li><button data-i="${i}" class="${i === cur ? "on" : ""}" title="${s.name.replace(EXT, "")}"><span class="led"></span><span class="nm">${s.name.replace(EXT, "")}</span></button></li>`).join("");
}

async function selectStrings(i, L = "A") {
  if (stringsLoading) return;
  allNotesOff();
  if (i < 0) {
    stringsOf(L).unload?.();
    loadedStringsIndex[L] = -1;
    if (L === "A") state.stringsName = null;
    else state.stringsNameB = null;
    renderStringsList();
    oled("Layer B sem strings", null, layerSummary(), 0);
    return;
  }
  const s = stringsSounds[i];
  const before = loadedStringsIndex[L];
  loadedStringsIndex[L] = i;
  if (L === "A") state.stringsName = s.name;
  else state.stringsNameB = s.name;
  renderStringsList();
  stringsLoading = (async () => {
    console.log("Loading strings", s.name);
    try {
      loadNotice(s.name.replace(EXT, ""), "Lendo o arquivo…", 0.04);
      const src = await getSf2Source(s);
      oled(src.name.replace(/\.sf2$/i, ""), "Lendo SF2…", null, 0);
      loadNotice(src.name.replace(EXT, ""), "Carregando strings…", 0.08);
      await stringsOf(L).load(src, (p) => {
        const pct = Math.round(p * 100);
        oled(null, `Carregando strings… ${pct}%`, null, p);
        loadNotice(null, `Carregando strings… ${pct}%`, Math.max(0.08, p));
      });
      if (!state.on.strings) setOn("strings", true);
      oled(null, `Strings carregado: ${s.name.replace(EXT, "")}`, layerSummary(), 0);
    } catch (err) {
      console.error(err);
      loadedStringsIndex[L] = before;
      renderStringsList();
      oled(null, "Erro ao carregar strings", String(err.message || err), 0);
      loadNoticeFail(String(err.message || err));
    } finally {
      stringsLoading = null;
      loadNoticeDone();
    }
  })();
}

$("stringsList")?.addEventListener("click", (e) => { const b = e.target.closest("button[data-i]"); if (b) selectStrings(+b.dataset.i, state.focus.strings); });
$("stringsLoadBtn")?.addEventListener("click", () => (access.full ? $("stringsFileInput").click() : lockedNotice(access, "Abrir outros SF2")));
$("stringsRemoveBtn")?.addEventListener("click", removeSelectedStrings);
$("stringsFileInput")?.addEventListener("change", (e) => { addFiles(e.target.files, "strings"); e.target.value = ""; });

function removeSelectedStrings() {
  const L = state.focus.strings || "A";
  const idx = loadedStringsIndex[L];
  if (idx < 0 || !stringsSounds[idx]) {
    oled("Strings", "Nenhum timbre selecionado", layerSummary());
    return;
  }
  const removedSound = stringsSounds[idx];
  stringsSounds.splice(idx, 1);

  if (loadedStringsIndex.A === idx) {
    strings.unload?.();
    loadedStringsIndex.A = -1;
    state.stringsName = null;
  } else if (loadedStringsIndex.A > idx) {
    loadedStringsIndex.A--;
  }

  if (loadedStringsIndex.B === idx) {
    strings.B.unload?.();
    loadedStringsIndex.B = -1;
    state.stringsNameB = null;
  } else if (loadedStringsIndex.B > idx) {
    loadedStringsIndex.B--;
  }

  renderStringsList();
  oled("Strings removido", removedSound.name.replace(EXT, ""), layerSummary());
}

// Alternador de abas Synth / Strings no painel
document.querySelectorAll(".syn-tab-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    const targetTab = btn.dataset.synTab;
    document.querySelectorAll(".syn-tab-btn").forEach((b) => {
      const on = b.dataset.synTab === targetTab;
      b.classList.toggle("on", on);
      b.setAttribute("aria-selected", on);
    });
    document.querySelectorAll(".syn-view-pane").forEach((pane) => {
      const isTarget = pane.dataset.tabPane === targetTab;
      pane.classList.toggle("on", isTarget);
      pane.classList.toggle("off", !state.on[pane.dataset.tabPane]);
    });
    document.querySelectorAll(".m-synth .on-btn").forEach((onBtn) => {
      onBtn.style.display = onBtn.dataset.on === targetTab ? "" : "none";
    });
    const mSynth = document.querySelector(".m-synth");
    if (mSynth) mSynth.classList.toggle("off", !state.on[targetTab]);
  });
});

renderStringsList();

// Load / Remove: carrega e remove timbres na layer em foco (A ou B).
$("loadBtn").addEventListener("click", () => (access.full ? $("fileInput").click() : lockedNotice(access, "Abrir outros SF2")));
$("removeBtn")?.addEventListener("click", removeSelectedPiano);
$("fileInput").addEventListener("change", (e) => { addFiles(e.target.files, "piano"); e.target.value = ""; });

function removeSelectedPiano() {
  const L = state.focus.piano;
  const idx = loadedIndex[L];
  if (idx < 0 || !pianoSounds[idx]) {
    oled("Piano", "Nenhum timbre selecionado", layerSummary());
    return;
  }
  const removedSound = pianoSounds[idx];
  pianoSounds.splice(idx, 1);

  if (loadedIndex.A === idx) {
    piano.unload?.();
    loadedIndex.A = -1;
    state.pianoName = null;
  } else if (loadedIndex.A > idx) {
    loadedIndex.A--;
  }

  if (loadedIndex.B === idx) {
    piano.B.unload?.();
    loadedIndex.B = -1;
    state.pianoNameB = null;
  } else if (loadedIndex.B > idx) {
    loadedIndex.B--;
  }

  renderPianoList();
  oled("Piano removido", removedSound.name.replace(EXT, ""), layerSummary());
}
let dragDepth = 0;
addEventListener("dragenter", (e) => { e.preventDefault(); dragDepth++; $("drop").classList.add("show"); });
addEventListener("dragleave", () => { if (--dragDepth <= 0) { dragDepth = 0; $("drop").classList.remove("show"); } });
addEventListener("dragover", (e) => e.preventDefault());
addEventListener("drop", (e) => {
  e.preventDefault();
  dragDepth = 0;
  $("drop").classList.remove("show");
  let mod = "piano";
  const target = e.target;
  if (target && target.closest) {
    if (target.closest('#stringsList, [data-syn-tab="strings"], [data-tab-pane="strings"]')) {
      mod = "strings";
    } else if (target.closest('#synthList, [data-syn-tab="synth"], [data-tab-pane="synth"]')) {
      mod = "synth";
    }
  }
  addFiles(e.dataTransfer.files, mod);
});

// ---------- Programas ----------
const PROG_KEY = "labpiano.programs.v2";
const programs = (() => { try { return JSON.parse(localStorage.getItem(PROG_KEY)) || []; } catch { return []; } })();

function snapshot() {
  return {
    on: { ...state.on }, oct: { ...state.oct }, transpose: state.transpose, focus: { ...state.focus },
    knobs: Object.fromEntries([...knobs].map(([k, c]) => [k, c.get()])),
    drawbars: drawbars.get(), drawbarsB: drawbarsB.get(),
    sel: Object.fromEntries(Object.entries(selectors).map(([k, s]) => [k, s.get()])),
    layers: layers.state(),
    piano: state.pianoName ?? null, pianoB: state.pianoNameB ?? null,
    strings: state.stringsName ?? null, stringsB: state.stringsNameB ?? null,
    synth: state.synthName ?? null, synthPreset: typeof synthPreset === "number" ? synthPreset : 0,
    workstation: ws?.getState?.() ?? null,
  };
}
function recall(p) {
  allNotesOff();
  Object.entries(p.knobs).forEach(([k, v]) => knobs.get(k)?.set(v));
  drawbars.set(p.drawbars);
  if (p.drawbarsB) drawbarsB.set(p.drawbarsB);
  Object.entries(p.sel).forEach(([k, v]) => v != null && selectors[k]?.set(v));
  if (p.layers) {
    layers.restore(p.layers);
    for (const s of SECTIONS) for (const L of LAYERS) {
      const l = layers.get(s, L);
      setLayerOct(s, L, l.octave);
      setZone(s, L, l.zone);
    }
    for (const sec of ["piano", "synth", "strings"]) {
      if (p.layers[sec]?.A?.level != null) knobs.get(`L.${sec}.A.level`)?.set(p.layers[sec].A.level);
      if (p.layers[sec]?.B?.level != null) knobs.get(`L.${sec}.B.level`)?.set(p.layers[sec].B.level);
    }
  }
  Object.assign(state.focus, p.focus ?? {});
  Object.entries(p.on).forEach(([s, v]) => setOn(s, v));
  Object.entries(p.oct).forEach(([s, v]) => setOct(s, v));
  setTranspose(p.transpose);

  // Piano A / B
  if (p.piano !== undefined) {
    const iA = p.piano ? pianoSounds.findIndex((s) => s.name === p.piano) : -1;
    if (iA >= 0) { if (iA !== loadedIndex.A) selectPiano(iA, "A"); }
    else if (p.piano === null && loadedIndex.A >= 0) selectPiano(-1, "A");
  }
  if (p.pianoB !== undefined) {
    const iB = p.pianoB ? pianoSounds.findIndex((s) => s.name === p.pianoB) : -1;
    if (iB >= 0) { if (iB !== loadedIndex.B) selectPiano(iB, "B"); }
    else if (p.pianoB === null && loadedIndex.B >= 0) selectPiano(-1, "B");
  }

  // Strings A / B
  if (p.strings !== undefined) {
    const sA = p.strings ? stringsSounds.findIndex((s) => s.name === p.strings) : -1;
    if (sA >= 0) { if (sA !== loadedStringsIndex.A) selectStrings(sA, "A"); }
    else if (p.strings === null && loadedStringsIndex.A >= 0) selectStrings(-1, "A");
  }
  if (p.stringsB !== undefined) {
    const sB = p.stringsB ? stringsSounds.findIndex((s) => s.name === p.stringsB) : -1;
    if (sB >= 0) { if (sB !== loadedStringsIndex.B) selectStrings(sB, "B"); }
    else if (p.stringsB === null && loadedStringsIndex.B >= 0) selectStrings(-1, "B");
  }

  // Synth SF2
  if (p.synth !== undefined) {
    const synI = p.synth ? synthSounds.findIndex((s) => s.name === p.synth) : -1;
    if (synI >= 0 && synI !== synthIndex) selectSynthSound(synI);
    if (typeof p.synthPreset === "number" && synthPresets && synthPresets[p.synthPreset]) {
      synthPreset = p.synthPreset;
      showSynthPreset();
      sampler.selectPreset(synthPresets[synthPreset].bank, synthPresets[synthPreset].num);
    }
  }

  // Workstation / Pads
  if (p.workstation && ws?.setState) {
    ws.setState(p.workstation);
  }

  refreshLayers();
}
let storeArmed = false;
function armStore(armed) {
  storeArmed = armed;
  const btn = $("storeBtn");
  if (btn) {
    btn.classList.toggle("on", storeArmed);
    btn.setAttribute("aria-pressed", storeArmed);
  }
  if (storeArmed) {
    oled("STORE ATIVADO", "Selecione o slot (1-8)", "Clique para gravar o preset");
  } else {
    oled(null, null, layerSummary());
  }
}
$("storeBtn")?.addEventListener("click", () => {
  if (!access.full) { lockedNotice(access, "Store"); return; }
  armStore(!storeArmed);
});

$("exportProgBtn")?.addEventListener("click", () => {
  if (!access.full) { lockedNotice(access, "Export"); return; }
  try {
    const data = {
      version: "2.0",
      type: "LabPiano_Preset_Bank",
      exportedAt: new Date().toISOString(),
      programs: programs.map((p) => p ?? null)
    };
    const jsonStr = JSON.stringify(data, null, 2);
    const blob = new Blob([jsonStr], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `labpiano-presets-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    oled("BANCO EXPORTADO", "Salvo em arquivo JSON", layerSummary());
  } catch (err) {
    console.error(err);
    oled("Erro ao exportar", String(err.message || err), layerSummary());
  }
});

$("importProgBtn")?.addEventListener("click", () => {
  if (!access.full) { lockedNotice(access, "Import"); return; }
  $("importProgFile")?.click();
});

$("importProgFile")?.addEventListener("change", async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  try {
    const text = await file.text();
    const data = JSON.parse(text);
    const importedProgs = Array.isArray(data) ? data : data.programs;
    if (!Array.isArray(importedProgs)) throw new Error("Formato de arquivo inválido");

    for (let i = 0; i < 8; i++) {
      programs[i] = importedProgs[i] ?? null;
    }
    localStorage.setItem(PROG_KEY, JSON.stringify(programs));

    document.querySelectorAll("#programs .btn.prog").forEach((b, i) => {
      b.classList.toggle("saved", !!programs[i]);
    });

    const activeIndex = programs[state.program] ? state.program : programs.findIndex(Boolean);
    if (activeIndex >= 0 && programs[activeIndex]) {
      state.program = activeIndex;
      recall(programs[activeIndex]);
      showProgram();
    }

    oled("BANCO IMPORTADO", `${programs.filter(Boolean).length} presets restaurados`, layerSummary());
  } catch (err) {
    console.error(err);
    oled("Erro ao importar", String(err.message || err), layerSummary());
  } finally {
    e.target.value = "";
  }
});

function saveProgramSlot(i, b) {
  programs[i] = snapshot();
  try {
    localStorage.setItem(PROG_KEY, JSON.stringify(programs));
    localStorage.setItem("labpiano.last_program", String(i));
  } catch { /* sem storage */ }
  b?.classList.add("saved");
  oled(`Program ${i + 1} gravado!`, "Configuração salva no slot", layerSummary());
  armStore(false);
  showProgram();
}

const progEl = $("programs");
for (let i = 0; i < 8; i++) {
  const b = document.createElement("button");
  b.className = "btn prog";
  b.innerHTML = `<span class="led"></span><b>${i + 1}</b><i class="slot"></i>`;
  b.title = "Clique: chamar · Segurar (1s) ou Store: gravar";
  b.classList.toggle("saved", !!programs[i]);

  let holdTimer = null;
  let didHold = false;
  b.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    didHold = false;
    holdTimer = setTimeout(() => {
      didHold = true;
      state.program = i;
      saveProgramSlot(i, b);
    }, 1100);
  });
  const clearHold = () => {
    if (holdTimer) { clearTimeout(holdTimer); holdTimer = null; }
  };
  b.addEventListener("pointerup", clearHold);
  b.addEventListener("pointerleave", clearHold);
  b.addEventListener("pointercancel", clearHold);

  b.addEventListener("click", (e) => {
    if (!access.full) { lockedNotice(access, "Programs"); return; }
    if (didHold) {
      didHold = false;
      return;
    }
    state.program = i;
    try { localStorage.setItem("labpiano.last_program", String(i)); } catch { /* sem storage */ }
    if (e.shiftKey || storeArmed) {
      saveProgramSlot(i, b);
    } else if (programs[i]) {
      recall(programs[i]);
      oled(`Program ${i + 1}`, null, layerSummary());
    } else {
      oled(`Program ${i + 1}`, "Slot vazio", "Segure para gravar");
    }
    showProgram();
  });
  progEl.appendChild(b);
}
showProgram();

// ---------- Medidor ----------
const meterLeds = [...document.querySelectorAll("#meter i")];
const buf = new Float32Array(analyser.fftSize);
let meterLast = 0;
let silentFrames = 0;
(function meter(now = 0) {
  const dt = now - meterLast;
  const interval = silentFrames > 10 ? 400 : 50; // 20 FPS ativo (50ms), ~2.5 FPS em silêncio
  if (dt >= interval) {
    meterLast = now;
    analyser.getFloatTimeDomainData(buf);
    let peak = 0;
    for (let i = 0; i < buf.length; i += 4) {
      const v = Math.abs(buf[i]);
      if (v > peak) peak = v;
    }
    const dbv = 20 * Math.log10(peak || 1e-6);
    const lit = Math.max(0, Math.min(meterLeds.length, Math.round((dbv + 48) / (48 / meterLeds.length))));
    if (lit === 0) silentFrames++;
    else silentFrames = 0;
    meterLeds.forEach((l, i) => l.classList.toggle("lit", i < lit));
  }
  requestAnimationFrame(meter);
})();

SECTIONS.forEach((s) => setOn(s, state.on[s]));
refreshFxLeds();
mountTabs(document.querySelector(".panel"));
mountKeyNav(document.querySelector(".keybed"));
addEventListener("resize", refreshSplit);
if (!access.full) {
  const css = document.createElement("link");
  css.rel = "stylesheet";
  css.href = "css/lock.css";
  document.head.appendChild(css);
  for (const sel of [".m-organ", ".m-synth", ".m-fx"]) lockBlock(document.querySelector(sel), access);
}
// Com ?sf2= (modo embutido) o piano pedido já fica selecionado e api/sounds nem é consultada:
// um 404 sempre aparece no console do navegador, mesmo tratado no JS.
// Chamada final para inicializar o app
setup();

// Palco do nativo: 1600 × 840 escalado para caber na janela (largura e altura), como o setTransform do JUCE.
// Em telas pequenas fica o layout em faixas/abas (mobile.js).
function fitStage() {
  const on = innerWidth >= 1000 && innerHeight >= 520;
  document.body.classList.toggle("stage", on);
  const h = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--stage-h")) || 840; // o Workstation é mais alto
  if (on) document.documentElement.style.setProperty("--stage-zoom", Math.max(0.6, Math.min((innerWidth - 24) / 1600, (innerHeight - 20) / h)).toFixed(4));
  refreshSplit();
}
addEventListener("resize", fitStage);
fitStage();

// Tela cheia (o resize que ela dispara reajusta o palco). iPhone não tem a API: botão some.
const fsBtn = $("fsBtn");
if (fsBtn && !document.fullscreenEnabled) fsBtn.hidden = true;
fsBtn?.addEventListener("click", () => {
  if (document.fullscreenElement) document.exitFullscreen();
  else document.documentElement.requestFullscreen().catch(() => {});
});
if (fsBtn) document.addEventListener("fullscreenchange", () => {
  const on = !!document.fullscreenElement;
  fsBtn.classList.toggle("on", on);
  fsBtn.setAttribute("aria-label", on ? "Sair da tela cheia" : "Tela cheia");
  fsBtn.title = on ? "Sair da tela cheia (Esc)" : "Tela cheia";
  fsBtn.querySelector(".ic").innerHTML = icon(on ? "fullscreenExit" : "fullscreen", { size: 13 });
  fitStage();
});
// Layout do painel: Stage (padrão) ou Workstation (css/fantom.css). O <head> aplica o salvo antes de pintar.
const SKINS = [["nord", "Stage", "#8c1a11"], ["fantom", "Workstation", "#111214"]];
function setSkin(id) {
  const [key, label, color] = SKINS.find((s) => s[0] === id) ?? SKINS[0];
  ws?.reset();
  if (key === "nord") delete document.documentElement.dataset.skin;
  else document.documentElement.dataset.skin = key;
  $("skinName").textContent = label;
  $("skinBtn").classList.toggle("on", key !== "nord");
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", color);
  try { localStorage.setItem("labpiano.skin", key); } catch { /* sem storage */ }
  fitStage();
}
setSkin(document.documentElement.dataset.skin ?? "nord");
$("skinBtn").addEventListener("click", () => {
  const i = SKINS.findIndex((s) => s[0] === (document.documentElement.dataset.skin ?? "nord"));
  setSkin(SKINS[(i + 1) % SKINS.length][0]);
});

// Cor do layout Workstation (seleção e persistência via localStorage "labpiano.ws_color")
const WS_COLORS = ["red", "orange", "yellow", "green", "moss", "darkblue", "lightblue", "purple", "white"];
function setWsColor(color) {
  const validColor = WS_COLORS.includes(color) ? color : "red";
  document.documentElement.dataset.wsColor = validColor;
  try { localStorage.setItem("labpiano.ws_color", validColor); } catch { /* sem storage */ }
  const menu = $("wsColorMenu");
  if (menu) {
    menu.querySelectorAll("button[data-ws-color]").forEach((btn) => {
      const isSel = btn.dataset.wsColor === validColor;
      btn.classList.toggle("on", isSel);
      btn.setAttribute("aria-checked", isSel ? "true" : "false");
    });
  }
}

const savedWsColor = (() => {
  try { return localStorage.getItem("labpiano.ws_color"); } catch { return "red"; }
})() || "red";
setWsColor(savedWsColor);

const wsColorMenu = $("wsColorMenu");
if (wsColorMenu) {
  wsColorMenu.addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-ws-color]");
    if (btn) {
      setWsColor(btn.dataset.wsColor);
    }
  });
}

// Pads, arpejador, chord memory, tempo e sequenciador (só agem no layout Workstation).
ws = mountWorkstation({ noteOn, noteOff, allNotesOff, noteName, oled });

