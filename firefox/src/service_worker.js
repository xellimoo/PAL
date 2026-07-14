// PAL (Pause, Ask, Learn) — service worker (corrected-spec §1).
// Owns capture orchestration + the LLM fetch so work survives the popup closing.
// Stays idle until the user clicks the icon (default MV3 lifecycle + activeTab).

import { decryptSecret } from "./lib/crypto.js";
import { buildRequest, streamText } from "./lib/adapters.js";
import { buildSystemPrompt, fmt } from "./lib/context.js";

// Decrypted keys cached for the browser session, one per profile so switching
// providers (or closing/reopening the popup) doesn't re-prompt. Backed by
// chrome.storage.session — in-memory only (never written to disk), it survives
// service-worker recycling and is cleared when the browser exits. value: { pt, blob }.
const unlockedKeys = new Map();
let pendingAsk = null; // ask deferred until a passphrase unlocks the key
// In-flight answers, keyed by tab id, so a popup that closed mid-answer can reopen
// and reattach (receive what streamed so far + keep streaming). value: { prompt, full, port, tabId }
const activeAsks = new Map();

// Hydrate the in-memory cache from session storage once per worker lifetime (the
// worker may have been recycled while the popup was closed). Idempotent.
let hydrated = null;
function hydrate() {
  if (!hydrated) {
    hydrated = chrome.storage.session.get("vt_unlocked").then((s) => {
      const obj = s.vt_unlocked || {};
      for (const id of Object.keys(obj)) unlockedKeys.set(id, obj[id]);
    }).catch(() => {});
  }
  return hydrated;
}
async function rememberUnlocked(id, pt, blob) {
  unlockedKeys.set(id, { pt, blob });
  try {
    const obj = ((await chrome.storage.session.get("vt_unlocked")).vt_unlocked) || {};
    obj[id] = { pt, blob };
    await chrome.storage.session.set({ vt_unlocked: obj });
  } catch {}
}
async function forgetUnlocked(id) {
  unlockedKeys.delete(id);
  try {
    const obj = ((await chrome.storage.session.get("vt_unlocked")).vt_unlocked) || {};
    delete obj[id];
    await chrome.storage.session.set({ vt_unlocked: obj });
  } catch {}
}

const ports = new Set();   // every open popup/window, for progress rebroadcast
let scrubState = null;     // latest scrub status while one exists, else null
let cancelScrub = false;   // set by a CANCEL_SCRUB message

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "vt") return;
  ports.add(port);
  port.onMessage.addListener((msg) => handleMessage(msg, port));
  port.onDisconnect.addListener(() => ports.delete(port));
  // Reattach a reopened popup to an in-progress (or paused) scrub.
  if (scrubState) {
    port.postMessage({
      type: scrubState.paused ? "TX_PAUSED" : "TX_PROGRESS",
      pct: scrubState.pct,
      count: scrubState.count,
    });
  }
});

function broadcast(msg) {
  for (const p of ports) {
    try { p.postMessage(msg); } catch {}
  }
}

// Forget the detached window id once that window is closed, so the next detach
// creates a fresh one (the popup also self-heals via windows.get, but this keeps
// storage tidy and survives the action popup being closed).
chrome.windows.onRemoved.addListener((winId) => {
  chrome.storage.local.get("vt_detached_win").then(({ vt_detached_win: id }) => {
    if (id != null && id === winId) chrome.storage.local.remove("vt_detached_win");
  }).catch(() => {});
});

function notify(title, message) {
  try {
    chrome.notifications.create({
      type: "basic",
      iconUrl: chrome.runtime.getURL("icons/icon128.png"),
      title,
      message,
    });
  } catch {}
}

async function handleMessage(msg, port) {
  try {
    if (msg.type === "GET_STATE") {
      await hydrate();
      port.postMessage(buildState(await loadSettings()));
      return;
    }

    if (msg.type === "SET_ACTIVE_PROFILE") {
      await hydrate();
      // Don't drop unlocked keys — each profile stays unlocked for the session, so
      // switching back doesn't re-prompt. The active profile's locked state is
      // derived from the per-profile cache in buildState / resolveKey.
      const { vt_settings } = await chrome.storage.local.get("vt_settings");
      await chrome.storage.local.set({
        vt_settings: { ...(vt_settings || {}), activeProfileId: msg.profileId },
      });
      broadcast(buildState(await loadSettings()));
      return;
    }

    if (msg.type === "UNLOCK") {
      await hydrate();
      const s = await loadSettings();
      let pt;
      try {
        pt = await decryptSecret(s.key, msg.passphrase);
      } catch {
        port.postMessage({ type: "ERROR", message: "Wrong passphrase." });
        return;
      }
      await rememberUnlocked(s.activeProfileId, pt, s.key);
      port.postMessage({ type: "UNLOCKED" });
      if (pendingAsk) {
        const a = pendingAsk;
        pendingAsk = null;
        runAsk(a.prompt, a.tabId, port);
      }
      return;
    }

    if (msg.type === "ASK") {
      runAsk(msg.prompt, msg.tabId, port);
      return;
    }

    if (msg.type === "RESUME_ASK") {
      // A popup reopened mid-answer: reattach if the SW is still streaming, or
      // recover the partial from storage if the SW was recycled mid-answer.
      const ask = activeAsks.get(msg.tabId);
      if (ask) {
        ask.port = port;
        port.postMessage({ type: "ANSWER_RESUME", prompt: ask.prompt, full: ask.full });
      } else {
        const prog = (await chrome.storage.session.get(`vt_prog_${msg.tabId}`))[`vt_prog_${msg.tabId}`];
        if (prog) port.postMessage({ type: "ANSWER_RESUME", prompt: prog.q, full: prog.a, terminated: true });
      }
      return;
    }

    if (msg.type === "LOAD_FULL_TRANSCRIPT") {
      loadFullTranscript(msg.tabId, port, msg.force);
      return;
    }

    if (msg.type === "PASTE_TRANSCRIPT") {
      cachePastedTranscript(msg.tabId, msg.text, port);
      return;
    }

    if (msg.type === "START_SCRUB") {
      runScrub(msg.tabId, port);
      return;
    }

    if (msg.type === "CANCEL_SCRUB") {
      cancelScrub = true; // honored at the next chunk boundary
      return;
    }
  } catch (e) {
    port.postMessage({ type: "ERROR", message: String(e?.message || e) });
  }
}

function buildState(s) {
  return {
    type: "STATE",
    configured: !!(s && s.baseUrl && s.key),
    locked: !!(s && s.key && s.key.enc && !isUnlocked(s.activeProfileId, s.key)),
    spec: s?.spec,
    model: s?.model,
    profiles: s?.profiles || [],
    activeProfileId: s?.activeProfileId,
  };
}

async function loadSettings() {
  const { vt_settings, vt_profiles } = await chrome.storage.local.get(["vt_settings", "vt_profiles"]);
  if (!vt_settings) return null;
  const profiles = Array.isArray(vt_profiles) ? vt_profiles : [];
  if (profiles.length) {
    // Resolve the active provider profile and surface its spec/baseUrl/model/key.
    const active = profiles.find((p) => p.id === vt_settings.activeProfileId) || profiles[0];
    return {
      ...vt_settings,
      spec: active.spec,
      baseUrl: active.baseUrl,
      model: active.model,
      key: active.key,
      activeProfileId: active.id,
      profiles: profiles.map((p) => ({ id: p.id, name: p.name })),
    };
  }
  // Legacy shape (pre-profiles): provider fields live directly on vt_settings.
  return { ...vt_settings, profiles: [] };
}

// Two encrypted-key blobs describe "the same key" when their ciphertext+salt+iv match.
function sameKey(a, b) {
  return !!a && !!b && a.ct === b.ct && a.salt === b.salt && a.iv === b.iv;
}
// A profile counts as unlocked if it's plaintext, or its current encrypted key
// matches one already decrypted this session.
function isUnlocked(id, key) {
  if (!key || !key.enc) return true;
  const e = unlockedKeys.get(id);
  return !!e && sameKey(e.blob, key);
}

async function resolveKey(settings, port) {
  if (!settings.key) throw new Error("Not configured. Open the options page.");
  if (!settings.key.enc) return settings.key.plain; // plaintext mode
  await hydrate();
  const id = settings.activeProfileId;
  const e = unlockedKeys.get(id);
  if (e && sameKey(e.blob, settings.key)) return e.pt;
  if (e) await forgetUnlocked(id); // stale — the profile's key changed; re-prompt
  return null; // locked — caller must prompt for the passphrase
}

