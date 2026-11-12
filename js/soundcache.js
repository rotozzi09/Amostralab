// Gerenciamento de cache persistente via IndexedDB para arquivos .sf2 e sons convertidos (Nord, WAV, Fantom).
// Verifica se o arquivo já foi processado/convertido anteriormente com base num hash robusto do conteúdo (SHA-256)
// e carrega diretamente do IndexedDB para economizar 100% da CPU na conversão.

const DB_NAME = "LabPianoCache";
const DB_VERSION = 1;
const STORE_NAME = "converted_sf2";

let dbPromise = null;

function getDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    if (typeof indexedDB === "undefined") {
      resolve(null);
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: "key" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => {
      console.warn("[Cache] Falha ao abrir IndexedDB:", req.error);
      resolve(null);
    };
  });
  return dbPromise;
}

/**
 * Calcula um hash SHA-256 robusto do conteúdo binário (ArrayBuffer ou Blob) do arquivo original.
 * @param {ArrayBuffer|Blob} data
 * @returns {Promise<string>}
 */
export async function computeFileHash(data) {
  try {
    const buffer = data instanceof Blob ? await data.arrayBuffer() : data;
    if (!buffer || !(buffer instanceof ArrayBuffer)) return "";
    const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  } catch (err) {
    console.warn("[Cache] Falha ao calcular hash SHA-256, usando fallback por tamanho:", err);
    const size = data instanceof Blob ? data.size : (data?.byteLength ?? 0);
    return `size_${size}`;
  }
}

/**
 * Gera uma chave única no IndexedDB baseada no prefixo, hash do conteúdo e tom opcional.
 * @param {string} prefix ('nord', 'wav', 'svz', 'sf2')
 * @param {ArrayBuffer|Blob} fileData
 * @param {number|string} [tone]
 * @returns {Promise<string>}
 */
export async function getHashCacheKey(prefix, fileData, tone = "") {
  const hash = await computeFileHash(fileData);
  const toneSuffix = tone !== "" && tone != null ? `_tone${tone}` : "";
  return `${prefix}_${hash}${toneSuffix}`;
}

/**
 * Busca no IndexedDB se o arquivo convertido já está armazenado no cache pelo hash.
 * @param {string} key
 * @returns {Promise<Blob|null>}
 */
export async function getCachedBlob(key) {
  try {
    const db = await getDb();
    if (!db) return null;
    return new Promise((resolve) => {
      const tx = db.transaction(STORE_NAME, "readonly");
      const store = tx.objectStore(STORE_NAME);
      const req = store.get(key);
      req.onsuccess = () => {
        if (req.result && req.result.blob) {
          resolve(req.result.blob);
        } else {
          resolve(null);
        }
      };
      req.onerror = () => resolve(null);
    });
  } catch (err) {
    console.warn("[Cache] Erro ao recuperar cache:", err);
    return null;
  }
}

/**
 * Salva o Blob convertido no IndexedDB.
 * @param {string} key
 * @param {Blob} blob
 * @param {string} name
 */
export async function setCachedBlob(key, blob, name) {
  try {
    const db = await getDb();
    if (!db) return;
    const tx = db.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);
    store.put({
      key,
      name,
      blob,
      size: blob.size,
      updatedAt: Date.now()
    });
  } catch (err) {
    console.warn("[Cache] Erro ao salvar cache:", err);
  }
}

// Mantido para compatibilidade com código existente
export function getSoundKey(sound) {
  if (!sound) return "";
  const size = sound.size || (sound.file?.size ?? 0);
  const tone = sound.tone != null ? `_tone${sound.tone}` : "";
  const baseName = (sound.name || "sound").replace(/\.[^.]+$/, "");
  return `sf2_${baseName}${tone}_${size}`;
}

export async function getCachedSf2(key) {
  return getCachedBlob(key);
}

export async function setCachedSf2(key, blob, name) {
  return setCachedBlob(key, blob, name);
}

export async function checkCachedSf2(sound) {
  if (!sound) return null;
  if (sound.converted) return sound.converted;
  return null;
}

export async function saveCachedSf2(sound, blob) {
  if (!sound || !blob) return;
  const fileData = sound.file ?? (sound.url ? await (await fetch(sound.url)).arrayBuffer() : null);
  if (fileData) {
    const prefix = sound.nord ? "nord" : sound.fantom ? "svz" : sound.wav ? "wav" : "sf2";
    const key = await getHashCacheKey(prefix, fileData, sound.tone);
    await setCachedBlob(key, blob, sound.name);
  }
}
