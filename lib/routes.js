/**
 * Settings-page transport: a few loopback HTTP routes owned by this plugin.
 *
 * This is the channel a third-party DSH bundle uses to let its own settings page
 * read and write host state (the shipped market plugin does the same). The
 * routes are same-origin checked, JSON-only, size-capped, and never return the
 * API key or any image byte.
 */

import { CREDENTIAL_REF, DEFAULT_ENDPOINT, DEFAULT_MODEL, LIMITS, WEB_SERVER_SERVICE } from "./defaults.js";
import { describeApiKey, ENDPOINT_PRESETS, normalizeEndpoint, normalizeModel, readConfig, resolveApiKey, writeApiKey, writeConfig } from "./config.js";
import { callVision, describeFailure, VISION_CODES } from "./glm.js";
import { endpointLabel, redact } from "./safe.js";

/**
 * A 16x16 solid red PNG used only by "test connection": it proves
 * authentication, endpoint, and model without ever touching a user image.
 */
const TEST_IMAGE_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAFklEQVR42mO4IydHEmIY1TCqYfhqAACaMxgQdrf9VwAAAABJRU5ErkJggg==";
const TEST_PROMPT = "Connectivity test. Reply with exactly one word: the dominant color of this image.";

/** Largest request body accepted from the page. */
const MAX_BODY_BYTES = 8 * 1024;

/** Longest API key accepted (the provider's own keys are far shorter). */
const MAX_API_KEY_CHARS = 512;

/**
 * A credential value is printable ASCII without whitespace — the same rule DSH
 * applies to API keys, so an unusable key is refused here instead of becoming an
 * opaque 401 later.
 * @param {unknown} value candidate key.
 * @returns {boolean} whether the value is storable.
 */
export function isUsableApiKey(value) {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_API_KEY_CHARS && /^[\x21-\x7E]+$/.test(value);
}

/**
 * Reject a request that does not come from this page's own origin.
 *
 * A browser always sends `Origin` on a POST, including same-origin ones, so an
 * exact host match is required. `Origin: null` (sandboxed iframe, `data:` URL) is
 * refused outright: a `no-cors` POST from such a page is fire-and-forget and
 * would otherwise be able to rewrite the endpoint or burn the vision quota.
 * A missing Origin (non-browser clients) is allowed.
 *
 * The desktop shell's own `dsh-app:` scheme is accepted: a web page cannot forge
 * that origin, and the shipped market plugin documents the same blind spot
 * ("whether those requests carry the session the host's gate checks has not been
 * measured on a real Desktop"). Every other origin must match the Host exactly.
 * @param {import('node:http').IncomingMessage} request incoming request.
 * @returns {boolean} whether the request may proceed.
 */
export function sameOrigin(request) {
  const origin = request.headers.origin;
  if (origin === undefined || origin === "") return true;
  const host = request.headers.host;
  if (typeof host !== "string" || host === "") return false;
  let parsed;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }
  if (parsed.protocol === "dsh-app:") return true;
  return parsed.host === host;
}

/**
 * Read and parse a JSON body with a hard size cap.
 * @param {import('node:http').IncomingMessage} request incoming request.
 * @returns {Promise<object | undefined>} parsed object, or undefined when invalid.
 */
export async function readJsonBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) return undefined;
    chunks.push(chunk);
  }
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function sendJson(response, status, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(body);
}

/**
 * Build the settings page's read model. Contains no secret: only presence.
 * @param {object} input
 * @returns {Promise<object>} state payload.
 */
export async function buildState({ ctx, configPath, baseConfig, cache }) {
  const config = readConfig(baseConfig, configPath);
  return {
    enabled: config.enabled,
    endpoint: config.endpoint,
    endpointIsDefault: config.endpoint === DEFAULT_ENDPOINT,
    model: config.model,
    modelIsDefault: config.model === DEFAULT_MODEL,
    presets: ENDPOINT_PRESETS.map((preset) => ({ id: preset.id, endpoint: preset.endpoint, label: preset.label })),
    credential: { ref: CREDENTIAL_REF, ...(await describeApiKey(ctx)) },
    limits: { maxImageBytes: LIMITS.maxImageBytes, maxImagesPerTurn: LIMITS.maxImagesPerTurn, requestTimeoutMs: LIMITS.requestTimeoutMs },
    cache: cache.stats(),
  };
}

/**
 * Run the connectivity test with the stored credential and the embedded test
 * image. Never uses the user's conversation images.
 * @param {object} input
 * @returns {Promise<{ ok: boolean, code?: string, message?: string, durationMs?: number, model?: string, endpoint?: string }>}
 */
export async function runConnectionTest({ ctx, configPath, baseConfig, fetchImpl, apiKey }) {
  const config = readConfig(baseConfig, configPath);
  const key = apiKey ?? (await resolveApiKey(ctx));
  if (key === undefined) {
    return { ok: false, code: VISION_CODES.UNCONFIGURED, message: "no API key is saved yet" };
  }
  try {
    const result = await callVision({
      endpoint: config.endpoint,
      model: config.model,
      apiKey: key.value,
      images: [{ mediaType: "image/png", base64: TEST_IMAGE_PNG_BASE64 }],
      prompt: TEST_PROMPT,
      maxTokens: 16,
      fetchImpl,
      // The same bounded retry a real turn gets. A 429 from the free tier is the
      // single most likely test outcome, and it is retryable by definition:
      // giving up after one attempt would report a working setup as broken.
      limits: { ...LIMITS, requestTimeoutMs: 20_000 },
    });
    return {
      ok: true,
      durationMs: result.durationMs,
      model: config.model,
      endpoint: endpointLabel(config.endpoint),
      reply: result.text.slice(0, 60),
    };
  } catch (error) {
    const failure = describeFailure(error);
    return {
      ok: false,
      code: failure.code,
      message: failure.message,
      ...(failure.durationMs === undefined ? {} : { durationMs: failure.durationMs }),
    };
  }
}

