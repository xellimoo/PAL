# Privacy Policy — PAL (Pause · Ask · Learn)

_Last updated: 2026-06-29_

PAL is a browser extension that runs entirely on your device. It has **no
backend server operated by the developer and collects no analytics or telemetry.**

## What data the extension handles

All of the following is stored **locally** on your device via `chrome.storage` and is
never transmitted to the developer:

- **Your LLM settings**: provider Base URL, model name, and API key. The API key can
  be encrypted with a passphrase you set (AES-GCM); otherwise it is stored unencrypted
  in local extension storage.
- **Cached transcripts** (per video), recent chat history (per browser session),
  token-usage totals, and your unsent question draft.

## What is sent off your device, and to whom

- **Your configured LLM endpoint only.** When you ask a question, the captured video
  frame, the relevant transcript text, your question, and recent chat turns are sent
  to the Base URL you configured, authenticated with your own API key. The data and
  key go only to that endpoint. Your use is also subject to that provider's policies.
- **YouTube caption requests.** On YouTube, the extension requests caption data from
  YouTube's own endpoints (same origin as the page) to obtain the transcript.

No data is sent anywhere else. There are no third-party trackers, analytics, or ad
networks.

## Your controls

- Clear cached transcripts in **Options → Cached transcripts**, or refresh one with
  Shift-click on the transcript button.
- Remove the extension to erase all locally stored data.

## Contact

Open an issue on the project's GitHub repository at https://github.com/0prrr/PAL.git.
