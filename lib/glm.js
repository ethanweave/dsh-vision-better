/**
 * GLM (Zhipu open platform) vision client.
 *
 * Contract, verified 2026-10-10 against the official docs:
 *  - `POST <endpoint>/chat/completions`, `Authorization: Bearer <api key>`
 *  - OpenAI-compatible body: `messages[].content[]` with `image_url` and `text` parts
 *  - multiple images in one message are supported, so a turn is ONE request
 *
 * No secret, image byte, or base64 payload ever reaches a log line, an error
 * message, or a returned object: failures carry a stable code plus a short,
 * redacted detail only.
 */

import { redact } from "./safe.js";
import { LIMITS } from "./defaults.js";
import { buildProviderRequest, parseProviderResponse } from "./providers.js";

/** Stable failure codes surfaced to the user and asserted by tests. */
export const VISION_CODES = Object.freeze({
  UNCONFIGURED: "VISION_RELAY_UNCONFIGURED",
  UNAUTHORIZED: "VISION_RELAY_UNAUTHORIZED",
  MODEL_NOT_FOUND: "VISION_RELAY_MODEL_NOT_FOUND",
  RATE_LIMITED: "VISION_RELAY_RATE_LIMITED",
  UPSTREAM_ERROR: "VISION_RELAY_UPSTREAM_ERROR",
  BAD_REQUEST: "VISION_RELAY_BAD_REQUEST",
  NETWORK: "VISION_RELAY_NETWORK",
  TIMEOUT: "VISION_RELAY_TIMEOUT",
  BAD_RESPONSE: "VISION_RELAY_BAD_RESPONSE",
  IMAGE_TOO_LARGE: "VISION_RELAY_IMAGE_TOO_LARGE",
  IMAGE_UNSUPPORTED: "VISION_RELAY_IMAGE_UNSUPPORTED",
  ABORTED: "VISION_RELAY_ABORTED",
  FAILED: "VISION_RELAY_FAILED",
});

/** @typedef {{ code: string, status?: number, retryable: boolean, attempts?: number, durationMs?: number }} FailureInfo */

export class VisionFailure extends Error {
  /**
   * @param {string} code stable code from {@link VISION_CODES}.
   * @param {string} message short, already-redacted message.
   * @param {FailureInfo} info failure metadata.
   */
  constructor(code, message, info = { retryable: false }) {
    super(message);
    this.name = "VisionFailure";
    this.code = code;
    this.status = info.status;
    this.retryable = info.retryable;
    this.attempts = info.attempts;
    this.durationMs = info.durationMs;
  }
}

/**
 * Map one HTTP status onto a stable code and whether retrying can help.
 * @param {number} status HTTP status.
 * @returns {{ code: string, retryable: boolean, message: string }}
 */
export function classifyStatus(status) {
  if (status === 401 || status === 403) {
    return { code: VISION_CODES.UNAUTHORIZED, retryable: false, message: "the vision API rejected the API key" };
  }
  if (status === 404) {
    return { code: VISION_CODES.MODEL_NOT_FOUND, retryable: false, message: "the vision endpoint or model id was not found" };
  }
  if (status === 429) {
    return {
      code: VISION_CODES.RATE_LIMITED,
      retryable: true,
      message: "the vision API rate-limited this request (account quota or concurrency); retrying shortly is safe",
    };
  }
  if (status >= 500) {
    return { code: VISION_CODES.UPSTREAM_ERROR, retryable: true, message: `the vision API answered ${status}` };
  }
  if (status === 400 || status === 413 || status === 422) {
    return { code: VISION_CODES.BAD_REQUEST, retryable: false, message: `the vision API rejected the request (${status})` };
  }
  return { code: VISION_CODES.FAILED, retryable: false, message: `the vision API answered ${status}` };
}

/**
 * Retry-After in milliseconds, when the server sent a usable value.
 * @param {Headers | undefined} headers response headers.
 * @returns {number | undefined} delay in ms.
 */
