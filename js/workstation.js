// Layout Workstation (html[data-skin="fantom"]): pads com modos, arpejador, chord memory, tempo/TAP
// e sequenciador de 16 passos. Fora desse layout as notas passam direto (keyOn → noteOn).
// Os pads de sample tocam as prévias da /biblioteca-amostras (api/pad-samples) ou um arquivo do usuário.
import { ctx, padIn } from "./audio.js";
import { mountSeg } from "./controls.js";

const $ = (id) => document.getElementById(id);
const STORE = "labpiano.workstation.v1";
const CHORDS = { maj: [0, 4, 7], min: [0, 3, 7], dom7: [0, 4, 7, 10], min7: [0, 3, 7, 10], sus4: [0, 5, 7], pow: [0, 7, 12] };
const RATES = { "8": 2, "16": 4, "8t": 3 };
const PAD_BASE = 48;

export function mountWorkstation({ noteOn, noteOff, allNotesOff, noteName, oled }) {
  const saved = (() => { try { return JSON.parse(localStorage.getItem(STORE)) || {}; } catch { return {}; } })();
  const st = {
    bpm: saved.bpm ?? 120,
    padMode: saved.padMode ?? "sample",
    arp: { on: false, type: saved.arpType ?? "up", rate: saved.arpRate ?? "16", oct: saved.arpOct ?? 1 },
    chord: { on: false, type: saved.chordType ?? "maj" },
    steps: saved.steps ?? Array(16).fill(null), // { n } por passo
    pads: saved.pads ?? Array(16).fill(null), // { name, url, kind } (arquivos locais não são salvos)
  };
  const persist = () => {
    try {
      localStorage.setItem(STORE, JSON.stringify({
        bpm: st.bpm, padMode: st.padMode, arpType: st.arp.type, arpRate: st.arp.rate, arpOct: st.arp.oct,
        chordType: st.chord.type, steps: st.steps, pads: st.pads.map((p) => (p?.url ? p : null)),
      }));
    } catch { /* sem storage */ }
  };
  const active = () => document.documentElement.dataset.skin === "fantom";

  // ---------- Saída com contagem: acorde, arpejo e sequenciador podem pedir a mesma nota ----------
  const count = new Map();
  const emitOn = (n, v) => {
    if (n < 0 || n > 127) return;
    count.set(n, (count.get(n) ?? 0) + 1);
    noteOn(n, v);
  };
  const emitOff = (n) => {
    const c = (count.get(n) ?? 0) - 1;
    if (c > 0) { count.set(n, c); return; }
    count.delete(n);
    noteOff(n);
  };

  // ---------- Tempo ----------
  const segTempo = mountSeg($("segTempo"), 3);
  const setBpm = (v) => {
    st.bpm = Math.max(40, Math.min(240, Math.round(v)));
    segTempo.set(String(st.bpm), `Tempo ${st.bpm} BPM`);
    persist();
  };
  setBpm(st.bpm);
  $("tempoDown").addEventListener("click", () => setBpm(st.bpm - 1));
  $("tempoUp").addEventListener("click", () => setBpm(st.bpm + 1));
  let taps = [];
  $("tapBtn").addEventListener("click", () => {
    const now = performance.now();
    taps = taps.filter((t) => now - t < 2000).concat(now);
    if (taps.length >= 2) setBpm(60000 / ((taps.at(-1) - taps[0]) / (taps.length - 1)));
    const b = $("tapBtn");
    b.classList.remove("flash");
    void b.offsetWidth;
    b.classList.add("flash");
  });
  const beat = () => 60 / st.bpm;

  // Relógio com correção de deriva (setTimeout atrasa; o próximo passo é marcado pelo horário ideal).
  function clock(period, tick) {
    let next = performance.now();
    let id = 0;
    const run = () => {
      tick();
      next += period() * 1000;
      id = setTimeout(run, Math.max(0, next - performance.now()));
    };
    run();
    return () => clearTimeout(id);
  }

  // ---------- Botões de grupo (um aceso por vez) ----------
  function group(el, key, value, onPick) {
    const buttons = [...el.querySelectorAll("button")];
    el.setAttribute("role", "radiogroup");
    const show = (v) => buttons.forEach((b) => { const on = b.dataset[key] === String(v); b.classList.toggle("on", on); b.setAttribute("aria-checked", on); });
    buttons.forEach((b) => { b.setAttribute("role", "radio"); b.addEventListener("click", () => { show(b.dataset[key]); onPick(b.dataset[key]); }); });
    show(value);
    return show;
  }
  function toggle(btn, onChange) {
    btn.addEventListener("click", () => {
      const on = !btn.classList.contains("on");
      btn.classList.toggle("on", on);
      btn.setAttribute("aria-pressed", on);
      onChange(on);
    });
    return (on) => { btn.classList.toggle("on", on); btn.setAttribute("aria-pressed", on); };
  }

  // ---------- Chord memory ----------
  group($("chordType"), "chord", st.chord.type, (v) => { st.chord.type = v; persist(); });
  const showChord = toggle($("chordBtn"), (on) => { releaseAll(); st.chord.on = on; });
  const expand = (k) => (st.chord.on ? CHORDS[st.chord.type].map((i) => k + i) : [k]);

  // ---------- Arpejador ----------
  group($("arpType"), "arp", st.arp.type, (v) => { st.arp.type = v; persist(); });
  group($("arpRate"), "rate", st.arp.rate, (v) => { st.arp.rate = v; persist(); });
  group($("arpOct"), "oct", st.arp.oct, (v) => { st.arp.oct = +v; persist(); });
  const showArp = toggle($("arpBtn"), (on) => { releaseAll(); st.arp.on = on; });
  const held = new Map(); // nota segurada → velocity (ordem de chegada)
  let arpStop = null;
  let arpIdx = 0;
  let arpNote = null;
  let arpVel = 100;
  function arpPattern() {
    const base = [...held.keys()].sort((a, b) => a - b);
    const seq = [];
    for (let o = 0; o < st.arp.oct; o++) for (const n of base) seq.push(n + o * 12);
    return seq;
  }
  function arpTick() {
    if (arpNote != null) { emitOff(arpNote); arpNote = null; }
    const seq = arpPattern();
    if (!seq.length) return;
    let i;
    if (st.arp.type === "rnd") i = Math.floor(Math.random() * seq.length);
    else if (st.arp.type === "down") i = seq.length - 1 - (arpIdx % seq.length);
    else if (st.arp.type === "updn" && seq.length > 1) {
      i = arpIdx % (2 * seq.length - 2);
      if (i >= seq.length) i = 2 * seq.length - 2 - i;
    } else i = arpIdx % seq.length;
    arpIdx++;
    arpNote = seq[i];
    emitOn(arpNote, arpVel);
    const gate = beat() / RATES[st.arp.rate] * 0.8 * 1000;
    const n = arpNote;
    setTimeout(() => { if (arpNote === n) { emitOff(n); arpNote = null; } }, gate);
  }
  function arpSync() {
    if (held.size && !arpStop) { arpIdx = 0; arpStop = clock(() => beat() / RATES[st.arp.rate], arpTick); }
    if (!held.size && arpStop) { arpStop(); arpStop = null; if (arpNote != null) { emitOff(arpNote); arpNote = null; } }
  }

  // ---------- Entrada das teclas ----------
  const keyMap = new Map(); // tecla → notas que ela disparou
  let lastNote = 60;
  function keyOn(k, v) {
    if (!active()) { noteOn(k, v); return; }
    lastNote = k;
    if (recOn) recordStep(k);
    keyOff(k);
    const notes = expand(k);
    keyMap.set(k, notes);
    if (st.arp.on) { arpVel = v; notes.forEach((n) => held.set(n, v)); arpSync(); return; }
    notes.forEach((n) => emitOn(n, v));
  }
  function keyOff(k) {
    const notes = keyMap.get(k);
    if (!notes) { if (!active()) noteOff(k); return; } // tecla apertada fora do layout

    keyMap.delete(k);
    if (st.arp.on) { notes.forEach((n) => held.delete(n)); arpSync(); return; }
    notes.forEach(emitOff);
  }
  function releaseAll() {
    for (const k of [...keyMap.keys()]) keyOff(k);
    held.clear();
    arpSync();
  }

  // ---------- Sequenciador de 16 passos ----------
  const stepsEl = $("steps");
  const stepBtns = [];
  let recOn = false;
  let cursor = 0;
  let seqStop = null;
  let seqPos = -1;
  for (let i = 0; i < 16; i++) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "step";
    b.innerHTML = `<span class="led"></span><b>${i + 1}</b><i></i>`;
    b.addEventListener("click", (e) => {
      if (recOn) { cursor = i; drawSteps(); return; }
      st.steps[i] = st.steps[i] && !e.shiftKey ? null : { n: lastNote };
      persist();
      drawSteps();
    });
    stepsEl.appendChild(b);
    stepBtns.push(b);
  }
  function drawSteps() {
    stepBtns.forEach((b, i) => {
      const s = st.steps[i];
      b.classList.toggle("on", !!s);
      b.classList.toggle("cur", i === seqPos);
      b.classList.toggle("cursor", recOn && i === cursor);
      b.querySelector("i").textContent = s ? noteName(s.n) : "";
      b.setAttribute("aria-label", `Passo ${i + 1}: ${s ? noteName(s.n) : "vazio"}`);
    });
    if (st.padMode === "step") drawPads();
  }
  function recordStep(k) {
    st.steps[cursor] = { n: k };
    cursor = (cursor + 1) % 16;
    persist();
    drawSteps();
  }
  const showPlay = toggle($("seqPlay"), (on) => {
    if (on) {
      if (ctx.state !== "running") ctx.resume();
      seqPos = -1;
      seqStop = clock(() => beat() / 4, () => {
        seqPos = (seqPos + 1) % 16;
        const s = st.steps[seqPos];
        if (s) { emitOn(s.n, 100); setTimeout(() => emitOff(s.n), beat() / 4 * 500); }
        drawSteps();
      });
    } else {
      seqStop?.();
      seqStop = null;
      seqPos = -1;
      drawSteps();
    }
  });
  toggle($("seqRec"), (on) => { recOn = on; drawSteps(); if (on) oled?.(null, "Step Rec: toque as notas no teclado", null); });
  $("seqClear").addEventListener("click", () => { st.steps = Array(16).fill(null); cursor = 0; persist(); drawSteps(); });
  drawSteps();

  // ---------- Pads ----------
  const padEls = [];
  const buffers = new Map(); // url → AudioBuffer
  const voices = new Map(); // pad → BufferSource (loops ligados)
  for (let row = 3; row >= 0; row--) for (let col = 0; col < 4; col++) {
    const i = row * 4 + col;
    const pad = document.createElement("button");
    pad.type = "button";
    pad.className = "pad";
    pad.innerHTML = `<b>${i + 1}</b><span></span>`;
    const up = () => { if (!pad.classList.contains("down")) return; pad.classList.remove("down"); padUp(i); };
    pad.addEventListener("pointerdown", (e) => { e.preventDefault(); pad.setPointerCapture(e.pointerId); pad.classList.add("down"); padDown(i); });
    pad.addEventListener("pointerup", up);
    pad.addEventListener("pointercancel", up);
    pad.addEventListener("keydown", (e) => { if ((e.key === " " || e.key === "Enter") && !e.repeat && !pad.classList.contains("down")) { e.preventDefault(); pad.classList.add("down"); padDown(i); } });
    pad.addEventListener("keyup", (e) => { if (e.key === " " || e.key === "Enter") up(); });
    pad.addEventListener("dragover", (e) => { if (st.padMode === "sample") { e.preventDefault(); pad.classList.add("drag"); } });
    pad.addEventListener("dragleave", () => pad.classList.remove("drag"));
    pad.addEventListener("drop", (e) => {
      if (st.padMode !== "sample") return;
      e.preventDefault(); // segue até o drop global, que fecha o aviso e ignora áudio
      pad.classList.remove("drag");
      const f = [...e.dataTransfer.files].find((x) => /^audio\//.test(x.type) || /\.(wav|mp3|ogg|flac|aif+)$/i.test(x.name));
      if (f) assignFile(i, f);
    });
    $("pads").appendChild(pad);
    padEls[i] = pad;
  }
  const zoneOf = { 0: "organ", 1: "piano", 2: "synth" };
  function drawPads() {
    padEls.forEach((pad, i) => {
      let label = "";
      let lit = false;
      let dim = false;
      if (st.padMode === "note") label = noteName(PAD_BASE + i);
      else if (st.padMode === "sample") {
        const p = st.pads[i];
        label = ""; // só o número; o nome fica no title (mouse) e no visor ao tocar
        dim = !p;
        lit = voices.has(i);
        pad.classList.toggle("loop", p?.kind === "loop");
      } else if (st.padMode === "zone") {
        const z = zoneOf[i];
        label = z ? z[0].toUpperCase() + z.slice(1) : i === 3 ? "Panic" : "";
        dim = !z && i !== 3;
        lit = !!z && document.querySelector(`[data-on="${z}"]`)?.classList.contains("on");
      } else if (st.padMode === "step") {
        const s = st.steps[i];
        label = s ? noteName(s.n) : "";
        lit = !!s;
        pad.classList.toggle("cur", i === seqPos);
      }
      if (st.padMode !== "step") pad.classList.remove("cur");
      if (st.padMode !== "sample") pad.classList.remove("loop");
      pad.classList.toggle("lit", lit);
      pad.classList.toggle("dim", dim);
      pad.querySelector("span").textContent = label;
      pad.title = st.padMode === "sample" ? (st.pads[i] ? `${st.pads[i].name} · Assign para trocar` : "Escolher amostra") : "";
      pad.setAttribute("aria-label", `Pad ${i + 1}${label ? `: ${label}` : ""}`);
    });
    $("padAssign").hidden = st.padMode !== "sample";
  }
  let assignOn = false;
  const showAssign = toggle($("padAssign"), (on) => { assignOn = on; });
  function padDown(i) {
    if (ctx.state !== "running") ctx.resume();
    if (st.padMode === "note") keyOn(PAD_BASE + i, 100);
    else if (st.padMode === "zone") {
      if (zoneOf[i]) { document.querySelector(`[data-on="${zoneOf[i]}"]`)?.click(); drawPads(); }
      else if (i === 3) $("panicBtn").click();
    } else if (st.padMode === "step") {
      st.steps[i] = st.steps[i] ? null : { n: lastNote };
      persist();
      drawSteps();
    } else if (assignOn || !st.pads[i]) openLibrary(i);
    else playPad(i);
  }
  function padUp(i) {
    if (st.padMode === "note") keyOff(PAD_BASE + i);
  }
  group($("padMode"), "pmode", st.padMode, (v) => {
    releaseAll();
    st.padMode = v;
    persist();
    drawPads();
  });
  // Zone: os pads seguem os botões On das seções (só eles: observar o painel todo pegaria os próprios pads).
  const zoneObs = new MutationObserver(() => st.padMode === "zone" && drawPads());
  document.querySelectorAll("[data-on]").forEach((b) => zoneObs.observe(b, { attributes: true, attributeFilter: ["class"] }));

  async function bufferOf(p) {
    if (p.buffer) return p.buffer;
    if (buffers.has(p.url)) return buffers.get(p.url);
    const res = await fetch(p.url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = await ctx.decodeAudioData(await res.arrayBuffer());
    buffers.set(p.url, buf);
    return buf;
  }
  function startBuffer(buf, loop = false) {
    const src = new AudioBufferSourceNode(ctx, { buffer: buf, loop });
    src.connect(padIn);
    src.start();
    return src;
  }
  async function playPad(i) {
    const p = st.pads[i];
    if (voices.has(i)) { voices.get(i).stop(); voices.delete(i); drawPads(); return; } // loop ligado: aperto desliga
    try {
      const buf = await bufferOf(p);
      if (p.kind === "loop") {
        const src = startBuffer(buf, true);
        voices.set(i, src);
        src.onended = () => { if (voices.get(i) === src) { voices.delete(i); drawPads(); } };
        drawPads();
      } else startBuffer(buf);
      oled?.(null, `Pad ${i + 1} · ${p.name}`, null); // o pad só cabe o começo do nome
    } catch {
      oled?.(null, `Pad ${i + 1}: não consegui abrir a amostra`, null);
    }
  }
  async function assignFile(i, f) {
    try {
      const buffer = await ctx.decodeAudioData(await f.arrayBuffer());
      st.pads[i] = { name: f.name.replace(/\.[^.]+$/, ""), kind: buffer.duration > 3 ? "loop" : "pad", buffer };
      persist();
      drawPads();
      oled?.(null, `Pad ${i + 1}: ${st.pads[i].name}`, null);
    } catch {
      oled?.(null, `${f.name}: formato de áudio não suportado`, null);
    }
  }
  function stopPads() {
    voices.forEach((v) => v.stop());
    voices.clear();
  }

  // ---------- Biblioteca de amostras (diálogo) ----------
  const dlg = $("padLib");
  const libList = $("libList");
  const libCat = $("libCat");
  const libQ = $("libQ");
  let libTarget = 0;
  let libTipo = "";
  let libReady = false;
  let previewSrc = null;
  group($("libTipo"), "tipo", "", (v) => { libTipo = v; search(); });
  async function fetchLib(params) {
    const res = await fetch(`api/pad-samples?${new URLSearchParams(params)}`, { credentials: "same-origin" });
    if (!res.ok || !(res.headers.get("content-type") || "").includes("json")) throw new Error("sem api");
    return res.json();
  }
  let seq = 0;
  async function search() {
    const my = ++seq;
    libList.innerHTML = `<li class="lib-msg">Carregando…</li>`;
    try {
      const data = await fetchLib({ cat: libCat.value, q: libQ.value.trim(), tipo: libTipo });
      if (my !== seq) return;
      if (!libReady) {
        libCat.innerHTML = `<option value="">Todas as categorias</option>` + data.categories.map((c) => `<option value="${c.slug}">${c.name} (${c.count})</option>`).join("");
        libReady = true;
      }
      $("libCount").textContent = data.total > data.files.length ? `${data.files.length} de ${data.total}` : `${data.total}`;
      libList.innerHTML = data.files.length ? "" : `<li class="lib-msg">Nada encontrado.</li>`;
      for (const f of data.files) {
        const li = document.createElement("li");
        li.innerHTML = `<button type="button" class="lib-play" aria-label="Ouvir ${f.name}">▶</button><span class="lib-nm"></span><span class="lib-meta"></span><button type="button" class="btn small lib-use">Usar</button>`;
        li.querySelector(".lib-nm").textContent = f.name;
        li.querySelector(".lib-meta").textContent = [f.cat, f.kind === "loop" ? "loop" : "one-shot", f.bpm ? `${Math.round(f.bpm)} BPM` : null, f.dur].filter(Boolean).join(" · ");
        li.querySelector(".lib-play").addEventListener("click", async () => {
          previewSrc?.stop();
          try { previewSrc = startBuffer(await bufferOf(f)); } catch { /* prévia indisponível */ }
        });
        li.querySelector(".lib-use").addEventListener("click", () => {
          st.pads[libTarget] = { name: f.name, url: f.url, kind: f.kind };
          persist();
          drawPads();
          bufferOf(f).catch(() => {});
          closeLibrary();
        });
        libList.appendChild(li);
      }
    } catch {
      if (my !== seq) return;
      $("libCount").textContent = "";
      libList.innerHTML = `<li class="lib-msg">A biblioteca do site não está disponível aqui. Use um arquivo de áudio do computador (ou arraste um .wav para o pad).</li>`;
    }
  }
  let qTimer = 0;
  libQ.addEventListener("input", () => { clearTimeout(qTimer); qTimer = setTimeout(search, 250); });
  libCat.addEventListener("change", search);
  $("libFileBtn").addEventListener("click", () => $("libFile").click());
  $("libFile").addEventListener("change", (e) => { const f = e.target.files[0]; if (f) { assignFile(libTarget, f); closeLibrary(); } e.target.value = ""; });
  $("libClear").addEventListener("click", () => { st.pads[libTarget] = null; persist(); drawPads(); closeLibrary(); });
  $("libClose").addEventListener("click", closeLibrary);
  dlg.addEventListener("close", () => { previewSrc?.stop(); previewSrc = null; });
  function openLibrary(i) {
    libTarget = i;
    $("libPad").textContent = `Pad ${i + 1}`;
    $("libClear").hidden = !st.pads[i];
    dlg.showModal();
    search();
  }
  function closeLibrary() {
    if (dlg.open) dlg.close();
    showAssign(false);
    assignOn = false;
  }

  // Pads todos vazios (primeira vez): enche com one-shots da biblioteca, se houver.
  if (st.pads.every((p) => !p)) fetchLib({ tipo: "pad" }).then((d) => {
    if (st.pads.some(Boolean)) return; // o usuário já escolheu algo enquanto carregava
    d.files.slice(0, 16).forEach((f, i) => { st.pads[i] = { name: f.name, url: f.url, kind: f.kind }; });
    persist();
    drawPads();
  }).catch(() => {});
  drawPads();

  return {
    keyOn,
    keyOff,
    // Troca de layout: para arpejo, sequência e loops dos pads.
    reset() {
      releaseAll();
      if (seqStop) { showPlay(false); seqStop(); seqStop = null; seqPos = -1; drawSteps(); }
      stopPads();
      showArp(false); st.arp.on = false;
      showChord(false); st.chord.on = false;
      drawPads();
    },
  };
}