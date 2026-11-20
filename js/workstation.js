// Layout Workstation (html[data-skin="fantom"]): pads com modos, arpejador, chord memory, tempo/TAP
// e sequenciador de 16 passos. Sample pads reproduzem via AVAudioPlayerNode nativo (CoreAudio/AVFoundation).
import { mountSeg } from "./controls.js";
import { nativeBridge, arrayBufferToBase64 } from "./native-bridge.js";

const $ = (id) => document.getElementById(id);
const STORE = "labpiano.workstation.v1";
const CHORDS = { maj: [0, 4, 7], min: [0, 3, 7], dom7: [0, 4, 7, 10], min7: [0, 3, 7, 10], sus4: [0, 5, 7], pow: [0, 7, 12] };
const RATES = { "8": 2, "16": 4, "8t": 3 };
const PAD_BASE = 48;
export const CONT_KEYS = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

export function mountWorkstation({ noteOn, noteOff, noteName, oled, resolvePadTimbre, listLoadedTimbres }) {
  const saved = (() => { try { return JSON.parse(localStorage.getItem(STORE)) || {}; } catch { return {}; } })();
  const st = {
    bpm: saved.bpm ?? 120,
    padMode: saved.padMode ?? "sample",
    prevPadMode: saved.prevPadMode && saved.prevPadMode !== "continuous" ? saved.prevPadMode : "sample",
    contKey: typeof saved.contKey === "number" && saved.contKey >= 0 && saved.contKey < 12 ? saved.contKey : null,
    contPlaying: false,
    padOct: !!saved.padOct,
    padTimbre: saved.padTimbre && saved.padTimbre.name ? saved.padTimbre : null,
    arp: { on: false, type: saved.arpType ?? "up", rate: saved.arpRate ?? "16", oct: saved.arpOct ?? 1 },
    chord: { on: false, type: saved.chordType ?? "maj" },
    steps: saved.steps ?? Array(16).fill(null),
    pads: Array.isArray(saved.pads) ? saved.pads : Array(16).fill(null),
  };
  const persist = () => {
    try {
      localStorage.setItem(STORE, JSON.stringify({
        bpm: st.bpm, padMode: st.padMode, prevPadMode: st.prevPadMode, contKey: st.contKey,
        padOct: st.padOct,
        padTimbre: st.padTimbre ? { kind: st.padTimbre.kind, name: st.padTimbre.name, path: st.padTimbre.path ?? null } : null,
        arpType: st.arp.type, arpRate: st.arp.rate, arpOct: st.arp.oct,
        chordType: st.chord.type, steps: st.steps,
        pads: st.pads.map((p) => (p?.path ? { name: p.name, path: p.path, kind: p.kind } : null)),
      }));
    } catch { /* sem storage */ }
  };
  const active = () => document.documentElement.dataset.skin === "fantom";

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
  const showChordType = group($("chordType"), "chord", st.chord.type, (v) => { st.chord.type = v; persist(); });
  const showChord = toggle($("chordBtn"), (on) => { releaseAll(); st.chord.on = on; });
  const expand = (k) => (st.chord.on ? CHORDS[st.chord.type].map((i) => k + i) : [k]);

  // ---------- Arpejador ----------
  const showArpType = group($("arpType"), "arp", st.arp.type, (v) => { st.arp.type = v; persist(); });
  const showArpRate = group($("arpRate"), "rate", st.arp.rate, (v) => { st.arp.rate = v; persist(); });
  const showArpOct = group($("arpOct"), "oct", st.arp.oct, (v) => { st.arp.oct = +v; persist(); });
  const showArp = toggle($("arpBtn"), (on) => { releaseAll(); st.arp.on = on; });
  const held = new Map();
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
  const keyMap = new Map();
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
    if (!notes) { if (!active()) noteOff(k); return; }
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

  // ---------- Pads (100% Nativo AVAudioPlayerNode) ----------
  const padEls = [];
  const activeLoops = new Set();
  const loadedPads = new Set();

  if (nativeBridge.active) {
    nativeBridge.onEvent("padEnded", (ev) => {
      if (ev && typeof ev.index === "number" && activeLoops.delete(ev.index)) {
        drawPads();
      }
    });
  }

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
      e.preventDefault();
      pad.classList.remove("drag");
      const f = [...e.dataTransfer.files].find((x) => /^audio\//.test(x.type) || /\.(wav|mp3|ogg|flac|aif+|m4a|caf)$/i.test(x.name));
      if (f) assignFile(i, f);
    });
    $("pads").appendChild(pad);
    padEls[i] = pad;
  }

  const zoneOf = { 0: "organ", 1: "piano", 2: "synth" };
  const padContBtn = $("padContBtn");
  const padTimbreBtn = $("padTimbreBtn");
  const padOctBtn = $("padOctBtn");
  const padAssignBtn = $("padAssign");
  const padAssignLbl = padAssignBtn?.querySelector(".pad-assign-lbl");
  const heldPadNotes = new Map();
  let assignOn = false;

  const showAssign = (on) => {
    assignOn = !!on;
    drawPads();
  };

  function drawPads() {
    const isCont = st.padMode === "continuous";
    const octShift = st.padOct ? 12 : 0;
    padEls.forEach((pad, i) => {
      let label = "";
      let lit = false;
      let dim = false;
      let contTone = false;
      let contPlayPad = false;
      if (isCont) {
        if (i < 12) {
          label = CONT_KEYS[i];
          contTone = true;
          lit = st.contKey === i;
          contPlayPad = st.contPlaying && st.contKey === i;
        } else {
          label = "";
          dim = true;
        }
      } else if (st.padMode === "note") label = noteName(PAD_BASE + octShift + i);
      else if (st.padMode === "sample") {
        const p = st.pads[i];
        label = "";
        dim = !p;
        lit = activeLoops.has(i);
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
      pad.classList.toggle("cont-tone", contTone);
      pad.classList.toggle("cont-playing", contPlayPad);
      pad.classList.toggle("lit", lit);
      pad.classList.toggle("dim", dim);
      pad.querySelector("span").textContent = label;
      pad.title = isCont
        ? (i < 12 ? `Pad Contínuo: tom ${CONT_KEYS[i]}${st.padOct ? " (+1 Oct)" : ""}` : "")
        : (st.padMode === "sample" ? (st.pads[i] ? `${st.pads[i].name} · Assign para trocar` : "Escolher amostra") : "");
      pad.setAttribute("aria-label", `Pad ${i + 1}${label ? `: ${label}` : ""}`);
    });

    if (padContBtn) {
      padContBtn.classList.toggle("on", isCont);
      padContBtn.classList.toggle("playing", st.contPlaying);
      padContBtn.setAttribute("aria-pressed", String(isCont));
    }

    if (padTimbreBtn) {
      const hasCustom = !!st.padTimbre;
      padTimbreBtn.classList.toggle("on", hasCustom);
      padTimbreBtn.setAttribute("aria-pressed", String(hasCustom));
      padTimbreBtn.title = hasCustom
        ? `Timbre dos pads: ${st.padTimbre.name} (clique para trocar ou restaurar)`
        : "Carregar timbre dos pads (SF2, Nord, SVZ, WAV, MP3…)";
    }

    if (padOctBtn) {
      padOctBtn.classList.toggle("on", st.padOct);
      padOctBtn.setAttribute("aria-pressed", String(st.padOct));
      padOctBtn.title = st.padOct
        ? "Oitava +1 ativa no timbre dos pads (clique para voltar à normal)"
        : "Adicionar +1 oitava acima no timbre dos pads";
    }

    if (padAssignBtn) {
      if (isCont) {
        padAssignBtn.hidden = false;
        if (st.contKey != null) {
          if (padAssignLbl) padAssignLbl.textContent = "Play";
          padAssignBtn.classList.add("is-play");
          padAssignBtn.classList.remove("waiting-key");
          padAssignBtn.classList.toggle("on", st.contPlaying);
          padAssignBtn.setAttribute("aria-pressed", String(st.contPlaying));
          padAssignBtn.title = st.contPlaying
            ? `Parar Pad Contínuo (${CONT_KEYS[st.contKey]})`
            : `Ligar Pad Contínuo (${CONT_KEYS[st.contKey]})`;
        } else {
          if (padAssignLbl) padAssignLbl.textContent = "Assign";
          padAssignBtn.classList.remove("is-play", "on");
          padAssignBtn.classList.add("waiting-key");
          padAssignBtn.setAttribute("aria-pressed", "false");
          padAssignBtn.title = "Escolha um tom (C–B) abaixo para transformar em Play";
        }
      } else if (st.padMode === "sample") {
        padAssignBtn.hidden = false;
        if (padAssignLbl) padAssignLbl.textContent = "Assign";
        padAssignBtn.classList.remove("is-play", "waiting-key");
        padAssignBtn.classList.toggle("on", assignOn);
        padAssignBtn.setAttribute("aria-pressed", String(assignOn));
        padAssignBtn.title = "Ligue e toque num pad para trocar a amostra";
      } else {
        padAssignBtn.hidden = true;
        padAssignBtn.classList.remove("is-play", "waiting-key", "on");
      }
    }
  }

  function syncContinuousPadAudio() {
    if (st.contKey == null && st.contPlaying) st.contPlaying = false;
    nativeBridge.send("continuousPad", {
      playing: st.contPlaying,
      key: st.contKey ?? 0,
      octave: st.padOct ? 1 : 0,
    });
  }

  function stopContinuousPad() {
    if (!st.contPlaying) return;
    st.contPlaying = false;
    syncContinuousPadAudio();
    drawPads();
  }

  padOctBtn?.addEventListener("click", () => {
    st.padOct = !st.padOct;
    persist();
    if (st.contPlaying) syncContinuousPadAudio();
    drawPads();
    oled?.(null, `Pads · Oitava ${st.padOct ? "+1 acima" : "Normal"}`, null);
  });

  padAssignBtn?.addEventListener("click", () => {
    if (st.padMode === "continuous") {
      if (st.contKey == null) {
        oled?.(null, "Pad Contínuo: escolha um tom (C–B)", null);
        return;
      }
      st.contPlaying = !st.contPlaying;
      syncContinuousPadAudio();
      drawPads();
      if (!nativeBridge.active) {
        oled?.(null, `Pad Contínuo (${CONT_KEYS[st.contKey]}) · Só no app Mac`, "Áudio Web removido (use Xcode)");
      } else {
        oled?.(null, `Pad Contínuo · ${CONT_KEYS[st.contKey]}${st.padOct ? " (+1)" : ""} · ${st.contPlaying ? "Tocando" : "Parado"}`, null);
      }
      return;
    }
    assignOn = !assignOn;
    drawPads();
  });

  function padDown(i) {
    if (st.padMode === "continuous") {
      if (i < 12) {
        st.contKey = i;
        persist();
        if (st.contPlaying) {
          syncContinuousPadAudio();
          oled?.(null, `Pad Contínuo · ${CONT_KEYS[i]}${st.padOct ? " (+1)" : ""} · Tocando`, null);
        } else {
          oled?.(null, `Pad Contínuo · ${CONT_KEYS[i]}${st.padOct ? " (+1)" : ""} · Clique em PLAY`, null);
        }
        drawPads();
      }
      return;
    }
    if (st.padMode === "note") {
      const note = PAD_BASE + (st.padOct ? 12 : 0) + i;
      heldPadNotes.set(i, note);
      if (st.padTimbre?.kind === "sf2" && nativeBridge.active) {
        nativeBridge.send("padTimbreNote", { on: true, note, vel: 100 });
      } else {
        keyOn(note, 100);
      }
    } else if (st.padMode === "zone") {
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
    if (st.padMode === "note") {
      const note = heldPadNotes.get(i);
      if (note == null) return;
      heldPadNotes.delete(i);
      if (st.padTimbre?.kind === "sf2" && nativeBridge.active) {
        nativeBridge.send("padTimbreNote", { on: false, note });
      } else {
        keyOff(note);
      }
    }
  }

  const showPadMode = group($("padMode"), "pmode", st.padMode, (v) => {
    releaseAll();
    assignOn = false;
    st.padMode = v;
    if (v !== "continuous") st.prevPadMode = v;
    persist();
    drawPads();
  });

  padContBtn?.addEventListener("click", () => {
    releaseAll();
    assignOn = false;
    if (st.padMode === "continuous") {
      st.padMode = st.prevPadMode || "sample";
    } else {
      if (st.padMode !== "continuous") st.prevPadMode = st.padMode;
      st.padMode = "continuous";
    }
    showPadMode(st.padMode);
    persist();
    drawPads();
    if (st.padMode === "continuous") {
      oled?.(null, st.contKey != null ? `Pads Contínuos · Tom ${CONT_KEYS[st.contKey]}${st.padOct ? " (+1)" : ""}` : "Pads Contínuos · Escolha um tom (C–B)", null);
    }
  });

  const zoneObs = new MutationObserver(() => st.padMode === "zone" && drawPads());
  document.querySelectorAll("[data-on]").forEach((b) => zoneObs.observe(b, { attributes: true, attributeFilter: ["class"] }));

  async function ensurePadLoaded(i, p) {
    if (loadedPads.has(i)) return;
    if (!nativeBridge.active) {
      loadedPads.add(i);
      return;
    }
    const res = await nativeBridge.request("loadPadSample", {
      index: i,
      name: p.name || `pad-${i + 1}.wav`,
      path: p.path || null,
      base64: p.base64 || null,
    });
    if (res?.path) p.path = res.path;
    if (res?.kind) p.kind = res.kind;
    loadedPads.add(i);
  }

  async function playPad(i) {
    const p = st.pads[i];
    if (!p) return;
    if (activeLoops.has(i)) {
      activeLoops.delete(i);
      nativeBridge.send("stopPad", { index: i });
      drawPads();
      return;
    }
    if (!nativeBridge.active) {
      oled?.(null, `Pad ${i + 1} · Áudio só no app Mac (Xcode)`, null);
      return;
    }
    try {
      await ensurePadLoaded(i, p);
      const loop = p.kind === "loop";
      if (loop) {
        activeLoops.add(i);
        drawPads();
      }
      nativeBridge.send("playPad", { index: i, loop });
      oled?.(null, `Pad ${i + 1} · ${p.name}`, null);
    } catch {
      oled?.(null, `Pad ${i + 1}: não consegui abrir a amostra`, null);
    }
  }

  async function assignNativePath(i, picked) {
    try {
      loadedPads.delete(i);
      activeLoops.delete(i);
      const res = await nativeBridge.request("loadPadSample", {
        index: i,
        name: picked.name,
        path: picked.path,
        base64: null,
      });
      st.pads[i] = {
        name: picked.name.replace(/\.[^.]+$/, ""),
        path: res?.path || picked.path,
        kind: res?.kind || "pad",
      };
      loadedPads.add(i);
      persist();
      drawPads();
      oled?.(null, `Pad ${i + 1}: ${st.pads[i].name}`, null);
    } catch {
      oled?.(null, `${picked.name}: formato de áudio não suportado`, null);
    }
  }

  async function assignFile(i, f) {
    try {
      loadedPads.delete(i);
      activeLoops.delete(i);
      const base64 = arrayBufferToBase64(await f.arrayBuffer());
      if (nativeBridge.active) {
        const res = await nativeBridge.request("loadPadSample", {
          index: i,
          name: f.name,
          path: null,
          base64,
        });
        st.pads[i] = {
          name: f.name.replace(/\.[^.]+$/, ""),
          path: res?.path || null,
          kind: res?.kind || "pad",
        };
      } else {
        st.pads[i] = { name: f.name.replace(/\.[^.]+$/, ""), kind: "pad" };
      }
      loadedPads.add(i);
      persist();
      drawPads();
      oled?.(null, `Pad ${i + 1}: ${st.pads[i].name}`, null);
    } catch {
      oled?.(null, `${f.name}: formato de áudio não suportado`, null);
    }
  }

  function stopPads() {
    activeLoops.clear();
    st.contPlaying = false;
    nativeBridge.send("stopAllPads", {});
  }

  // ---------- Diálogo do Pad (arquivo local no macOS) ----------
  const dlg = $("padLib");
  const libList = $("libList");
  let libTarget = 0;

  $("libFileBtn").addEventListener("click", async () => {
    if (nativeBridge.active) {
      try {
        const picked = await nativeBridge.request("pickPadAudioFile", {});
        if (picked?.path) {
          await assignNativePath(libTarget, picked);
          closeLibrary();
        }
      } catch (err) {
        console.warn("Picker de pad falhou:", err);
      }
      return;
    }
    $("libFile").click();
  });
  $("libFile").addEventListener("change", (e) => {
    const f = e.target.files[0];
    if (f) { assignFile(libTarget, f); closeLibrary(); }
    e.target.value = "";
  });
  $("libClear").addEventListener("click", () => {
    loadedPads.delete(libTarget);
    activeLoops.delete(libTarget);
    nativeBridge.send("stopPad", { index: libTarget });
    st.pads[libTarget] = null;
    persist();
    drawPads();
    closeLibrary();
  });
  $("libClose").addEventListener("click", closeLibrary);
  dlg.addEventListener("close", () => nativeBridge.send("stopPadPreview", {}));

  function openLibrary(i) {
    libTarget = i;
    $("libPad").textContent = `Pad ${i + 1}`;
    $("libClear").hidden = !st.pads[i];
    if (libList) {
      libList.innerHTML = `<li class="lib-msg">Clique em <strong>Escolher arquivo</strong> ou arraste um arquivo .wav, .aif, .mp3 ou .m4a direto para o pad no MacBook.</li>`;
    }
    if ($("libCount")) $("libCount").textContent = "";
    dlg.showModal();
  }

  function closeLibrary() {
    if (dlg.open) dlg.close();
    showAssign(false);
  }

  // ---------- Diálogo de Timbre dos Pads ----------
  const tDlg = $("padTimbreDlg");
  const tList = $("padTimbreList");
  const tNameEl = $("padTimbreName");

  async function applyPadTimbreSource(source) {
    try {
      if (!source) {
        if (nativeBridge.active) {
          await nativeBridge.request("loadPadTimbre", { kind: "native", name: "Pad Nativo" });
        }
        st.padTimbre = null;
        persist();
        drawPads();
        if (tNameEl) tNameEl.textContent = "Pad Nativo";
        oled?.(null, "Pads: Pad Nativo restaurado", null);
        return true;
      }
      const res = resolvePadTimbre
        ? await resolvePadTimbre(source)
        : null;
      if (res) {
        st.padTimbre = { kind: res.kind, name: res.name, path: res.path ?? null };
        persist();
        drawPads();
        if (tNameEl) tNameEl.textContent = res.name;
        oled?.(null, `Timbre dos Pads: ${res.name}`, null);
        return true;
      }
    } catch (err) {
      oled?.(null, `Timbre dos Pads: ${err?.message || "erro ao carregar"}`, null);
    }
    return false;
  }

  function renderTimbreDialog() {
    if (tNameEl) tNameEl.textContent = st.padTimbre ? st.padTimbre.name : "Pad Nativo";
    if (!tList) return;
    const loaded = listLoadedTimbres?.() || [];
    if (!loaded.length) {
      tList.innerHTML = `<li class="lib-msg">Use <strong>Carregar arquivo do MacBook…</strong> para abrir .sf2, .npno, .nsmp3, .nsmp4, .svz, .wav ou .mp3 como timbre dos pads.</li>`;
      return;
    }
    tList.innerHTML = "";
    for (const item of loaded) {
      const li = document.createElement("li");
      const clean = item.name.replace(/\.(sf2|npno|nsmp|nsmp3|nsmp4|svz|wav)$/i, "");
      const isCur = st.padTimbre && st.padTimbre.name === clean;
      if (isCur) li.classList.add("cur");
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "pad-t-pick";
      btn.innerHTML = `<span class="lib-nm"></span><span class="lib-badge"></span>`;
      btn.querySelector(".lib-nm").textContent = clean;
      btn.querySelector(".lib-badge").textContent = item.sectionLabel;
      btn.addEventListener("click", async () => {
        const ok = await applyPadTimbreSource(item.entry);
        if (ok && tDlg?.open) tDlg.close();
      });
      li.appendChild(btn);
      tList.appendChild(li);
    }
  }

  padTimbreBtn?.addEventListener("click", () => {
    renderTimbreDialog();
    tDlg?.showModal();
  });
  $("padTimbreClose")?.addEventListener("click", () => tDlg?.close());
  $("padTimbreResetBtn")?.addEventListener("click", async () => {
    await applyPadTimbreSource(null);
    if (tDlg?.open) tDlg.close();
  });
  $("padTimbreFileBtn")?.addEventListener("click", async () => {
    if (nativeBridge.active) {
      try {
        const picked = await nativeBridge.request("pickPadTimbreFile", {});
        if (picked?.path) {
          const ok = await applyPadTimbreSource({
            name: picked.name,
            size: picked.size || 0,
            nativePath: picked.path,
          });
          if (ok && tDlg?.open) tDlg.close();
        }
      } catch (err) {
        console.warn("Picker timbre pad falhou:", err);
      }
      return;
    }
    $("padTimbreFile")?.click();
  });
  $("padTimbreFile")?.addEventListener("change", async (e) => {
    const f = e.target.files?.[0];
    e.target.value = "";
    if (!f) return;
    const ok = await applyPadTimbreSource({ name: f.name, size: f.size, file: f });
    if (ok && tDlg?.open) tDlg.close();
  });

  if (st.padTimbre?.path && nativeBridge.active) {
    nativeBridge.request("loadPadTimbre", {
      kind: st.padTimbre.kind || "sf2",
      name: st.padTimbre.name,
      path: st.padTimbre.path,
    }).catch(() => {
      st.padTimbre = null;
      persist();
      drawPads();
    });
  }

  drawPads();

  return {
    keyOn,
    keyOff,
    stopContinuousPad,
    triggerPad(i) {
      const pad = padEls[i];
      if (!pad) return;
      pad.classList.add("down");
      padDown(i);
      setTimeout(() => {
        pad.classList.remove("down");
        padUp(i);
      }, 160);
    },
    getPadElements: () => padEls,
    reset() {
      releaseAll();
      heldPadNotes.clear();
      if (seqStop) { showPlay(false); seqStop(); seqStop = null; seqPos = -1; drawSteps(); }
      stopPads();
      showArp(false); st.arp.on = false;
      showChord(false); st.chord.on = false;
      drawPads();
    },
    getState() {
      return {
        bpm: st.bpm,
        padMode: st.padMode,
        prevPadMode: st.prevPadMode,
        contKey: st.contKey,
        padOct: st.padOct,
        padTimbre: st.padTimbre ? { ...st.padTimbre } : null,
        arp: { ...st.arp },
        chord: { ...st.chord },
        steps: [...st.steps],
        pads: st.pads.map((p) => (p ? { name: p.name, path: p.path ?? null, kind: p.kind } : null)),
      };
    },
    setState(wState) {
      if (!wState) return;
      if (typeof wState.bpm === "number") setBpm(wState.bpm);
      if (wState.prevPadMode && wState.prevPadMode !== "continuous") st.prevPadMode = wState.prevPadMode;
      if (wState.contKey === null || (typeof wState.contKey === "number" && wState.contKey >= 0 && wState.contKey < 12)) {
        st.contKey = wState.contKey;
      }
      if (typeof wState.padOct === "boolean") st.padOct = wState.padOct;
      if (wState.padTimbre !== undefined) {
        st.padTimbre = wState.padTimbre && wState.padTimbre.name ? { ...wState.padTimbre } : null;
        if (nativeBridge.active) {
          if (st.padTimbre?.path) {
            nativeBridge.request("loadPadTimbre", st.padTimbre).catch(() => {});
          } else if (!st.padTimbre) {
            nativeBridge.request("loadPadTimbre", { kind: "native", name: "Pad Nativo" }).catch(() => {});
          }
        }
      }
      if (wState.padMode) { st.padMode = wState.padMode; showPadMode(st.padMode); }
      if (wState.arp) {
        st.arp = { ...st.arp, ...wState.arp };
        showArp(st.arp.on);
        showArpType(st.arp.type);
        showArpRate(st.arp.rate);
        showArpOct(st.arp.oct);
      }
      if (wState.chord) {
        st.chord = { ...st.chord, ...wState.chord };
        showChord(st.chord.on);
        showChordType(st.chord.type);
      }
      if (Array.isArray(wState.steps)) {
        st.steps = [...wState.steps];
        drawSteps();
      }
      if (Array.isArray(wState.pads)) {
        loadedPads.clear();
        activeLoops.clear();
        nativeBridge.send("stopAllPads", {});
        st.contPlaying = false;
        wState.pads.forEach((p, i) => {
          st.pads[i] = p ? { name: p.name, path: p.path ?? null, kind: p.kind } : null;
        });
      }
      drawPads();
      persist();
    },
  };
}