export function retryAfterMs(headers) {
  const raw = headers?.get?.("retry-after");
  if (raw == null || raw === "") return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(raw);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined;
}

/**
 * Send one chat completion and return the assistant text.
 *
 * @param {object} options call options.
 * @param {string} [options.provider] protocol id from `lib/providers.js` (default: the OpenAI-compatible one).
 * @param {string} options.endpoint base URL; the protocol-specific chat path is appended by the adapter.
 * @param {string} options.model model id.
 * @param {string} options.apiKey credential value; never logged or returned.
 * @param {{ mediaType: string, base64: string, id: string }[]} options.images images in order.
 * @param {string} options.prompt analysis instruction.
 * @param {number} [options.maxTokens] answer cap.
 * @param {AbortSignal} [options.signal] caller cancellation.
 * @param {typeof fetch} [options.fetchImpl] transport override (tests).
 * @param {object} [options.limits] limits from {@link ./defaults.js}.
 * @returns {Promise<{ text: string, attempts: number, durationMs: number, imageUrlMode: string }>}
 */
export async function callVision({
  provider = "openai-compatible",
  endpoint,
  model,
  apiKey,
  images,
  prompt,
  maxTokens,
  signal,
  fetchImpl,
  limits = LIMITS,
}) {
  if (typeof apiKey !== "string" || apiKey.length === 0) {
    throw new VisionFailure(VISION_CODES.UNCONFIGURED, "no vision API key is configured", { retryable: false });
  }
  // Enforce the declared body cap at the boundary that would actually send it:
  // base64 inflates by ~4/3, and a payload the provider would reject as too
  // large must never leave this process.
  const encodedBytes = images.reduce((total, image) => total + (image.base64?.length ?? 0), 0);
  if (encodedBytes > limits.maxRequestBytes) {
    throw new VisionFailure(
      VISION_CODES.IMAGE_TOO_LARGE,
      `the encoded images total ${encodedBytes} bytes, above this plugin's ${limits.maxRequestBytes}-byte request cap`,
      { retryable: false },
    );
  }
  const transport = fetchImpl ?? ((...args) => globalThis.fetch(...args));
  const startedAt = Date.now();
  const maxAttempts = Math.max(1, limits.maxAttempts);

  let lastFailure;
  // Request variants, tried in order on a 400. They only exist for the
  // OpenAI-compatible protocol: bare base64 instead of a data URI, and a body
  // without the GLM-specific `thinking` field for endpoints that reject it.
  // Anthropic and Gemini have no such degrees of freedom, so they get one.
  const variants = provider === "openai-compatible"
    ? [
        { imageUrlMode: "data-uri", thinking: "disabled" },
        { imageUrlMode: "base64", thinking: "disabled" },
        { imageUrlMode: "data-uri", thinking: "omitted" },
      ]
    : [{}];
  let variantIndex = 0;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (signal?.aborted === true) {
      throw new VisionFailure(VISION_CODES.ABORTED, "the vision request was cancelled", { retryable: false, attempts: attempt });
    }
    const variant = variants[Math.min(variantIndex, variants.length - 1)];
    let request;
    try {
      request = buildProviderRequest({ provider, endpoint, model, apiKey, images, prompt, maxTokens, variant });
    } catch (error) {
      throw new VisionFailure(VISION_CODES.BAD_REQUEST, redact(error?.message ?? error), { retryable: false });
    }
    let response;
    try {
      response = await transport(request.url, {
        method: "POST",
        headers: request.headers,
        body: request.body,
        redirect: "error", // a credential must never follow a redirect to another origin
        signal: combineSignals(signal, limits.requestTimeoutMs),
      });
    } catch (error) {
      lastFailure = transportFailure(error, signal, Date.now() - startedAt, attempt);
      if (lastFailure.retryable !== true || attempt >= maxAttempts) break;
      await backoff(attempt, undefined, signal, limits);
      continue;
    }

    const text = await safeText(response);
    if (response.ok === true) {
      const parsed = parseProviderResponse(provider, text);
      if (parsed === undefined) {
        throw new VisionFailure(VISION_CODES.BAD_RESPONSE, "the vision API returned an unexpected response shape", {
          status: response.status,
          retryable: false,
          attempts: attempt,
          durationMs: Date.now() - startedAt,
        });
      }
      return { text: parsed, attempts: attempt, durationMs: Date.now() - startedAt, imageUrlMode: variant.imageUrlMode ?? "data-uri" };
    }

    const classified = classifyStatus(response.status);
    // Surface the provider's own short reason so the operator can tell "quota
    // exhausted" from "too many concurrent requests". Never for 401/403, whose
    // bodies some providers echo the credential into, and always redacted+cut.
    const detail = detailOf(response.status, text, apiKey);
    const message = detail === undefined ? classified.message : `${classified.message} (${detail})`;
    // A 400 can mean the endpoint wants a different request shape; walk the
    // variant list before reporting failure.
    if (response.status === 400 && variantIndex < variants.length - 1 && signal?.aborted !== true) {
      variantIndex += 1;
      lastFailure = new VisionFailure(classified.code, message, {
        status: response.status,
        retryable: true,
        attempts: attempt,
        durationMs: Date.now() - startedAt,
      });
      continue;
    }
    lastFailure = new VisionFailure(classified.code, message, {
      status: response.status,
      retryable: classified.retryable,
      attempts: attempt,
      durationMs: Date.now() - startedAt,
    });
    if (classified.retryable !== true || attempt >= maxAttempts) break;
    await backoff(attempt, retryAfterMs(response.headers), signal, limits);
  }

  throw lastFailure ?? new VisionFailure(VISION_CODES.FAILED, "the vision request failed", { retryable: false });
}

