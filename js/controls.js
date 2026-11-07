// Controles do painel: knobs com anel de LEDs, faders, drawbars, seletores com LED,
// displays de 7 segmentos, pitch stick / mod wheel e o teclado de 88 teclas.

const clamp01 = (x) => Math.min(1, Math.max(0, x));

function dragValue(el, get, setv, sensitivity = 160) {
  el.tabIndex = 0;
  el.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    el.setPointerCapture(e.pointerId);
    el.classList.add("grab");
    const y0 = e.clientY;
    const v0 = get();
    const move = (ev) => setv(clamp01(v0 + (y0 - ev.clientY) / (ev.shiftKey ? sensitivity * 4 : sensitivity)));
    const up = () => {
      el.classList.remove("grab");
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
  });
  el.addEventListener("wheel", (e) => { e.preventDefault(); setv(clamp01(get() - Math.sign(e.deltaY) * 0.03)); }, { passive: false });
  el.addEventListener("keydown", (e) => {
    const big = e.shiftKey ? 0.01 : 0.05;
    const d = { ArrowUp: big, ArrowRight: big, ArrowDown: -big, ArrowLeft: -big, PageUp: 0.2, PageDown: -0.2 }[e.key];
    if (d) { e.preventDefault(); setv(clamp01(get() + d)); }
    else if (e.key === "Home") { e.preventDefault(); setv(0); }
    else if (e.key === "End") { e.preventDefault(); setv(1); }
  });
}

const RING_LEDS = 13;
const FADER_LEDS = 12;

// Knob e fader: data-param, data-value (0–1). onChange(param, valor).
export function mountContinuous(root, onChange) {
  const controls = new Map();
  for (const el of root.querySelectorAll(".knob, .fader")) {
    const param = el.dataset.param;
    let v = Number(el.dataset.value);
    let leds;
    const isKnob = el.classList.contains("knob");
    const label = el.dataset.label || el.textContent.trim();
    if (isKnob) {
      // 13 LEDs de -135° a +135°; o primeiro fica sempre aceso (como no painel real, marca o mínimo).
      // --i: posição no anel, usada pela varredura de LEDs ao ligar.
      const ring = Array.from({ length: RING_LEDS }, (_, i) => `<i style="--a:${-135 + (270 * i) / (RING_LEDS - 1)}deg;--i:${i}"></i>`).join("");
      el.innerHTML = `<div class="wrap" aria-hidden="true"><div class="ring">${ring}</div><div class="skirt"></div><div class="cap"><b></b></div><em class="val"></em></div><span>${label}</span>`;
      leds = [...el.querySelectorAll(".ring i")];
    } else {
      el.insertAdjacentHTML("afterbegin", `<div class="f-leds" aria-hidden="true">${Array.from({ length: FADER_LEDS }, (_, i) => `<i style="--i:${FADER_LEDS - 1 - i}"></i>`).join("")}</div><div class="slot" aria-hidden="true"></div><div class="thumb" aria-hidden="true"></div><em class="val" aria-hidden="true"></em>`);
      leds = [...el.querySelectorAll(".f-leds i")].reverse(); // de baixo para cima
    }
    const bubble = el.querySelector(".val");
    el.setAttribute("role", "slider");
    el.setAttribute("aria-label", label);
    el.setAttribute("aria-valuemin", "0");
    el.setAttribute("aria-valuemax", "100");
    el.setAttribute("aria-orientation", "vertical");
    const apply = (nv, quiet) => {
      v = nv;
      el.style.setProperty("--v", v);
      const pct = Math.round(v * 100);
      el.setAttribute("aria-valuenow", pct);
      el.setAttribute("aria-valuetext", `${label} ${pct}%`);
      bubble.textContent = pct;
      const lit = isKnob ? Math.round(v * (RING_LEDS - 1)) : Math.round(v * FADER_LEDS) - 1;
      leds.forEach((l, i) => l.classList.toggle("lit", i <= lit));
      if (!quiet) onChange(param, v);
    };
    dragValue(el, () => v, apply);
    el.addEventListener("dblclick", () => apply(Number(el.dataset.value)));
    apply(v);
    controls.set(param, { get: () => v, set: (x) => apply(x) });
  }
  return controls;
}

