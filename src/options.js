import { encryptSecret } from "./lib/crypto.js";

const $ = (id) => document.getElementById(id);

const HINTS = {
  openai: "Example: https://api.deepseek.com  ·  model deepseek-chat. Vision needs a vision-capable model.",
  anthropic: "Native Claude API. Transcript is sent as an ephemeral cached block.",
  gemini: "Native Gemini API; the key is passed in the request URL.",
};

// Selecting a spec type only updates the hint text — it never overwrites the
// Base URL / Model the user typed. Generic placeholders guide them instead.
function applySpecHint() {
  $("spec-hint").textContent = HINTS[$("spec").value];
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

const uid = () => crypto.randomUUID();
const readStore = () => chrome.storage.local.get(["vt_settings", "vt_profiles"]);

let profiles = [];        // [{id,name,spec,baseUrl,model,key}]
let activeProfileId = null;
let editingId = null;     // profile loaded into the form, or null = new

async function load() {
  const { vt_settings, vt_profiles } = await readStore();
  let settings = vt_settings || {};
  let list = Array.isArray(vt_profiles) ? vt_profiles : [];

  // One-time migration: fold the legacy single-provider settings into one profile.
  if (!list.length && settings.baseUrl && settings.model) {
    const p = {
      id: uid(), name: "Default", spec: settings.spec || "openai",
      baseUrl: settings.baseUrl, model: settings.model, key: settings.key,
    };
    list = [p];
    settings = { ...settings, activeProfileId: p.id };
    delete settings.spec; delete settings.baseUrl; delete settings.model; delete settings.key;
    await chrome.storage.local.set({ vt_settings: settings, vt_profiles: list });
  }

  profiles = list;
  activeProfileId = settings.activeProfileId || (profiles[0] && profiles[0].id) || null;

  $("maxTokens").value = settings.maxTokens ?? 65536;
  $("contextThreshold").value = settings.contextThreshold ?? 120000;
  $("windowMinutes").value = settings.windowMinutes ?? 10;
  $("captionScrub").checked = settings.captionScrub !== false;
  $("captionWindowSec").value = settings.captionWindowSec ?? 20;
  $("debug").checked = !!settings.debug;

  renderList();
  const active = profiles.find((p) => p.id === activeProfileId) || profiles[0];
  if (active) loadForm(active); else clearForm();
  applySpecHint();
}

function renderList() {
  const ul = $("profileList");
  ul.innerHTML = "";
  profiles.forEach((p) => {
    const li = document.createElement("li");
    li.className = "profile-row" + (p.id === activeProfileId ? " active" : "");

    const head = document.createElement("div");
    head.className = "profile-head";
    const name = document.createElement("span");
    name.className = "profile-name";
    name.textContent = p.name || "(unnamed)";
    const sub = document.createElement("span");
    sub.className = "profile-sub";
    sub.textContent = `${p.spec} · ${p.model}`;
    head.append(name, sub);

    const ops = document.createElement("div");
    ops.className = "profile-ops";
    if (p.id === activeProfileId) {
      const badge = document.createElement("span");
      badge.className = "badge";
      badge.textContent = "active";
      ops.append(badge);
    } else {
      const use = document.createElement("button");
      use.className = "secondary small";
      use.textContent = "Use";
      use.onclick = () => makeActive(p.id);
      ops.append(use);
    }
    const edit = document.createElement("button");
    edit.className = "secondary small";
    edit.textContent = "Edit";
    edit.onclick = () => loadForm(p);
    const del = document.createElement("button");
    del.className = "secondary small danger";
    del.textContent = "Delete";
    del.onclick = () => delProfile(p.id);
    ops.append(edit, del);

    li.append(head, ops);
    ul.append(li);
  });
}

function loadForm(p) {
  editingId = p.id;
  $("formTitle").textContent = "Edit profile";
  $("profileName").value = p.name || "";
  $("spec").value = p.spec || "openai";
  $("baseUrl").value = p.baseUrl || "";
  $("model").value = p.model || "";
  $("apiKey").value = "";
  $("apiKey").placeholder = p.key ? "•••••• (stored — leave blank to keep)" : "sk-…";
  applySpecHint();
}

function clearForm() {
  editingId = null;
  $("formTitle").textContent = "Add profile";
  $("profileName").value = "";
  $("spec").value = "openai";
  $("baseUrl").value = "";
  $("model").value = "";
  $("apiKey").value = "";
  $("apiKey").placeholder = "sk-…";
  applySpecHint();
}

// Persist the global (non-provider) prefs + active id, leaving profiles untouched.
async function persistGlobals() {
  const { vt_settings } = await readStore();
  await chrome.storage.local.set({
    vt_settings: {
      ...(vt_settings || {}),
      activeProfileId,
      maxTokens: Number($("maxTokens").value) || 65536,
      contextThreshold: Number($("contextThreshold").value) || 120000,
      windowMinutes: Number($("windowMinutes").value) || 10,
      captionScrub: $("captionScrub").checked,
      captionWindowSec: Number($("captionWindowSec").value) || 20,
      debug: $("debug").checked,
    },
  });
}

async function save() {
  showErr("");
  const name = $("profileName").value.trim() || "Profile";
  const spec = $("spec").value;
  const baseUrl = $("baseUrl").value.trim();
  const model = $("model").value.trim();
  const apiKey = $("apiKey").value;
  const passphrase = $("passphrase").value;

  if (!validUrl(baseUrl)) { showErr("Base URL must be HTTPS (or http://localhost / 127.0.0.1)."); return; }
  if (!model) { showErr("Model is required."); return; }

  // Request host access to the endpoint now (needs the Save click's user activation).
  try {
    const u = new URL(baseUrl);
    await chrome.permissions.request({ origins: [`${u.protocol}//${u.hostname}/*`] });
  } catch {}

  // Resolve the key: typed (new), kept (editing + blank), or required (new profile).
  const existing = profiles.find((p) => p.id === editingId);
  let key = existing?.key || null;
  if (apiKey) {
    key = passphrase ? await encryptSecret(apiKey, passphrase) : { enc: false, plain: apiKey };
  } else if (!editingId) {
    showErr("An API key is required for a new profile."); return;
  } else if (passphrase && key && key.enc === false) {
    // adding a passphrase to an existing plaintext key
    key = await encryptSecret(key.plain, passphrase);
  } else if (!key) {
    showErr("An API key is required."); return;
  }

  const profile = { id: editingId || uid(), name, spec, baseUrl, model, key };
  if (editingId) {
    profiles = profiles.map((p) => (p.id === editingId ? profile : p));
  } else {
    profiles = [...profiles, profile];
    activeProfileId = profile.id; // a freshly added profile becomes active
  }

  await chrome.storage.local.set({ vt_profiles: profiles });
  await persistGlobals();

  $("apiKey").value = "";
  $("passphrase").value = "";
  renderList();
  loadForm(profile);
  const s = $("saved");
  s.classList.remove("hidden");
  setTimeout(() => s.classList.add("hidden"), 1500);
}

async function delProfile(id) {
  if (profiles.length <= 1) { showErr("Keep at least one profile."); return; }
  if (!confirm("Delete this provider profile?")) return;
  profiles = profiles.filter((p) => p.id !== id);
  if (activeProfileId === id) activeProfileId = profiles[0].id;
  await chrome.storage.local.set({ vt_profiles: profiles });
  await persistGlobals();
  renderList();
  const active = profiles.find((p) => p.id === activeProfileId);
  if (active) loadForm(active);
}

async function makeActive(id) {
  activeProfileId = id;
  await persistGlobals();
  renderList();
}

$("spec").addEventListener("change", applySpecHint);
$("save").addEventListener("click", save);
$("addProfile").addEventListener("click", clearForm);
$("cancelProfile").addEventListener("click", () => {
  const active = profiles.find((p) => p.id === activeProfileId) || profiles[0];
  if (active) loadForm(active); else clearForm();
});

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
