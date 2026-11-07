// Mini-displays do painel: forma de onda, filtro e ADSR do Synth (layers A e B) e os blocos
// de efeito (Mod, Delay, Reverb, EQ·Comp). Só observa os knobs (--v) e os seletores;
// usa as mesmas fórmulas do audio.js, então o desenho mostra o som real.
// O LED "ativo" de cada bloco fica no app.js (refreshFxLeds), com as regras do nativo.

const $ = (sel) => document.querySelector(sel);
const W = 100, H = 40;

const val = (param) => {
  const el = $(`[data-param="${param}"]`);
  const v = el && parseFloat(el.style.getPropertyValue("--v"));
  return Number.isFinite(v) ? v : Number(el?.dataset.value ?? 0);
};
const sel = (id, key) => $(`#${id} .on`)?.dataset[key];
const viz = (name) => $(`svg[data-viz="${name}"]`);
const envTime = (v) => 0.002 + v * v * 4; // audio.js: time()
const fmtHz = (f) => (f >= 1000 ? `${(f / 1000).toFixed(f >= 10000 ? 0 : 1)}k` : `${Math.round(f)}`);
const fmtS = (s) => (s >= 1 ? `${s.toFixed(1)} s` : `${Math.round(s * 1000)} ms`);
const path = (pts) => pts.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`).join(" ");

function render(svg, d, { fill = false, label = "", label2 = "" } = {}) {
  if (!svg || !svg.parentElement) return;
  if (!svg.querySelector(".line")) {
    svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
    svg.setAttribute("preserveAspectRatio", "none");
    svg.innerHTML =
      `<g class="grid">${[10, 20, 30].map((y) => `<line x1="0" x2="${W}" y1="${y}" y2="${y}"/>`).join("")}</g>` +
      `<path class="area"/><path class="line"/>`;
  }
  const host = svg.parentElement;
  if (!host.querySelector(".viz-l")) {
    host.insertAdjacentHTML("beforeend", `<span class="viz-l"></span><span class="viz-r"></span>`);
  }
  const lineEl = svg.querySelector(".line");
  const areaEl = svg.querySelector(".area");
  if (lineEl) lineEl.setAttribute("d", d);
  if (areaEl) areaEl.setAttribute("d", fill ? `${d} L${W} ${H} L0 ${H} Z` : "");
  const lEl = host.querySelector(".viz-l");
  const rEl = host.querySelector(".viz-r");
  if (lEl) lEl.textContent = label;
  if (rEl) rEl.textContent = label2;
}

// ---------- Synth (L = "" para a layer A, "B" para a B) ----------
const p = (L, name) => (L ? `${L}.${name}` : name);

function drawOsc(L) {
  const osc = sel(L ? "oscSelB" : "oscSel", "osc") || "sawtooth";
  const pts = [];
  for (let i = 0; i <= 100; i++) {
    const ph = ((i / 100) * 2) % 1; // dois ciclos
    let y;
    if (osc === "square") y = ph < 0.5 ? 1 : -1;
    else if (osc === "triangle") y = 1 - 4 * Math.abs(ph - 0.5);
    else if (osc === "super") y = (2 * ph - 1) * 0.6 + (2 * (((i / 100) * 2.13) % 1) - 1) * 0.4;
    else if (osc === "sample") y = Math.sin(ph * Math.PI * 2) * Math.exp(-i / 70) * (0.7 + 0.3 * Math.sin(i * 0.9));
    else y = 2 * ph - 1;
    pts.push([i, H / 2 - y * 14]);
  }
  const names = { sawtooth: "SAW", square: "PULSE", triangle: "TRI", super: "SUPER", sample: "SF2" };
  render(viz(`osc${L}`), path(pts), { label: names[osc] || "", label2: `DET ${Math.round(val(p(L, "detune")) * 100)}` });
}

function drawFilter(L) {
  const fc = Math.min(18000, 40 * Math.pow(2, val(p(L, "cutoff")) * 9));
  const q = 0.7 + val(p(L, "reso")) * 16;
  const pts = [];
  for (let i = 0; i <= 100; i++) {
    const f = 20 * Math.pow(1000, i / 100); // 20 Hz … 20 kHz, eixo log
    const r = f / fc;
    const db = -10 * Math.log10((1 - r * r) ** 2 + (r / q) ** 2);
    pts.push([i, 14 - Math.max(-24, Math.min(18, db)) * (24 / 42)]);
  }
  render(viz(`filter${L}`), path(pts), { fill: true, label: fmtHz(fc), label2: `Q ${q.toFixed(1)}` });
}

function drawAdsr(L) {
  const a = envTime(val(p(L, "attack"))), d = envTime(val(p(L, "decay"))), s = val(p(L, "sustain")), r = envTime(val(p(L, "release")));
  const span = a + d + r + 0.6; // 0,6 s de nota segurada
  const x = (t) => (t / span) * W;
  const top = 4, base = H - 2, sy = base - (base - top) * s;
  const pts = [[0, base], [x(a), top], [x(a + d), sy], [x(a + d + 0.6), sy], [W, base]];
  render(viz(`env${L}`), path(pts), { fill: true, label: "ADSR", label2: `A ${fmtS(a)} · R ${fmtS(r)}` });
}

// ---------- Efeitos ----------
// Mod: LFO correndo (fase animada), forma conforme o tipo, como o display do nativo.
const MOD_SHAPE = {
  tremolo: (ph) => Math.sin(ph),
  pan: (ph) => Math.sin(ph),
  chorus: (ph) => Math.sin(ph) * 0.8 + Math.sin(ph * 2.7) * 0.2,
  flanger: (ph) => 1 - 2 * Math.abs(((ph / (2 * Math.PI)) % 1) - 0.5) * 2,
  phaser: (ph) => Math.sign(Math.sin(ph)) * Math.pow(Math.abs(Math.sin(ph)), 0.5),
};
let modPhase = 0, modLast = 0;
function drawMod(now = performance.now()) {
  const type = sel("modType", "mod") || "chorus";
  const rate = 0.1 * Math.pow(80, val("modRate")); // Hz aproximado, só para o desenho
  const amt = val("modAmount");
  modPhase += ((now - modLast) / 1000) * rate * 2 * Math.PI;
  modLast = now;
  const f = MOD_SHAPE[type] || MOD_SHAPE.chorus;
  const pts = [];
  for (let i = 0; i <= 100; i++) pts.push([i, H / 2 - f(modPhase + (i / 100) * Math.PI * 4) * 14 * Math.max(0.06, amt)]);
  render(viz("mod"), path(pts), { label: type.toUpperCase(), label2: `${rate.toFixed(1)} Hz` });
}

function drawDelay() {
  const send = val("delay"), fb = val("delayFeedback");
  const t = 0.08 + val("delayTime") * 0.92;
  const step = (t / 2.4) * W; // 2,4 s de janela
  const decay = 0.2 + fb * 0.7;
  let d = "";
  for (let k = 0, amp = 1; k * step <= W && k < 24; k++, amp *= decay) {
    const h = (H - 6) * amp * (k ? Math.max(0.15, send) : 1);
    d += `M${(k * step).toFixed(1)} ${H - 2} V${(H - 2 - h).toFixed(1)} `;
  }
  const mode = { mono: "MONO", pingpong: "PING", tape: "TAPE" }[sel("delayMode", "dmode")] || "";
  render(viz("delay"), d.trim(), { label: `${Math.round(t * 1000)} ms`, label2: mode });
}

const RT = { room: 0.6, stage: 1.6, hall: 2.8, plate: 2, spring: 1.4 };
function drawReverb() {
  const send = val("reverb"), size = val("reverbSize");
  const type = sel("reverbType", "rtype") || "stage";
  const rt = RT[type] * (0.5 + size);
  const pts = [];
  for (let i = 0; i <= 100; i++) {
    const t = (i / 100) * 4; // 4 s de janela
    const ripple = type === "spring" ? 0.6 + 0.4 * Math.cos(i * 0.9) ** 2 : 0.75 + 0.25 * Math.sin(i * 1.7) ** 2;
    pts.push([i, H - 2 - (H - 6) * Math.max(0.12, send) * Math.pow(0.001, t / rt) * ripple]);
  }
  render(viz("reverb"), path(pts), { fill: true, label: `${rt.toFixed(1)} s`, label2: type.toUpperCase() });
}

function drawEq() {
  const gb = (val("bass") - 0.5) * 30, gm = (val("mid") - 0.5) * 24, gt = (val("treble") - 0.5) * 30;
  const pts = [];
  for (let i = 0; i <= 100; i++) {
    const lf = Math.log10(20 * Math.pow(1000, i / 100));
    const low = gb / (1 + Math.exp((lf - Math.log10(250)) * 6));
    const mid = gm * Math.exp(-(((lf - Math.log10(1200)) / 0.35) ** 2));
    const high = gt / (1 + Math.exp(-(lf - Math.log10(3500)) * 6));
    pts.push([i, H / 2 - (low + mid + high) * (H / 2 - 3) / 20]);
  }
  const comp = val("comp");
  render(viz("eq"), path(pts), { label: "EQ", label2: comp ? `COMP ${Math.round(3 + comp * 21)} dB` : "" });
}

const A = (f) => () => f(""), B = (f) => () => f("B");
const oscA = A(drawOsc), oscB = B(drawOsc), filA = A(drawFilter), filB = B(drawFilter), envA = A(drawAdsr), envB = B(drawAdsr);
const DRAW = {
  detune: [oscA], cutoff: [filA], reso: [filA], fenv: [filA],
  attack: [envA], decay: [envA], sustain: [envA], release: [envA],
  "B.detune": [oscB], "B.cutoff": [filB], "B.reso": [filB], "B.fenv": [filB],
  "B.attack": [envB], "B.decay": [envB], "B.sustain": [envB], "B.release": [envB],
  delay: [drawDelay], delayTime: [drawDelay], delayFeedback: [drawDelay],
  reverb: [drawReverb], reverbSize: [drawReverb], reverbTone: [drawReverb],
  bass: [drawEq], mid: [drawEq], treble: [drawEq], comp: [drawEq], chorus: [drawEq],
};
const SEL = { oscSel: oscA, oscSelB: oscB, delayMode: drawDelay, reverbType: drawReverb, modType: () => drawMod() };

export function refreshVisuals() {
  [oscA, oscB, filA, filB, envA, envB, drawDelay, drawReverb, drawEq].forEach((f) => f());
  drawMod();
}
window.refreshVisuals = refreshVisuals;

// Espera os knobs montarem (--v aparece quando o controls.js aplica o valor).
function start() {
  refreshVisuals();
  const mo = new MutationObserver((list) => {
    const todo = new Set();
    for (const m of list) {
      const prm = m.target.dataset?.param;
      if (prm && DRAW[prm]) DRAW[prm].forEach((f) => todo.add(f));
      for (const [id, f] of Object.entries(SEL)) if (m.target.closest?.(`#${id}`)) todo.add(f);
    }
    todo.forEach((f) => f());
  });
  document.querySelectorAll("[data-param]").forEach((el) => mo.observe(el, { attributes: true, attributeFilter: ["style"] }));
  for (const id of Object.keys(SEL)) {
    const el = $(`#${id}`);
    if (el) mo.observe(el, { attributes: true, subtree: true, attributeFilter: ["class"] });
  }
  // Mod anima sempre (a 30 fps), mas só com a aba visível.
  modLast = performance.now();
  let last = 0;
  (function tick(now) {
    if (now - last > 33) { drawMod(now); last = now; }
    requestAnimationFrame(tick);
  })(modLast);
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => requestAnimationFrame(() => requestAnimationFrame(start)));
} else {
  requestAnimationFrame(() => requestAnimationFrame(start));
}