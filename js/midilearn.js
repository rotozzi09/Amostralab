// MIDI Learn como no nativo (Source/MidiLearn.h): um CC do controlador (qualquer canal) move um
// controle do painel. O mapa é do controlador, não do programa: fica no navegador (localStorage)
// e vale para todos os programas. CC 64 (sustain) e 120–127 (modo de canal) não são aprendidos.
//
// Aprender: o botão MIDI liga o modo (os controles mapeáveis ficam marcados); clicar num controle
// o arma e o próximo CC fica com ele. Clique direito num controle abre o menu do controle.
// Knobs, faders e drawbars seguem o valor 0–127; seletor escolhe a opção pela faixa do valor;
// botão liga/desliga troca de estado a cada aperto (valor cruzando 64 para cima).

const KEY = "labpiano.midimap";
const learnable = (cc) => cc >= 0 && cc < 120 && cc !== 64;

function heading(el) {
  return (el.closest(".fx-block")?.querySelector(".blk-h") ?? el.closest(".module")?.querySelector("h2"))?.textContent.trim() ?? "";
}

export function mountMidiLearn({ root, button, knobs, drawbars, notify }) {
  if (!button) return { handle: () => false }; // index.html antigo em cache, sem o botão
  const targets = new Map(); // id → { el, name, apply(v, last), toggle }
  const add = (el, id, label, apply, toggle = false) => {
    el.dataset.learn = id;
    const sec = heading(el);
    targets.set(id, { el, name: sec && sec !== label ? `${sec} · ${label}` : label, apply, toggle });
  };
  const layerB = (p) => (p.startsWith("B.") || p.includes(".B.") ? " B" : "");

  for (const el of root.querySelectorAll(".knob[data-param], .fader[data-param]")) {
    const p = el.dataset.param;
    add(el, `k:${p}`, (el.getAttribute("aria-label") || p) + layerB(p), (v) => knobs.get(p)?.set(v / 127));
  }
  for (const el of root.querySelectorAll(".selector[id]:not(.multi)")) {
    const opts = [...el.querySelectorAll("button:not(.cycle)")];
    add(el, `s:${el.id}`, el.getAttribute("aria-label") || el.id, (v) => {
      const b = opts[Math.min(opts.length - 1, Math.floor((v * opts.length) / 128))];
      if (b && !b.classList.contains("on")) b.click();
    });
  }
  for (const el of root.querySelectorAll(".selector.multi[id] button")) {
    add(el, `t:${el.parentElement.id}:${[...el.parentElement.children].indexOf(el)}`, el.textContent.trim(), () => el.click(), true);
  }
  for (const el of root.querySelectorAll("button[data-on]")) {
    add(el, `on:${el.dataset.on}`, "On", () => el.click(), true);
  }
  const storeBtn = root.querySelector("#storeBtn");
  if (storeBtn) add(storeBtn, "prog:store", "Program · Store", () => storeBtn.click(), true);
  const sustainBtn = root.querySelector("#sustainBtn");
  if (sustainBtn) add(sustainBtn, "prog:sustain", "Program · Sustain", () => sustainBtn.click(), true);
  const panicBtn = root.querySelector("#panicBtn");
  if (panicBtn) add(panicBtn, "prog:panic", "Program · Panic", () => panicBtn.click(), true);
  for (const el of root.querySelectorAll("#programs .btn")) {
    const num = el.textContent.trim();
    add(el, `prog:${num}`, `Program ${num}`, () => el.click(), true);
  }
  for (const [cid, api] of Object.entries(drawbars)) {
    root.querySelectorAll(`#${cid} .drawbar`).forEach((el, i) => {
      add(el, `d:${cid}:${i}`, (el.getAttribute("aria-label") || `Drawbar ${i + 1}`) + (cid.endsWith("B") ? " B" : ""), (v) => {
        const lv = api.get();
        lv[i] = Math.round((v * 8) / 127);
        api.set(lv);
      });
    });
  }

  let map = {}; // cc → id
  try { map = JSON.parse(localStorage.getItem(KEY) || "{}"); } catch { map = {}; }
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify(map)); } catch { /* sem storage: vale só nesta aba */ } };
  const ccFor = (id) => Object.keys(map).find((cc) => map[cc] === id);
  const badges = () => {
    for (const [id, t] of targets) {
      const cc = ccFor(id);
      if (cc != null) t.el.dataset.cc = `CC${cc}`;
      else delete t.el.dataset.cc;
    }
  };
  badges();

  const last = new Array(128).fill(0);
  let mode = false;
  let armed = null;

  function setArmed(id) {
    root.querySelector("[data-learn].learn-armed")?.classList.remove("learn-armed");
    armed = id;
    if (id) {
      targets.get(id).el.classList.add("learn-armed");
      notify(null, `MIDI Learn: ${targets.get(id).name}`, "Mexa um knob, fader ou botão do controlador");
    }
    button.classList.toggle("armed", !!id);
  }
  function setMode(on) {
    mode = on;
    document.body.classList.toggle("midi-learn", on);
    button.classList.toggle("on", on);
    button.setAttribute("aria-pressed", on);
    if (!on) setArmed(null);
    else notify(null, "MIDI Learn: clique num controle", `${Object.keys(map).length} mapeado(s) · Esc sai`);
  }
  function assign(cc, id) {
    for (const k of Object.keys(map)) if (map[k] === id) delete map[k]; // um CC por controle
    map[cc] = id; // e um controle por CC
    save();
    badges();
  }
  function clear(id) {
    const cc = ccFor(id);
    if (cc != null) { delete map[cc]; save(); badges(); }
  }

  button.addEventListener("click", () => setMode(!mode));
  addEventListener("keydown", (e) => { if (e.key === "Escape" && mode) setMode(false); });

  // No modo, clicar num controle arma em vez de mexer nele.
  const targetAt = (e) => e.target.closest?.("[data-learn]");
  const intercept = (e) => {
    if (!mode) return;
    const el = targetAt(e);
    if (!el) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.type === "pointerdown" && e.button === 0) setArmed(el.dataset.learn);
  };
  for (const t of ["pointerdown", "click", "dblclick"]) root.addEventListener(t, intercept, true);

  // Clique direito: menu do controle.
  const menu = document.createElement("div");
  menu.className = "learn-menu";
  menu.setAttribute("role", "menu");
  menu.hidden = true;
  document.body.appendChild(menu);
  const closeMenu = () => (menu.hidden = true);
  root.addEventListener("contextmenu", (e) => {
    const el = targetAt(e);
    if (!el) return;
    e.preventDefault();
    const id = el.dataset.learn;
    const cc = ccFor(id);
    const n = Object.keys(map).length;
    const items = [["learn", "Aprender MIDI"]];
    if (cc != null) items.push(["clear", `Remover CC ${cc}`]);
    if (armed) items.push(["cancel", "Cancelar aprendizado"]);
    if (n) items.push(["clearAll", `Remover todos (${n})`]);
    menu.innerHTML = `<div class="lm-title">${targets.get(id).name}</div>` + items.map(([k, t]) => `<button type="button" role="menuitem" data-k="${k}">${t}</button>`).join("");
    menu.hidden = false;
    menu.style.left = `${Math.min(e.clientX, innerWidth - menu.offsetWidth - 8)}px`;
    menu.style.top = `${Math.min(e.clientY, innerHeight - menu.offsetHeight - 8)}px`;
    menu.onclick = (ev) => {
      const k = ev.target.closest("button")?.dataset.k;
      if (k === "learn") setArmed(id);
      else if (k === "clear") { clear(id); notify(null, `${targets.get(id).name}: sem MIDI`, null); }
      else if (k === "cancel") setArmed(null);
      else if (k === "clearAll") { map = {}; save(); badges(); notify(null, "MIDI Learn: mapa apagado", null); }
      closeMenu();
    };
    menu.querySelector("button").focus();
  });
  addEventListener("pointerdown", (e) => { if (!menu.hidden && !menu.contains(e.target)) closeMenu(); }, true);
  addEventListener("keydown", (e) => { if (e.key === "Escape") closeMenu(); });

  // Mensagem MIDI: true = usada (aprendida ou mapeada) e não segue para o resto.
  return {
    handle(cc, v) {
      if (!learnable(cc)) return false;
      const prev = last[cc];
      last[cc] = v;
      if (armed) {
        const id = armed;
        assign(cc, id);
        setArmed(null);
        notify(null, `CC ${cc} → ${targets.get(id).name}`, mode ? "Clique em outro controle ou Esc para sair" : null);
        return true;
      }
      const t = targets.get(map[cc]);
      if (!t) return false;
      if (t.toggle) { if (v >= 64 && prev < 64) t.apply(v); }
      else t.apply(v);
      return true;
    },
  };
}