// Defense-in-depth: re-check the endpoint scheme here, not just in the options UI,
// so a bad stored value can never reach fetch(). HTTPS only (localhost allowed).
function isAllowedEndpoint(u) {
  try {
    const url = new URL(u);
    if (url.protocol === "https:") return true;
    if (url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1")) return true;
    return false;
  } catch {
    return false;
  }
}

async function runAsk(prompt, tabId, port) {
  let ask = null; // in-flight entry (set when streaming starts); visible to the catch
  try {
    const settings = await loadSettings();
    if (!settings || !settings.baseUrl || !settings.key) {
      port.postMessage({ type: "NEED_CONFIG" });
      return;
    }
    if (!isAllowedEndpoint(settings.baseUrl)) {
      port.postMessage({ type: "ERROR", message: "Endpoint must be HTTPS (or http://localhost). Fix it in Options." });
      return;
    }

    const apiKey = await resolveKey(settings, port);
    if (apiKey === null) {
      pendingAsk = { prompt, tabId };
      port.postMessage({ type: "NEED_PASSPHRASE" });
      return;
    }

    // 1. Inject into the target tab: pause, measure, extract transcript.
    port.postMessage({ type: "STATUS", text: "Reading the video…" });
    let tab = null;
    if (tabId != null) {
      try { tab = await chrome.tabs.get(tabId); } catch {}
    }
    if (!tab) {
      [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    }
    if (!tab) throw new Error("No video tab found.");

    // Set up in-flight tracking + persist the question BEFORE the (potentially slow)
    // setup — so a popup that closed right after Ask and reopens during setup can
    // reattach (RESUME_ASK finds the entry) and the question survives SW termination.
    ask = { prompt, full: "", port, tabId: tab.id, saved: 0 };
    activeAsks.set(tab.id, ask);
    const progKey = `vt_prog_${tab.id}`;
    chrome.storage.session.set({ [progKey]: { q: prompt, a: "" } }).catch(() => {});

    // Prior turns for this tab (oldest first), flattened to role-tagged messages.
    // Capped to the last 8 turns to bound token growth on long sessions.
    const priorTurns = await getHistory(tab.id);
    const history = [];
    for (const t of priorTurns.slice(-8)) {
      history.push({ role: "user", text: t.q });
      history.push({ role: "assistant", text: t.a });
    }

    let page = { transcript: [], rect: null, dpr: 1, currentTime: 0, source: "none" };
    try {
      const [res] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: pageProbe,
      });
      if (res?.result) page = res.result;
    } catch (e) {
      // e.g. chrome:// pages or restricted tabs — continue text-only.
      page.error = String(e?.message || e);
    }

    // YouTube transcript: reuse cache, else direct download, else a per-question
    // window scan — caching whatever we get so later asks reuse it.
    const vid = ytVideoId(tab.url);
    const ytKey = vid ? "vt_yttx_" + vid : null;
    // Non-YouTube pages: reuse a transcript the user pasted (cached per page).
    const pasteKey = !vid ? txCacheKey(tab) : null;
    let cached = ytKey
      ? (await chrome.storage.local.get(ytKey))[ytKey] || null
      : pasteKey
      ? (await chrome.storage.local.get(pasteKey))[pasteKey] || null
      : null;
    if (cached?.lines?.length) {
      page.transcript = cached.lines;
      page.source = cached.complete
        ? (vid ? "youtube-cc-cached(full)" : "pasted-transcript(full)")
        : (vid ? "youtube-cc-cached(partial)" : "pasted-transcript(partial)");
      page.transcriptNote = undefined;
    }

    // Direct download (full transcript) — only when nothing is cached yet.
    const isYouTube = /youtube\.com\/(watch|embed)|youtu\.be\//.test(tab.url || "");
    // Collect every extractor's failure reason so the debug log shows the WHOLE
    // picture (each method used to overwrite the last, hiding why earlier ones failed).
    const ytReasons = [];
    if (isYouTube && !cached) {
      try {
        const [r2] = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          world: "MAIN",
          func: ytCaptions,
        });
        if (r2?.result?.ok && r2.result.lines.length) {
          page.transcript = r2.result.lines;
          page.source = `youtube-captions(${r2.result.kind || "manual"},${r2.result.lang})`;
          // Persist the full download so later asks AND the ⤓ button reuse it.
          cached = {
            lines: page.transcript, complete: true,
            covered: [[0, page.duration || 1e9]], nextFrom: page.duration || 0,
            duration: page.duration || 0, method: "download", t: Date.now(),
          };
          if (ytKey) await chrome.storage.local.set({ [ytKey]: cached });
        } else if (r2?.result?.reason) {
          page.transcriptNote = r2.result.reason;
          ytReasons.push("download: " + r2.result.reason);
        }
      } catch (e) {
        page.transcriptNote = String(e?.message || e);
        ytReasons.push("download threw: " + String(e?.message || e));
      }
    }

    // Direct download gated (no readable PoToken)? Force the player itself to fetch
    // its caption track and intercept that authenticated request — its URL carries
    // the pot we can't read directly. Briefly toggles CC, then restores it. This is
    // the reliable "direct" full-transcript path; the result is cached so later
    // questions skip it entirely.
    if (isYouTube && !cached) {
      try {
        port.postMessage({ type: "STATUS", text: "Reading captions…" });
        const [rv] = await chrome.scripting.executeScript({
          target: { tabId: tab.id }, world: "MAIN", func: ytCaptionsViaPlayer,
        });
        if (rv?.result?.ok && rv.result.lines.length) {
          page.transcript = rv.result.lines;
          page.source = "youtube-captions(player-pot)";
          cached = {
            lines: page.transcript, complete: true,
            covered: [[0, page.duration || 1e9]], nextFrom: page.duration || 0,
            duration: page.duration || 0, method: "player-pot", t: Date.now(),
          };
          if (ytKey) await chrome.storage.local.set({ [ytKey]: cached });
        } else if (rv?.result?.reason) {
          page.transcriptNote = rv.result.reason;
          ytReasons.push("player-pot: " + rv.result.reason);
        }
      } catch (e) {
        page.transcriptNote = String(e?.message || e);
        ytReasons.push("player-pot threw: " + String(e?.message || e));
      }
    }

    // Download gated? Full transcript via the ANDROID player (ungated captions).
    if (isYouTube && !cached) {
      try {
        const [ra] = await chrome.scripting.executeScript({
          target: { tabId: tab.id }, world: "MAIN", func: ytPlayerAndroid,
        });
        if (ra?.result?.ok && ra.result.lines.length) {
          page.transcript = ra.result.lines;
          page.source = "youtube-player-android";
          cached = {
            lines: page.transcript, complete: true,
            covered: [[0, page.duration || 1e9]], nextFrom: page.duration || 0,
            duration: page.duration || 0, method: "android", t: Date.now(),
          };
          if (ytKey) await chrome.storage.local.set({ [ytKey]: cached });
        } else if (ra?.result?.reason) {
          ytReasons.push("player-android: " + ra.result.reason);
        }
      } catch (e) {
        ytReasons.push("player-android threw: " + String(e?.message || e));
      }
    }

    // Fallback: YouTube's internal get_transcript API.
    if (isYouTube && !cached) {
      try {
        const [rg] = await chrome.scripting.executeScript({
          target: { tabId: tab.id }, world: "MAIN", func: ytGetTranscript,
        });
        if (rg?.result?.ok && rg.result.lines.length) {
          page.transcript = rg.result.lines;
          page.source = "youtube-get_transcript";
          cached = {
            lines: page.transcript, complete: true,
            covered: [[0, page.duration || 1e9]], nextFrom: page.duration || 0,
            duration: page.duration || 0, method: "innertube", t: Date.now(),
          };
          if (ytKey) await chrome.storage.local.set({ [ytKey]: cached });
        } else if (rg?.result?.reason) {
          page.transcriptNote = rg.result.reason;
          ytReasons.push("get_transcript: " + rg.result.reason);
        }
      } catch (e) {
        page.transcriptNote = String(e?.message || e);
        ytReasons.push("get_transcript threw: " + String(e?.message || e));
      }
    }

    // Still nothing? Last resort for the full transcript: open YouTube's own
    // "Show transcript" panel, scrape it, and close it again (self-reverting UI).
    if (isYouTube && !cached) {
      try {
        const [rp] = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          world: "MAIN",
          func: ytOpenTranscriptPanel,
        });
        if (rp?.result?.ok && rp.result.lines.length) {
          page.transcript = rp.result.lines;
          page.source = rp.result.opened ? "youtube-transcript-panel(opened)" : "youtube-transcript-panel";
          cached = {
            lines: page.transcript, complete: true,
            covered: [[0, page.duration || 1e9]], nextFrom: page.duration || 0,
            duration: page.duration || 0, method: "panel", t: Date.now(),
          };
          if (ytKey) await chrome.storage.local.set({ [ytKey]: cached });
        } else if (rp?.result?.reason) {
          page.transcriptNote = rp.result.reason;
          ytReasons.push("panel: " + rp.result.reason);
        }
      } catch (e) {
        page.transcriptNote = String(e?.message || e);
        ytReasons.push("panel threw: " + String(e?.message || e));
      }
    }

    const host = (() => { try { return new URL(tab.url).hostname; } catch { return tab.url || "?"; } })();
    // Diagnostic log — off by default; enable in Options. Local console only
    // (never sent anywhere). Logs domain + counts, never key/question/answer/frame.
    if (settings.debug) {
      console.log("[PAL] tab", tab.id, host, "| video?", !!page.rect,
        "| transcript", page.transcript?.length || 0, page.source,
        page.transcriptNote ? `(${page.transcriptNote})` : "",
        ytReasons.length ? `| full-extract tried: ${ytReasons.join(" | ")}` : "");
    }

    // 2. Capture + crop to the player bounds (device-pixel correct).
    let imageB64 = null;
    let imageNote = "";
    if (page.rect) {
      try {
        port.postMessage({ type: "STATUS", text: "Capturing the frame…" });
        imageB64 = await captureAndCrop(tab.windowId, page.rect, page.dpr);
      } catch (e) {
        imageNote = "capture failed: " + String(e?.message || e);
      }
    } else {
      imageNote = `no <video> found on ${host}`;
    }

    // 2b. YouTube fallback: download gated but the player renders captions — scan a
    // window around the pause. Skip if we already have a COMPLETE transcript, or this
    // moment is already covered by the cached partial (so we never re-scan / move the
    // playhead for the same region). Merge results into the cache so later asks reuse.
    const scrubEnabled = settings.captionScrub !== false;
    const win = settings.captionWindowSec ?? 20;
    const haveComplete = !!cached?.complete;
    const coveredNow = cached?.covered || [];
    if (isYouTube && scrubEnabled && page.rect && !haveComplete &&
        !rangesCover(coveredNow, page.currentTime, 2)) {
      try {
        port.postMessage({ type: "STATUS", text: "Reading captions around the pause…" });
        const [r3] = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: ytCaptionWindow,
          args: [win],
        });
        if (r3?.result?.ok && r3.result.lines.length) {
          const lines = mergeLines(cached?.lines || [], r3.result.lines);
          const covered = addRange(coveredNow, [Math.max(0, page.currentTime - win), page.currentTime + win]);
          page.transcript = lines;
          page.source = "youtube-caption-scan";
          page.transcriptNote = undefined;
          cached = { lines, complete: false, covered, duration: page.duration || 0, method: "scan", t: Date.now() };
          if (ytKey) await chrome.storage.local.set({ [ytKey]: cached });
        } else if (r3?.result?.reason) {
          page.transcriptNote = r3.result.reason;
        }
      } catch (e) {
        page.transcriptNote = String(e?.message || e);
      }
    }

    // 3. Build context (full vs window+summary) and the request.
    let { system, mode, tokenEstimate } = buildSystemPrompt({
      transcript: page.transcript,
      currentTime: page.currentTime,
      source: page.source,
      contextThreshold: settings.contextThreshold ?? 120000,
      windowMinutes: settings.windowMinutes ?? 10,
    });

    // No image AND no transcript: the model has zero context. Forbid guessing.
    if (!imageB64 && (!page.transcript || !page.transcript.length)) {
      system +=
        "\n\nIMPORTANT: No screenshot and no transcript could be captured for this " +
        "video. Do NOT guess or invent what is on screen. Tell the user no video " +
        "context was available and suggest they ensure a video is the active tab.";
    }

    const user =
      `Current video timestamp: ${fmt(page.currentTime)}.\n` +
      `Question: ${prompt}`;

    const req = buildRequest({
      spec: settings.spec || "openai",
      baseUrl: settings.baseUrl,
      apiKey,
      model: settings.model,
      system,
      user,
      imageB64,
      maxTokens: settings.maxTokens ?? 65536,
      history,
    });

    const transcriptLabel =
      !page.transcript?.length
        ? "no transcript"
        : page.source === "youtube-caption-scan"
        ? "captions near the pause"
        : mode === "full"
        ? "full transcript"
        : "windowed transcript + outline";
    const imageLabel = imageB64 ? " + screenshot" : imageNote ? ` + no screenshot (${imageNote})` : "";
    const ctxNote = `on ${host} • ${transcriptLabel}${imageLabel} • ~${tokenEstimate.toLocaleString()} ctx tokens`;
    port.postMessage({ type: "STATUS", text: `Asking ${settings.model} (${ctxNote})…` });

    // 4. Stream the response.
    const resp = await fetch(req.url, {
      method: "POST",
      headers: req.headers,
      body: JSON.stringify(req.body),
    });

    if (!resp.ok) {
      const errText = await resp.text().catch(() => "");
      throw new Error(`HTTP ${resp.status}: ${errText.slice(0, 500)}`);
    }

    safePost(ask.port, { type: "ANSWER_START" });
    const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    for await (const chunk of streamText(settings.spec || "openai", resp, usage)) {
      ask.full += chunk;
      safePost(ask.port, { type: "TOKEN", text: chunk });
      if (ask.full.length - ask.saved >= 200) {
        ask.saved = ask.full.length;
        chrome.storage.session.set({ [progKey]: { q: prompt, a: ask.full } }).catch(() => {});
      }
    }
    // Persist the final turn so a reopened popup can render it even if it closed.
    await appendHistory(tab.id, prompt, ask.full);
    activeAsks.delete(tab.id);
    chrome.storage.session.remove(progKey).catch(() => {});

    // Accumulate a running token total and report turn + total.
    const total = await addUsage(usage);
    safePost(ask.port, { type: "USAGE", turn: usage, total });
    safePost(ask.port, { type: "DONE", full: ask.full });
  } catch (e) {
    if (ask) { activeAsks.delete(ask.tabId); chrome.storage.session.remove(`vt_prog_${ask.tabId}`).catch(() => {}); }
    safePost(ask?.port || port, { type: "ERROR", message: String(e?.message || e) });
  }
}

