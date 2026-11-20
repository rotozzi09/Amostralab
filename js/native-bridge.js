// Ponte entre a interface web (WKWebView) e o motor nativo macOS (CoreAudio + CoreMIDI + Foundation + libc++).
// No navegador comum, `active` é false e tudo continua usando Web Audio / WebAssembly normalmente.

const handler = typeof window !== "undefined" ? window.webkit?.messageHandlers?.workestraNative : null;
const pending = new Map();
const listeners = new Map();
let nextReqId = 1;

if (typeof window !== "undefined") {
  window.__workestraNativeResolve = (reqId, ok, data, error) => {
    const entry = pending.get(reqId);
    if (!entry) return;
    pending.delete(reqId);
    clearTimeout(entry.timer);
    if (ok) entry.resolve(data);
    else entry.reject(new Error(error || "Erro na chamada nativa macOS"));
  };

  window.__workestraNativeEvent = (type, data) => {
    const set = listeners.get(type);
    if (set) {
      for (const fn of set) {
        try { fn(data); } catch (err) { console.error("Erro em listener nativo:", err); }
      }
    }
    const anySet = listeners.get("*");
    if (anySet) {
      for (const fn of anySet) {
        try { fn({ type, data }); } catch (err) { console.error("Erro em listener nativo:", err); }
      }
    }
  };
}

export function arrayBufferToBase64(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const chunk = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += chunk) {
    const slice = bytes.subarray(i, Math.min(i + chunk, bytes.length));
    binary += String.fromCharCode(...slice);
  }
  return btoa(binary);
}

export const nativeBridge = {
  active: Boolean(handler),
  send(type, payload = {}) {
    if (!handler) return false;
    try {
      handler.postMessage({ type, payload });
      return true;
    } catch (err) {
      console.warn("nativeBridge.send falhou:", type, err);
      return false;
    }
  },
  request(type, payload = {}, timeoutMs = 30000) {
    if (!handler) return Promise.reject(new Error("Motor nativo macOS indisponível"));
    const reqId = nextReqId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(reqId);
        reject(new Error(`Timeout na chamada nativa: ${type}`));
      }, timeoutMs);
      pending.set(reqId, { resolve, reject, timer });
      try {
        handler.postMessage({ reqId, type, payload });
      } catch (err) {
        clearTimeout(timer);
        pending.delete(reqId);
        reject(err);
      }
    });
  },
  onEvent(type, fn) {
    let set = listeners.get(type);
    if (!set) {
      set = new Set();
      listeners.set(type, set);
    }
    set.add(fn);
    return () => set.delete(fn);
  },
};
