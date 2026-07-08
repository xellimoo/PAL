// WebCrypto AES-GCM wrap for the API key (corrected-spec §4).
// chrome.storage.local is plaintext on disk, so when the user sets a passphrase
// we store only ciphertext; the key is decrypted into service-worker memory per
// session and never persisted in the clear.

const enc = new TextEncoder();
const dec = new TextDecoder();

function b64(bytes) {
  let s = "";
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  for (let i = 0; i < arr.length; i++) s += String.fromCharCode(arr[i]);
  return btoa(s);
}

function ub64(str) {
  const bin = atob(str);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function deriveKey(passphrase, salt) {
  const baseKey = await crypto.subtle.importKey(
    "raw",
    enc.encode(passphrase),
    "PBKDF2",
    false,
    ["deriveKey"]
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations: 600000, hash: "SHA-256" },
    baseKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

export async function encryptSecret(plaintext, passphrase) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(passphrase, salt);
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    enc.encode(plaintext)
  );
  return { enc: true, salt: b64(salt), iv: b64(iv), ct: b64(ct) };
}

export async function decryptSecret(blob, passphrase) {
  const key = await deriveKey(passphrase, ub64(blob.salt));
  const pt = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: ub64(blob.iv) },
    key,
    ub64(blob.ct)
  );
  return dec.decode(pt);
}