/**
 * Register the routes and return a disposer, or `undefined` when this
 * deployment mounts no web server (the caller reports that loudly).
 * @param {object} input
 * @returns {(() => void) | undefined} disposer.
 */
export function registerRoutes({ ctx, configPath, baseConfig, cache, logger, fetchImpl }) {
  const server = ctx.get(WEB_SERVER_SERVICE);
  if (server === undefined || typeof server.register !== "function") return undefined;

  const guard = (request, response, method) => {
    if (!sameOrigin(request)) {
      sendJson(response, 403, { error: "cross-origin request refused" });
      return false;
    }
    if (request.method !== method) {
      response.writeHead(405, { allow: method });
      response.end();
      return false;
    }
    if (method === "POST") {
      // A cross-site `no-cors` POST always carries a simple content type
      // (text/plain, urlencoded, multipart); only this page sends JSON. A
      // browser request that carries an Origin must therefore declare JSON,
      // while a header-less local caller (an agent, a tool, a test) may not.
      const contentType = request.headers["content-type"];
      const declared = typeof contentType === "string" ? contentType.toLowerCase() : undefined;
      const fromBrowser = typeof request.headers.origin === "string" && request.headers.origin !== "";
      if (declared !== undefined ? !declared.startsWith("application/json") : fromBrowser) {
        sendJson(response, 415, { error: "content-type must be application/json" });
        return false;
      }
    }
    return true;
  };

  const disposers = [
    server.register({
      kind: "exact",
      path: "/vision-better/api/state",
      handler: async (request, response) => {
        if (!guard(request, response, "GET")) return;
        try {
          sendJson(response, 200, await buildState({ ctx, configPath, baseConfig, cache }));
        } catch (error) {
          logger.warn(`vision-better: state route failed (${redact(error?.message ?? error)})`);
          sendJson(response, 500, { error: "state unavailable" });
        }
      },
    }),
    server.register({
      kind: "exact",
      path: "/vision-better/api/config",
      handler: async (request, response) => {
        if (!guard(request, response, "POST")) return;
        const body = await readJsonBody(request);
        if (body === undefined) {
          sendJson(response, 400, { error: "invalid JSON body" });
          return;
        }
        const patch = {};
        if (body.endpoint !== undefined) {
          const endpoint = normalizeEndpoint(body.endpoint);
          if (endpoint.ok !== true) {
            sendJson(response, 400, { error: endpoint.message });
            return;
          }
          patch.endpoint = endpoint.value;
        }
        if (body.model !== undefined) {
          const model = normalizeModel(body.model);
          if (model.ok !== true) {
            sendJson(response, 400, { error: model.message });
            return;
          }
          patch.model = model.value;
        }
        if (body.enabled !== undefined) {
          if (typeof body.enabled !== "boolean") {
            sendJson(response, 400, { error: "enabled must be a boolean" });
            return;
          }
          patch.enabled = body.enabled;
        }
        const written = writeConfig(patch, configPath);
        if (written.ok !== true) {
          logger.warn(`vision-better: could not save config (${redact(written.message)})`);
          sendJson(response, 500, { error: `config could not be saved: ${written.message}` });
          return;
        }
        cache.clear();
        sendJson(response, 200, await buildState({ ctx, configPath, baseConfig, cache }));
      },
    }),
    server.register({
      kind: "exact",
      path: "/vision-better/api/key",
      handler: async (request, response) => {
        if (!guard(request, response, "POST")) return;
        const body = await readJsonBody(request);
        if (body === undefined) {
          sendJson(response, 400, { error: "invalid JSON body" });
          return;
        }
        const clearing = body.clear === true;
        const value = typeof body.apiKey === "string" ? body.apiKey.trim() : undefined;
        if (!clearing && (value === undefined || value.length === 0)) {
          sendJson(response, 400, { error: "apiKey must be a non-empty string, or clear:true" });
          return;
        }
        // Reject locally what the provider would reject as an opaque 401: a key is
        // printable ASCII with no whitespace, so a pasted line break fails here.
        if (!clearing && !isUsableApiKey(value)) {
          sendJson(response, 400, { error: "apiKey contains characters that cannot be part of an API key" });
          return;
        }
        const written = await writeApiKey(ctx, clearing ? undefined : value);
        if (written.ok !== true) {
          sendJson(response, 400, { error: redact(written.message) });
          return;
        }
        cache.clear();
        sendJson(response, 200, await buildState({ ctx, configPath, baseConfig, cache }));
      },
    }),
    server.register({
      kind: "exact",
      path: "/vision-better/api/test",
      handler: async (request, response) => {
        if (!guard(request, response, "POST")) return;
        const result = await runConnectionTest({ ctx, configPath, baseConfig, fetchImpl });
        logger.info(
          `vision-better: connection test ${result.ok ? "ok" : `failed (${result.code})`}` +
            (result.durationMs === undefined ? "" : ` in ${result.durationMs}ms`),
        );
        // A failed test is a result, not a transport failure: answering 200 lets
        // the page render the code and the provider's own reason inline instead
        // of collapsing every outcome into one error banner.
        sendJson(response, 200, result);
      },
    }),
  ];
  return () => {
    for (const dispose of disposers) dispose();
  };
}
