# PAL — Pause · Ask · Learn (Chrome Extension)

**PAL** (short for **Pause, Ask, Learn**) lets you pause an educational video,
screenshot the current frame, and ask an AI tutor about it. Universal BYOK: works
with any OpenAI-compatible, Anthropic, or native Gemini endpoint.

> **Also available for Firefox (128+)** — same MV3 codebase, separate manifest.
> This folder is the Chrome build; see [`firefox/`](../firefox/) for the Firefox
> build, or install it from AMO.

Current version: **0.8.7**.

## What it does

1. You open the popup (or the detached window) and type a question.
2. The **service worker** injects a probe into the target video tab: it pauses the
   `<video>`, waits for the frame to paint, measures its bounds, reads `currentTime`,
   and gathers any transcript.
3. It captures the visible tab and crops to the player bounds (device-pixel correct).
4. It builds the prompt — **full transcript** if it fits, otherwise **window +
   global outline** — wraps the transcript as untrusted reference data, threads the
   last 8 Q&A turns, and **streams** the model's answer back, rendered as Markdown
   (with **LaTeX math** typeset via MathML).

All network + capture run in the service worker, so answers keep streaming/finishing
even if the popup closes.

## Features

**Architecture & capture**
- Manifest V3, **opt-in only**: idle until you click the icon (no passive content
  scripts; on-demand `chrome.scripting` injection via `activeTab`).
- All capture + LLM fetch run in the **service worker**, so work survives the popup
  closing; answers stream over a `runtime` port.
- **Pause → paint-wait → capture → crop** to the player bounds, **device-pixel
  correct** (rect × `devicePixelRatio`); cropping done in an `OffscreenCanvas`.
- Picks the **largest visible `<video>`**; clamps the crop to the viewport.

**Universal BYOK & providers**
- Three spec types: **OpenAI-compatible**, **Anthropic**, **native Gemini**, via a
  Provider Adapter Layer (payload shaping + SSE stream parsing).
- Works with OpenAI, DeepSeek, Kimi, GLM, MiniMax, Groq, vLLM, Ollama, LM Studio
  (OpenAI spec), Claude (Anthropic spec), Gemini (native).
