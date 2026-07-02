// Popup: UI only. All capture + network happens in the service worker, so the
// answer keeps streaming/finishing even if this popup closes (corrected-spec §1).

import { renderMarkdown } from "./lib/markdown.js";

const $ = (id) => document.getElementById(id);
const log = $("log");
const statusEl = $("status");
const askBtn = $("ask");
const promptEl = $("prompt");

// "?window=1" means we're the detached, resizable standalone window.
const DETACHED = new URLSearchParams(location.search).has("window");

let port = chrome.runtime.connect({ name: "vt" });
let activeAnswerEl = null;
let activeRaw = ""; // accumulated markdown for the in-flight answer
let draftKey = "vt_draft_global"; // per-tab key for the unsent question draft
let llmOriginPattern = null; // cached from settings, for runtime host permission

// Least-privilege: instead of a broad install-time host permission, request access
// to the specific origins we need at runtime (transient user-activation lasts ~5s,
// so the awaits before request() are fine). Already-granted origins don't re-prompt.
function originPattern(url) {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.hostname}/*`;
  } catch {
    return null;
  }
}
async function ensureOrigins(origins) {
  origins = [...new Set(origins.filter(Boolean))];
  if (!origins.length) return true;
  try {
    return await chrome.permissions.request({ origins });
  } catch {
    return false;
  }
}
// LLM endpoint host is always needed (service-worker fetch). The video tab is
// covered by activeTab in the attached popup, but NOT in the detached window —
// there we must request host access to the video site too.
async function ensureAccess(tab, needLLM) {
  const origins = [];
  if (needLLM && llmOriginPattern) origins.push(llmOriginPattern);
  if (DETACHED && tab?.url) origins.push(originPattern(tab.url));
  return ensureOrigins(origins);
}

// Find the video tab to act on. As the action popup, that's the current window's
// active tab. As a detached window, our own window is active, so look at the
// user's normal browser window instead.
async function getTargetTab() {
  if (DETACHED) {
    const tabs = await chrome.tabs.query({ active: true, windowType: "normal" });
    if (tabs.length <= 1) return tabs[0];
    const wins = await chrome.windows.getAll();
    const focused = wins.find((w) => w.focused && w.type === "normal");
    return (focused && tabs.find((t) => t.windowId === focused.id)) || tabs[0];
  }
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

port.onMessage.addListener(onMessage);
port.onDisconnect.addListener(() => {
  // service worker recycled; reconnect lazily on next action
  port = null;
});

function send(msg) {
  if (!port) {
    port = chrome.runtime.connect({ name: "vt" });
    port.onMessage.addListener(onMessage);
    port.onDisconnect.addListener(() => (port = null));
  }
  port.postMessage(msg);
}

function hk(n) {
  n = n || 0;
  if (n >= 1e6) return (n / 1e6).toFixed(2) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1) + "K";
  return String(n);
}

function humanTime(s) {
  s = Math.max(1, Math.round(s || 0));
  if (s < 90) return `~${s} sec`;
  return `~${Math.round(s / 60)} min`;
}

let scrubTabId = null; // tab awaiting a scrub confirmation

function renderTokens(total) {
  total = total || { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  const cached = (total.cacheRead || 0) + (total.cacheWrite || 0);
  $("tok-text").textContent =
    `Σ tokens — in ${hk(total.input)} · out ${hk(total.output)} · cached ${hk(cached)}`;
}

function setStatus(text, isError) {
  if (!text) {
    statusEl.classList.add("hidden");
    return;
  }
  statusEl.textContent = text;
  statusEl.classList.toggle("error", !!isError);
  statusEl.classList.remove("hidden");
}

function showScrub(text) {
  $("scrubprog").textContent = text;
  $("scrubctl").classList.remove("hidden");
  setStatus("");
}
function hideScrub() {
  $("scrubctl").classList.add("hidden");
}

function addTurn(q) {
  log.querySelector(".empty")?.remove();
  const wrap = document.createElement("div");
  wrap.className = "turn";
  const qEl = document.createElement("div");
  qEl.className = "q";
  qEl.textContent = q;
  const aEl = document.createElement("div");
  aEl.className = "a";
  aEl.textContent = "";
  wrap.append(qEl, aEl);
  log.append(wrap);
  log.scrollTop = log.scrollHeight;
  return aEl;
}

function onMessage(msg) {
  switch (msg.type) {
    case "STATE":
      $("notconfigured").classList.toggle("hidden", msg.configured);
      $("unlock").classList.toggle("hidden", !msg.locked);
      askBtn.disabled = !msg.configured;
      break;
    case "NEED_CONFIG":
      $("notconfigured").classList.remove("hidden");
      askBtn.disabled = false;
      setStatus("");
      break;
    case "NEED_PASSPHRASE":
      $("unlock").classList.remove("hidden");
      $("passphrase").focus();
      setStatus("");
      break;
    case "UNLOCKED":
      $("unlock").classList.add("hidden");
      break;
    case "STATUS":
      setStatus(msg.text);
      break;
    case "ANSWER_START":
      setStatus("Generating…");
      break;
    case "TOKEN":
      if (activeAnswerEl) {
        activeRaw += msg.text;
        activeAnswerEl.innerHTML = renderMarkdown(activeRaw);
        log.scrollTop = log.scrollHeight;
      }
      break;
    case "USAGE": {
      renderTokens(msg.total);
      const t = msg.turn || {};
      const parts = [`${hk(t.input)} in`];
      if (t.cacheRead) parts.push(`${hk(t.cacheRead)} cached-read`);
      if (t.cacheWrite) parts.push(`${hk(t.cacheWrite)} cache-write`);
      parts.push(`${hk(t.output)} out`);
      setStatus("This question: " + parts.join(" · "));
      break;
    }
    case "DONE":
      askBtn.disabled = false;
      activeAnswerEl = null;
      break;
    case "TX_PROGRESS":
      showScrub(`${msg.resumed ? "Resuming" : "Loading"} transcript… ${msg.pct}% (${msg.count} lines)`);
      break;
    case "CONFIRM_SCRUB":
      askBtn.disabled = false;
      $("scrubmsg").textContent =
        `${msg.reason}. ` +
        `${msg.resume ? "Resuming" : "Reading"} it by scanning the captions will take about ` +
        `${humanTime(msg.estSec)}, and the playhead will move while it runs.\n\n` +
        `Tip: you can open a NEW browser window and keep watching the video there ` +
        `meanwhile. Just keep the scanning tab visible and don't switch to another ` +
        `tab in its window — that pauses the scan.\n\nProceed?`;
      $("scrub-yes").textContent = `${msg.resume ? "Resume" : "Scan"} (${humanTime(msg.estSec)})`;
      $("scrubconfirm").classList.remove("hidden");
      setStatus("");
      break;
    case "TX_DONE": {
      hideScrub();
      $("scrubconfirm").classList.add("hidden");
      const how =
        msg.method === "download" ? "downloaded" :
        msg.method === "player-pot" ? "read from the captions" :
        msg.method === "android" ? "fetched from YouTube" :
        msg.method === "innertube" ? "fetched from YouTube" :
        msg.method === "panel" ? "read from the transcript panel" :
        msg.method === "scan" ? "scanned" : "cached";
      setStatus(
        msg.already
          ? `Transcript for this video is already ${how === "cached" ? "loaded" : how} ` +
            `(${msg.count} lines). Questions are using it. Shift-click ⤓ to force a refresh.`
          : `Full transcript ready (${msg.count} lines, ${how}). Questions now use it.`
      );
      askBtn.disabled = false;
      break;
    }
    case "TX_CANCELED":
      hideScrub();
      setStatus(`Scan canceled — kept ${msg.count} lines (resume with ⤓). Playhead restored.`);
      askBtn.disabled = false;
      break;
    case "TX_PAUSED":
      hideScrub();
      setStatus(
        `Paused at ${msg.pct}% (${msg.count} lines) — keep the YouTube tab visible ` +
          `(foreground, not minimized), then click ⤓ to resume.`,
        true
      );
      askBtn.disabled = false;
      break;
    case "TX_ERROR":
      hideScrub();
      setStatus("Transcript load failed: " + msg.message, true);
      askBtn.disabled = false;
      break;
    case "PASTE_TX_DONE":
      $("paste-save").disabled = false;
      if (msg.cleared) {
        $("paste-text").value = "";
        $("paste-pop").classList.add("hidden");
        setStatus("Transcript cleared — answers will use the screenshot only.");
      } else if (msg.ok) {
        $("paste-text").value = "";
        $("paste-pop").classList.add("hidden");
        setStatus(`Transcript saved (${msg.count} segments). Questions will use it.`);
      } else {
        setStatus(msg.message || "Couldn't save transcript.", true);
      }
      break;
    case "ERROR":
      setStatus(msg.message, true);
      askBtn.disabled = false;
      if (activeAnswerEl && !activeAnswerEl.textContent) {
        activeAnswerEl.textContent = "⚠ " + msg.message;
      }
      activeAnswerEl = null;
      break;
  }
}

async function ask() {
  const prompt = promptEl.value.trim();
  if (!prompt) return;
  const tab = await getTargetTab();
  // Ask for host access before doing anything that would lose the typed question.
  if (!(await ensureAccess(tab, true))) {
    setStatus("Site access is required (your AI endpoint" + (DETACHED ? " and the video site" : "") + "). Click Ask to grant it.", true);
    return;
  }
  promptEl.value = "";
  chrome.storage.session.remove(draftKey); // submitted — clear the saved draft
  askBtn.disabled = true;
  activeAnswerEl = addTurn(prompt);
  activeRaw = "";
  setStatus("Working…");
  send({ type: "ASK", prompt, tabId: tab?.id, windowId: tab?.windowId });
}

askBtn.addEventListener("click", ask);
promptEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    ask();
  }
});
// Persist the draft as the user types, so closing the popup doesn't lose it.
promptEl.addEventListener("input", () => {
  chrome.storage.session.set({ [draftKey]: promptEl.value });
});
$("settings").addEventListener("click", () => chrome.runtime.openOptionsPage());
$("tok-reset").addEventListener("click", async () => {
  const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  await chrome.storage.local.set({ vt_usage: zero });
  renderTokens(zero);
});
$("loadtx").addEventListener("click", async (e) => {
  const force = e.shiftKey; // shift-click = force a fresh download/scan
  const tab = await getTargetTab();
  if (!(await ensureAccess(tab, false))) {
    setStatus("Site access is required to read this video's captions.", true);
    return;
  }
  scrubTabId = tab?.id ?? null;
  askBtn.disabled = true;
  $("scrubconfirm").classList.add("hidden");
  setStatus(force ? "Refreshing transcript…" : "Checking transcript…");
  send({ type: "LOAD_FULL_TRANSCRIPT", tabId: tab?.id, force });
});

// --- Paste-transcript popover (non-YouTube sites) ---
const pastePop = $("paste-pop");
$("pastetx").addEventListener("click", (e) => {
  e.stopPropagation(); // don't let the click-outside handler re-close it
  pastePop.classList.toggle("hidden");
  if (!pastePop.classList.contains("hidden")) $("paste-text").focus();
});
$("paste-cancel").addEventListener("click", () => pastePop.classList.add("hidden"));
$("paste-save").addEventListener("click", async () => {
  const tab = await getTargetTab();
  $("paste-save").disabled = true;
  setStatus("Saving transcript…");
  send({ type: "PASTE_TRANSCRIPT", tabId: tab?.id, text: $("paste-text").value });
});
$("paste-clear").addEventListener("click", async () => {
  const tab = await getTargetTab();
  $("paste-save").disabled = true;
  send({ type: "PASTE_TRANSCRIPT", tabId: tab?.id, text: "" });
});
// Click outside the popover closes it.
document.addEventListener("click", (e) => {
  if (pastePop.classList.contains("hidden")) return;
  if (pastePop.contains(e.target) || e.target === $("pastetx")) return;
  pastePop.classList.add("hidden");
});

$("scrub-yes").addEventListener("click", () => {
  $("scrubconfirm").classList.add("hidden");
  askBtn.disabled = true;
  setStatus("Starting scan… keep the YouTube tab visible (a new window is fine).");
  send({ type: "START_SCRUB", tabId: scrubTabId });
});
$("scrub-no").addEventListener("click", () => {
  $("scrubconfirm").classList.add("hidden");
  setStatus("Skipped transcript — answers will use the screenshot only.");
});
$("cancelscrub").addEventListener("click", () => {
  $("scrubprog").textContent = "Canceling… (restoring playhead)";
  send({ type: "CANCEL_SCRUB" });
});
const DETACHED_WIN_KEY = "vt_detached_win";
$("detach").addEventListener("click", async () => {
  const url = chrome.runtime.getURL("src/popup.html") + "?window=1";
  // Single instance: if our detached window still exists, focus it instead of
  // opening another. We match by stored window id because matching by tab.url
  // would need the 'tabs' permission, which we deliberately don't request.
  let focused = false;
  try {
    const { [DETACHED_WIN_KEY]: id } = await chrome.storage.local.get(DETACHED_WIN_KEY);
    if (id != null) {
      await chrome.windows.get(id); // rejects if the window was already closed
      await chrome.windows.update(id, { focused: true, drawAttention: true });
      focused = true;
    }
  } catch {}
  if (!focused) {
    const w = await chrome.windows.create({ url, type: "popup", width: 460, height: 700 });
    if (w?.id != null) await chrome.storage.local.set({ [DETACHED_WIN_KEY]: w.id });
  }
  window.close(); // close the little action popup; the window stays open
});
$("open-options").addEventListener("click", (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});
$("unlock-btn").addEventListener("click", () => {
  const pp = $("passphrase").value;
  if (pp) send({ type: "UNLOCK", passphrase: pp });
});
$("passphrase").addEventListener("keydown", (e) => {
  if (e.key === "Enter") $("unlock-btn").click();
});

// Restore this tab's prior turns (survives popup close) and probe state.
(async function init() {
  if (DETACHED) {
    document.body.classList.add("windowed");
    $("detach").classList.add("hidden");
  }
  const tab = await getTargetTab();
  if (tab && /youtube\.com\/(watch|embed)|youtu\.be\//.test(tab.url || "")) {
    $("loadtx").classList.remove("hidden");
  } else if (tab && /^https?:/i.test(tab.url || "")) {
    // Non-YouTube site: offer a paste-transcript button instead of the ⤓ download.
    $("pastetx").classList.remove("hidden");
  }
  if (tab) {
    draftKey = `vt_draft_${tab.id}`;
    const key = `vt_hist_${tab.id}`;
    const store = await chrome.storage.session.get([key, draftKey]);
    const hist = store[key] || [];
    for (const t of hist) {
      const aEl = addTurn(t.q);
      aEl.innerHTML = renderMarkdown(t.a);
    }
    // Restore an unsent draft for this tab.
    if (store[draftKey]) promptEl.value = store[draftKey];
  }
  promptEl.focus();
  if (!log.children.length) {
    const e = document.createElement("div");
    e.className = "empty";
    e.textContent = "Pause on a moment, then ask a question about it.";
    log.append(e);
  }
  // Cache the configured endpoint's origin so we can request host access at ask time.
  const s = (await chrome.storage.local.get("vt_settings")).vt_settings;
  if (s?.baseUrl) llmOriginPattern = originPattern(s.baseUrl);
  // Show the running token total immediately.
  renderTokens((await chrome.storage.local.get("vt_usage")).vt_usage);
  send({ type: "GET_STATE" });
})();