function safePost(port, msg) {
  try {
    port.postMessage(msg);
  } catch {
    // popup closed; ignore (work already persisted to storage.session)
  }
}

function dedupLines(lines) {
  const out = [];
  let prev = null;
  for (const l of lines.slice().sort((a, b) => a.start - b.start)) {
    if (l.text !== prev) { out.push(l); prev = l.text; }
  }
  return out;
}

// Coverage helpers for partial (scan-built) transcript caches.
function rangesCover(ranges, t, margin = 0) {
  return (ranges || []).some(([a, b]) => t >= a - margin && t <= b + margin);
}
function addRange(ranges, range) {
  const all = [...(ranges || []), range].sort((x, y) => x[0] - y[0]);
  const out = [];
  for (const r of all) {
    const last = out[out.length - 1];
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else out.push([r[0], r[1]]);
  }
  return out;
}
function mergeLines(a, b) {
  const seen = new Set();
  const out = [];
  for (const l of [...(a || []), ...(b || [])]) {
    const k = Math.round((l.start || 0) * 10);
    if (!seen.has(k)) { seen.add(k); out.push(l); }
  }
  return out.sort((x, y) => (x.start || 0) - (y.start || 0));
}

async function resolveYtTab(tabId) {
  let tab = tabId != null ? await chrome.tabs.get(tabId).catch(() => null) : null;
  if (!tab) [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) throw new Error("no tab");
  const vid = ytVideoId(tab.url);
  if (!vid) throw new Error("not a YouTube watch page");
  return { tab, vid, key: "vt_yttx_" + vid };
}

// Rough scrub-time estimate: one read per ~2.5s of video, ~0.25s per read.
function estimateScrubSeconds(durationSec) {
  const step = 2.5, perStep = 0.25;
  return Math.round((durationSec / step) * perStep);
}

// Paste-transcript entry point: cache text the user pasted for the current page's
// video, so every question reuses it (just like a downloaded YouTube transcript).
// An empty paste clears any cached transcript for the page.
async function cachePastedTranscript(tabId, text, port) {
  try {
    let tab = tabId != null ? await chrome.tabs.get(tabId).catch(() => null) : null;
    if (!tab) [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) throw new Error("no active tab");
    const key = txCacheKey(tab);
    if (!key) {
      safePost(port, { type: "PASTE_TX_DONE", ok: false, message: "Open a video page first." });
      return;
    }
    const trimmed = (text || "").trim();
    if (!trimmed) {
      await chrome.storage.local.remove(key);
      safePost(port, { type: "PASTE_TX_DONE", ok: true, cleared: true });
      return;
    }
    // Best-effort video duration, to spread un-timestamped text across the timeline
    // so a large pasted transcript still slices sensibly in window mode.
    let duration = 0;
    try {
      const [d] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => document.querySelector("video")?.duration || 0,
      });
      duration = d?.result || 0;
    } catch {}
    const lines = parsePastedTranscript(trimmed, duration);
    if (!lines.length) {
      safePost(port, { type: "PASTE_TX_DONE", ok: false, message: "Couldn't read any transcript text." });
      return;
    }
    await chrome.storage.local.set({ [key]: { lines, complete: true, method: "pasted", t: Date.now() } });
    safePost(port, { type: "PASTE_TX_DONE", ok: true, count: lines.length });
  } catch (e) {
    safePost(port, { type: "PASTE_TX_DONE", ok: false, message: String(e?.message || e) });
  }
}