- Anthropic path sends `ephemeral` cache_control on the transcript and **both**
  `x-api-key` and `Bearer` (for MiniMax's Anthropic endpoint).
- OpenAI path requests `stream_options.include_usage`.
- Graceful degrade: **text-only models** still work (screenshot omitted).

**Transcript handling**
- **Full vs. window+summary** strategy: full transcript if it fits the context
  threshold (and the provider caches), else a time-windowed slice + an extractive
  global outline. **No retrieval/RAG.**
- Non-YouTube HTML5 captions loaded **invisibly** via `hidden` text tracks.
- YouTube: **direct caption download** (json3 → XML → srv1) with fallbacks; if gated,
  **caption scan** (per-question ±N-sec window, or full-video harvest).
- **Full transcript harvest (⤓):** download-first; if gated, **time estimate +
  confirm**, then chunked scan with **incremental cache**, **resume**, **playhead
  restore**, **Cancel**, **progress rebroadcast**, and a **visibility guard** that
  pauses cleanly if the tab is backgrounded. Cached **per video** (persists).
- Status reports the source/coverage of whatever transcript was captured.

**Conversation & prompt**
- **Multi-turn**: last 8 Q&A turns threaded into the request (text only).
- Per-tab **history** persisted to session storage and restored on reopen.
- Transcript wrapped as **untrusted reference data** (prompt-injection mitigation),
  separate from HTML/XSS escaping.
- **Anti-hallucination guard**: if neither screenshot nor transcript is available,
  the model is instructed not to invent.

**UI**
- Popup chat with **Markdown rendering** and **LaTeX math** (`$$…$$`, `$…$`, `\[…\]`,
  `\(…\)`) typeset to MathML via bundled Temml.
- **Detached, resizable window** (⧉) that stays open for repeated questions.
- **Live token meter** (running `in · out · cached` from provider usage; per-answer
  breakdown incl. cache-write/read; **⟲** reset).
- **Draft persistence** of the unsent question (per tab).
- **Scan controls**: progress bar, Cancel button, resume, pause-on-hidden messaging.
- Diagnostic status line + a `[PAL]` console log per question.

**Security**
- API key in `chrome.storage.local`, optionally **AES-GCM-wrapped** with a
  PBKDF2-derived key from a session passphrase (decrypted into worker memory only).
- Custom Base URL **HTTPS-enforced** (localhost/127.0.0.1 allowed).
- **Least-privilege host access**: no broad install-time host permission. Access to
  your AI endpoint (and, for the detached window, the video site) is **requested at
  runtime** the first time you use it, via `optional_host_permissions`.

## Files

```
manifest.json            MV3 manifest
src/service_worker.js     orchestrator: inject → capture → crop → fetch → stream;
                          YouTube transcript download + scan harvest; token totals
src/lib/adapters.js       provider payloads + SSE stream parsing + usage (openai/anthropic/gemini)
src/lib/context.js        full vs. window+summary transcript strategy
src/lib/crypto.js         AES-GCM key wrap (PBKDF2)
src/lib/markdown.js       CSP-safe Markdown renderer + LaTeX→MathML (Temml)
src/lib/temml.mjs         bundled Temml (LaTeX→MathML); see "Third-party" below
src/popup.*               UI only (chat, token meter, scan controls)
src/options.*             settings (provider, base URL, model, key, passphrase, advanced)
icons/                    toolbar icons
```

## Install from GitHub (load unpacked)

This extension is distributed as **source** — install it via Chrome's "load
unpacked". There's nothing to build.

**1. Get the code** (either way):
- **Download:** on the GitHub page, *Code → Download ZIP* (or grab the ZIP from
  *Releases*), then **unzip** it. Or download a tagged release asset.
- **Clone:** `git clone https://github.com/xellimoo/PAL.git`

**2. Load it into Chrome:**
1. Open **chrome://extensions**.
2. Toggle **Developer mode** on (top-right).
3. Click **Load unpacked** and select the folder that contains **`manifest.json`**
   (if you downloaded a ZIP, that's the unzipped folder — open into it until you see
   `manifest.json` at the top level).
4. The PAL icon appears in the toolbar (pin it via the puzzle-piece menu).

**Updating:** download/pull the newer version, then click the **reload ↻** icon on
the extension's card at `chrome://extensions`. (Load-unpacked extensions don't
auto-update.)

> Chrome may show a "Disable developer-mode extensions" prompt on startup — that's
> normal for unpacked extensions and can be dismissed.

## Configure

1. Right-click the icon → **Options** (or click ⚙ in the popup).
2. Under **Provider profiles**, click **+ Add profile** and fill in a **name**, the
   **spec type**, **Base URL**, **Model**, and **API Key**. Add as many as you like
   (e.g. one per provider) and switch the active one from the popup header. OpenAI and
   Anthropic compatible. Examples:
   - OpenAI: `https://api.openai.com/v1` · `gpt-4o`
   - Anthropic: `https://api.anthropic.com/v1` · `claude-sonnet-4-6`
   - Gemini: `https://generativelanguage.googleapis.com/v1beta` · `gemini-2.5-flash`
