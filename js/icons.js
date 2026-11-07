// Ícones do painel, os mesmos do app nativo (Source/ui/Icons.cpp): desenhados num quadrado
// unitário (0…1), com uma parte em traço e outra preenchida. icon("hall") devolve um <svg>.

const PI = Math.PI;
const f = (n) => +n.toFixed(4);

function wave(x0, x1, yc, amp, cycles, phase, env) {
  let d = "";
  for (let i = 0; i <= 48; i++) {
    const t = i / 48;
    const y = yc - amp * (env ? env(t) : 1) * Math.sin(phase + t * cycles * 2 * PI);
    d += `${i ? "L" : "M"}${f(x0 + (x1 - x0) * t)} ${f(y)}`;
  }
  return d;
}
function arrow(x0, y, x1, head = 0.14) {
  const d = x1 > x0 ? -head : head;
  return `M${x0} ${y}L${x1} ${y}M${f(x1 + d)} ${f(y - head)}L${x1} ${y}L${f(x1 + d)} ${f(y + head)}`;
}
// Arco do JUCE: ângulos em radianos a partir das 12 h, sentido horário.
function arc(cx, cy, rx, ry, a0, a1, start = true) {
  const pt = (a) => `${f(cx + rx * Math.sin(a))} ${f(cy - ry * Math.cos(a))}`;
  let d = start ? `M${pt(a0)}` : `L${pt(a0)}`;
  for (let i = 1; i <= 24; i++) d += `L${pt(a0 + ((a1 - a0) * i) / 24)}`;
  return d;
}
const ellipse = (x, y, w, h) => {
  const rx = w / 2, ry = h / 2, cx = x + rx, cy = y + ry;
  return `M${f(cx - rx)} ${f(cy)}a${f(rx)} ${f(ry)} 0 1 0 ${f(w)} 0a${f(rx)} ${f(ry)} 0 1 0 ${f(-w)} 0Z`;
};
const rrect = (x, y, w, h, r) =>
  `M${f(x + r)} ${f(y)}H${f(x + w - r)}Q${f(x + w)} ${f(y)} ${f(x + w)} ${f(y + r)}V${f(y + h - r)}Q${f(x + w)} ${f(y + h)} ${f(x + w - r)} ${f(y + h)}H${f(x + r)}Q${f(x)} ${f(y + h)} ${f(x)} ${f(y + h - r)}V${f(y + r)}Q${f(x)} ${f(y)} ${f(x + r)} ${f(y)}Z`;
const poly = (pts, close = false) => pts.map(([x, y], i) => `${i ? "L" : "M"}${x} ${y}`).join("") + (close ? "Z" : "");

const S = {}, F = {};

