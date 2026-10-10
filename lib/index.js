/**
 * dsh-vision-better — host half.
 *
 * Gives a text-only main model automatic image understanding without changing
 * the session's model, its visible messages, or its history:
 *
 *  1. `agent/pre-step` sees the user's claimed messages for this step.
 *  2. If they carry images and the route does not accept images natively, the
 *     plugin asks the configured GLM vision endpoint for ONE batched analysis.
 *  3. The analysis is appended as a hidden context message (`source.kind:
 *     "vision-better"`), which the client renders as a context node — never as a
 *     user bubble, a message rewrite, or an assistant reply.
 *
 * No image, no call: a turn without images performs zero vision requests, and a
 * route that declares native image support is never touched.
 *
 * The plugin also answers the `session/image-admission` waterfall. That hook
 * does not exist in stock 0.2.0-rc.2 — it is the minimal core extension shipped
 * in `patches/` — so on an unpatched host this half is simply never asked, and
 * a text-only model keeps DSH's original "does not support image input" answer.
 */

import { CREDENTIAL_REF, LIMITS, WEB_SERVER_SERVICE } from "./defaults.js";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Record how activation went, next to the plugin's own config file.
 *
 * This exists because the plugin has already failed silently twice on a real
 * host: activation died on an undeclared context read and nothing was written
 * anywhere the operator could see. One small JSON file turns "it still does not
 * work" into a factual answer (was the plugin activated, did the web server
 * service arrive, how many routes mounted).
 * @param {string} configPath the plugin's config file path.
 * @param {object} status JSON-serializable status.
 */