3. Optional: set an **encryption passphrase** to AES-GCM-wrap each key at rest. Each
   key is wrapped under its own random salt; unlock a profile's key once per browser
   session (switching back to it doesn't re-prompt).
4. **Advanced:** max output tokens (default 65536), context threshold (full vs.
   window), window minutes, and the YouTube caption-scan options.
5. **Save**.

> Use a **vision-capable** model if you want the screenshot used. Text-only models
> (many local/OpenAI-compatible ones) still work — they just ignore the image.

> On **Save**, Chrome asks to allow access to your endpoint's host (e.g. "read and
> change your data on api.openai.com") — that's required for PAL to reach it. The
> first **Ask** from a detached window similarly requests access to the video site.

## UI overview

- **⚙** settings · **⧉** open a detached, **resizable** window that stays open so you
  can ask repeatedly without reclicking · **⤓** load the full transcript (YouTube) —
  it reports **"already loaded"** if cached; **Shift-click ⤓** forces a fresh
  download/scan · **≡** (non-YouTube) **paste a transcript** for the current video —
  plain text, VTT/SRT, or `[0:12]`-timestamped; cached per page and reused.
- **Token meter** (always visible): running totals `in · out · cached`, straight from
  the provider's reported usage. **⟲** resets it. Each answer also prints its own
  breakdown (incl. `cache-write` / `cache-read`) so you can see caching working.
- **Draft persistence:** a half-typed question is saved per-tab and restored if the
  popup closes.
- **Answers render as Markdown + math:** headings, lists, code, and LaTeX (`$$…$$`,
  `$…$`, `\[…\]`, `\(…\)`) typeset to MathML.

## Transcripts

- **Non-YouTube** sites with standard HTML5 captions: cues are loaded **invisibly**
  (the `<track>` is set to `hidden`, so no on-screen subtitles) and read directly.
  For **any** site, you can also **paste a transcript** (plain text, VTT/SRT, or
  `[0:12]`-timestamped) via the **≡** button — it's cached per page and reused for
  every question, with no playback movement.
- **YouTube:** captions are pulled from the player data. PAL tries several download
  routes in order (fast → robust); whatever it gets is **cached per video** so later
  questions reuse it instantly, with no re-fetch and no playhead movement:
  1. **Direct download** (json3 → XML → srv1), with a **PoToken** appended when one is
     available — instant, no UI. Tried first per question and by **⤓**.
  2. **Player-CC intercept** (when the direct download is PoToken-gated): briefly
     toggles CC so the player fetches its caption track, and intercepts that
     authenticated request — its URL carries a valid PoToken, so it returns the
     **full transcript at once**, still with no panel and no playhead movement.
  3. **Transcript-panel intercept** (last no-scan resort): opens YouTube's own "Show
     transcript" panel, captures its authenticated `get_transcript` response and
     scroll-collects every segment, then closes it again.
  4. **Caption scan** (final fallback): briefly enables CC and reads the rendered
     caption lines.
     - Per question: a quick ±N-second window around the pause.
     - **⤓ full transcript:** if download fails, it **estimates the time**, asks you
       to **confirm**, then reads through the whole video. It **caches per video**
       (persists), caches **incrementally** (survives interruption), **resumes** from
       where it stopped, and **restores your playhead** when done.
     - A **Cancel** button stops a running scan and restores the playhead; progress
       **rebroadcasts** to any reopened window.
     - The tab must stay **visible** during a scan (YouTube only renders captions
       for the foreground tab); if it goes to the background the scan pauses cleanly
       and is resumable. You can open a separate window to keep watching meanwhile.

## Test it

1. Open a lecture video on a non-DRM platform — **YouTube** is the easiest test.
2. Pause on a meaningful frame (a diagram, slide, or equation).
3. Type e.g. *"What is shown on screen right now?"* or *"Explain this diagram"*,
   press **Enter**.
4. Watch the status line: *Reading the video… → Capturing the frame… → Asking
   <model> (on host • full transcript + screenshot • ~N ctx tokens)… → Generating…*

### Quick checks
- **Vision working?** Ask "Describe exactly what's visible in the image."
- **Transcript working?** The status shows `full transcript`,
  `windowed transcript + outline`, `youtube-caption-scan`,
  `youtube-cc-cached(full)`, or `no transcript`.
- **Math?** Ask for "the definition of the derivative" — it should typeset.
- **Tokens?** The meter should show a real `in` and a large `cached` on follow-ups.
- **Survives popup close?** Ask, close the popup, reopen — the answer is restored.

## Known limitations

- **No DRM.** Widevine-protected video (Netflix etc.) returns black frames by design;
  this targets plain HLS/MP4 lecture platforms.
- **YouTube caption download** is PoToken-gated; PAL sidesteps this by intercepting
  the player's own authenticated caption request (the player-CC route) or the
  transcript panel's `get_transcript` response. The **caption-scan** fallback (used
  only when those are unavailable) is slow (~one read per caption line; a 3-hr lecture
  ≈ ~18 min) and requires the tab to stay visible. Whatever it captures is cached per
  video, so it's one-time.