/**
 * A short, redacted reason taken from a provider error body, or undefined when
 * there is nothing safe to add.
 * @param {number} status HTTP status.
 * @param {string} body raw response text.
 * @param {string} [secret] the credential sent with the request, if any.
 * @returns {string | undefined} trimmed detail.
 */
export function detailOf(status, body, secret) {
  if (status === 401 || status === 403) return undefined; // never quote an auth failure body
  if (typeof body !== "string" || body.trim() === "") return undefined;
  // Exact-match guard first: pattern redaction cannot know how an arbitrary
  // provider shapes its error body, but it can always be compared against the
  // one secret this request carried.
  if (typeof secret === "string" && secret.length > 0 && body.includes(secret)) return undefined;
  let text = body.trim();
  try {
    const parsed = JSON.parse(text);
    const error = parsed?.error ?? parsed;
    const code = typeof error?.code === "string" || typeof error?.code === "number" ? String(error.code) : undefined;
    const message = typeof error?.message === "string" ? error.message : undefined;
    text = [code === undefined ? undefined : `code ${code}`, message].filter(Boolean).join(": ") || text;
  } catch {
    // Not JSON: fall through with the raw text.
  }
  if (typeof secret === "string" && secret.length > 0 && text.includes(secret)) return undefined;
  const redacted = redact(text).replace(/\s+/g, " ").trim();
  return redacted === "" ? undefined : redacted.slice(0, 200);
}

/**
 * Build the request body. Exported for tests: it is the only place an image
 * byte is encoded, and it must never carry a URL instead of the real bytes.
 *
 * `thinking` is sent **disabled** by default: the GLM-4.6V series thinks by
 * default, and a thinking pass consumed the whole token budget on the first real
 * run, leaving `content` empty. A relay wants the analysis, not the deliberation.
 * The `"omitted"` variant covers endpoints that reject the field entirely.
 *
 * Kept as a thin alias over `lib/providers.js` so the OpenAI-compatible shape
 * stays reachable without the full `callVision` machinery.
 * @param {{ model: string, images: {mediaType: string, base64: string}[], prompt: string, maxTokens?: number, imageUrlMode: string, thinking?: "disabled" | "omitted" }} input
 * @returns {string} JSON body.
 */
