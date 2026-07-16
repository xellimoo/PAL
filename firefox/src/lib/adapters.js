// Provider Adapter Layer (corrected-spec §3).
// Translates {system, user, image} into the right JSON payload per spec type and
// parses the streamed response back into plain text chunks.
//
// Three spec types:
//   "openai"    -> /chat/completions ; image via image_url ; auto prefix caching
//   "anthropic" -> /messages ; image via base64 source ; ephemeral cache_control
//   "gemini"    -> :streamGenerateContent ; image via inlineData
//
// OpenAI-compatible backends (DeepSeek, Kimi/Moonshot, GLM/Z.ai, MiniMax, Groq,
// vLLM, Ollama, LM Studio) all use the "openai" spec. They cache automatically on
// a stable leading prefix, so we always place the transcript first in `system`.

function trimSlash(u) {
  return u.replace(/\/+$/, "");
}

// Build {url, headers, body} for a streaming chat request.
// `history` is prior turns as [{ role: "user"|"assistant", text }], oldest first,
// carried as text only (no stale screenshots). Only the current turn gets the image.
export function buildRequest({ spec, baseUrl, apiKey, model, system, user, images = [], maxTokens, history = [] }) {
  const base = trimSlash(baseUrl);

  if (spec === "anthropic") {
    const content = [{ type: "text", text: user }];
    for (const img of images) {
      content.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: img } });
    }
    return {
      url: base.endsWith("/messages") ? base : `${base}/messages`,
      headers: {
        "content-type": "application/json",
        // Anthropic uses x-api-key; some Anthropic-compatible backends (e.g.
        // MiniMax's /anthropic endpoint) expect a Bearer token. Send both.
        "x-api-key": apiKey,
        authorization: `Bearer ${apiKey}`,
        "anthropic-version": "2023-06-01",
        // Required when Anthropic itself sees a browser-origin request:
        "anthropic-dangerous-direct-browser-access": "true",
      },
      body: {
        model,
        max_tokens: maxTokens,
        stream: true,
        // Transcript carried in system as a cacheable ephemeral block.
        system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
        messages: [
          ...history.map((h) => ({ role: h.role, content: h.text })),
          { role: "user", content },
        ],
      },
    };
  }

  if (spec === "gemini") {
    const parts = [{ text: user }];
    for (const img of images) parts.push({ inlineData: { mimeType: "image/jpeg", data: img } });
    // key goes in the query string for the native Gemini endpoint
    const root = base.endsWith("/v1beta") || base.endsWith("/v1") ? base : base;
    return {
      url: `${root}/models/${model}:streamGenerateContent?alt=sse&key=${encodeURIComponent(apiKey)}`,
      headers: { "content-type": "application/json" },
      body: {
        systemInstruction: { parts: [{ text: system }] },
        contents: [
          ...history.map((h) => ({
            role: h.role === "assistant" ? "model" : "user",
            parts: [{ text: h.text }],
          })),
          { role: "user", parts },
        ],
      },
    };
  }

  // default: openai-compatible
  const userContent = images.length
    ? [
        { type: "text", text: user },
        ...images.map((img) => ({ type: "image_url", image_url: { url: `data:image/jpeg;base64,${img}` } })),
      ]
    : user;
  return {
    url: base.endsWith("/chat/completions") ? base : `${base}/chat/completions`,
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
    },
    body: {
      model,
      stream: true,
      stream_options: { include_usage: true }, // ask for a final usage chunk
      messages: [
        { role: "system", content: system },
        ...history.map((h) => ({ role: h.role, content: h.text })),
        { role: "user", content: userContent },
      ],
    },
  };
}

// Async generator yielding text deltas from a streaming Response.
// `usage` (if passed) is mutated in place with normalized token counts:
//   input     = fresh, uncached prompt tokens
//   cacheRead = prompt tokens served from cache
//   cacheWrite= prompt tokens written to cache (Anthropic only)
//   output    = generated tokens
export async function* streamText(spec, response, usage = {}) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    // SSE frames are separated by blank lines; process complete lines.
    let nl;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      let line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line || !line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (data === "[DONE]") return;

      let json;
      try {
        json = JSON.parse(data);
      } catch {
        continue;
      }

      if (spec === "anthropic") {
        // Some Anthropic-compatible backends (e.g. MiniMax) report the prompt /
        // cache counts only in the final message_delta, not message_start — so
        // merge any usage fields wherever they appear.
        const mergeAnthropic = (u) => {
          if (!u) return;
          if (u.input_tokens != null) usage.input = u.input_tokens;
          if (u.cache_creation_input_tokens != null) usage.cacheWrite = u.cache_creation_input_tokens;
          if (u.cache_read_input_tokens != null) usage.cacheRead = u.cache_read_input_tokens;
          if (u.output_tokens != null) usage.output = u.output_tokens;
        };
        if (json.type === "message_start") {
          mergeAnthropic(json.message?.usage);
        } else if (json.type === "message_delta") {
          mergeAnthropic(json.usage);
        } else if (json.usage) {
          mergeAnthropic(json.usage); // message_stop or other event carrying usage
        }
        if (json.type === "content_block_delta" && json.delta?.type === "text_delta") {
          yield json.delta.text;
        } else if (json.type === "error") {
          throw new Error(json.error?.message || "anthropic stream error");
        }
      } else if (spec === "gemini") {
        const t = json.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("");
        if (t) yield t;
        if (json.usageMetadata) {
          const u = json.usageMetadata;
          usage.cacheRead = u.cachedContentTokenCount || 0;
          usage.input = (u.promptTokenCount || 0) - usage.cacheRead;
          usage.output = u.candidatesTokenCount || 0;
        }
      } else {
        // openai-compatible
        const delta = json.choices?.[0]?.delta?.content;
        if (delta) yield delta;
        if (json.usage) {
          const cached = json.usage.prompt_tokens_details?.cached_tokens || 0;
          usage.cacheRead = cached;
          usage.input = (json.usage.prompt_tokens || 0) - cached;
          usage.output = json.usage.completion_tokens || 0;
        }
        if (json.error) throw new Error(json.error.message || "openai stream error");
      }
    }
  }
}