// Seletor exclusivo (rádio com coluna de LEDs + botão que avança, como no hardware)
// ou .multi (cada opção é um botão com LED próprio). Devolve get/set para os programas.
export function mountSelector(el, key, onChange) {
  const multi = el.classList.contains("multi");
  const buttons = [...el.querySelectorAll("button")];
  const groupName = el.dataset.name || el.previousElementSibling?.textContent?.trim() || key;
  const value = () => (multi ? Object.fromEntries(buttons.map((b) => [b.dataset[key], b.classList.contains("on")])) : el.querySelector(".on")?.dataset[key]);
  const sync = () => buttons.forEach((b) => {
    const on = b.classList.contains("on");
    if (multi) b.setAttribute("aria-pressed", on);
    else { b.setAttribute("aria-checked", on); b.tabIndex = on ? 0 : -1; }
  });
  if (!multi) {
    el.setAttribute("role", "radiogroup");
    el.setAttribute("aria-label", groupName);
    buttons.forEach((b) => b.setAttribute("role", "radio"));
  }
  const choose = (b) => {
    if (multi) b.classList.toggle("on");
    else buttons.forEach((x) => x.classList.toggle("on", x === b));
    sync();
    onChange(value());
  };
  for (const b of buttons) {
    b.addEventListener("click", () => choose(b));
    if (!multi) b.addEventListener("keydown", (e) => {
      const d = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 }[e.key];
      if (!d) return;
      e.preventDefault();
      const nb = buttons[(buttons.indexOf(b) + d + buttons.length) % buttons.length];
      choose(nb);
      nb.focus();
    });
  }
  if (!multi) {
    const cyc = document.createElement("button");
    cyc.className = "rubber cycle";
    cyc.type = "button";
    cyc.setAttribute("aria-label", `${groupName}: próxima opção`);
    cyc.addEventListener("click", () => {
      const i = buttons.findIndex((b) => b.classList.contains("on"));
      choose(buttons[(i + 1) % buttons.length]);
    });
    el.appendChild(cyc);
  }
  sync();
  return {
    get: value,
    set(v) {
      if (multi) buttons.forEach((b) => b.classList.toggle("on", !!v[b.dataset[key]]));
      else buttons.forEach((b) => b.classList.toggle("on", b.dataset[key] === String(v)));
      sync();
      onChange(value());
    },
  };
}

// Drawbars estilo Hammond: a haste sai do trilho com a escala 1–8 impressa e o puxador colorido na ponta.
export function mountDrawbars(el, bars, initial, onChange) {
  const levels = [...initial];
  const items = bars.map((bar, i) => {
    const d = document.createElement("div");
    d.className = `drawbar ${bar.color}`;
    d.setAttribute("role", "slider");
    d.setAttribute("aria-label", `Drawbar ${bar.name}`);
    d.setAttribute("aria-valuemin", "0");
    d.setAttribute("aria-valuemax", "8");
    d.setAttribute("aria-orientation", "vertical");
    const scale = Array.from({ length: 8 }, (_, k) => `<em>${k + 1}</em>`).join("");
    d.innerHTML = `<small aria-hidden="true">${bar.name}</small><div class="track" aria-hidden="true"><div class="shaft"><div class="scale">${scale}</div></div><div class="pull"><b></b></div></div>`;
    const render = () => {
      d.style.setProperty("--l", levels[i]);
      d.setAttribute("aria-valuenow", levels[i]);
      d.setAttribute("aria-valuetext", `${bar.name}: ${levels[i]}`);
    };
    // Puxar para baixo abre o drawbar (como no órgão): arrasto invertido.
    const setLevel = (v) => {
      const lvl = Math.round(v * 8);
      if (lvl === levels[i]) return;
      levels[i] = lvl;
      render();
      onChange(i, lvl);
    };
    dragValue(d, () => 1 - levels[i] / 8, (v) => setLevel(1 - v), 90);
    // Teclas: seta para baixo puxa (aumenta), para cima empurra.
    d.addEventListener("keydown", (e) => {
      const k = { ArrowDown: 1, ArrowUp: -1, ArrowRight: 1, ArrowLeft: -1 }[e.key];
      if (k) { e.stopImmediatePropagation(); e.preventDefault(); setLevel(Math.min(8, Math.max(0, levels[i] + k)) / 8); }
      else if (/^[0-8]$/.test(e.key)) { e.preventDefault(); setLevel(+e.key / 8); }
    }, { capture: true });
    render();
    el.appendChild(d);
    return { set: (lvl) => { levels[i] = lvl; render(); onChange(i, lvl); } };
  });
  return { get: () => [...levels], set: (arr) => arr.forEach((l, i) => items[i].set(l)) };
}