export function buildBody({ model, images, prompt, maxTokens, imageUrlMode, thinking = "disabled" }) {
  return buildProviderRequest({
    provider: "openai-compatible",
    endpoint: "https://openai-compatible.invalid",
    model,
    apiKey: "unused-here",
    images,
    prompt,
    maxTokens,
    variant: { imageUrlMode, thinking },
  }).body;
}

/**
 * Extract assistant text from an OpenAI-compatible completion payload.
 *
 * GLM-4.6V puts its reasoning in `reasoning_content` and the answer in
 * `content`; some deployments return the answer as content parts. The
 * reasoning is deliberately **not** a substitute for an empty answer — an
 * analysis that is all deliberation and no conclusion is not an analysis.
 * @param {string} text raw response body.
 * @returns {string | undefined} the analysis, or undefined when the shape is wrong.
 */
export function parseCompletion(text) {
  return parseProviderResponse("openai-compatible", text);
}

/** Read a response body, refusing to buffer more than the caller allows. */
async function safeText(response, limitBytes = 4 * 1024 * 1024) {
  try {
    const body = response.body;
    if (body === null || body === undefined || typeof body.getReader !== "function") {
      const text = await response.text();
      return text.slice(0, limitBytes);
    }
    const reader = body.getReader();
    const chunks = [];
    let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done === true) break;
      size += value.byteLength;
      if (size > limitBytes) {
        await reader.cancel();
        throw new VisionFailure(VISION_CODES.BAD_RESPONSE, "the vision API response was too large to read", { retryable: false });
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8");
  } catch (error) {
    if (error instanceof VisionFailure) throw error;
    return "";
  }
}

/** Combine the caller signal with a per-request deadline. */
function combineSignals(signal, timeoutMs) {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
}

/** Classify a transport-level throw (network, DNS, TLS, deadline, cancellation). */
function transportFailure(error, signal, durationMs, attempts) {
  if (signal?.aborted === true) {
    return new VisionFailure(VISION_CODES.ABORTED, "the vision request was cancelled", {
      retryable: false,
      attempts,
      durationMs,
    });
  }
  const name = error?.name;
  if (name === "TimeoutError" || name === "AbortError") {
    return new VisionFailure(VISION_CODES.TIMEOUT, "the vision request timed out", {
      retryable: true,
      attempts,
      durationMs,
    });
  }
  // `cause.code` carries DNS/TLS/socket failures without quoting the URL or key.
  const detail = redact(error?.cause?.code ?? error?.message ?? "network error");
  return new VisionFailure(VISION_CODES.NETWORK, `the vision request could not reach the endpoint (${detail})`, {
    retryable: true,
    attempts,
    durationMs,
  });
}

/** Bounded exponential backoff that respects Retry-After and the caller signal. */
async function backoff(attempt, retryAfter, signal, limits) {
  const ceiling = Math.min(limits.maxRetryAfterMs, limits.baseRetryDelayMs * 2 ** (attempt - 1));
  const delayMs = Math.min(ceiling, retryAfter ?? ceiling);
  await sleep(delayMs, signal);
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(new VisionFailure(VISION_CODES.ABORTED, "the vision request was cancelled", { retryable: false }));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener?.("abort", onAbort);
      resolve(undefined);
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new VisionFailure(VISION_CODES.ABORTED, "the vision request was cancelled", { retryable: false }));
    };
    signal?.addEventListener?.("abort", onAbort, { once: true });
  });
}

/**
 * One short, secret-free line describing a failure, for logs and diagnostics.
 * @param {unknown} failure any thrown value.
 * @returns {{ code: string, message: string, status?: number, attempts?: number, durationMs?: number }}
 */
export function describeFailure(failure) {
  if (failure instanceof VisionFailure) {
    return {
      code: failure.code,
      message: failure.message,
      ...(failure.status === undefined ? {} : { status: failure.status }),
      ...(failure.attempts === undefined ? {} : { attempts: failure.attempts }),
      ...(failure.durationMs === undefined ? {} : { durationMs: failure.durationMs }),
    };
  }
  return { code: VISION_CODES.FAILED, message: redact(failure?.message ?? failure) };
}