// Parse a user-pasted transcript into timed lines. Accepts VTT/SRT cue blocks,
// "[timestamp] text" lines, or plain text (chunked + spread across the duration).
// Runs in the service worker (no DOM), so decoding/tag-stripping is regex-based.
function parsePastedTranscript(text, durationSec) {
  const clean = (s) =>
    s.replace(/<[^>]+>/g, "")
     .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
     .replace(/&#0?39;/g, "'").replace(/&quot;/g, "\"").replace(/&nbsp;/g, " ")
     .replace(/\s+/g, " ").trim();
  const out = [];
  const push = (start, txt) => { const t = clean(txt); if (t) out.push({ start: start || 0, text: t }); };
  const secs = (h, m, s) => (h ? parseInt(h) * 3600 : 0) + parseInt(m) * 60 + parseInt(s);
  const body = text.replace(/\r/g, "");

  // 1) VTT / SRT cue blocks ("00:01:23.000 --> 00:01:25.000").
  if (body.includes("-->")) {
    const ts = /(?:(\d{1,2}):)?(\d{1,2}):(\d{1,2})(?:[.,]\d+)?\s*-->/;
    for (const block of body.split(/\n\s*\n/)) {
      const m = block.match(ts);
      if (!m) continue;
      const lines = block.split("\n").filter((l) => !/^\d+\s*$/.test(l) && !ts.test(l));
      push(secs(m[1], m[2], m[3]), lines.join(" "));
    }
    if (out.length) return dedupLines(out);
  }

  // 2) Bracketed timestamps: "[0:12] text" / "[00:01:23] text".
  const bracket = /^\s*\[(?:(\d{1,2}):)?(\d{1,2}):(\d{1,2})\]\s*(.*)$/;
  for (const l of body.split("\n")) {
    const m = l.match(bracket);
    if (m) push(secs(m[1], m[2], m[3]), m[4]);
  }
  if (out.length) return dedupLines(out);

  // 3) Plain text: chunk by paragraph (or line) and spread synthetic starts across
  //    the timeline so the whole thing is included verbatim, and window mode still
  //    returns a sensible slice + outline.
  const paras = body.split(/\n\s*\n/).map((p) => p.replace(/\s+/g, " ").trim()).filter(Boolean);
  const chunks = paras.length > 1 ? paras : body.split("\n").map((s) => s.trim()).filter(Boolean);
  const n = chunks.length;
  const span = durationSec && durationSec > 1 ? durationSec : Math.max(60, n * 5);
  chunks.forEach((c, i) => push(span * (i / Math.max(1, n)), c));
  return dedupLines(out);
}

// ⤓ entry point: try the fast direct download first; only if that fails do we
// estimate the scrub time and ask the user to confirm (the SLOW playhead sweep).
async function loadFullTranscript(tabId, port, force) {
  try {
    const { tab, vid, key } = await resolveYtTab(tabId);

    // Force refresh (shift-click): drop any cache so we re-download / re-scan fresh.
    if (force) await chrome.storage.local.remove(key);

    // 0. Already have a COMPLETE transcript for THIS video? Don't redo anything.
    //    (Cache is keyed by video id, so a different video won't match.)
    const existing = force ? null : (await chrome.storage.local.get(key))[key];
    if (existing?.complete && existing.lines?.length) {
      safePost(port, {
        type: "TX_DONE",
        count: existing.lines.length,
        method: existing.method || "cache",
        already: true,
      });
      return;
    }

    const [m] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: ytMeta });
    const meta = m?.result || {};

    // 1. Fast path: direct caption download (the whole timed file at once).
    safePost(port, { type: "STATUS", text: "Trying to download the transcript…" });
    const [r] = await chrome.scripting.executeScript({
      target: { tabId: tab.id }, world: "MAIN", func: ytCaptions,
    });
    if (r?.result?.ok && r.result.lines.length) {
      const lines = dedupLines(r.result.lines);
      await chrome.storage.local.set({
        [key]: { lines, complete: true, nextFrom: meta.duration || 0, duration: meta.duration || 0, method: "download", t: Date.now() },
      });
      safePost(port, { type: "TX_DONE", count: lines.length, method: "download" });
      return;
    }

    // 1b. Direct download gated? Force the player to fetch its caption track and
    //     intercept that authenticated request (its URL carries a valid pot).
    safePost(port, { type: "STATUS", text: "Reading captions…" });
    const [rv] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, world: "MAIN", func: ytCaptionsViaPlayer });
    if (rv?.result?.ok && rv.result.lines.length) {
      const lines = dedupLines(rv.result.lines);
      await chrome.storage.local.set({
        [key]: { lines, complete: true, nextFrom: meta.duration || 0, duration: meta.duration || 0, method: "player-pot", t: Date.now() },
      });
      safePost(port, { type: "TX_DONE", count: lines.length, method: "player-pot" });
      return;
    }

    // 2. Download gated → ANDROID player (ungated captions), then get_transcript.
    safePost(port, { type: "STATUS", text: "Fetching the transcript…" });
    const [ra] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, world: "MAIN", func: ytPlayerAndroid });
    if (ra?.result?.ok && ra.result.lines.length) {
      const lines = dedupLines(ra.result.lines);
      await chrome.storage.local.set({
        [key]: { lines, complete: true, nextFrom: meta.duration || 0, duration: meta.duration || 0, method: "android", t: Date.now() },
      });
      safePost(port, { type: "TX_DONE", count: lines.length, method: "android" });
      return;
    }
    const [rg] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, world: "MAIN", func: ytGetTranscript });
    if (rg?.result?.ok && rg.result.lines.length) {
      const lines = dedupLines(rg.result.lines);
      await chrome.storage.local.set({
        [key]: { lines, complete: true, nextFrom: meta.duration || 0, duration: meta.duration || 0, method: "innertube", t: Date.now() },
      });
      safePost(port, { type: "TX_DONE", count: lines.length, method: "innertube" });
      return;
    }

    // 3. Fall back to opening + scraping the "Show transcript" panel (then close it).
    safePost(port, { type: "STATUS", text: "Reading the transcript panel…" });
    const [rp] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, world: "MAIN", func: ytOpenTranscriptPanel });
    if (rp?.result?.ok && rp.result.lines.length) {
      const lines = dedupLines(rp.result.lines);
      await chrome.storage.local.set({
        [key]: { lines, complete: true, nextFrom: meta.duration || 0, duration: meta.duration || 0, method: "panel", t: Date.now() },
      });
      safePost(port, { type: "TX_DONE", count: lines.length, method: "panel" });
      return;
    }

    if (!meta.hasCC) {
      safePost(port, { type: "TX_ERROR", message: "transcript can't be downloaded and this video has no captions to scan." });
      return;
    }

    // 3. Offer the scrub with a time estimate; the popup confirms before we start.
    const resume = !!(existing && !existing.complete && existing.nextFrom > 0);
    const remainingSec = resume ? Math.max(0, (meta.duration || 0) - existing.nextFrom) : (meta.duration || 0);
    safePost(port, {
      type: "CONFIRM_SCRUB",
      estSec: estimateScrubSeconds(remainingSec),
      durationSec: meta.duration || 0,
      resume,
      reason: "This video's transcript can't be downloaded directly",
    });
  } catch (e) {
    safePost(port, { type: "TX_ERROR", message: String(e?.message || e) });
  }
}

// The SLOW path: harvest captions by scrubbing the whole video in chunks, caching
// after each chunk (survives interruption) and resuming from the last point.
async function runScrub(tabId, port) {
  try {
    const { tab, key } = await resolveYtTab(tabId);
    const [m] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: ytMeta });
    const meta = m?.result || {};
    if (!meta.hasCC) throw new Error("this video has no captions (CC button absent)");
    if (!meta.duration) throw new Error("could not read video duration");

    const dur = meta.duration;
    const step = 2.5;       // seconds between reads (~caption line length)
    const chunkSec = 120;   // timeline seconds per executeScript call

    // Resume from an incomplete cache; start fresh if absent or already complete.
    const existing = (await chrome.storage.local.get(key))[key];
    let all = [];
    let startFrom = 0;
    // Remember the playhead from BEFORE the first scrub run, so resume restores it
    // too (not the mid-video spot a prior interrupted run left behind).
    let origTime = meta.t || 0;
    if (existing && !existing.complete && existing.nextFrom > 0 && existing.lines?.length) {
      all = existing.lines.slice();
      startFrom = existing.nextFrom;
      if (existing.origTime != null) origTime = existing.origTime;
    }

    const restore = () =>
      chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: ytRestore,
        args: [origTime, meta.ccWasOn],
      });

    cancelScrub = false;
    scrubState = { pct: Math.round((startFrom / dur) * 100), count: all.length, paused: false };
    broadcast({ type: "TX_PROGRESS", pct: scrubState.pct, count: all.length, resumed: startFrom > 0 });

    let ensure = true; // (re)enable CC on the first chunk of this run
    for (let from = startFrom; from < dur; from += chunkSec) {
      // Cancel requested: restore the playhead and stop (partial cache is kept).
      if (cancelScrub) {
        await restore();
        scrubState = null;
        broadcast({ type: "TX_CANCELED", pct: Math.round((from / dur) * 100), count: all.length });
        return;
      }

      const to = Math.min(from + chunkSec, dur);
      const [r] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: ytScrubRange,
        args: [from, to, step, ensure],
      });
      // Tab went to the background: stop here WITHOUT advancing nextFrom (the prior
      // chunk's save stands), so resuming re-does this range with no gap.
      if (r?.result?.hidden) {
        scrubState = { pct: Math.round((from / dur) * 100), count: all.length, paused: true };
        broadcast({ type: "TX_PAUSED", pct: scrubState.pct, count: all.length });
        notify("PAL — scan paused", "Keep the YouTube tab visible, then click ⤓ to resume.");
        return;
      }
      ensure = false;
      if (r?.result?.lines) all.push(...r.result.lines);

      // Persist progress after every chunk so an interruption can resume.
      all = dedupLines(all);
      await chrome.storage.local.set({
        [key]: { lines: all, complete: false, nextFrom: to, duration: dur, origTime, method: "scan", t: Date.now() },
      });
      scrubState = { pct: Math.min(100, Math.round((to / dur) * 100)), count: all.length, paused: false };
      broadcast({ type: "TX_PROGRESS", pct: scrubState.pct, count: all.length });
    }

    // Restore the playhead to exactly where the user was before scrubbing began.
    await restore();

    await chrome.storage.local.set({
      [key]: { lines: all, complete: true, nextFrom: dur, duration: dur, origTime, method: "scan", t: Date.now() },
    });
    scrubState = null;
    broadcast({ type: "TX_DONE", count: all.length, method: "scan" });
    notify("PAL — transcript ready", `Scanned ${all.length} lines. Questions now use the full transcript.`);
  } catch (e) {
    scrubState = null;
    broadcast({ type: "TX_ERROR", message: String(e?.message || e) });
  }
}

