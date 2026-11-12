// Mini-displays do painel: Gráficos estáticos e elegantes dos efeitos e synth.
// Renderiza o visual uma única vez ao carregar a página sem laços de CPU/GPU ou observadores.

const W = 100, H = 40;

function render(svg, d, { fill = false, label = "", label2 = "" } = {}) {
  if (!svg || !svg.parentElement) return;
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svg.setAttribute("preserveAspectRatio", "none");
  svg.innerHTML =
    `<g class="grid">${[10, 20, 30].map((y) => `<line x1="0" x2="${W}" y1="${y}" y2="${y}"/>`).join("")}</g>` +
    (fill ? `<path class="area" d="${d} L${W} ${H} L0 ${H} Z"/>` : "") +
    `<path class="line" d="${d}"/>`;

  const host = svg.parentElement;
  if (!host.querySelector(".viz-l")) {
    host.insertAdjacentHTML("beforeend", `<span class="viz-l"></span><span class="viz-r"></span>`);
  }
  const lEl = host.querySelector(".viz-l");
  const rEl = host.querySelector(".viz-r");
  if (lEl) lEl.textContent = label;
  if (rEl) rEl.textContent = label2;
}

export function refreshVisuals() {
  // Synth A
  const oscA = document.querySelector('svg[data-viz="osc"]');
  if (oscA) render(oscA, "M0 30 L25 10 L25 30 L50 10 L50 30 L75 10 L75 30 L100 10", { label: "SAW", label2: "DET 30%" });

  const filterA = document.querySelector('svg[data-viz="filter"]');
  if (filterA) render(filterA, "M0 12 L50 12 Q64 6 72 16 L100 36", { fill: true, label: "2.4 kHz", label2: "Q 1.2" });

  const envA = document.querySelector('svg[data-viz="env"]');
  if (envA) render(envA, "M0 38 L15 6 L35 16 L65 16 L100 38", { fill: true, label: "ADSR", label2: "A 50ms · R 300ms" });

  // Synth B
  const oscB = document.querySelector('svg[data-viz="oscB"]');
  if (oscB) render(oscB, "M0 30 L25 10 L25 30 L50 10 L50 30 L75 10 L75 30 L100 10", { label: "SUPER", label2: "DET 40%" });

  const filterB = document.querySelector('svg[data-viz="filterB"]');
  if (filterB) render(filterB, "M0 14 L45 14 Q58 8 68 18 L100 36", { fill: true, label: "1.8 kHz", label2: "Q 1.0" });

  const envB = document.querySelector('svg[data-viz="envB"]');
  if (envB) render(envB, "M0 38 L25 10 L45 18 L75 18 L100 38", { fill: true, label: "ADSR", label2: "A 300ms · R 500ms" });

  // Efeitos
  const mod = document.querySelector('svg[data-viz="mod"]');
  if (mod) render(mod, "M0 20 Q12.5 6 25 20 T50 20 T75 20 T100 20", { label: "CHORUS", label2: "1.2 Hz" });

  const delay = document.querySelector('svg[data-viz="delay"]');
  if (delay) render(delay, "M10 38 V8 M30 38 V14 M50 38 V22 M70 38 V30 M90 38 V34", { label: "380 ms", label2: "PING" });

  const reverb = document.querySelector('svg[data-viz="reverb"]');
  if (reverb) render(reverb, "M0 8 Q20 20 40 28 T100 38", { fill: true, label: "1.8 s", label2: "STAGE" });

  const eq = document.querySelector('svg[data-viz="eq"]');
  if (eq) render(eq, "M0 20 Q20 14 35 20 T65 24 T100 16", { label: "EQ", label2: "COMP" });
}

window.refreshVisuals = refreshVisuals;

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", refreshVisuals);
} else {
  refreshVisuals();
}