function writeStatus(configPath, status) {
  try {
    const target = join(dirname(configPath), "vision-better-status.json");
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, `${JSON.stringify(status, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  } catch {
    // Diagnostics must never be able to break activation.
  }
}
import { baseConfig, DEFAULT_CONFIG_PATH, readConfig, resolveApiKey } from "./config.js";
import { AnalysisCache } from "./cache.js";
import { buildAnalysisContextText, buildContextMessage, buildFailureContextText, analyzeTurn } from "./relay.js";
import { collectImageBlocks } from "./images.js";
import { registerRoutes } from "./routes.js";
import { routeFor, routeReason } from "./routing.js";
import { endpointLabel, redact } from "./safe.js";

export const name = "vision-better";

/** Services that must exist before the relay can do anything at all. */
export const inject = ["llm", "attachments"];

/**
 * Resolve the provider/model the next request will actually use.
 *
 * `sessionProjections.snapshot(...).values.modelSelection.next` is the published
 * view of the live selection (the same value the model picker renders), and it
 * already accounts for a switch the user just made — which the logged request
 * header does not until the next request is built. The logged header, then the
 * agent's creation options, are the fallbacks for a deployment that registers no
 * such projection.
 *
 * @param {object} ctx plugin context.
 * @param {object} agent live agent.
 * @returns {{ provider: string, model: string } | undefined} the live route.
 */
export function resolveRoute(ctx, agent) {
  const session = agent?.session;
  if (session !== undefined) {
    try {
      const view = ctx.get("sessionProjections")?.snapshot?.(session, ["modelSelection"])?.values?.modelSelection;
      const live = view?.next ?? view?.lastUsed;
      if (isRoute(live)) return { provider: live.provider, model: live.model };
    } catch {
      // Projection absent or not materializable: fall through to the log.
    }
    try {
      const config = session.requestHeader?.()?.config;
      if (isRoute(config)) return { provider: config.provider, model: config.model };
    } catch {
      // A malformed header must not break the turn.
    }
  }
  const options = agent?.options;
  if (isRoute(options)) return { provider: options.provider, model: options.model };
  return undefined;
}

function isRoute(value) {
  return typeof value?.provider === "string" && value.provider !== "" && typeof value?.model === "string" && value.model !== "";
}

/**
 * Build the hidden context message for one step, or undefined when the relay
 * must not act at all (no images, native route, disabled, or already handled).
 */
export async function contextForStep({ ctx, agent, messages, signal, configPath, baseConfig: base, cache, logger, fetchImpl }) {
  // Cheapest possible gate, before any service lookup: a turn without an image
  // costs this plugin nothing at all.
  if (collectImageBlocks(messages).length === 0) return undefined;

  const effective = readConfig(base, configPath);
  if (effective.enabled !== true) return undefined;
  const route = resolveRoute(ctx, agent);
  if (route === undefined) {
    logger.debug?.("vision-better: no resolvable provider/model for this step; skipping");
    return undefined;
  }
  let modelInfo;
  try {
    modelInfo = await ctx.get("llm")?.resolveModelInfo?.(route.provider, route.model, signal);
  } catch (error) {
    // Unknown capability: never assume the model can see images. The relay runs.
    logger.debug?.(`vision-better: capability lookup failed for ${route.provider}/${route.model} (${redact(error?.code ?? error)})`);
    modelInfo = undefined;
  }
  if (routeFor(modelInfo) === "native") {
    logger.debug?.(`vision-better: ${route.provider}/${route.model} declares image input; relay stays silent`);
    return undefined;
  }

  const apiKey = await resolveApiKey(ctx);
  if (apiKey === undefined) {
    return buildContextMessage(
      buildFailureContextText({
        code: "VISION_RELAY_UNCONFIGURED",
        message: `no ${CREDENTIAL_REF} credential is saved, so the images in this message were not analyzed`,
      }),
    );
  }

  const startedAt = Date.now();
  const result = await analyzeTurn({
    attachments: ctx.get("attachments"),
    config: effective,
    apiKey,
    messages,
    signal,
    cache,
    limits: LIMITS,
    fetchImpl,
  });
  if (result.kind === "none") return undefined;

  if (result.kind === "failed") {
    logger.warn(
      `vision-better: analysis failed for ${route.provider}/${route.model}: ${result.failure.code} ` +
        `(${redact(result.failure.message)}) after ${Date.now() - startedAt}ms; the turn continues with an explicit failure notice`,
    );
    return buildContextMessage(buildFailureContextText(result.failure));
  }

  logger.info(
    `vision-better: ${result.cached ? "reused" : "produced"} analysis for ${result.imageCount} image(s) with ` +
      `${effective.model} at ${endpointLabel(effective.endpoint)} (${result.calls} request(s), ${Date.now() - startedAt}ms, ` +
      `route ${routeReason(modelInfo)})`,
  );
  return buildContextMessage(
    buildAnalysisContextText({
      text: result.text,
      imageCount: result.imageCount,
      cached: result.cached,
      failures: result.failures ?? [],
      overflow: result.overflow ?? 0,
      model: effective.model,
      endpoint: effective.endpoint,
      limits: LIMITS,
    }),
  );
}

/**
 * Build this plugin's logger.
 *
 * Read through `ctx.get`, never `ctx.logger`: a cordis plugin fiber may not read
 * a context property it did not declare, and `ctx.logger` throws
 * `cannot get property "logger" without inject`. `ctx.get` is the documented
 * accessor that bypasses that guard. The service is callable, so it is minted
 * once with this plugin's name as the scope.
 * @param {object} ctx plugin context.
 * @returns {{ info: Function, warn: Function, debug: Function }} a no-op logger when the service is absent.
 */
function createLogger(ctx) {
  const service = ctx.get("logger");
  const scoped = typeof service === "function" ? service("vision-better") : service;
  return {
    info: (message) => scoped?.info?.(message),
    warn: (message) => scoped?.warn?.(message),
    debug: (message) => scoped?.debug?.(message),
  };
}

/**
 * Cordis plugin entry.
 * @param {import('@deepseek-ai/cordis').Context} ctx plugin context.
 * @param {{ endpoint?: string, model?: string, enabled?: boolean, configPath?: string, fetchImpl?: typeof fetch }} [config]
 *   the row's `config:` block, handed to `apply` as the second argument. Never read
 *   back from `ctx.config`: an undeclared property read throws in cordis, which is
 *   how this plugin once failed to activate at all on a real host.
 */
export function apply(ctx, config = {}) {
  const options = config ?? {};
  const configPath = typeof options.configPath === "string" && options.configPath.trim() !== "" ? options.configPath.trim() : DEFAULT_CONFIG_PATH;
  const fetchImpl = options.fetchImpl;
  const base = baseConfig(options);
  const cache = new AnalysisCache({ maxEntries: LIMITS.cacheEntries, ttlMs: LIMITS.cacheTtlMs });
  const logger = createLogger(ctx);

  // --- hidden vision context for the current turn -------------------------
  ctx.on("agent/pre-step", async ({ agent, messages, signal }, next) => {
    const decision = await next();
    if (decision?.kind !== "enter") return decision;
    try {
      const extra = await contextForStep({
        ctx,
        agent,
        messages,
        signal,
        configPath,
        baseConfig: base,
        cache,
        logger,
        fetchImpl,
      });
      if (extra === undefined) return decision;
      return { ...decision, messages: [...decision.messages, extra] };
    } catch (error) {
      // Nothing this plugin does may break a turn: fall back to the default decision.
      logger.warn(`vision-better: step handling failed (${redact(error?.message ?? error)}); continuing without vision context`);
      return decision;
    }
  });

  // --- image admission (requires the core extension in patches/) ----------
  // The host asks only inside the branch that would otherwise reject a text-only
  // model, so the decision here is just "can this deployment handle the image":
  // enabled and configured. Nothing about the model is re-derived or faked.
  ctx.on("session/image-admission", async (_payload, next) => {
    const upstream = await next();
    if (upstream !== undefined) return upstream;
    try {
      const effective = readConfig(base, configPath);
      if (effective.enabled !== true) return undefined; // disabled: stock DSH behaviour
      if ((await resolveApiKey(ctx)) === undefined) {
        return {
          admit: false,
          code: "VISION_RELAY_UNCONFIGURED",
          message:
            "This model cannot accept images and the vision relay has no API key yet. " +
            "Open Settings → 图像识别 to add one; your message and image are still here.",
        };
      }
      return { admit: true };
    } catch (error) {
      logger.warn(`vision-better: image admission failed (${redact(error?.message ?? error)}); falling back to the host decision`);
      return undefined;
    }
  });

  // --- settings page transport -------------------------------------------
  // The web server may be mounted after this plugin on some compositions, so
  // wait for the service instead of reading it once at apply time.
  const mountRoutes = (scope) => {
    scope.effect(() => {
      const dispose = registerRoutes({
        ctx: scope,
        configPath,
        baseConfig: base,
        cache,
        logger,
        fetchImpl,
      });
      const routes = dispose === undefined ? 0 : 4;
      writeStatus(configPath, {
        plugin: "dsh-vision-better",
        activated: true,
        webServer: dispose === undefined ? "missing" : "mounted",
        routes,
        configPath,
        at: new Date().toISOString(),
      });
      if (dispose === undefined) {
        // Loud on purpose: a settings page without its API reads to the user as
        // a broken save, which is far worse than a missing feature.
        logger.warn(`vision-better: no "${WEB_SERVER_SERVICE}" service in this deployment; the settings page cannot be served`);
        return () => undefined;
      }
      logger.info(`vision-better: settings API mounted on /vision-better/api/* (config: ${configPath})`);
      return dispose;
    }, "vision-better: settings routes");
  };
  if (typeof ctx.inject === "function") ctx.inject([WEB_SERVER_SERVICE], mountRoutes);
  else mountRoutes(ctx);
}

export default apply;