// ---- Mod
S.tremolo = wave(0.05, 0.95, 0.5, 0.38, 3, 0, (t) => 0.25 + 0.75 * Math.abs(Math.sin(t * PI * 1.5)));
S.pan = arrow(0.42, 0.5, 0.04) + arrow(0.58, 0.5, 0.96) + "M0.5 0.25L0.5 0.75";
S.chorus = wave(0.05, 0.95, 0.42, 0.22, 2, 0) + wave(0.05, 0.95, 0.62, 0.22, 2, 1.2);
S.flanger = "M0.06 0.85L0.94 0.85" + [0, 1, 2, 3, 4, 5].map((i) => { const x = f(0.12 + i * 0.152); return `M${x} 0.85L${x} ${f(0.85 - (i % 2 ? 0.42 : 0.7))}`; }).join("");
S.phaser = wave(0.05, 0.95, 0.5, 0.3, 1.5, 0) + [0.22, 0.5, 0.78].map((x) => ellipse(x - 0.07, 0.5 - 0.07 - 0.3 * Math.sin(((x - 0.05) / 0.9) * 1.5 * 2 * PI), 0.14, 0.14)).join("");
// ---- Delay
S.mono = [0.75, 0.52, 0.34, 0.2].map((h, i) => { const x = f(0.14 + i * 0.24); return `M${x} 0.88L${x} ${f(0.88 - h)}`; }).join("") + "M0.04 0.88L0.96 0.88";
S.pingpong = "M0.04 0.5L0.96 0.5" + [0.4, 0.32, 0.24, 0.16].map((h, i) => { const x = f(0.14 + i * 0.24); return `M${x} 0.5L${x} ${f(i % 2 ? 0.5 + h : 0.5 - h)}`; }).join("");
S.tape = ellipse(0.06, 0.18, 0.36, 0.36) + ellipse(0.58, 0.18, 0.36, 0.36) + ellipse(0.2, 0.32, 0.08, 0.08) + ellipse(0.72, 0.32, 0.08, 0.08) + poly([[0.24, 0.54], [0.3, 0.82], [0.7, 0.82], [0.76, 0.54]]);
// ---- Reverb
S.room = poly([[0.1, 0.48], [0.5, 0.12], [0.9, 0.48]]) + poly([[0.2, 0.4], [0.2, 0.88], [0.8, 0.88], [0.8, 0.4]]) + poly([[0.42, 0.88], [0.42, 0.64], [0.58, 0.64], [0.58, 0.88]]);
S.stage = "M0.04 0.86L0.96 0.86M0.1 0.72L0.9 0.72M0.06 0.1Q0.3 0.3 0.16 0.66M0.94 0.1Q0.7 0.3 0.84 0.66M0.06 0.1L0.94 0.1";
F.stage = ellipse(0.44, 0.4, 0.12, 0.12);
S.hall = [0, 1, 2].map((i) => { const x = 0.08 + i * 0.29; return `M${f(x)} 0.9L${f(x)} 0.5` + arc(x + 0.13, 0.5, 0.13, 0.18, -PI / 2, PI / 2, false) + `L${f(x + 0.26)} 0.9`; }).join("") + "M0.04 0.9L0.96 0.9";
S.plate = poly([[0.12, 0.36], [0.78, 0.28], [0.88, 0.74], [0.22, 0.82]], true) + "M0.12 0.36L0.06 0.08M0.78 0.28L0.84 0.06M0.4 0.5L0.6 0.6";
S.spring = "M0.02 0.5" + Array.from({ length: 81 }, (_, i) => { const t = i / 80, a = t * 10 * PI; return `L${f(0.1 + 0.8 * t + 0.07 * Math.sin(a))} ${f(0.5 - 0.3 * Math.cos(a))}`; }).join("") + "L0.98 0.5";
// ---- Blocos e seções
S.mod = wave(0.05, 0.95, 0.5, 0.34, 1.5, 0);
S.delay = S.mono;
S.reverb = [1, 2, 3].map((i) => arc(0.14, 0.5, 0.24 * i, 0.24 * i, PI * 0.22, PI * 0.78)).join("");
F.reverb = ellipse(0.06, 0.42, 0.16, 0.16);
S.eq = [0, 1, 2].map((i) => { const x = f(0.2 + i * 0.3); return `M${x} 0.08L${x} 0.92`; }).join("");
F.eq = [0.62, 0.3, 0.5].map((y, i) => rrect(0.2 + i * 0.3 - 0.11, y - 0.07, 0.22, 0.14, 0.04)).join("");
S.drawbars = "M0.04 0.1L0.96 0.1" + [0.7, 0.45, 0.78, 0.3].map((l, i) => { const x = f(0.17 + i * 0.22); return `M${x} 0.1L${x} ${f(0.1 + l)}`; }).join("");
F.drawbars = [0.7, 0.45, 0.78, 0.3].map((l, i) => rrect(0.17 + i * 0.22 - 0.08, 0.1 + l, 0.16, 0.14, 0.03)).join("");
S.piano = rrect(0.06, 0.14, 0.88, 0.72, 0.06) + [1, 2, 3].map((i) => { const x = f(0.06 + 0.22 * i); return `M${x} 0.5L${x} 0.86`; }).join("");
F.piano = [0.22, 0.5, 0.72].map((x) => rrect(x - 0.06, 0.14, 0.12, 0.38, 0)).join("");
S.synth = poly([[0.04, 0.78], [0.36, 0.22], [0.36, 0.78], [0.68, 0.22], [0.68, 0.78], [0.96, 0.3]]);
S.strings = [0.15, 0.35, 0.55, 0.75, 0.9].map((x) => `M${x} 0.12L${x} 0.88`).join("") + "M0.1 0.2L0.9 0.2";
S.master = ellipse(0.14, 0.14, 0.72, 0.72) + "M0.5 0.5L0.72 0.26" + Array.from({ length: 7 }, (_, i) => { const a = ((-135 + 45 * i) * PI) / 180; return `M${f(0.5 + 0.44 * Math.sin(a))} ${f(0.5 - 0.44 * Math.cos(a))}L${f(0.5 + 0.5 * Math.sin(a))} ${f(0.5 - 0.5 * Math.cos(a))}`; }).join("");
S.program = [0, 1, 2, 3].map((i) => rrect(0.08 + (i % 2) * 0.46, 0.08 + Math.floor(i / 2) * 0.46, 0.38, 0.38, 0.06)).join("");
F.program = rrect(0.08, 0.08, 0.38, 0.38, 0.06);
const star = (cx, cy, r) => `M${cx} ${f(cy - r)}Q${cx} ${cy} ${f(cx + r)} ${cy}Q${cx} ${cy} ${cx} ${f(cy + r)}Q${cx} ${cy} ${f(cx - r)} ${cy}Q${cx} ${cy} ${cx} ${f(cy - r)}Z`;
F.fx = star(0.4, 0.55, 0.38) + star(0.8, 0.2, 0.17);
// ---- Botões e status
S.power = arc(0.5, 0.55, 0.36, 0.36, PI * 0.2, PI * 1.8) + "M0.5 0.06L0.5 0.5";
S.pedal = poly([[0.22, 0.12], [0.62, 0.12], [0.74, 0.7], [0.14, 0.7]], true) + "M0.04 0.9L0.96 0.9M0.82 0.9L0.74 0.7M0.3 0.32L0.56 0.32";
S.alert = poly([[0.5, 0.08], [0.94, 0.88], [0.06, 0.88]], true) + "M0.5 0.36L0.5 0.6";
F.alert = ellipse(0.44, 0.68, 0.12, 0.12);
S.split = "M0.5 0.06L0.5 0.94" + arrow(0.4, 0.5, 0.04, 0.12) + arrow(0.6, 0.5, 0.96, 0.12);
S.save = rrect(0.12, 0.12, 0.76, 0.76, 0.08) + poly([[0.26, 0.12], [0.26, 0.42], [0.74, 0.42], [0.74, 0.12]]) + rrect(0.28, 0.52, 0.44, 0.34, 0.04);
S.layers = rrect(0.06, 0.36, 0.6, 0.56, 0.08) + poly([[0.24, 0.36], [0.24, 0.14], [0.9, 0.14], [0.9, 0.7], [0.66, 0.7]]);
// Só no web: conector DIN (MIDI Learn), engrenagem (Configurações Áudio/MIDI) e tela cheia.
S.midi = ellipse(0.06, 0.06, 0.88, 0.88) + "M0.4 0.9L0.4 0.8L0.6 0.8L0.6 0.9";
F.midi = [[0.5, 0.2], [0.27, 0.3], [0.73, 0.3], [0.2, 0.52], [0.8, 0.52]].map(([x, y]) => ellipse(x - 0.06, y - 0.06, 0.12, 0.12)).join("");
S.gear = "M0.4192 0.1904L0.437 0.0443L0.563 0.0443L0.5808 0.1904L0.6618 0.2239L0.7776 0.1332L0.8668 0.2224L0.7761 0.3382L0.8096 0.4192L0.9557 0.437L0.9557 0.563L0.8096 0.5808L0.7761 0.6618L0.8668 0.7776L0.7776 0.8668L0.6618 0.7761L0.5808 0.8096L0.563 0.9557L0.437 0.9557L0.4192 0.8096L0.3382 0.7761L0.2224 0.8668L0.1332 0.7776L0.2239 0.6618L0.1904 0.5808L0.0443 0.563L0.0443 0.437L0.1904 0.4192L0.2239 0.3382L0.1332 0.2224L0.2224 0.1332L0.3382 0.2239Z" +
  "M0.36 0.5a0.14 0.14 0 1 0 0.28 0a0.14 0.14 0 1 0 -0.28 0Z";