- **Multi-turn** carries the last 8 turns of Q&A (text only — prior screenshots
  aren't re-sent). History is per-tab in session storage and clears on browser exit.
- **Detached window** targets the active tab of your last-focused *normal* window —
  keep the intended video tab in the foreground when asking from it.
- **Math:** Temml covers the vast majority of LaTeX. A few constructs that need
  Temml's optional web font (some `\mathbb`/`\mathscr` styles) aren't bundled and may
  fall back to plain glyphs.
- Host access is requested **at runtime** (`optional_host_permissions`), not granted
  broadly at install — so the first Save/Ask prompts for the endpoint and video site.
- Keys live in `chrome.storage.local` (plaintext unless you set a passphrase), highly
  recommend to set a passphrase to the API key.

## Privacy

PAL has **no backend and no telemetry**. The only network requests it makes:

- **Your configured LLM endpoint** (BYOK) — the screenshot, transcript, and your
  question are sent only to the Base URL you set, using your own API key.
- **YouTube's own caption URLs**, same-origin from the page, to fetch/read captions.

That's it — there is no developer-controlled server, no analytics, and nothing is
sent to any third party you didn't configure. (Verify yourself: the only `fetch`
calls are in `src/service_worker.js` and `src/lib/adapters.js`.)

**Data at rest** (all local, in `chrome.storage`):
- API key in `chrome.storage.local`, **optionally AES-GCM-encrypted** with a
  passphrase. It is plaintext on disk if you don't set one.
- **Per-video transcripts** in `chrome.storage.local`, keyed `vt_yttx_<videoId>`
  (persists across restarts). Per-tab chat history (session), token totals, and your
  unsent draft. Nothing leaves the machine except in calls to your chosen endpoint.

**Clearing cached transcripts:** the browser's "Clear cache" does **not** remove
extension storage. Use **Options → Cached transcripts → "Clear all cached
transcripts"** (shows count/size), or **Shift-click ⤓** to refresh just the current
video. Removing the extension also wipes everything.

**Notifications:** a desktop notification fires when a long caption **scan completes**
or **pauses** (the `notifications` permission). Direct transcript downloads are
instant and don't notify.

**Debug logging:** off by default. If enabled in Options, the service-worker console
logs only the page domain and counts (never your key, question, answer, transcript,
or screenshot) — and only to the local DevTools console, never over the network.

## Third-party

- **Temml** (`src/lib/temml.mjs`) — LaTeX→MathML renderer by Ron Kok, MIT licensed.
  Bundled unmodified (no CDN, no network at runtime) so it works offline and within
  MV3's CSP. MathML is rendered natively by Chrome, so no fonts or stylesheets are
  required for common math. Full license: `THIRD_PARTY_LICENSES.txt`.

## License

MIT — see `LICENSE` (set your name as the copyright holder before publishing).
Bundled third-party code is covered by `THIRD_PARTY_LICENSES.txt`.

## Changelog

- **0.1.0** — Initial MV3 extension: opt-in capture, pause/crop (DPR-correct),
  BYOK adapter layer (OpenAI/Anthropic/Gemini), full-vs-window transcript strategy,
  AES-GCM key wrap, popup + options.
- **0.1.1** — Invisible `<track>` caption loading (no on-screen subtitles); MiniMax
  Anthropic endpoint support (dual `x-api-key` + `Bearer`); default max tokens 65536.
- **0.1.2** — Multi-turn (last 8 turns); Markdown rendering; bigger popup; **detached
  resizable window**; correct target-tab resolution for the detached window.
- **0.1.3** — YouTube captions pulled from player data (MAIN world) instead of the
  flaky transcript panel.
- **0.1.4** — Diagnostics: host/video/transcript reason in status + console;
  anti-hallucination guard when no context is available.
- **0.1.5** — Robust YouTube caption download (json3 → XML → srv1 fallbacks).
- **0.1.6** — Draft persistence of the unsent question (per tab).
- **0.1.7** — **⤓ full-transcript** via caption scan; per-question ±N-sec caption
  window; advanced options for scan on/off and window size.
- **0.1.8** — Full-transcript harvest cached **per video**; reused by all questions.
- **0.1.9** — **Incremental caching + resume** for the harvest.
- **0.2.0** — **Live token meter** (provider usage incl. cache read/write; reset).
- **0.2.1** — ⤓ tries **direct download first**; if gated, **estimate + confirm**
  before scanning; reuse complete cache.
- **0.2.2** — Durable **original-playhead restore** across resume.
- **0.2.3** — **Visibility guard**: scan pauses cleanly if the tab is backgrounded.
- **0.2.4** — **Progress rebroadcast** to reopened windows + **Cancel** button.
- **0.3.0** — **LaTeX math** rendering (Temml → MathML); token parsing fixed for
  providers that report usage in `message_delta` (e.g. MiniMax).
