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
const MAX_ATTACHMENTS = 3; // cap on total attachments (images + text files) per question
let attachedFiles = []; // [{ kind:"image", b64, url } | { kind:"text", content, name }]
let draftKey = "vt_draft_global"; // per-tab key for the unsent question draft
let attachKey = "vt_attach_global"; // per-tab key for the unsent attachments
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
  if (!origins.length) return true;
  if (DETACHED) {
    // The detached window can't show a permission prompt (Firefox), so just verify
    // the origins are already granted (pre-granted via Options + the detach button).
    return chrome.permissions.contains({ origins });
  }
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

// Provider switcher (only shown when >1 profile is saved). Rebuilt only when the
// profile set/active changes, so it never clobbers the user mid-select.
function renderProvider(profiles, activeId) {
  const sel = $("provider");
  const list = Array.isArray(profiles) ? profiles : [];
  if (list.length <= 1) { sel.classList.add("hidden"); return; }
  const sig = list.map((p) => p.id + ":" + (p.name || "")).join("|") + "@" + (activeId || "");
  if (sel.dataset.sig === sig) return;
  sel.dataset.sig = sig;
  sel.innerHTML = "";
  list.forEach((p) => {
    const o = document.createElement("option");
    o.value = p.id;
    o.textContent = p.name || "(unnamed)";
    sel.append(o);
  });
  sel.value = activeId || list[0].id;
  sel.classList.remove("hidden");
}
$("provider").addEventListener("change", () => {
  send({ type: "SET_ACTIVE_PROFILE", profileId: $("provider").value });
  setStatus("Switching provider…");
});

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

// Only follow new content if the user is already near the bottom; if they've
// scrolled up to read earlier output, don't yank them down while it streams.
function stickToBottom() {
  if (log.scrollHeight - log.scrollTop - log.clientHeight < 60) log.scrollTop = log.scrollHeight;
}

function addTurn(q, imgUrls) {
  log.querySelector(".empty")?.remove();
  const wrap = document.createElement("div");
  wrap.className = "turn";
  const qEl = document.createElement("div");
  qEl.className = "q";
  qEl.textContent = q;
  wrap.append(qEl);
  const urls = Array.isArray(imgUrls) ? imgUrls : [];
  if (urls.length) {
    const thumbs = document.createElement("div");
    thumbs.className = "q-thumbs";
    for (const u of urls) {
      const img = document.createElement("img");
      img.src = u;
      img.className = "q-thumb";
      img.alt = "Attached image";
      thumbs.append(img);
    }
    wrap.append(thumbs);
  }
  const aEl = document.createElement("div");
  aEl.className = "a";
  aEl.textContent = "";
  wrap.append(aEl);
  log.append(wrap);
  stickToBottom();
  return aEl;
}