S.fullscreen = "M0.08 0.36L0.08 0.08L0.36 0.08M0.64 0.08L0.92 0.08L0.92 0.36M0.92 0.64L0.92 0.92L0.64 0.92M0.36 0.92L0.08 0.92L0.08 0.64";
S.fullscreenExit = "M0.08 0.36L0.36 0.36L0.36 0.08M0.64 0.08L0.64 0.36L0.92 0.36M0.92 0.64L0.64 0.64L0.64 0.92M0.36 0.92L0.36 0.64L0.08 0.64";
F.arrowLeft =poly([[0.22, 0.5], [0.78, 0.16], [0.78, 0.84]], true);
F.arrowRight = poly([[0.78, 0.5], [0.22, 0.16], [0.22, 0.84]], true);
S.note = "M0.62 0.76L0.62 0.08Q0.82 0.2 0.9 0.36";
F.note = ellipse(0.24, 0.62, 0.4, 0.3);
S.saw = poly([[0.04, 0.75], [0.5, 0.25], [0.5, 0.75], [0.96, 0.25], [0.96, 0.75]]);
S.square = poly([[0.04, 0.75], [0.04, 0.25], [0.34, 0.25], [0.34, 0.75], [0.66, 0.75], [0.66, 0.25], [0.96, 0.25], [0.96, 0.75]]);
S.triangle = poly([[0.04, 0.5], [0.2, 0.25], [0.5, 0.75], [0.8, 0.25], [0.96, 0.5]]);
S.supersaw = [0, 1, 2].map((i) => { const dx = (i - 1) * 0.07, dy = (i - 1) * 0.08; return poly([[f(0.06 + dx), f(0.75 + dy)], [f(0.5 + dx), f(0.25 + dy)], [f(0.5 + dx), f(0.75 + dy)], [f(0.94 + dx), f(0.25 + dy)]]); }).join("");
S.osc = S.saw;
S.filter = "M0.04 0.4L0.42 0.4Q0.58 0.4 0.62 0.22Q0.68 0.5 0.96 0.9";
S.envelope = poly([[0.04, 0.88], [0.22, 0.12], [0.42, 0.48], [0.72, 0.48], [0.96, 0.88]]);
S.amp = rrect(0.08, 0.16, 0.84, 0.68, 0.08) + ellipse(0.22, 0.34, 0.32, 0.32) + [0, 1, 2].map((i) => { const y = f(0.34 + i * 0.16); return `M0.64 ${y}L0.82 ${y}`; }).join("");
// Sample (modo SF2 do synth, só no web): barras de forma de onda.
F.sample = [0.2, 0.55, 0.35, 0.8, 0.45, 0.2].map((h, i) => rrect(0.06 + i * 0.155, 0.5 - h / 2, 0.09, h, 0.02)).join("");

// <svg> do ícone; a espessura do traço segue o tamanho como no nativo (≈1,3 px a 16 px).
export function icon(name, { stroke = 1.3, size = 16, cls = "ico" } = {}) {
  const s = S[name], fl = F[name];
  if (!s && !fl) return "";
  const w = (stroke / size).toFixed(4);
  return `<svg class="${cls}" viewBox="-0.04 -0.04 1.08 1.08" width="${size}" height="${size}" aria-hidden="true">` +
    (s ? `<path d="${s}" fill="none" stroke="currentColor" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round"/>` : "") +
    (fl ? `<path d="${fl}" fill="currentColor"/>` : "") + "</svg>";
}

// Troca cada <i data-icon="nome"> pelo ícone.
export function mountIcons(root = document) {
  for (const el of root.querySelectorAll("[data-icon]")) {
    if (el.firstElementChild?.matches("svg")) continue;
    el.insertAdjacentHTML("afterbegin", icon(el.dataset.icon, { size: +(el.dataset.size || 16), stroke: +(el.dataset.stroke || 1.3) }));
  }
}

export const ICON_NAMES = [...new Set([...Object.keys(S), ...Object.keys(F)])];