async function addUsage(turn) {
  const t = (await chrome.storage.local.get("vt_usage")).vt_usage || {
    input: 0, output: 0, cacheRead: 0, cacheWrite: 0,
  };
  t.input += turn.input || 0;
  t.output += turn.output || 0;
  t.cacheRead += turn.cacheRead || 0;
  t.cacheWrite += turn.cacheWrite || 0;
  await chrome.storage.local.set({ vt_usage: t });
  return t;
}

async function getHistory(tabId) {
  const key = `vt_hist_${tabId}`;
  const store = await chrome.storage.session.get(key);
  return store[key] || [];
}

async function appendHistory(tabId, q, a) {
  const key = `vt_hist_${tabId}`;
  const arr = await getHistory(tabId);
  arr.push({ q, a, t: Date.now() });
  await chrome.storage.session.set({ [key]: arr.slice(-20) });
}

// Capture the visible tab (device-pixel res) and crop to the CSS rect scaled by dpr.
async function captureAndCrop(windowId, rect, dpr) {
  const dataUrl = await chrome.tabs.captureVisibleTab(windowId, {
    format: "jpeg",
    quality: 85,
  });
  const blob = await (await fetch(dataUrl)).blob();
  const bitmap = await createImageBitmap(blob);

  // CSS px -> device px. Chrome's devicePixelRatio already folds in page zoom.
  let sx = Math.round(rect.x * dpr);
  let sy = Math.round(rect.y * dpr);
  let sw = Math.round(rect.width * dpr);
  let sh = Math.round(rect.height * dpr);

  // Clamp to the captured bitmap bounds.
  sx = Math.max(0, Math.min(sx, bitmap.width - 1));
  sy = Math.max(0, Math.min(sy, bitmap.height - 1));
  sw = Math.max(1, Math.min(sw, bitmap.width - sx));
  sh = Math.max(1, Math.min(sh, bitmap.height - sy));

  const canvas = new OffscreenCanvas(sw, sh);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(bitmap, sx, sy, sw, sh, 0, 0, sw, sh);
  const outBlob = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.85 });

  const buf = new Uint8Array(await outBlob.arrayBuffer());
  let s = "";
  for (let i = 0; i < buf.length; i++) s += String.fromCharCode(buf[i]);
  return btoa(s);
}

// Injected into YouTube's MAIN world: read caption tracks from the player and
// fetch the full timed transcript directly (no panel, no on-screen captions).
// YouTube sometimes returns an empty body for one format, so we try json3 then
// fall back to the XML formats.
async function ytCaptions() {
  function decode(s) {
    // Decode HTML entities without innerHTML (keeps the AMO unsafe-assignment lint clean).
    const named = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
    return s.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, e) => {
      if (e[0] === "#") {
        const c = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return Number.isNaN(c) ? m : String.fromCharCode(c);
      }
      return named[e.toLowerCase()] || m;
    });
  }
  function parseJson3(text) {
    const data = JSON.parse(text);
    return (data.events || [])
      .filter((e) => e.segs)
      .map((e) => ({
        start: (e.tStartMs || 0) / 1000,
        text: e.segs.map((s) => s.utf8 || "").join("").replace(/\s+/g, " ").trim(),
      }))
      .filter((l) => l.text);
  }
  function parseXml(text) {
    const doc = new DOMParser().parseFromString(text, "text/xml");
    return [...doc.querySelectorAll("text")]
      .map((n) => ({
        start: parseFloat(n.getAttribute("start") || "0"),
        text: decode(n.textContent || "").replace(/\s+/g, " ").trim(),
      }))
      .filter((l) => l.text);
  }

  try {
    let pr = null;
    const mp = document.getElementById("movie_player");
    if (mp && typeof mp.getPlayerResponse === "function") {
      try { pr = mp.getPlayerResponse(); } catch {}
    }
    if (!pr) pr = window.ytInitialPlayerResponse;
    const tracks = pr?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
    if (!tracks || !tracks.length) return { ok: false, reason: "video has no caption tracks" };

    // Prefer a human (non-asr) English track, then any human, then English, then first.
    const pick =
      tracks.find((t) => t.kind !== "asr" && /^en/i.test(t.languageCode)) ||
      tracks.find((t) => t.kind !== "asr") ||
      tracks.find((t) => /^en/i.test(t.languageCode)) ||
      tracks[0];
    if (!pick?.baseUrl) return { ok: false, reason: "no caption baseUrl" };

    // PoToken (proof-of-origin): YouTube now returns an EMPTY body (HTTP 200) for
    // the timedtext download unless a per-video pot is present. In a logged-in
    // browser the page already holds one — grab it and append &pot= when needed.
    const extractPot = () => {
      try { if (pr?.serviceIntegrityDimensions?.poToken) return pr.serviceIntegrityDimensions.poToken; } catch {}
      try {
        const cfg = window.ytcfg;
        const p = cfg?.get?.("PO_TOKEN") || cfg?.data_?.PO_TOKEN;
        if (p) return p;
      } catch {}
      try {
        const st = pr?.responseContext?.serviceTrackingParams;
        if (Array.isArray(st)) { const f = st.find((x) => x?.key === "pot"); if (f?.value) return f.value; }
      } catch {}
      return null;
    };
    const pot = extractPot();

    // Strip any existing fmt param; build candidate base URLs (plain, then +pot).
    const clean = (u) => u.replace(/([?&])fmt=[^&]*/g, "$1").replace(/[?&]$/, "");
    const withPot = (u) => pot && !/[?&]pot=/.test(u)
      ? u + (u.includes("?") ? "&" : "?") + "pot=" + encodeURIComponent(pot)
      : u;
    const bases = [clean(pick.baseUrl)];
    if (pot) bases.push(withPot(bases[0]));

    const get = async (base2, param) => {
      const u = param ? base2 + (base2.includes("?") ? "&" : "?") + param : base2;
      // Same-origin (youtube.com) fetch: cookies + the browser UA are sent
      // automatically, which is what YouTube's pot check expects in-page.
      const r = await fetch(u, { credentials: "include" });
      return { status: r.status, ok: r.ok, text: r.ok ? await r.text() : "" };
    };

    let lines = [];
    let last = { status: 0, text: "" };
    const fmts = ["fmt=json3", "", "fmt=srv1"];
    for (const base2 of bases) {
      for (const f of fmts) {
        last = await get(base2, f);
        if (!last.text) continue;
        try { lines = f === "fmt=json3" ? parseJson3(last.text) : parseXml(last.text); } catch {}
        if (lines.length) break;
      }
      if (lines.length) break;
    }

    if (!lines.length) {
      return { ok: false, reason: `caption fetch empty (status ${last.status}, ${last.text.length} bytes${pot ? ", pot tried" : ", no pot found"})` };
    }
    return { ok: true, lines, lang: pick.languageCode, kind: pick.kind || "manual" };
  } catch (e) {
    return { ok: false, reason: String((e && e.message) || e) };
  }
}