function onMessage(msg) {
  switch (msg.type) {
    case "STATE":
      $("notconfigured").classList.toggle("hidden", msg.configured);
      $("unlock").classList.toggle("hidden", !msg.locked);
      if (msg.locked) $("passphrase").value = ""; // never show stale/autofilled dots
      askBtn.disabled = !msg.configured;
      renderProvider(msg.profiles, msg.activeProfileId);
      break;
    case "NEED_CONFIG":
      $("notconfigured").classList.remove("hidden");
      askBtn.disabled = false;
      setStatus("");
      break;
    case "NEED_PASSPHRASE":
      $("unlock").classList.remove("hidden");
      $("passphrase").value = "";
      $("passphrase").focus();
      setStatus("");
      break;
    case "UNLOCKED":
      $("unlock").classList.add("hidden");
      $("passphrase").value = "";
      setStatus(""); // clear any "Wrong passphrase." error
      break;
    case "STATUS":
      setStatus(msg.text);
      break;
    case "ANSWER_START":
      setStatus("Generating…");
      break;
    case "ANSWER_RESUME":
      // Reattached to an answer that was streaming when the popup closed/reopened.
      activeAnswerEl = addTurn(msg.prompt, msg.imgs ? msg.imgs.map((b) => `data:image/jpeg;base64,${b}`) : null);
      activeRaw = msg.full || "";
      activeAnswerEl.innerHTML = renderMarkdown(activeRaw);
      stickToBottom();
      $("exportqa").classList.remove("hidden");
      if (msg.terminated) {
        setStatus("Answer was interrupted when the popup closed. Partial shown — re-ask to continue.");
        activeAnswerEl = null; // no more TOKENs coming
      } else {
        setStatus("Generating…"); // the SW is still streaming — TOKENs will follow
      }
      break;
    case "TOKEN":
      if (activeAnswerEl) {
        activeRaw += msg.text;
        activeAnswerEl.innerHTML = renderMarkdown(activeRaw);
        stickToBottom();
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
      $("exportqa").classList.remove("hidden"); // there's now a Q&A to export
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
    setStatus(
      DETACHED
        ? "Site access is required. Right-click the PAL browser icon and choose 'Always Allow on [this site]', then retry."
        : "Site access is required (your AI endpoint). Click Ask to grant it.",
      true
    );
    return;
  }
  promptEl.value = "";
  chrome.storage.session.remove(draftKey); // submitted — clear the saved draft
  askBtn.disabled = true;
  const imgUrls = attachedFiles.filter((a) => a.kind === "image").map((a) => a.url);
  const attachedTexts = attachedFiles.filter((a) => a.kind === "text").map((a) => ({ name: a.name, content: a.content }));
  activeAnswerEl = addTurn(prompt, imgUrls.length ? imgUrls : null);
  log.scrollTop = log.scrollHeight;
  $("exportqa").classList.remove("hidden");
  activeRaw = "";
  setStatus("Working…");
  send({
    type: "ASK", prompt, tabId: tab?.id,
    userImages: attachedFiles.filter((a) => a.kind === "image").map((a) => a.b64),
    attachedTexts: attachedTexts.length ? attachedTexts : undefined,
    windowId: tab?.windowId,
  });
  clearAttachments(); // consumed by this question
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

// --- Export Q&A as Markdown ---
// Gathers this tab's questions/answers plus the video's title (from the page, when
// available) into a .md file the user can save as a note. Title falls back to a
// short derivation from the first question when the page exposes none.
async function exportQA() {
  const tab = await getTargetTab();
  if (!tab) { setStatus("No active tab to export from.", true); return; }
  const key = `vt_hist_${tab.id}`;
  const hist = (await chrome.storage.session.get(key))[key] || [];
  if (!hist.length) { setStatus("No questions to export yet.", true); return; }
  // Best-effort site access so we can read the video title (Chrome prompts for it
  // from the detached window). Firefox doesn't surface a prompt here, so the title
  // probe below just falls back to a derived title — the export never blocks on it.
  await ensureAccess(tab, false);

  // Video title: og:title -> document.title; else summarize from the first question.
  let title = "";
  try {
    const [r] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () =>
        (document.querySelector('meta[property="og:title"]')?.content || document.title || "").trim(),
    });
    title = (r?.result || "").trim();
  } catch {}
  if (!title) {
    const q = (hist[0].q || "").trim();
    title = (q.slice(0, 80) + (q.length > 80 ? "…" : "")) || "PAL Q&A";
  }

  const url = tab.url || "";
  let host = "";
  try { host = new URL(url).hostname; } catch {}
  const md = buildMarkdown({ title, url, host, when: new Date().toLocaleString(), hist });
  downloadText(md, "PAL - " + sanitizeName(title).slice(0, 60) + ".md");
  setStatus(`Exported ${hist.length} Q&A as Markdown.`);
}

function buildMarkdown({ title, url, host, when, hist }) {
  const L = [`# ${title}`, ""];
  if (url) L.push(`**Source:** ${url}`);
  if (host) L.push(`**Site:** ${host}`);
  L.push(`**Exported:** ${when}`, "", "---", "");
  hist.forEach((t, i) => {
    L.push(`## Q${i + 1}: ${(t.q || "").trim()}`, "", (t.a || "").trim(), "");
  });
  return L.join("\n").trim() + "\n";
}