// Display de 7 segmentos em SVG (segmentos apagados visíveis, acesos com brilho).
//    a
//  f   b
//    g
//  e   c
//    d
const SEGS = {
  a: "2,1 3,0 9,0 10,1 9,2 3,2", g: "2,11 3,10 9,10 10,11 9,12 3,12", d: "2,21 3,20 9,20 10,21 9,22 3,22",
  f: "1,2 2,3 2,9 1,10 0,9 0,3", b: "11,2 12,3 12,9 11,10 10,9 10,3",
  e: "1,12 2,13 2,19 1,20 0,19 0,13", c: "11,12 12,13 12,19 11,20 10,19 10,13",
};
const GLYPH = {
  0: "abcdef", 1: "bc", 2: "abdeg", 3: "abcdg", 4: "bcfg", 5: "acdfg", 6: "acdefg", 7: "abc", 8: "abcdefg", 9: "abcdfg",
  A: "abcefg", b: "cdefg", C: "adef", d: "bcdeg", E: "adefg", F: "aefg", P: "abefg", L: "def", o: "cdeg", n: "ceg", r: "eg", u: "cde", "-": "g", " ": "", _: "d",
};
export function mountSeg(el, chars, { colon = -1 } = {}) {
  const W = 15;
  const width = chars * W + (colon >= 0 ? 5 : 0);
  let svg = `<svg viewBox="-1 -1 ${width + 1} 24" aria-hidden="true">`;
  let x = 0;
  for (let i = 0; i < chars; i++) {
    if (i === colon) { svg += `<g class="col"><rect x="${x + 0.5}" y="5.5" width="2" height="2" rx=".4"/><rect x="${x + 0.5}" y="14.5" width="2" height="2" rx=".4"/></g>`; x += 5; }
    svg += `<g class="dg" transform="translate(${x + 1.2} 0) skewX(-6)">${Object.entries(SEGS).map(([k, p]) => `<polygon data-s="${k}" points="${p}"/>`).join("")}</g>`;
    x += W;
  }
  svg += `</svg><span class="sr"></span>`;
  el.innerHTML = svg;
  el.classList.add("seg7");
  const digits = [...el.querySelectorAll(".dg")];
  const sr = el.querySelector(".sr");
  const colonG = el.querySelector(".col");
  return {
    set(text, label = text) {
      const s = String(text).replace(":", "").padStart(chars, " ").slice(-chars);
      digits.forEach((g, i) => {
        const on = GLYPH[s[i]] ?? GLYPH[s[i].toUpperCase()] ?? "";
        g.querySelectorAll("polygon").forEach((p) => p.classList.toggle("on", on.includes(p.dataset.s)));
      });
      colonG?.classList.toggle("on", String(text).includes(":"));
      sr.textContent = label;
    },
  };
}

// Pitch stick (volta ao centro) e mod wheel. onBend(-1…1), onMod(0…1).
export function mountWheels(el, onBend, onMod) {
  el.innerHTML = `
    <div class="wheel-box"><div class="stick" role="slider" aria-label="Pitch bend" aria-valuemin="-100" aria-valuemax="100" aria-valuenow="0" aria-orientation="horizontal" tabindex="0"><div class="stick-slot"></div><div class="stick-knob"></div></div><span>Pitch</span></div>
    <div class="wheel-box"><div class="modw" role="slider" aria-label="Modulação" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0" aria-orientation="vertical" tabindex="0"><div class="modw-drum"></div></div><span>Mod</span></div>`;
  const stick = el.querySelector(".stick");
  const modw = el.querySelector(".modw");
  let bend = 0, mod = 0;
  const setBend = (b) => {
    bend = Math.max(-1, Math.min(1, b));
    stick.style.setProperty("--b", bend);
    stick.setAttribute("aria-valuenow", Math.round(bend * 100));
    onBend(bend);
  };
  const setMod = (m) => {
    mod = clamp01(m);
    modw.style.setProperty("--m", mod);
    modw.setAttribute("aria-valuenow", Math.round(mod * 100));
    onMod(mod);
  };
  stick.addEventListener("pointerdown", (e) => {
    stick.setPointerCapture(e.pointerId);
    const r = stick.getBoundingClientRect();
    const x0 = e.clientX;
    stick.classList.add("grab");
    const move = (ev) => setBend((ev.clientX - x0) / (r.width / 2));
    const up = () => {
      stick.classList.remove("grab");
      stick.removeEventListener("pointermove", move);
      stick.removeEventListener("pointerup", up);
      stick.removeEventListener("pointercancel", up);
      setBend(0);
    };
    stick.addEventListener("pointermove", move);
    stick.addEventListener("pointerup", up);
    stick.addEventListener("pointercancel", up);
  });
  // Teclado: as setas dobram enquanto pressionadas; soltar volta ao centro.
  stick.addEventListener("keydown", (e) => {
    const d = { ArrowLeft: -1, ArrowRight: 1, ArrowDown: -1, ArrowUp: 1 }[e.key];
    if (d) { e.preventDefault(); setBend(d); }
  });
  stick.addEventListener("keyup", (e) => { if (e.key.startsWith("Arrow")) setBend(0); });
  stick.addEventListener("blur", () => bend && setBend(0));
  dragValue(modw, () => mod, setMod, 120);
  setBend(0);
  setMod(0);
}

