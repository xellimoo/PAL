# AMO submission text — PAL (Pause, Ask, Learn)

Copy each section into the matching field on the AMO developer hub
(https://addons.mozilla.org/developers/). Not packaged in the build zip.

---

## Add-on name
PAL — Pause, Ask, Learn

## Summary  (≤ 250 chars)
Pause any video, ask your own AI about the moment. PAL captures the frame + transcript
and asks your own OpenAI-/Anthropic-/Gemini-compatible endpoint — a context-aware tutor.
Bring your own key; no backend, no telemetry.

## Detailed description
PAL (Pause, Ask, Learn) turns any video into an on-demand tutor. Pause on a frame — a
diagram, equation, or anything — and ask a question. PAL captures a screenshot of the
player, pulls the video's transcript/captions when available, and sends both (plus your
question) to **your own** AI endpoint using **your own** API key (OpenAI-compatible,
Anthropic, or native Gemini). The answer streams back, rendered as Markdown with LaTeX
math.

- **Bring your own key (BYOK).** No backend, no telemetry, no third-party calls except
  the endpoint you configure. Keys are stored locally and can be AES-GCM wrapped with a
  passphrase.
- **Multiple provider profiles** — save several (e.g. OpenAI + a local model) and switch
  from the popup header.
- **Transcripts:** YouTube captions via several no-UI strategies; for any other site,
  paste a transcript (plain text, VTT/SRT, or `[timestamp]` lines), cached per video.
- **Privacy-first:** all capture + network run in the background; the only network
  egress is to your configured endpoint and the page's own caption URLs.

## Categories
Productivity, Education / Tools (pick the closest available)

## Privacy policy URL
https://github.com/xellimoo/PAL/blob/main/PRIVACY.md
(raw alternative: https://raw.githubusercontent.com/xellimoo/PAL/main/PRIVACY.md )
— must point to a PUBLIC repo. The policy text is identical to the Chrome version
(PAL's data practices are browser-independent); see PRIVACY.md in this folder.

## Single purpose
A personal educational video tutor: the user pauses a video and asks a question about
the current frame, and PAL sends that screenshot together with the video's transcript
and the question to the user's own AI endpoint (BYOK), then renders the answer.

## Permissions justification  (reviewer scrutinizes these)

- **activeTab** — Access the *active* tab only when the user clicks the PAL icon, to
  capture the video frame and read captions/transcript. No passive/background access.
- **scripting** — Inject a probe into the active tab on the user's click: pause the
  `<video>`, measure its bounds, and read the transcript/captions. Runs only on user
  action, in the active tab.
- **storage** — Store the user's settings, API key (optionally AES-GCM encrypted with a
  passphrase), provider profiles, and per-video transcript cache — all on-device in
  `chrome.storage`. Nothing leaves the machine except calls to the user's own endpoint.
- **notifications** — A single desktop notification when a long, user-initiated caption
  scan completes or pauses.
- **optional_host_permissions** (`https://*/*`, `http://localhost/*`, `http://127.0.0.1/*`)
  — OPTIONAL, never granted at install. Requested at runtime via the permissions API
  ONLY when the user configures/saves **their own** AI endpoint (BYOK), so PAL can reach
  whatever host the user chose (e.g. api.openai.com, api.anthropic.com,
  generativelanguage.googleapis.com, or a local Ollama / LM Studio at localhost). The
  video-site host is likewise requested only for the detached window. PAL never accesses
  arbitrary sites; each origin is granted on demand, by the user.
- **scripting `world: "MAIN"`** (used on YouTube only) — YouTube's caption data and its
  PoToken-gated caption request are only reachable from the page's main world; this reads
  them in the active YouTube tab, on the user's click, to extract the transcript. No data
  is exfiltrated — it's sent only to the user's own endpoint.

## Notes to reviewer

- **BYOK — no test credentials.** Because each user supplies their own AI key, there are
  no shared test credentials. To review: open **Options → + Add profile**, enter any
  OpenAI-/Anthropic-/Gemini-compatible endpoint + model + key, and **Save** (Firefox will
  prompt to grant that endpoint's host — required for PAL to reach it).
- **Quick test:** open a public YouTube lecture, pause on a clear frame, and ask e.g.
  *"What's shown on screen right now?"* or *"Summarize what's been covered so far."*
  Status line shows what context was used (screenshot / transcript / both).
- **Non-YouTube:** open any site with a video; the **≡** button lets you paste a
  transcript (cached per page).
- **Source / security:** all code is in `src/` (no remote/CDN code; Temml is bundled for
  MV3 CSP). The API key can be AES-GCM-wrapped with a passphrase (PBKDF2, 600k
  iterations); the decrypted key lives only in memory for the session.
- **No backend, no analytics.** The only `fetch` calls are to the user's configured
  endpoint (`src/lib/adapters.js`) and the page's own caption URLs (`src/service_worker.js`).