function sanitizeName(s) {
  return (s || "").replace(/[\\/:*?"<>|]+/g, " ").replace(/\s+/g, " ").trim() || "Q&A";
}

function downloadText(text, filename) {
  const blob = new Blob([text], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
$("exportqa").addEventListener("click", exportQA);

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
  // The detached window can't prompt for host access (Firefox doesn't surface
  // permissions.request from a windows.create popup) and Firefox won't grant a
  // wildcard, so grant the LLM endpoint + the current video site's host NOW from
  // this action popup (which CAN prompt for specific hosts). The detached window
  // inherits the grant.
  const tab = await getTargetTab();
  const origins = [llmOriginPattern, tab?.url && originPattern(tab.url)].filter(Boolean);
  if (origins.length) await ensureOrigins(origins);
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
  if (!pp) return;
  setStatus(""); // clear a previous "Wrong passphrase." while unlocking
  send({ type: "UNLOCK", passphrase: pp });
});
$("passphrase").addEventListener("keydown", (e) => {
  if (e.key === "Enter") $("unlock-btn").click();
});
$("resetchat").addEventListener("click", async () => {
  if (!confirm("Reset conversation? This clears all Q&A for this tab.")) return;
  const tab = await getTargetTab();
  if (tab) {
    await chrome.storage.session.remove(`vt_hist_${tab.id}`);
  }
  log.innerHTML = "";
  const e = document.createElement("div");
  e.className = "empty";
  e.textContent = "Conversation reset. Ask a new question.";
  log.append(e);
  setStatus("Conversation reset.");
  $("exportqa").classList.add("hidden");
});

// --- Attach image (file select or paste) ---

// Read an image File, resize to <=1568px, re-encode as JPEG base64 (same pipeline
// as the SW's captureAndCrop — keeps the adapter's hardcoded image/jpeg consistent).
async function fileToJpegBase64(file, maxDim = 1568) {
  const bitmap = await createImageBitmap(file);
  let { width, height } = bitmap;
  if (width > maxDim || height > maxDim) {
    const scale = maxDim / Math.max(width, height);
    width = Math.round(width * scale);
    height = Math.round(height * scale);
  }
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#fff"; // white background — JPEG has no alpha, so transparent
  ctx.fillRect(0, 0, width, height); // pixels would otherwise render as black.
  ctx.drawImage(bitmap, 0, 0, width, height);
  const blob = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.85 });
  const buf = new Uint8Array(await blob.arrayBuffer());
  let s = "";
  for (let i = 0; i < buf.length; i++) s += String.fromCharCode(buf[i]);
  return btoa(s);
}

const attachPreview = $("attach-preview");

function isTextFile(file) {
  if (file.type.startsWith("text/")) return true;
  if (file.type === "application/json" || file.type === "application/xml") return true;
  return /\.(txt|md|markdown|csv|json|xml|yaml|yml|log|ini|cfg|conf|tsv|html?|css|js|ts|py|rb|go|rs|java|c|cpp|h|sh|sql)$/i.test(file.name || "");
}

function renderAttachChips() {
  attachPreview.innerHTML = "";
  attachedFiles.forEach((a, i) => {
    const chip = document.createElement("div");
    chip.className = "attach-chip";
    if (a.kind === "image") {
      const img = document.createElement("img");
      img.src = a.url;
      img.alt = "Attached image";
      chip.append(img);
    } else {
      chip.classList.add("attach-chip-text");
      const label = document.createElement("span");
      label.textContent = a.name || "text";
      chip.append(label);
    }
    const rm = document.createElement("button");
    rm.className = "chip-remove";
    rm.title = "Remove";
    rm.textContent = "✕";
    rm.onclick = () => { if (a.url) URL.revokeObjectURL(a.url); attachedFiles.splice(i, 1); saveAndRender(); };
    chip.append(rm);
    attachPreview.append(chip);
  });
  if (attachedFiles.length) {
    const hint = document.createElement("span");
    hint.className = "attach-hint";
    hint.textContent = `(up to ${MAX_ATTACHMENTS}…)`;
    attachPreview.append(hint);
  }
  attachPreview.classList.toggle("hidden", attachedFiles.length === 0);
}

function saveAndRender() {
  renderAttachChips();
  if (attachedFiles.length) {
    chrome.storage.session.set({ [attachKey]: attachedFiles });
  } else {
    chrome.storage.session.remove(attachKey);
  }
}