- **0.3.1** — Caption harvest reworded "scrub" → **"scan"** in the UI; the confirm
  prompt explains you can open a separate window to keep watching during a scan.
- **0.3.2** — ⤓ reports **"already loaded"** when a video's transcript is fully
  cached (no redundant work); transcripts remain keyed **per video**, so switching
  videos requires its own download/scan. Cache records now note download vs. scan.
- **0.3.3** — **Shift-click ⤓** forces a fresh download/scan (drops the cached
  transcript); the "already loaded" message tells the user about it.
- **0.4.0** — **Clear cached transcripts** in Options (count + size); **desktop
  notifications** on scan completion/pause (`notifications` permission). Documented
  that transcripts live in `chrome.storage.local` and survive "Clear cache".
- **0.4.1** — Renamed to **PAL (Pause · Ask · Learn)** with a new logo; debug console
  logging is now **opt-in** (Options, off by default).
- **0.4.2** — Security hardening: PBKDF2 raised to 600k iterations; the service
  worker re-validates the endpoint scheme (HTTPS/localhost) before any request.
- **0.4.3** — Options page: `box-sizing: border-box` fix so inputs no longer
  overflow the right border (notably in the Advanced section) and align consistently.
- **0.4.4** — Detached window is now **single-instance**: ⧉ focuses the existing
  PAL window instead of opening another.
- **0.5.0** — **Least-privilege permissions** for Web Store readiness: dropped the
  broad `<all_urls>` host permission in favor of `optional_host_permissions`
  requested at runtime (endpoint host on Save; video site on first detached Ask).
- **0.5.1** — Manifest description trimmed to the 132-char store limit; repo trimmed
  to dev-load essentials.
- **0.5.2** — Ask-time YouTube caption **download is now cached** per video, so later
  asks reuse it instantly (no re-fetch, no per-question scan, no playhead movement)
  and ⤓ reports "already downloaded". A per-question scan is no longer mislabeled
  "full transcript".
- **0.5.3** — Transcript-cache fix: follow-up questions on a YouTube video reliably
  reuse the cached transcript instead of re-fetching / re-scanning.
- **0.5.7** — Markdown **table** rendering fix.
- **0.5.12** — When the direct YouTube caption download is PoToken-gated, PAL now
  tries further full-transcript routes in turn — the **ANDROID Innertube player**, the
  authenticated **`get_transcript`** endpoint, and a **"Show transcript" panel** scrape
  — collecting every failure reason for the (opt-in) debug console log.
- **0.5.13** — Robust YouTube transcript extraction. New **player-CC intercept**:
  toggling CC makes the player fetch its caption track, which PAL intercepts — that
  request's URL carries a valid PoToken (otherwise unreadable), yielding the **full
  transcript in one shot** with no panel and no playhead scrub, cached so later
  questions reuse it instantly. The panel fallback now **intercepts the panel's own
  `get_transcript` response** and **scroll-collects** every (virtualized) segment;
  PoToken is also appended to the direct download when available. **Technical failure
  reasons are hidden from the user** (debug log only). The **detached window is now
  truly single-instance** (fixed a bug that always opened a new one).
- **0.5.15** — **Paste-transcript** for non-YouTube sites: a new **≡** button (top row,
  shown only off YouTube) opens a popover to paste a transcript — plain text, VTT/SRT,
  or `[timestamp]` lines — which is cached per page and reused for every question
  (screenshot-only when none is provided). YouTube's download path is unchanged. Header
  icon buttons realigned to a single row.
- **0.5.18** — **Provider profiles**: save multiple provider configs (spec type, base
  URL, model, API key) and switch between them from the popup header; manage them
  (add/edit/delete) on the settings page. Each key is wrapped under its own random
  salt (independently encrypted). Unlocks are cached per profile in
  `chrome.storage.session` (in-memory, never on disk) for the browser session, so
  switching providers — or closing and reopening the popup — doesn't re-prompt; it's
  cleared only when the browser exits. Changing a profile's passphrase requires the
  current one; a guard confirms before storing a key unencrypted. The unlock field
  starts empty (no browser autofill) and a stale "wrong passphrase" message clears on
  success. Selecting a spec type no longer overwrites the Base URL / Model (generic
  placeholders), and the settings form got consistent field spacing. Legacy
  single-provider settings migrate into a profile automatically.