// Injected (MAIN world): the player fetches its caption track with a VALID PoToken
// baked into the timedtext URL — a token we cannot read any other way (it's minted
// by YouTube's botguard runtime, not stored in any ytcfg / player field). So we
// force the player to make that request (toggle CC off→on), INTERCEPT it, and parse
// the COMPLETE caption file it returns — the full transcript in one shot, with no
// transcript panel and no playhead scrubbing. CC is restored to its prior state.
async function ytCaptionsViaPlayer() {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  function decode(s) {
    // Decode HTML entities without innerHTML (keeps the AMO unsafe-assignment lint clean).
    const named = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
    return s.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, e) => {
      if (e[0] === "#") {
        const c = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return Number.isNaN(c) ? m : String.fromCharCode(c);
      }
      return named[e.toLowerCase()] || m;
    });
  }
  function parseJson3(text) {
    const data = JSON.parse(text);
    return (data.events || [])
      .filter((e) => e.segs)
      .map((e) => ({
        start: (e.tStartMs || 0) / 1000,
        text: e.segs.map((s) => s.utf8 || "").join("").replace(/\s+/g, " ").trim(),
      }))
      .filter((l) => l.text);
  }
  function parseXml(text) {
    const doc = new DOMParser().parseFromString(text, "text/xml");
    return [...doc.querySelectorAll("text")]
      .map((n) => ({
        start: parseFloat(n.getAttribute("start") || "0"),
        text: decode(n.textContent || "").replace(/\s+/g, " ").trim(),
      }))
      .filter((l) => l.text);
  }
  const parseAny = (text) => {
    const t = (text || "").trim();
    if (!t) return [];
    if (t[0] === "{") { try { return parseJson3(t); } catch {} }
    try { return parseXml(t); } catch {}
    return [];
  };

  const video = document.querySelector("video");
  const ccBtn = document.querySelector(".ytp-subtitles-button");
  if (!video || !ccBtn) return { ok: false, reason: "no captions on this video" };
  const ccWasOn = ccBtn.getAttribute("aria-pressed") === "true";

  // Capture the player's caption request — its URL carries the pot, its body is the
  // whole track. Patch BOTH fetch and XHR; YouTube has used each for timedtext.
  let capturedUrl = null;
  let capturedBody = null;
  const note = (url, body) => {
    if (typeof url === "string" && url.indexOf("timedtext") !== -1) {
      if (!capturedUrl) capturedUrl = url;
      if (body && !capturedBody) capturedBody = body;
    }
  };
  const origFetch = window.fetch;
  window.fetch = function (input, init) {
    const p = origFetch.apply(this, arguments);
    try {
      const url = typeof input === "string" ? input : (input && input.url) || "";
      if (url.indexOf("timedtext") !== -1) {
        p.then((resp) => resp.clone().text().then((txt) => note(url, txt)).catch(() => {})).catch(() => {});
      }
    } catch {}
    return p;
  };
  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url) {
    this.__palUrl = url;
    return origOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function () {
    this.addEventListener("load", () => { try { note(this.__palUrl, this.responseText); } catch {} });
    return origSend.apply(this, arguments);
  };

  try {
    // Force a fresh fetch: flip CC off then on so the player re-requests the track
    // (leaving it "on" when already-on may reuse a cached track and never fetch).
    const press = async () => { ccBtn.click(); await sleep(450); };
    if (ccWasOn) await press(); // off
    await press();              // on → triggers the timedtext fetch

    const deadline = Date.now() + 4500;
    while (Date.now() < deadline && !capturedBody) await sleep(120);

    let lines = parseAny(capturedBody);

    // Got the pot-bearing URL but no usable body? Re-fetch it ourselves in json3.
    if (!lines.length && capturedUrl) {
      const base = capturedUrl.replace(/([?&])fmt=[^&]*/g, "$1").replace(/[&?]$/, "");
      for (const f of ["fmt=json3", "", "fmt=srv1"]) {
        try {
          const r = await fetch(base + (base.includes("?") ? "&" : "?") + f, { credentials: "include" });
          if (!r.ok) continue;
          const text = await r.text();
          if (text) { lines = parseAny(text); if (lines.length) break; }
        } catch {}
      }
    }

    if (!lines.length) return { ok: false, reason: "player caption request captured no transcript" };
    return { ok: true, lines };
  } finally {
    window.fetch = origFetch;
    XMLHttpRequest.prototype.open = origOpen;
    XMLHttpRequest.prototype.send = origSend;
    try {
      const nowOn = ccBtn.getAttribute("aria-pressed") === "true";
      if (nowOn !== ccWasOn) ccBtn.click(); // restore prior CC state
    } catch {}
  }
}

function ytVideoId(url) {
  try {
    const u = new URL(url);
    if (u.hostname.includes("youtu.be")) return u.pathname.slice(1);
    return u.searchParams.get("v");
  } catch {
    return null;
  }
}

// Cache key for a non-YouTube video page — stable per host+pathname so a pasted
// transcript is reused across questions and reloads. Shares the vt_yttx_ prefix so
// Options → "Clear all cached transcripts" covers pasted ones too.
function txCacheKey(tab) {
  try {
    const u = new URL(tab.url || "");
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    const stem = u.hostname + u.pathname;
    let h = 5381;
    for (let i = 0; i < stem.length; i++) h = ((h * 33) ^ stem.charCodeAt(i)) >>> 0;
    return "vt_yttx_" + h.toString(36);
  } catch {
    return null;
  }
}

// --- Injected helpers for full-video caption harvesting (self-contained) ---
function ytMeta() {
  const v = document.querySelector("video");
  const b = document.querySelector(".ytp-subtitles-button");
  return {
    duration: v?.duration || 0,
    t: v?.currentTime || 0,
    ccWasOn: !!(b && b.getAttribute("aria-pressed") === "true"),
    hasCC: !!b,
  };
}

async function ytScrubRange(from, to, step, ensureCC) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  // The player only renders captions while the tab is visible. If it's hidden,
  // bail before doing anything so we don't record empty lines or advance past
  // this range — the caller will pause and can resume later.
  if (document.visibilityState !== "visible") return { ok: false, hidden: true, lines: [] };
  const v = document.querySelector("video");
  if (!v) return { ok: false, lines: [] };
  if (ensureCC) {
    const b = document.querySelector(".ytp-subtitles-button");
    if (b && b.getAttribute("aria-pressed") !== "true") { b.click(); await sleep(350); }
  }
  const seek = (t) =>
    new Promise((res) => {
      const on = () => { v.removeEventListener("seeked", on); res(); };
      v.addEventListener("seeked", on);
      v.currentTime = t;
      setTimeout(() => { v.removeEventListener("seeked", on); res(); }, 700);
    });
  const read = () => {
    const s = document.querySelectorAll(".ytp-caption-segment, .captions-text");
    return [...s].map((x) => x.textContent || "").join(" ").replace(/\s+/g, " ").trim();
  };
  const lines = [];
  let prev = null;
  for (let t = from; t <= to; t += step) {
    await seek(t);
    await sleep(120);
    const txt = read();
    if (txt && txt !== prev) { lines.push({ start: Math.round(t * 10) / 10, text: txt }); prev = txt; }
  }
  return { ok: true, lines };
}

function ytRestore(t, ccWasOn) {
  const v = document.querySelector("video");
  if (v) { try { v.currentTime = t; v.pause(); } catch {} }
  const b = document.querySelector(".ytp-subtitles-button");
  if (b && !ccWasOn && b.getAttribute("aria-pressed") === "true") b.click();
}

// Injected into the page: when the caption DOWNLOAD is gated but the player still
// renders captions on screen, harvest them. Briefly enable CC, scrub the playhead
// across a window around the pause, read each rendered caption line, then restore
// the time + CC state. The screenshot is already captured before this runs.
// Injected (MAIN world): fetch the FULL transcript via YouTube's internal Innertube
// get_transcript API — the same authenticated endpoint the "Show transcript" panel
// uses. Works when the timedtext download is PoToken-gated. No UI, no playhead.
// Injected (MAIN world): full transcript via the ANDROID Innertube player. The
// Android client's caption baseUrls are NOT PoToken-gated, so we can fetch the
// whole timed track directly — the same approach youtube-to-transcript sites use.
async function ytPlayerAndroid() {
  try {
    const cfg = window.ytcfg;
    const apiKey = cfg?.get?.("INNERTUBE_API_KEY") || cfg?.data_?.INNERTUBE_API_KEY;
    if (!apiKey) return { ok: false, reason: "no innertube key" };
    const videoId =
      new URLSearchParams(location.search).get("v") ||
      (location.hostname.includes("youtu.be") ? location.pathname.slice(1) : null) ||
      (location.pathname.startsWith("/embed/") ? location.pathname.split("/")[2] : null);
    if (!videoId) return { ok: false, reason: "no video id" };

    // The ANDROID client must be called ANONYMOUSLY. Sending the logged-in web
    // session cookies with an ANDROID client context makes YouTube reject the
    // request (400 / stripped captions), so omit credentials here.
    const r = await fetch(`/youtubei/v1/player?key=${apiKey}&prettyPrint=false`, {
      method: "POST",
      credentials: "omit",
      headers: { "content-type": "application/json", "X-YouTube-Client-Name": "3", "X-YouTube-Client-Version": "19.09.37" },
      body: JSON.stringify({
        videoId,
        context: { client: { clientName: "ANDROID", clientVersion: "19.09.37", androidSdkVersion: 30, hl: "en", gl: "US" } },
      }),
    });
    if (!r.ok) return { ok: false, reason: "player HTTP " + r.status };
    const pr = await r.json();
    const tracks = pr?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
    if (!tracks?.length) return { ok: false, reason: "player: no caption tracks" };
    const pick =
      tracks.find((t) => t.kind !== "asr" && /^en/i.test(t.languageCode)) ||
      tracks.find((t) => t.kind !== "asr") ||
      tracks.find((t) => /^en/i.test(t.languageCode)) ||
      tracks[0];
    if (!pick?.baseUrl) return { ok: false, reason: "player: no baseUrl" };

    function decodeXml(s) {
      const named = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
      return s.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, e) => {
        if (e[0] === "#") {
          const c = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
          return Number.isNaN(c) ? m : String.fromCharCode(c);
        }
        return named[e.toLowerCase()] || m;
      });
    }
    const base = pick.baseUrl.replace(/([?&])fmt=[^&]*/g, "$1").replace(/[?&]$/, "");
    const fetchCaptions = async (param) => {
      const u = param ? base + (base.includes("?") ? "&" : "?") + param : base;
      const cr = await fetch(u);
      if (!cr.ok) return { status: cr.status, lines: [] };
      const text = await cr.text();
      if (!text) return { status: cr.status, lines: [] };
      // json3 first, then XML (srv1/plain) — same tolerance as the web download.
      if (param === "fmt=json3") {
        try {
          const data = JSON.parse(text);
          return {
            status: cr.status,
            lines: (data.events || [])
              .filter((e) => e.segs)
              .map((e) => ({
                start: (e.tStartMs || 0) / 1000,
                text: e.segs.map((s) => s.utf8 || "").join("").replace(/\s+/g, " ").trim(),
              }))
              .filter((l) => l.text),
          };
        } catch { return { status: cr.status, lines: [] }; }
      }
      const doc = new DOMParser().parseFromString(text, "text/xml");
      return {
        status: cr.status,
        lines: [...doc.querySelectorAll("text")]
          .map((n) => ({
            start: parseFloat(n.getAttribute("start") || "0"),
            text: decodeXml(n.textContent || "").replace(/\s+/g, " ").trim(),
          }))
          .filter((l) => l.text),
      };
    };

    let out = await fetchCaptions("fmt=json3");
    if (!out.lines.length) out = await fetchCaptions("");
    if (!out.lines.length) out = await fetchCaptions("fmt=srv1");
    if (!out.lines.length) return { ok: false, reason: "player: empty caption track (status " + out.status + ")" };
    return { ok: true, lines: out.lines, lang: pick.languageCode };
  } catch (e) {
    return { ok: false, reason: String((e && e.message) || e) };
  }
}

