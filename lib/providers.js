/** Provider protocol adapters for the vision relay. */

import { DEFAULT_ENDPOINT, DEFAULT_MODEL, DEFAULT_PROVIDER } from "./defaults.js";

export const PROVIDERS = Object.freeze([
  { id: "openai-compatible", label: { zh: "OpenAI 兼容 API", en: "OpenAI-compatible API" }, endpoint: DEFAULT_ENDPOINT, model: DEFAULT_MODEL },
  { id: "anthropic", label: { zh: "Anthropic API", en: "Anthropic API" }, endpoint: "https://api.anthropic.com/v1", model: "claude-3-5-sonnet-latest" },
  { id: "google", label: { zh: "Google Gemini API", en: "Google Gemini API" }, endpoint: "https://generativelanguage.googleapis.com/v1beta", model: "gemini-2.5-flash" },
]);

export function normalizeProvider(value) {
  return typeof value === "string" && PROVIDERS.some((provider) => provider.id === value)
    ? { ok: true, value }
    : { ok: false, message: `provider must be one of: ${PROVIDERS.map((provider) => provider.id).join(", ")}` };
}

export function providerDefaults(provider) {
  return PROVIDERS.find((item) => item.id === provider) ?? PROVIDERS.find((item) => item.id === DEFAULT_PROVIDER);
}

/** Build a protocol-specific request. The API key is never placed in a URL. */
export function buildProviderRequest({ provider = DEFAULT_PROVIDER, endpoint, model, apiKey, images, prompt, maxTokens, variant }) {
  const base = endpoint.replace(/\/+$/, "");
  if (provider === "anthropic") {
    return {
      url: `${base}/messages`,
      headers: { "content-type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01", accept: "application/json" },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens ?? 1200,
        system: prompt,
        messages: [{ role: "user", content: [
          ...images.map((image) => ({ type: "image", source: { type: "base64", media_type: image.mediaType, data: image.base64 } })),
          { type: "text", text: prompt },
        ] }],
      }),
    };
  }
  if (provider === "google") {
    return {
      url: `${base}/models/${encodeURIComponent(model)}:generateContent`,
      headers: { "content-type": "application/json", "x-goog-api-key": apiKey, accept: "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [
          ...images.map((image) => ({ inlineData: { mimeType: image.mediaType, data: image.base64 } })),
          { text: prompt },
        ] }],
        generationConfig: { maxOutputTokens: maxTokens ?? 1200, temperature: 0.1 },
      }),
    };
  }
  const imageUrlMode = variant?.imageUrlMode ?? "data-uri";
  const content = images.map((image) => ({
    type: "image_url",
    image_url: { url: imageUrlMode === "base64" ? image.base64 : `data:${image.mediaType};base64,${image.base64}` },
  }));
  content.push({ type: "text", text: prompt });
  return {
    url: `${base}/chat/completions`,
    headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}`, accept: "application/json" },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content }],
      ...(Number.isFinite(maxTokens) && maxTokens > 0 ? { max_tokens: maxTokens } : {}),
      temperature: 0.1,
      stream: false,
      ...(variant?.thinking === "omitted" ? {} : { thinking: { type: variant?.thinking ?? "disabled" } }),
    }),
  };
}

/** Parse the text response for each supported protocol. */
export function parseProviderResponse(provider, text) {
  let payload;
  try { payload = JSON.parse(text); } catch { return undefined; }
  if (provider === "anthropic") {
    const joined = payload?.content?.filter((part) => part?.type === "text").map((part) => part.text).join("").trim();
    return joined || undefined;
  }
  if (provider === "google") {
    const joined = payload?.candidates?.[0]?.content?.parts?.map((part) => typeof part?.text === "string" ? part.text : "").join("").trim();
    return joined || undefined;
  }
  return parseOpenAiResponse(payload);
}

function parseOpenAiResponse(payload) {
  const content = payload?.choices?.[0]?.message?.content ?? payload?.content;
  if (typeof content === "string") return content.trim();
  if (Array.isArray(content)) {
    const joined = content.map((part) => typeof part === "string" ? part : typeof part?.text === "string" ? part.text : "").join("").trim();
    return joined || undefined;
  }
  return undefined;
}

/**
 * Fetch model IDs through the selected provider protocol. The caller must pass
 * the unsaved form values explicitly; this never reads or persists settings.
 */
export async function listProviderModels({ provider = DEFAULT_PROVIDER, endpoint, apiKey, fetchImpl, signal }) {
  if (!apiKey) throw new Error("no API key is configured");
  const base = endpoint.replace(/\/+$/, "");
  let url;
  let headers = { accept: "application/json" };
  if (provider === "anthropic") {
    url = `${base}/models?limit=100`;
    headers["x-api-key"] = apiKey;
    headers["anthropic-version"] = "2023-06-01";
  } else if (provider === "google") {
    url = `${base}/models?pageSize=100`;
    headers["x-goog-api-key"] = apiKey;
  } else {
    url = `${base}/models`;
    headers.authorization = `Bearer ${apiKey}`;
  }
  const response = await (fetchImpl ?? globalThis.fetch)(url, { method: "GET", headers, redirect: "error", signal: signal ?? AbortSignal.timeout(20_000) });
  const text = (await response.text()).slice(0, 1024 * 1024);
  if (!response.ok) {
    const detail = response.status === 401 || response.status === 403 ? "API key rejected" : `provider returned HTTP ${response.status}`;
    throw new Error(detail);
  }
  let payload;
  try { payload = JSON.parse(text); } catch { throw new Error("provider returned invalid JSON"); }
  const raw = Array.isArray(payload?.data) ? payload.data
    : Array.isArray(payload?.models) ? payload.models
      : Array.isArray(payload?.items) ? payload.items : undefined;
  if (raw === undefined) throw new Error("provider returned an unsupported model list shape");
  const ids = raw.map((item) => typeof item === "string" ? item : item?.id ?? item?.name)
    .filter((id) => typeof id === "string")
    .map((id) => provider === "google" ? id.replace(/^models\//, "") : id)
    .filter((id) => /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/.test(id))
    .filter((id) => provider !== "google" || raw.find((item) => (item?.name ?? "").endsWith(id))?.supportedGenerationMethods?.includes("generateContent") !== false);
  return [...new Set(ids)].sort((a, b) => a.localeCompare(b)).slice(0, 500);
}