- **0.6.0** — **Firefox support**: PAL now runs on Firefox (128+) alongside Chrome,
  from one shared MV3 codebase (separate manifests in `chrome/` and `firefox/`).
  Same features — BYOK provider profiles, YouTube + paste transcript, unlock cache,
  etc.
- **0.7.0** — **Export Q&A as Markdown**: a new button in the popup header exports
  the current tab's questions and answers to a `.md` file — with the video title
  (read from the page, else derived from the first question), the source URL, and an
  export timestamp — for saving as notes.
- **0.7.1** — Toolbar icons replaced with consistent, base-aligned inline SVGs; the
  export button now appears the moment a question is asked; and the view no longer
  auto-scrolls to the bottom while a reply streams if you've scrolled up to read
  earlier output.
- **0.7.2** — Fix detached-window host access on Firefox: the detach button now
  grants the specific video site + your AI endpoint (Firefox won't grant a
  wildcard), and the detached window checks rather than requests access (it can't
  show a permission prompt). Export also no longer blocks when the video title
  can't be read — it falls back to a derived title.
- **0.7.3** — Answers survive popup close: the service worker tracks in-flight
  answers per tab so a reopened popup reattaches to the stream (live) or recovers
  the partial from session storage (if the worker was recycled). The question is
  persisted immediately on Ask — before the slow setup — so closing the popup
  right after asking no longer loses it. Firefox detached-window error message now
  guides users to right-click the icon → "Always Allow on [site]".
- **0.8.0** — **Attach images to questions**: paste a screenshot or web image
  (Ctrl+V), drag-and-drop a file, or use the paperclip button (detached window).
  Images are sent alongside the screenshot so the model sees both. Auto-resized to
  ≤1568px JPEG. A thumbnail shows under the question in the chat. Adapters updated
  to support multiple images per turn (OpenAI / Anthropic / Gemini). Browser-aware
  placeholder hints (drag in Chrome, paste in Firefox).
- **0.8.1** — Attached images survive popup close: the image is persisted to session
  storage (like the text draft) and restored with its thumbnail on reopen.
- **0.8.2** — Transparent images render correctly in the thumbnail (uses the original
  file, not the JPEG re-encode). The JPEG sent to the model composites onto white.
- **0.8.3** — Image thumbnails persist in chat history across popup close/reopen
  (stored in session history alongside the Q&A text, threaded through all reattach
  and recovery paths).
- **0.8.4** — Support up to 3 images per question (file picker, paste, drag-drop).
  Multiple thumbnails shown horizontally above the input and under each question in
  chat history. `MAX_ATTACHMENTS` constant (3) ready for future txt/md support.
- **0.8.5** — Reset conversation button on the toolbar (clears Q&A for the tab,
  keeps transcript cache). Image limit hint "(up to 3…)" next to thumbnails. Fixed
  stale `imgSrc` reference that broke Ask when no image was attached.
- **0.8.6** — **Attach text files**: the clip button now accepts text-based files (txt,
  md, csv, json, code, etc.) in addition to images. Text content is prepended to the
  question as reference material. Shared limit of 3 attachments (images + text combined).
  Unsupported file types show an error. Drag-and-drop accepts any file type.
- **0.8.7** — Fix: delete button on text-file chips was clipped by `overflow: hidden`.
  Filename now wraps in an inner span so the ✕ button is fully visible. Attachment
  chips raised above the footer border via `z-index` + `overflow: visible`.

## Disclaimer

PAL is provided for **personal study and educational use**. It runs entirely on your
own device with your own AI provider key (BYOK); it has no backend and does not
collect, transmit, or redistribute your data or any video content.

- **Respect platform terms.** You are responsible for ensuring your use complies with
  the terms of service of the sites you use it on (e.g., YouTube) and of your chosen
  AI provider. Caption reading and on-screen capture are provided as conveniences for
  personal learning, not for bulk extraction or redistribution.
- **Content & copyright.** Screenshots and transcripts are sent only to the endpoint
  you configure, for your own understanding. Respect the rights of content creators;
  do not use PAL to reproduce or distribute others' material.
- **No DRM circumvention.** PAL does not bypass DRM and is not intended for protected
  (e.g., Widevine) content, which it cannot capture.
- **No warranty.** The software is provided "as is", without warranty of any kind, and
  the authors are not liable for how it is used. See `LICENSE`.
