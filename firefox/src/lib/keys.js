// Durable Q&A-history storage helpers, shared by the service worker and popup.
//
// History is keyed per video/page (a stable id, so it survives a browser restart and
// reloads when you revisit the same video) and stored in chrome.storage.local. There is
// NO cap — every question is kept. A one-time lazy migration copies the legacy per-tab
// history (vt_hist_<tabId> in chrome.storage.session) into the new key on first access.

// YouTube video id from a watch/embed/share URL, or null.
function videoId(url) {
  try {
    const u = new URL(url);
    if (u.hostname.includes("youtu.be")) return u.pathname.slice(1) || null;
    return u.searchParams.get("v");
  } catch {
    return null;
  }
}

// Stable hash of hostname+pathname (no query/hash) for a non-YouTube http(s) page.
function pageHash(tab) {
  try {
    const u = new URL(tab.url || "");
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    const stem = u.hostname + u.pathname;
    let h = 5381;
    for (let i = 0; i < stem.length; i++) h = ((h * 33) ^ stem.charCodeAt(i)) >>> 0;
    return h.toString(36);
  } catch {
    return null;
  }
}

// Durable history key for a tab: per video/page when one can be derived, else a
// per-tab fallback (so blank/local pages still work).
export function histKeyForTab(tab) {
  if (!tab) return null;
  const vid = videoId(tab.url);
  if (vid) return "vt_qa_" + vid;
  const h = pageHash(tab);
  if (h) return "vt_qa_" + h;
  return tab.id != null ? `vt_qa_tab_${tab.id}` : null;
}

// Read this tab's history from local storage. On first access after the upgrade, migrates
// the legacy vt_hist_<tabId> (session) into the new local key. Returns [] if none.
export async function loadHist(tab) {
  const key = histKeyForTab(tab);
  if (!key) return [];
  const cur = (await chrome.storage.local.get(key))[key];
  if (Array.isArray(cur)) return cur;
  if (tab.id != null) {
    const oldKey = `vt_hist_${tab.id}`;
    const old = (await chrome.storage.session.get(oldKey))[oldKey];
    if (Array.isArray(old) && old.length) {
      await chrome.storage.local.set({ [key]: old });
      chrome.storage.session.remove(oldKey).catch(() => {});
      return old;
    }
  }
  return [];
}

// Write (or clear) this tab's history to local storage.
export async function saveHist(tab, arr) {
  const key = histKeyForTab(tab);
  if (!key) return;
  if (Array.isArray(arr) && arr.length) await chrome.storage.local.set({ [key]: arr });
  else await chrome.storage.local.remove(key);
}

// Explicitly clear this tab's history (the per-page Reset action).
export async function removeHist(tab) {
  const key = histKeyForTab(tab);
  if (key) await chrome.storage.local.remove(key);
}
