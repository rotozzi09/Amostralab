// Seção Piano: gerenciada 100% pelo AVAudioUnitSampler nativo do macOS (CoreAudio + AudioToolbox).
import { nativeBridge, arrayBufferToBase64 } from "./native-bridge.js";

function readSourceBuffer(source, onProgress) {
  return new Promise((resolve, reject) => {
    if (!source?.file) {
      reject(new Error(`Arquivo não encontrado para ${source?.name || "piano"}`));
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

function createPianoLayer(layer = "A") {
  let current = null;
  const knownKeys = new Set();

  return {
    init: () => Promise.resolve(),
    setQuality(mode) {
      nativeBridge.send("fx", { param: "perfMode", value: mode === "studio" ? "studio" : "live" });
    },
    setActive(on) {
      nativeBridge.send("sectionActive", { section: "piano", layer, on });
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
        section: "piano",
        layer,
        name: source.name || "piano.sf2",
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
      nativeBridge.send("unloadSound", { section: "piano", layer });
    },
    async remove(source) {
      const key = getSourceKey(source);
      knownKeys.delete(key);
      if (current?.key === key || current?.source === source) {
        current = null;
        nativeBridge.send("unloadSound", { section: "piano", layer });
      }
    },
    loaded: () => current?.source ?? null,
    noteOn: (note, vel) => current && nativeBridge.send("noteOn", { section: "piano", layer, note, vel }),
    noteOff: (note) => current && nativeBridge.send("noteOff", { section: "piano", layer, note }),
    sustain: (down) => current && nativeBridge.send("sustain", { section: "piano", layer, down }),
    pitchBend: (v) => current && nativeBridge.send("pitchBend", { section: "piano", layer, raw: v }),
    allOff: () => nativeBridge.send("allOff", { section: "piano", layer }),
    modWheel: (v) => current && nativeBridge.send("modWheel", { section: "piano", layer, value: v }),
  };
}

const A = createPianoLayer("A");
export const B = createPianoLayer("B");
export const { init, load, unload, remove, isInMemory, loaded, noteOn, noteOff, sustain, pitchBend, allOff, modWheel, setQuality, setActive } = A;