// Teclado de 88 teclas (A0–C8). onNote(nota, velocity | 0).
export function mountKeyboard(el, onNote) {
  const LOW = 21, HIGH = 108;
  const keys = new Map();
  const whites = [];
  for (let n = LOW; n <= HIGH; n++) if (![1, 3, 6, 8, 10].includes(n % 12)) whites.push(n);
  const w = 100 / whites.length;
  // Deslocamento real das pretas dentro do grupo (C#/D# para fora, F#/A# levemente).
  const shift = { 1: -0.12, 3: 0.12, 6: -0.14, 8: 0, 10: 0.14 };
  el.setAttribute("aria-hidden", "true"); // tocado por mouse/toque; QWERTY e MIDI cobrem o teclado do computador
  for (let n = LOW; n <= HIGH; n++) {
    const black = [1, 3, 6, 8, 10].includes(n % 12);
    const k = document.createElement("div");
    k.dataset.note = n;
    if (black) {
      k.className = "key-b";
      const left = whites.indexOf(n - 1);
      const bw = w * 0.58;
      k.style.left = `${(left + 1) * w - bw / 2 + shift[n % 12] * bw}%`;
      k.style.width = `${bw}%`;
    } else {
      k.className = "key-w" + (n % 12 === 0 ? " c" : "");
      if (n % 12 === 0) k.dataset.oct = `C${n / 12 - 1}`;
    }
    el.appendChild(k);
    keys.set(n, k);
  }

  // Mouse/toque: a velocity depende da altura do toque na tecla (mais embaixo = mais forte).
  const pointers = new Map();
  const velAt = (k, y) => {
    const r = k.getBoundingClientRect();
    return Math.round(20 + 107 * clamp01((y - r.top) / r.height));
  };
  const keyAt = (x, y) => document.elementFromPoint(x, y)?.closest("[data-note]");
  el.addEventListener("pointerdown", (e) => {
    const k = keyAt(e.clientX, e.clientY);
    if (!k) return;
    el.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, +k.dataset.note);
    onNote(+k.dataset.note, velAt(k, e.clientY));
  });
  el.addEventListener("pointermove", (e) => {
    if (!pointers.has(e.pointerId)) return;
    const k = keyAt(e.clientX, e.clientY);
    const n = k ? +k.dataset.note : null;
    if (n === pointers.get(e.pointerId)) return;
    onNote(pointers.get(e.pointerId), 0);
    pointers.set(e.pointerId, n);
    if (n) onNote(n, velAt(k, e.clientY));
  });
  const release = (e) => {
    if (!pointers.has(e.pointerId)) return;
    const n = pointers.get(e.pointerId);
    if (n) onNote(n, 0);
    pointers.delete(e.pointerId);
  };
  el.addEventListener("pointerup", release);
  el.addEventListener("pointercancel", release);

  // vel (opcional) acende a tecla de baixo para cima, mais forte quanto maior a velocity.
  return {
    show: (n, down, vel = 96) => {
      const k = keys.get(n);
      if (!k) return;
      if (down) k.style.setProperty("--vel", (Math.max(1, Math.min(127, vel)) / 127).toFixed(2));
      k.classList.toggle("down", down);
    },
  };
}