async function addAttachment(file) {
  if (!file) return;
  if (attachedFiles.length >= MAX_ATTACHMENTS) {
    setStatus("Max " + MAX_ATTACHMENTS + " attachments per question.", true);
    return;
  }
  const isImage = file.type.startsWith("image/");
  const isText = isTextFile(file);
  if (!isImage && !isText) {
    setStatus("Only images and text files (txt, md, csv, json, etc.) are supported.", true);
    return;
  }
  try {
    setStatus("Processing…");
    if (isImage) {
      const b64 = await fileToJpegBase64(file);
      attachedFiles.push({ kind: "image", b64, url: URL.createObjectURL(file) });
    } else {
      const content = await file.text();
      if (content.length > 50000) {
        setStatus("Text file too large (max ~50KB).", true);
        return;
      }
      attachedFiles.push({ kind: "text", content, name: file.name });
    }
    saveAndRender();
    setStatus("");
  } catch (e) {
    setStatus("Couldn't process that file.", true);
  }
}

function clearAttachments() {
  attachedFiles.forEach((a) => { if (a.url) URL.revokeObjectURL(a.url); });
  attachedFiles = [];
  saveAndRender();
}

$("attach").addEventListener("click", () => $("file-input").click());
$("file-input").addEventListener("change", async () => {
  const files = [...($("file-input").files || [])];
  for (const f of files) {
    if (attachedFiles.length >= MAX_ATTACHMENTS) break;
    await addAttachment(f);
  }
  $("file-input").value = "";
});
// Paste an image — works for screenshots, web-copied images (all browsers), and
// OS-copied files (Firefox). Chrome doesn't put image data in the clipboard for
// OS-copied files (only the file path as text) — drag-and-drop works there instead.
document.addEventListener("paste", (e) => {
  const cd = e.clipboardData;
  if (!cd) return;
  for (let i = 0; i < cd.items.length; i++) {
    if (cd.items[i].type.startsWith("image/")) {
      const file = cd.items[i].getAsFile();
      if (file) { e.preventDefault(); addAttachment(file); return; }
    }
  }
});
// Drag-and-drop files onto the popup.
document.addEventListener("dragover", (e) => e.preventDefault());
document.addEventListener("drop", async (e) => {
  e.preventDefault();
  const files = [...(e.dataTransfer?.files || [])];
  for (const f of files) {
    if (attachedFiles.length >= MAX_ATTACHMENTS) break;
    await addAttachment(f);
  }
});

// Restore this tab's prior turns (survives popup close) and probe state.
(async function init() {
  if (DETACHED) {
    document.body.classList.add("windowed");
    $("detach").classList.add("hidden");
  } else {
    // The native file picker closes the attached popup; hide the button there.
    // Users paste (Ctrl+V) or drag-drop instead.
    $("attach").classList.add("hidden");
    const isFirefox = chrome.runtime.getURL("").startsWith("moz-");
    promptEl.placeholder = isFirefox
      ? "Ask about what's on screen…  (paste an image here to attach)"
      : "Ask about what's on screen…  (drag up to three images here to attach)";
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
    attachKey = `vt_attach_${tab.id}`;
    const key = `vt_hist_${tab.id}`;
    const store = await chrome.storage.session.get([key, draftKey, attachKey]);
    const hist = store[key] || [];
    for (const t of hist) {
      const aEl = addTurn(t.q, Array.isArray(t.imgs) ? t.imgs.map((b) => `data:image/jpeg;base64,${b}`) : (t.img ? [`data:image/jpeg;base64,${t.img}`] : null));
      aEl.innerHTML = renderMarkdown(t.a);
    }
    $("exportqa").classList.toggle("hidden", hist.length === 0);
    // Restore an unsent draft for this tab.
    if (store[draftKey]) promptEl.value = store[draftKey];
    // Restore unsent attached images.
    if (Array.isArray(store[attachKey]) && store[attachKey].length) {
      attachedFiles = store[attachKey].map((a) =>
        a.kind === "image" ? { ...a, url: `data:image/jpeg;base64,${a.b64}` } : a
      );
      renderAttachChips();
    }
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
  // Reattach to an answer that was streaming when the popup closed/reopened.
  if (tab?.id != null) send({ type: "RESUME_ASK", tabId: tab.id });
})();
