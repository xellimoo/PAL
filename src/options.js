import { encryptSecret } from "./lib/crypto.js";

const $ = (id) => document.getElementById(id);

const DEFAULTS = {
  openai: { baseUrl: "https://api.openai.com/v1", model: "gpt-4o" },
  anthropic: { baseUrl: "https://api.anthropic.com/v1", model: "claude-sonnet-4-6" },
  gemini: { baseUrl: "https://generativelanguage.googleapis.com/v1beta", model: "gemini-2.5-flash" },
};

const HINTS = {
  openai: "Example: https://api.deepseek.com  ·  model deepseek-chat. Vision needs a vision-capable model.",
  anthropic: "Native Claude API. Transcript is sent as an ephemeral cached block.",
  gemini: "Native Gemini API; the key is passed in the request URL.",
};

function applySpecDefaults() {
  const spec = $("spec").value;
  $("spec-hint").textContent = HINTS[spec];
  if (!$("baseUrl").value) $("baseUrl").value = DEFAULTS[spec].baseUrl;
  if (!$("model").value) $("model").value = DEFAULTS[spec].model;
}

function showErr(msg) {
  const e = $("err");
  if (!msg) return e.classList.add("hidden");
  e.textContent = msg;
  e.classList.remove("hidden");
}

function validUrl(u) {
  try {
    const url = new URL(u);
    if (url.protocol === "https:") return true;
    if (url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1")) return true;
    return false;
  } catch {
    return false;
  }
}

async function load() {
  const { vt_settings } = await chrome.storage.local.get("vt_settings");
  if (vt_settings) {
    $("spec").value = vt_settings.spec || "openai";
    $("baseUrl").value = vt_settings.baseUrl || "";
    $("model").value = vt_settings.model || "";
    $("maxTokens").value = vt_settings.maxTokens ?? 65536;
    $("contextThreshold").value = vt_settings.contextThreshold ?? 120000;
    $("windowMinutes").value = vt_settings.windowMinutes ?? 10;
    $("captionScrub").checked = vt_settings.captionScrub !== false;
    $("captionWindowSec").value = vt_settings.captionWindowSec ?? 20;
    $("debug").checked = !!vt_settings.debug;
    // Key is never shown back; placeholder indicates one is stored.
    if (vt_settings.key) $("apiKey").placeholder = "•••••• (stored — leave blank to keep)";
  }
  applySpecDefaults();
}

async function save() {
  showErr("");
  const spec = $("spec").value;
  const baseUrl = $("baseUrl").value.trim();
  const model = $("model").value.trim();
  const apiKey = $("apiKey").value;
  const passphrase = $("passphrase").value;

  if (!validUrl(baseUrl)) {
    showErr("Base URL must be HTTPS (or http://localhost / 127.0.0.1).");
    return;
  }
  if (!model) {
    showErr("Model is required.");
    return;
  }

  // Request host access to the endpoint now, while we have the Save click's user
  // activation. Without it the service worker can't reach the endpoint.
  try {
    const u = new URL(baseUrl);
    await chrome.permissions.request({ origins: [`${u.protocol}//${u.hostname}/*`] });
  } catch {}

  const prev = (await chrome.storage.local.get("vt_settings")).vt_settings || {};

  let key = prev.key || null;
  if (apiKey) {
    key = passphrase ? await encryptSecret(apiKey, passphrase) : { enc: false, plain: apiKey };
  } else if (passphrase && key && key.enc === false) {
    // user added a passphrase without re-entering the key: re-wrap existing plaintext
    key = await encryptSecret(key.plain, passphrase);
  }

  if (!key) {
    showErr("An API key is required.");
    return;
  }

  await chrome.storage.local.set({
    vt_settings: {
      spec,
      baseUrl,
      model,
      key,
      maxTokens: Number($("maxTokens").value) || 65536,
      contextThreshold: Number($("contextThreshold").value) || 120000,
      windowMinutes: Number($("windowMinutes").value) || 10,
      captionScrub: $("captionScrub").checked,
      captionWindowSec: Number($("captionWindowSec").value) || 20,
      debug: $("debug").checked,
    },
  });

  $("apiKey").value = "";
  $("passphrase").value = "";
  $("apiKey").placeholder = "•••••• (stored — leave blank to keep)";
  const s = $("saved");
  s.classList.remove("hidden");
  setTimeout(() => s.classList.add("hidden"), 1500);
}

$("spec").addEventListener("change", () => {
  // reset defaults to match the newly chosen spec
  $("baseUrl").value = "";
  $("model").value = "";
  applySpecDefaults();
});
$("save").addEventListener("click", save);

// --- Cached transcript management ---
async function refreshCacheInfo() {
  const all = await chrome.storage.local.get(null);
  const keys = Object.keys(all).filter((k) => k.startsWith("vt_yttx_"));
  let bytes = 0;
  try { bytes = await chrome.storage.local.getBytesInUse(keys); } catch {}
  const info = $("cacheinfo");
  if (!keys.length) {
    info.textContent = "No transcripts cached.";
  } else {
    const lines = keys.reduce((n, k) => n + (all[k]?.lines?.length || 0), 0);
    info.textContent =
      `${keys.length} video transcript(s), ${lines.toLocaleString()} lines` +
      `${bytes ? `, ~${Math.round(bytes / 1024)} KB` : ""}.`;
  }
  return keys;
}

$("clearcache").addEventListener("click", async () => {
  const keys = await refreshCacheInfo();
  if (!keys.length) return;
  await chrome.storage.local.remove(keys);
  await refreshCacheInfo();
});

load();
refreshCacheInfo();
