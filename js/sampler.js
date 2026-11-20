// Synth no modo Sample: gerenciado 100% pelo AVAudioUnitSampler nativo do macOS (CoreAudio).
import { nativeBridge, arrayBufferToBase64 } from "./native-bridge.js";
import { readSf2 } from "./sf2reader.js";

let current = null; // { id, source, key, name, presets, preset }
const knownFonts = new Map();

function readSourceBuffer(source, onProgress) {
  return new Promise((resolve, reject) => {
    if (!source?.file) {
      reject(new Error(`Arquivo não encontrado para ${source?.name || "synth"}`));
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

export function setQuality(mode) {
  nativeBridge.send("fx", { param: "perfMode", value: mode === "studio" ? "studio" : "live" });
}

export function setActive(on) {
  nativeBridge.send("sectionActive", { section: "synth", layer: "A", on });
}

export const init = () => Promise.resolve();

export async function load(source, onProgress = () => {}) {
  const key = getSourceKey(source);
  let presets = [{ bank: 0, num: 0, name: "Preset 0" }];

  try {
    const sf = await readSf2(source);
    if (sf?.presets?.length) {
      presets = sf.presets.map((p) => ({ bank: p.bank, num: p.preset, name: p.name.trim() || `Preset ${p.preset}` }));
    }
  } catch {
    // fallback padrão
  }

  const first = presets[0];

  if (!nativeBridge.active) {
    current = {
      id: 1,
      source,
      key,
      name: (source.name || "SF2").replace(/\.sf2$/i, ""),
      presets,
      preset: first,
    };
    knownFonts.set(key, current);
    onProgress(1);
    return info();
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
    section: "synth",
    layer: "A",
    name: source.name || "synth.sf2",
    path: nativePath,
    base64,
    bank: first.bank,
    preset: first.num,
  });
  if (res?.path) source.nativePath = res.path;
  const resolvedKey = getSourceKey(source);
  const outPresets = Array.isArray(res?.presets) && res.presets.length ? res.presets : presets;
  const fontInfo = {
    id: 1,
    source,
    key: resolvedKey,
    name: (source.name || "SF2").replace(/\.sf2$/i, ""),
    presets: outPresets,
    preset: outPresets[0] || first,
  };
  knownFonts.set(key, fontInfo);
  knownFonts.set(resolvedKey, fontInfo);
  current = { ...fontInfo };
  onProgress(1);
  return info();
}

export function isInMemory(source) {
  return knownFonts.has(getSourceKey(source));
}

export function unload() {
  current = null;
  nativeBridge.send("unloadSound", { section: "synth", layer: "A" });
}

export async function remove(source) {
  const key = getSourceKey(source);
  knownFonts.delete(key);
  if (current?.key === key || current?.source === source) {
    current = null;
    nativeBridge.send("unloadSound", { section: "synth", layer: "A" });
  }
}

export function selectPreset(bank, num) {
  if (!current) return;
  nativeBridge.send("selectPreset", { section: "synth", layer: "A", bank, preset: num });
  current.preset = current.presets.find((p) => p.bank === bank && p.num === num) ?? { bank, num, name: "" };
}

const info = () => current && { name: current.name, presets: current.presets, preset: current.preset };
export const loaded = () => current?.source ?? null;
export const state = () => info();