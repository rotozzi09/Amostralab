// Seção Strings: gerenciada 100% pelo AVAudioUnitSampler nativo do macOS (CoreAudio + AudioToolbox).
import { nativeBridge, arrayBufferToBase64 } from "./native-bridge.js";

function readSourceBuffer(source, onProgress) {
  return new Promise((resolve, reject) => {
    if (!source?.file) {
      reject(new Error(`Arquivo não encontrado para ${source?.name || "strings"}`));
      return;
    }
    const fr = new FileReader();
    fr.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    fr.onload = () => resolve(fr.result);
    fr.onerror = () => reject(fr.error);
    fr.readAsArrayBuffer(source.file);
  });
}

function getSourceKey(source) {
  if (!source) return "";
  if (source.nativePath) return source.nativePath;
  if (source.name && source.size) return `${source.name}_${source.size}`;
  return source.name || "default";
}

function createStringsLayer(layer = "A") {
  let current = null;
  const knownKeys = new Set();

  return {
    init: () => Promise.resolve(),
    setQuality(mode) {
      nativeBridge.send("fx", { param: "perfMode", value: mode === "studio" ? "studio" : "live" });
    },
    setActive(on) {
      nativeBridge.send("sectionActive", { section: "strings", layer, on });
    },
    isInMemory(source) {
      return knownKeys.has(getSourceKey(source));
    },
    async load(source, onProgress = () => {}, bank = 0, preset = 0) {
      const key = getSourceKey(source);
      if (!nativeBridge.active) {
        current = { id: 1, source, key, bank, preset };
        knownKeys.add(key);
        onProgress(1);
        return 1;
      }
      onProgress(0.2);
      const nativePath = source.nativePath || null;
      let base64 = null;
      if (!nativePath) {
        const bin = await readSourceBuffer(source, (p) => onProgress(0.2 + p * 0.5));
        base64 = arrayBufferToBase64(bin);
      }
      onProgress(0.8);
      const res = await nativeBridge.request("loadSound", {
        section: "strings",
        layer,
        name: source.name || "strings.sf2",
        path: nativePath,
        base64,
        bank,
        preset,
      });
      if (res?.path) source.nativePath = res.path;
      const resolvedKey = getSourceKey(source);
      knownKeys.add(key);
      knownKeys.add(resolvedKey);
      current = { id: 1, source, key: resolvedKey, bank: res?.bank ?? bank, preset: res?.preset ?? preset };
      onProgress(1);
      return 1;
    },
    async unload() {
      current = null;
      nativeBridge.send("unloadSound", { section: "strings", layer });
    },
    async remove(source) {
      const key = getSourceKey(source);
      knownKeys.delete(key);
      if (current?.key === key || current?.source === source) {
        current = null;
        nativeBridge.send("unloadSound", { section: "strings", layer });
      }
    },
    loaded: () => current?.source ?? null,
    noteOn: (note, vel) => current && nativeBridge.send("noteOn", { section: "strings", layer, note, vel }),
    noteOff: (note) => current && nativeBridge.send("noteOff", { section: "strings", layer, note }),
    sustain: (down) => current && nativeBridge.send("sustain", { section: "strings", layer, down }),
    pitchBend: (v) => current && nativeBridge.send("pitchBend", { section: "strings", layer, raw: v }),
    allOff: () => nativeBridge.send("allOff", { section: "strings", layer }),
    modWheel: (v) => current && nativeBridge.send("modWheel", { section: "strings", layer, value: v }),
  };
}

const A = createStringsLayer("A");
export const B = createStringsLayer("B");
export const { init, load, unload, remove, isInMemory, loaded, noteOn, noteOff, sustain, pitchBend, allOff, modWheel, setQuality, setActive } = A;
