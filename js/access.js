// Acesso no AmostraLab: sem plano comprado, só o piano grátis toca. O resto do painel
// fica visível, mas travado. Fora do AmostraLab (serve.mjs, sem api/access) tudo fica livre.
const FREE = { full: true };

export async function fetchAccess() {
  try {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), 2000);
    const res = await fetch("api/access", { credentials: "same-origin", signal: controller.signal });
    clearTimeout(id);
    if (!res.ok) return FREE;
    const a = await res.json();
    return typeof a?.full === "boolean" ? a : FREE;
  } catch {
    return FREE;
  }
}

function unlockHref(a) {
  return a.logged_in ? a.plans_url : a.login_url;
}

function badge(a) {
  const el = document.createElement("div");
  el.className = "lock-badge";
  el.innerHTML = `<span class="lock-ico" aria-hidden="true"></span><span>Recurso do plano</span><a class="lock-cta"></a>`;
  const cta = el.querySelector("a");
  cta.href = unlockHref(a);
  cta.textContent = a.logged_in ? "Ver planos" : "Entrar";
  return el;
}

// Trava um bloco inteiro: inert tira clique e foco dos controles; o selo fica por cima.
export function lockBlock(el, a) {
  if (!el) return;
  for (const child of el.children) child.inert = true;
  el.classList.add("locked");
  el.appendChild(badge(a));
}

// Aviso curto para ações travadas (Load SF2, programas, arrastar arquivo).
let toastTimer;
export function lockedNotice(a, what) {
  let t = document.getElementById("lockToast");
  if (!t) {
    t = document.createElement("div");
    t.id = "lockToast";
    t.className = "lock-toast";
    t.setAttribute("role", "status");
    document.body.appendChild(t);
  }
  t.innerHTML = `<span>${what} é para quem tem plano. Compre qualquer plano uma vez e o LabPiano fica liberado para sempre.</span><a class="lock-cta"></a>`;
  const cta = t.querySelector("a");
  cta.href = unlockHref(a);
  cta.textContent = a.logged_in ? "Ver planos" : "Entrar";
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), 6000);
}