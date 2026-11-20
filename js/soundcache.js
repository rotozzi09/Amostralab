// Gerenciamento de chaves SHA-256 e cache nativo em SSD (~/Library/Application Support/WorkestraPiano/ConvertedCache).
// Zero duplicação de SoundFonts de centenas de MB em IndexedDB no WebKit.
import { nativeBridge } from "./native-bridge.js";

export async function computeFileHash(data) {
  try {
    const buffer = data instanceof Blob ? await data.arrayBuffer() : data;
    if (!buffer || !(buffer instanceof ArrayBuffer)) return "";
    const hashBuffer = await crypto.subtle.digest("SHA-256", buffer);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
  } catch {
    const size = data instanceof Blob ? data.size : (data?.byteLength ?? 0);
    return `size_${size}`;
  }
}

export async function getHashCacheKey(prefix, fileData, tone = "") {
  const hash = await computeFileHash(fileData);
  const toneSuffix = tone !== "" && tone != null ? `_tone${tone}` : "";
  return `${prefix}_${hash}${toneSuffix}`;
}

export async function checkNativeCachedPath(cacheKey) {
  if (!nativeBridge.active || !cacheKey) return null;
  try {
    const res = await nativeBridge.request("checkCachedSf2", { key: cacheKey });
    if (res?.exists && res.path) return { path: res.path, size: res.size || 0 };
  } catch {
    // sem cache em disco ainda
  }
  return null;
}

export function getSoundKey(sound) {
  if (!sound) return "";
  const size = sound.size || (sound.file?.size ?? 0);
  const tone = sound.tone != null ? `_tone${sound.tone}` : "";
  const baseName = (sound.name || "sound").replace(/\.[^.]+$/, "");
  return `sf2_${baseName}${tone}_${size}`;
}