async function ytGetTranscript() {
  try {
    const cfg = window.ytcfg;
    const apiKey = cfg?.get?.("INNERTUBE_API_KEY") || cfg?.data_?.INNERTUBE_API_KEY;
    const context = cfg?.get?.("INNERTUBE_CONTEXT") || cfg?.data_?.INNERTUBE_CONTEXT;
    if (!apiKey || !context) return { ok: false, reason: "no innertube config" };

    // Innertube POSTs need the client name/version headers; include credentials so
    // the authenticated session is used (same as the Show-transcript panel's XHR).
    const clientName = String(cfg?.get?.("INNERTUBE_CONTEXT_CLIENT_NAME") || 1);
    const clientVersion = cfg?.get?.("INNERTUBE_CLIENT_VERSION") || context?.client?.clientVersion || "";
    // The transcript `params` are bound to the page's visitor session. The real
    // "Show transcript" XHR sends the visitor id; without it get_transcript rejects
    // the (otherwise valid) params with HTTP 400. Send it as the header AND fold it
    // into the request context's client, exactly like the page does.
    const visitorData =
      cfg?.get?.("VISITOR_DATA") || cfg?.data_?.VISITOR_DATA || context?.client?.visitorData || "";
    const ctx = visitorData
      ? { ...context, client: { ...(context.client || {}), visitorData } }
      : context;
    const innertube = (endpoint, body) =>
      fetch(`/youtubei/v1/${endpoint}?key=${apiKey}&prettyPrint=false`, {
        method: "POST",
        credentials: "include",
        headers: {
          "content-type": "application/json",
          "X-YouTube-Client-Name": clientName,
          "X-YouTube-Client-Version": clientVersion,
          ...(visitorData ? { "X-Goog-Visitor-Id": visitorData } : {}),
        },
        body: JSON.stringify(body),
      });

    const findParams = (root) => {
      let found = null;
      (function walk(o) {
        if (!o || typeof o !== "object" || found) return;
        // YouTube has used both names for this across versions; accept either.
        const ep = o.getTranscriptEndpoint || o.getTranscriptCommand;
        if (ep?.params) { found = ep.params; return; }
        for (const k in o) walk(o[k]);
      })(root);
      return found;
    };

    const videoId =
      new URLSearchParams(location.search).get("v") ||
      (location.hostname.includes("youtu.be") ? location.pathname.slice(1) : null) ||
      (location.pathname.startsWith("/embed/") ? location.pathname.split("/")[2] : null);

    // Fetch fresh params from the `next` endpoint — this is how the transcript
    // panel gets them too. Used as a fallback when the initial-data params are
    // stale (a common cause of get_transcript HTTP 400).
    const freshParams = async () => {
      if (!videoId) return null;
      const nr = await innertube("next", { context: ctx, videoId });
      if (!nr.ok) throw new Error("next HTTP " + nr.status);
      return findParams(await nr.json());
    };

    const collectLines = (json) => {
      const lines = [];
      (function collect(o) {
        if (!o || typeof o !== "object") return;
        const seg = o.transcriptSegmentRenderer;
        if (seg) {
          const start = (Number(seg.startMs) || 0) / 1000;
          const text = (seg.snippet?.runs || []).map((r) => r.text || "").join("").replace(/\s+/g, " ").trim();
          if (text) lines.push({ start, text });
        }
        for (const k in o) collect(o[k]);
      })(json);
      return lines;
    };

    // Try the fast initial-data params first; if get_transcript rejects them
    // (400 = stale/wrong params), refetch fresh params from `next` and retry once.
    let params = findParams(window.ytInitialData);
    let usedFresh = false;
    let lastReason = "no transcript params (video may have no captions)";
    for (let attempt = 0; attempt < 2; attempt++) {
      if (!params) {
        if (usedFresh) break;
        usedFresh = true;
        params = await freshParams();
        if (!params) break;
      }
      const resp = await innertube("get_transcript", { context: ctx, params });
      if (!resp.ok) {
        lastReason = "get_transcript HTTP " + resp.status;
        params = null; // force a fresh-params retry on the next loop
        continue;
      }
      const lines = collectLines(await resp.json());
      if (lines.length) return { ok: true, lines };
      lastReason = "get_transcript returned no segments";
      params = null;
    }
    return { ok: false, reason: lastReason };
  } catch (e) {
    return { ok: false, reason: String((e && e.message) || e) };
  }
}

// Injected (MAIN world): the ground-truth fallback. YouTube's own "Show
// transcript" panel loads its segments via an AUTHENTICATED get_transcript call —
// the same request our manual ytGetTranscript tries to reproduce (and which YouTube
// now 400s) — but when the PAGE issues it, it always works. So we OPEN the panel,
// INTERCEPT that very response (capturing the COMPLETE segment list, immune to the
// transcript list's DOM virtualization), parse it, and close the panel again.
// Falls back to scrolling the rendered list to collect every segment if the
// intercept captures nothing. A brief, self-reverting UI blip in exchange for the
// full transcript. (Button/label matching is English-oriented.)
async function ytOpenTranscriptPanel() {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const hms = (s) => {
    const p = String(s).trim().split(":").map(Number);
    if (p.some(isNaN)) return null;
    return p.length === 3 ? p[0] * 3600 + p[1] * 60 + p[2] : p.length === 2 ? p[0] * 60 + p[1] : p[0];
  };

  // Recursively harvest every transcriptSegmentRenderer (startMs + snippet runs).
  const collectFromInnertube = (json) => {
    const lines = [];
    (function walk(o) {
      if (!o || typeof o !== "object") return;
      const seg = o.transcriptSegmentRenderer;
      if (seg) {
        const start = (Number(seg.startMs) || 0) / 1000;
        const text = (seg.snippet?.runs || []).map((r) => r.text || "").join("").replace(/\s+/g, " ").trim();
        if (text) lines.push({ start, text });
      }
      for (const k in o) walk(o[k]);
    })(json);
    return lines;
  };

  // Read the rendered segments. YouTube has renamed these classes over time, so
  // accept several selectors and degrade to the row's text minus its timestamp.
  const scrapeDom = () =>
    [...document.querySelectorAll("ytd-transcript-segment-renderer")]
      .map((s) => {
        const ts = (s.querySelector(".segment-timestamp, [class*='timestamp']")?.textContent || "").trim();
        let text = (s.querySelector(".segment-text, yt-formatted-string.segment-text, [class*='segment-text']")?.textContent || "").trim();
        if (!text) text = (s.textContent || "").replace(ts, "");
        return { start: hms(ts) ?? 0, text: text.replace(/\s+/g, " ").trim() };
      })
      .filter((l) => l.text);

  const scrollContainer = () =>
    document.querySelector(
      "#transcript-scroll-container, " +
      "ytd-transcript-search-panel-renderer [id='transcript-scroll-container'], " +
      "ytd-transcript-search-panel-renderer"
    );

  // The transcript list is virtualized — only the rows near the viewport exist in
  // the DOM. Scroll it top→bottom, collecting whatever renders at each step.
  const scrollCollect = async () => {
    const c = scrollContainer();
    if (!c) return [];
    const seen = new Map();
    try { c.scrollTop = 0; } catch {}
    await sleep(120);
    const snap = () => { for (const l of scrapeDom()) seen.set(Math.round((l.start || 0) * 10), l); };
    for (let i = 0; i < 600; i++) {
      snap();
      const before = c.scrollTop;
      c.scrollTop += Math.max(40, Math.round((c.clientHeight || 220) * 0.85));
      await sleep(55);
      const atEnd = c.scrollTop <= before || c.scrollTop + (c.clientHeight || 0) + 2 >= (c.scrollHeight || Infinity);
      if (atEnd) { snap(); break; }
    }
    return [...seen.values()].sort((a, b) => (a.start || 0) - (b.start || 0));
  };

  // Panel already open (user opened it)? Collect without touching the UI.
  if (scrapeDom().length) {
    const lines = await scrollCollect();
    return { ok: true, lines, opened: false };
  }

  // Patch fetch so we can capture the panel's OWN get_transcript response.
  let captured = null;
  const origFetch = window.fetch;
  window.fetch = function (input, init) {
    const p = origFetch.apply(this, arguments);
    try {
      const url = typeof input === "string" ? input : (input && input.url) || "";
      if (url.indexOf("/youtubei/v1/get_transcript") !== -1) {
        // clone() so the page's own .then() still receives the body unchanged.
        p.then((resp) => resp.clone().json().then((j) => { if (!captured) captured = j; }).catch(() => {}))
          .catch(() => {});
      }
    } catch {}
    return p;
  };

  try {
    const findShowBtn = () => {
      const bySelector = document.querySelector(
        "ytd-video-description-transcript-section ytd-button-renderer button, " +
        "ytd-structured-description-content [aria-label*='transcript' i], " +
        "ytd-button-renderer button[aria-label*='transcript' i], " +
        "button[aria-label*='transcript' i]"
      );
      if (bySelector) return bySelector;
      const cands = document.querySelectorAll("ytd-button-renderer button, yt-button-shape button, tp-yt-paper-button, button");
      for (const c of cands) {
        const t = (c.textContent || "").trim().toLowerCase();
        if (t === "show transcript" || (t.includes("transcript") && t.length < 40)) return c;
      }
      return null;
    };

    let btn = findShowBtn();
    if (!btn) {
      // The button lives inside the (collapsed) description — expand it first.
      const expand = document.querySelector(
        "#description #expand, ytd-structured-description-wrapper #expand, tp-yt-paper-button#expand, #expand"
      );
      if (expand) { expand.click(); await sleep(500); btn = findShowBtn(); }
    }
    if (!btn) return { ok: false, reason: "no Show transcript button (not offered / non-English UI)" };

    btn.click();

    // Prefer the intercepted response (complete + virtualization-free). If the
    // panel's call is blocked or slow, fall back to scrolling the rendered DOM.
    const deadline = Date.now() + 6500;
    while (Date.now() < deadline) {
      if (captured) break;
      await sleep(150);
    }
    let lines = captured ? collectFromInnertube(captured) : [];
    if (!lines.length) lines = await scrollCollect();

    if (!lines.length) return { ok: false, reason: "opened transcript panel but no segments rendered" };
    return { ok: true, lines, opened: true };
  } finally {
    window.fetch = origFetch; // always restore, even on early return / throw
    try {
      const closeBtn = document.querySelector(
        'ytd-engagement-panel-section-list-renderer[target-id="engagement-panel-searchable-transcript"] button[aria-label*="Close" i], ' +
        'button[aria-label*="Close transcript" i], ' +
        'ytd-engagement-panel-section-list-renderer[target-id="engagement-panel-searchable-transcript"] #visibility-button button, ' +
        'ytd-engagement-panel-section-list-renderer button[aria-label*="Close" i]'
      );
      if (closeBtn) closeBtn.click();
    } catch {}
  }
}

