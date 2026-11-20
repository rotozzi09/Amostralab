// Celular: um módulo por vez (abas) e teclado com teclas largas, mudado de oitava por botões
// (arrastar o dedo nas teclas é glissando, não rolagem). No desktop as abas ficam escondidas.
import { noteName } from "./sf2reader.js";

const TABS = [
  ["m-piano", "Piano"],
  ["m-program", "Program"],
  ["m-master", "Master"],
  ["m-organ", "Organ"],
  ["m-synth", "Synth"],
  ["m-fx", "Efeitos"],
];
const phone = matchMedia("(max-width: 760px), (orientation: landscape) and (max-height: 500px)");

export function mountTabs(panel) {
  const bar = document.createElement("div");
  bar.className = "mtabs";
  bar.setAttribute("role", "tablist");
  bar.setAttribute("aria-label", "Módulos");
  const show = (cls) => {
    for (const [c] of TABS) {
      panel.querySelector(`.${c}`)?.classList.toggle("tab-on", c === cls);
      const b = bar.querySelector(`[data-tab="${c}"]`);
      b.classList.toggle("on", c === cls);
      b.setAttribute("aria-selected", c === cls);
    }
  };
  for (const [cls, label] of TABS) {
    const b = document.createElement("button");
    b.type = "button";
    b.dataset.tab = cls;
    b.setAttribute("role", "tab");
    b.innerHTML = `<span class="led"></span>${label}`;
    b.addEventListener("click", () => show(cls));
    bar.appendChild(b);
  }
  panel.prepend(bar);
  show("m-piano");
  // Cadeado nas abas travadas e LED aceso nas seções ligadas (lidos do próprio painel).
  const sync = () => {
    for (const [cls] of TABS) {
      const mod = panel.querySelector(`.${cls}`);
      const b = bar.querySelector(`[data-tab="${cls}"]`);
      b.classList.toggle("locked-tab", !!mod?.classList.contains("locked"));
      b.classList.toggle("lit", !!mod?.matches(".section:not(.off)"));
    }
  };
  new MutationObserver(sync).observe(panel, { subtree: true, attributes: true, attributeFilter: ["class"] });
  sync();
}

export function mountKeyNav(keybed) {
  const wrap = keybed.querySelector(".keys-wrap");
  const nav = document.createElement("div");
  nav.className = "knav";
  nav.innerHTML = `<button type="button" class="knav-btn" data-d="-1" aria-label="Oitava abaixo">◀</button>
    <span class="knav-range" role="status"></span>
    <button type="button" class="knav-btn" data-d="1" aria-label="Oitava acima">▶</button>`;
  keybed.prepend(nav);
  const range = nav.querySelector(".knav-range");
  const whites = () => [...wrap.querySelectorAll(".key-w")];

  const label = () => {
    const ks = whites();
    const r = wrap.getBoundingClientRect();
    const vis = ks.filter((k) => { const b = k.getBoundingClientRect(); return b.left >= r.left - 2 && b.right <= r.right + 2; });
    if (vis.length) range.textContent = `${noteName(+vis[0].dataset.note)} – ${noteName(+vis.at(-1).dataset.note)}`;
  };
  const goTo = (note, smooth) => {
    const k = wrap.querySelector(`[data-note="${note}"]`);
    if (!k) return;
    wrap.scrollTo({ left: k.offsetLeft, behavior: smooth ? "smooth" : "auto" });
  };
  let base = 60; // C4
  nav.addEventListener("click", (e) => {
    const b = e.target.closest("[data-d]");
    if (!b) return;
    base = Math.max(24, Math.min(96, base + 12 * +b.dataset.d));
    goTo(base, true);
  });
  wrap.addEventListener("scroll", () => requestAnimationFrame(label), { passive: true });
  const reset = () => { if (phone.matches) goTo(base, false); label(); };
  phone.addEventListener("change", reset);
  addEventListener("resize", label);
  requestAnimationFrame(reset);
}