async function ytCaptionWindow(windowSec) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const video = document.querySelector("video");
  if (!video) return { ok: false, reason: "no video" };

  const seekTo = (t) =>
    new Promise((res) => {
      const on = () => { video.removeEventListener("seeked", on); res(); };
      video.addEventListener("seeked", on);
      video.currentTime = t;
      setTimeout(() => { video.removeEventListener("seeked", on); res(); }, 700);
    });
  const readCaption = () => {
    const segs = document.querySelectorAll(".ytp-caption-segment, .captions-text");
    return [...segs].map((s) => s.textContent || "").join(" ").replace(/\s+/g, " ").trim();
  };

  const origTime = video.currentTime;
  const ccBtn = document.querySelector(".ytp-subtitles-button");
  const ccWasOn = ccBtn && ccBtn.getAttribute("aria-pressed") === "true";
  if (ccBtn && !ccWasOn) { ccBtn.click(); await sleep(350); }

  const collected = [];
  let prev = null;
  const start = Math.max(0, origTime - windowSec);
  const end = origTime + windowSec;
  for (let t = start; t <= end; t += 1.5) {
    await seekTo(t);
    await sleep(140); // let the overlay paint for this time
    const txt = readCaption();
    if (txt && txt !== prev) { collected.push({ start: Math.round(t * 10) / 10, text: txt }); prev = txt; }
  }

  // restore
  await seekTo(origTime);
  try { video.pause(); } catch {}
  if (ccBtn && !ccWasOn) ccBtn.click(); // turn CC back off if we enabled it

  if (!collected.length) {
    return { ok: false, reason: "no captions rendered (turn CC on to confirm they exist)" };
  }
  return { ok: true, lines: collected };
}

// ---- Injected into the page (must be fully self-contained) -------------------
async function pageProbe() {
  function fmt(t) {
    t = Math.max(0, Math.floor(t || 0));
    const h = String(Math.floor(t / 3600)).padStart(2, "0");
    const m = String(Math.floor((t % 3600) / 60)).padStart(2, "0");
    const s = String(t % 60).padStart(2, "0");
    return `${h}:${m}:${s}`;
  }
  function hms(str) {
    const p = String(str).trim().split(":").map(Number);
    if (p.some(isNaN)) return null;
    if (p.length === 3) return p[0] * 3600 + p[1] * 60 + p[2];
    if (p.length === 2) return p[0] * 60 + p[1];
    if (p.length === 1) return p[0];
    return null;
  }

  // Pick the largest visible <video>.
  const vids = [...document.querySelectorAll("video")].filter((v) => {
    const r = v.getBoundingClientRect();
    return r.width > 50 && r.height > 50;
  });
  vids.sort((a, b) => {
    const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
    return rb.width * rb.height - ra.width * ra.height;
  });
  const video = vids[0] || null;

  let rect = null, currentTime = 0, dur = 0;
  if (video) {
    try { video.pause(); } catch {}
    // Let the paused frame composite before the worker captures the tab.
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const r = video.getBoundingClientRect();
    // Clamp to viewport (captureVisibleTab only sees the visible area).
    const vx = Math.max(0, r.left), vy = Math.max(0, r.top);
    const vr = Math.min(window.innerWidth, r.right);
    const vb = Math.min(window.innerHeight, r.bottom);
    rect = { x: vx, y: vy, width: Math.max(1, vr - vx), height: Math.max(1, vb - vy) };
    currentTime = video.currentTime || 0;
    dur = video.duration || 0;
  }

  // --- Transcript extraction (best-effort, multiple strategies) ---
  let transcript = [], source = "none";

  // 1) <track> text cues. Force mode="hidden" so the browser LOADS the whole
  //    cue file WITHOUT rendering subtitles on screen (no overlay to block the
  //    video). Then poll briefly for cues to populate (loading is async).
  if (video && video.textTracks && video.textTracks.length) {
    const tracks = [...video.textTracks].filter(
      (t) => t.kind === "subtitles" || t.kind === "captions" || t.kind === ""
    );
    for (const t of tracks) {
      if (t.mode === "disabled") t.mode = "hidden"; // load cues, don't display
    }
    const deadline = Date.now() + 2500;
    let best = [];
    while (Date.now() < deadline) {
      for (const t of tracks) {
        if (t.cues && t.cues.length > best.length) {
          best = [...t.cues].map((c) => ({
            start: c.startTime,
            text: (c.text || "").replace(/\s+/g, " ").trim(),
          }));
        }
      }
      if (best.length) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    if (best.length > transcript.length) {
      transcript = best;
      source = "text-track(hidden)";
    }
  }

  // 2) YouTube transcript panel (if opened by the user)
  if (location.hostname.includes("youtube.")) {
    const segs = document.querySelectorAll("ytd-transcript-segment-renderer");
    if (segs.length) {
      const lines = [...segs].map((seg) => {
        const ts = seg.querySelector(".segment-timestamp, [class*='timestamp']")?.textContent || "";
        let tx = seg.querySelector(".segment-text, yt-formatted-string.segment-text, [class*='segment-text']")?.textContent || "";
        if (!tx) tx = (seg.textContent || "").replace(ts, "");
        return { start: hms(ts) ?? 0, text: tx.replace(/\s+/g, " ").trim() };
      }).filter((l) => l.text);
      if (lines.length > transcript.length) { transcript = lines; source = "youtube-panel"; }
    }
  }

  // 3) Udemy transcript cues
  if (location.hostname.includes("udemy.")) {
    const cues = document.querySelectorAll('[data-purpose="transcript-cue"], .transcript--cue-container--Vu011 p');
    if (cues.length) {
      const lines = [...cues].map((c) => ({ start: 0, text: (c.textContent || "").replace(/\s+/g, " ").trim() })).filter((l) => l.text);
      if (lines.length > transcript.length) { transcript = lines; source = "udemy"; }
    }
  }

  // 4) Generic fallback: elements that look like transcript cues
  if (!transcript.length) {
    const cand = document.querySelectorAll('[class*="transcript" i] [class*="cue" i], [class*="caption" i] li, [data-testid*="transcript" i] div');
    if (cand.length > 5) {
      const lines = [...cand].map((c) => ({ start: 0, text: (c.textContent || "").replace(/\s+/g, " ").trim() })).filter((l) => l.text && l.text.length < 400);
      if (lines.length > 5) { transcript = lines; source = "generic-dom"; }
    }
  }

  return {
    rect,
    dpr: window.devicePixelRatio || 1,
    currentTime,
    duration: dur,
    transcript,
    source,
    hasVideo: !!video,
    timestampLabel: fmt(currentTime),
  };
}
