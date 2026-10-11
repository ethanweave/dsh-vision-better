/**
 * Plugin configuration: a small JSON file owned by the plugin, plus the API key
 * held by DSH's credential store (never in this file, never returned to a client).
 *
 * Precedence: defaults < inline cordis row config < the JSON file the settings
 * page writes.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { CREDENTIAL_REF, CONFIG_FILE_NAME, DEFAULT_ENDPOINT, DEFAULT_MODEL, DEFAULT_PROVIDER, INTERNATIONAL_ENDPOINT } from "./defaults.js";
import { normalizeProvider, providerDefaults } from "./providers.js";

/** `<harness home>/vision-better.json`, matching DSH's own home convention. */
export const DEFAULT_CONFIG_PATH = join(
  process.env.DSH_HOME?.trim() !== undefined && process.env.DSH_HOME.trim() !== ""
    ? process.env.DSH_HOME.trim()
    : join(homedir(), ".dsh"),
  CONFIG_FILE_NAME,
);

/**
 * Validate and normalize an endpoint. HTTPS is required except for an explicit
 * loopback address (a local vision server), and credentials/query/fragment are
 * rejected so the API key can only ever go to a plain host the user typed.
 * @param {unknown} value candidate endpoint.
 * @returns {{ ok: true, value: string } | { ok: false, message: string }}
 */
export function normalizeEndpoint(value) {
  if (typeof value !== "string" || value.trim() === "") return { ok: false, message: "endpoint must be a non-empty URL" };
  let url;
  try {
    url = new URL(value.trim());
  } catch {
    return { ok: false, message: "endpoint is not a valid URL" };
  }
  const loopback = ["127.0.0.1", "::1", "localhost", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    return { ok: false, message: "endpoint must use https (plain http is allowed only for localhost)" };
  }
  if (url.username !== "" || url.password !== "") return { ok: false, message: "endpoint must not embed credentials" };
  if (url.search !== "" || url.hash !== "") return { ok: false, message: "endpoint must not carry a query or fragment" };
  const path = url.pathname.replace(/\/+$/, "");
  return { ok: true, value: `${url.origin}${path}` };
}

/**
 * Validate a model id: the request body carries it verbatim, so it must be a
 * plain identifier and never a path or header fragment.
 * @param {unknown} value candidate model id.
 * @returns {{ ok: true, value: string } | { ok: false, message: string }}
 */
export function normalizeModel(value) {
  if (typeof value !== "string") return { ok: false, message: "model id must be a string" };
  const trimmed = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/.test(trimmed)) {
    return { ok: false, message: "model id must be 1-64 characters of letters, digits, dot, underscore, colon or dash" };
  }
  return { ok: true, value: trimmed };
}

/** @typedef {{ provider: string, endpoint: string, model: string, enabled: boolean }} RelayConfig */

/**
 * @param {object} [row] inline config from the cordis row (`config:` in cordis.patch.yml).
 * @returns {RelayConfig} defaults overlaid with any valid inline values.
 */
export function baseConfig(row = {}) {
  const provider = row.provider === undefined ? DEFAULT_PROVIDER : normalizeProvider(row.provider);
  const endpoint = row.endpoint === undefined ? providerDefaults(provider.ok === true ? provider.value : DEFAULT_PROVIDER).endpoint : normalizeEndpoint(row.endpoint);
  const model = row.model === undefined ? providerDefaults(provider.ok === true ? provider.value : DEFAULT_PROVIDER).model : normalizeModel(row.model);
  return {
    provider: provider.ok === true ? provider.value : DEFAULT_PROVIDER,
    endpoint: endpoint.ok === true ? endpoint.value : DEFAULT_ENDPOINT,
    model: model.ok === true ? model.value : DEFAULT_MODEL,
    enabled: row.enabled !== false,
  };
}

/** Parse one JSON config document into a partial config; unknown keys are dropped. */
export function parseConfigDocument(text) {
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  /** @type {Partial<RelayConfig>} */
  const parsed = {};
  const provider = normalizeProvider(raw.provider);
  if (provider.ok === true) parsed.provider = provider.value;
  const endpoint = normalizeEndpoint(raw.endpoint);
  if (endpoint.ok === true) parsed.endpoint = endpoint.value;
  const model = normalizeModel(raw.model);
  if (model.ok === true) parsed.model = model.value;
  if (typeof raw.enabled === "boolean") parsed.enabled = raw.enabled;
  return parsed;
}

/**
 * Read the plugin config. A missing file falls back to defaults silently (first
 * run); a file that exists but is unreadable or invalid is reported through the
 * returned `diagnostic` so the settings page can tell the user "your config
 * could not be read" instead of silently showing defaults that a save would
 * then overwrite.
 * @param {RelayConfig} base inline config.
 * @param {string} filePath config file path.
 * @returns {RelayConfig & { diagnostic?: string }} effective config plus an optional problem description.
 */
export function readConfig(base, filePath = DEFAULT_CONFIG_PATH) {
  if (!existsSync(filePath)) return base;
  let text;
  try {
    text = readFileSync(filePath, "utf8");
  } catch (error) {
    return { ...base, diagnostic: `config file could not be read (${String(error?.code ?? error?.message ?? error)})` };
  }
  const parsed = parseConfigDocument(text);
  if (parsed === undefined) {
    return { ...base, diagnostic: `config file at ${filePath} is not valid JSON for this plugin; its values were ignored and defaults are shown — saving would overwrite it` };
  }
  return { ...base, ...parsed };
}

/**
 * Persist a config change atomically (temp file + rename) so a crash mid-write
 * cannot leave a truncated document behind. Secrets never pass through here.
 * @param {Partial<RelayConfig>} patch fields to store.
 * @param {string} filePath config file path.
 * @returns {{ ok: true } | { ok: false, message: string }}
 */
export function writeConfig(patch, filePath = DEFAULT_CONFIG_PATH) {
  const current = readConfig(baseConfig(), filePath);
  // Whitelist, never spread: a caller must not be able to persist an arbitrary
  // key (a secret, a token) into a plaintext file this plugin owns.
  const providerChanged = patch.provider !== undefined && patch.provider !== current.provider;
  const defaults = providerChanged ? providerDefaults(patch.provider) : undefined;
  const next = {
    provider: current.provider,
    endpoint: current.endpoint,
    model: current.model,
    enabled: current.enabled,
    ...(patch.provider === undefined ? {} : { provider: patch.provider }),
    // Switching protocol fills in that protocol's own defaults unless the patch
    // carries an explicit endpoint/model, so the user never has to know a base
    // URL by heart and old endpoint/model values never leak across protocols.
    ...(patch.endpoint === undefined && defaults !== undefined ? { endpoint: defaults.endpoint } : {}),
    ...(patch.model === undefined && defaults !== undefined ? { model: defaults.model } : {}),
    ...(patch.endpoint === undefined ? {} : { endpoint: patch.endpoint }),
    ...(patch.model === undefined ? {} : { model: patch.model }),
    ...(patch.enabled === undefined ? {} : { enabled: patch.enabled }),
  };
  try {
    mkdirSync(dirname(filePath), { recursive: true });
    const temporary = `${filePath}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(temporary, filePath);
    return { ok: true };
  } catch (error) {
    return { ok: false, message: String(error?.message ?? error) };
  }
}

/** @returns {boolean} whether the config file exists on disk. */
export function configFileExists(filePath = DEFAULT_CONFIG_PATH) {
  try {
    return statSync(filePath).isFile();
  } catch {
    return false;
  }
}

/**
 * Host-side credential access. `resolve` is the only read of the secret and is
 * host-only; the browser can never obtain it (DSH exposes describe/set/unset only).
 * @param {import('@deepseek-ai/cordis').Context} ctx plugin context.
 * @param {string} [ref] credential reference name.
 * @returns {Promise<{ value: string } | undefined>} the key, or undefined when unset.
 */
export async function resolveApiKey(ctx, ref = CREDENTIAL_REF) {
  const credentials = ctx.get("credentials");
  if (credentials === undefined || typeof credentials.resolve !== "function") return undefined;
  try {
    const resolved = await credentials.resolve(credentialRef(ref));
    return typeof resolved?.value === "string" && resolved.value.length > 0 ? { value: resolved.value } : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Presence-only credential view safe to send to a browser.
 *
 * The legacy `GLM_API_KEY` reference is flagged as `legacy: true` so the
 * settings page can explain that this is the pre-provider name and a newly
 * saved generic key replaces it.
 * @param {import('@deepseek-ai/cordis').Context} ctx plugin context.
 * @param {string} [ref] credential reference name.
 * @returns {Promise<{ configured: boolean, source?: string, writable?: boolean, legacy?: boolean }>}
 */
export async function describeApiKey(ctx, ref = CREDENTIAL_REF) {
  const credentials = ctx.get("credentials");
  if (credentials === undefined || typeof credentials.describe !== "function") {
    return { configured: false, writable: false };
  }
  try {
    const info = await credentials.describe(credentialRef(ref));
    return {
      configured: info?.configured === true,
      ...(ref === CREDENTIAL_REF && info?.configured === true ? { legacy: true } : {}),
      ...(typeof info?.source === "string" ? { source: info.source } : {}),
      ...(typeof info?.writable === "boolean" ? { writable: info.writable } : {}),
    };
  } catch {
    return { configured: false, writable: false };
  }
}

/**
 * Write or clear the API key through the host credential service.
 * @param {import('@deepseek-ai/cordis').Context} ctx plugin context.
 * @param {string | undefined} value new key, or undefined to clear.
 * @param {string} [ref] credential reference name.
 * @returns {Promise<{ ok: true } | { ok: false, message: string }>}
 */
/**
 * Write or clear the API key through the host credential service.
 *
 * A key that came from the launch environment is read-only by DSH's own rules;
 * it is checked up front so the user gets an explanation instead of a raw
 * provider refusal, and the environment value can never be shadowed by a UI save.
 * @param {import('@deepseek-ai/cordis').Context} ctx plugin context.
 * @param {string | undefined} value new key, or undefined to clear.
 * @param {string} [ref] credential reference name.
 * @returns {Promise<{ ok: true } | { ok: false, message: string }>}
 */
export async function writeApiKey(ctx, value, ref = CREDENTIAL_REF) {
  const credentials = ctx.get("credentials");
  if (credentials === undefined) return { ok: false, message: "no credential provider is mounted in this deployment" };
  try {
    if (typeof credentials.describe === "function") {
      const info = await credentials.describe(credentialRef(ref));
      if (info?.configured === true && info.writable === false) {
        return {
          ok: false,
          message:
            `the ${ref} key comes from the launch environment (source: ${info.source ?? "env"}) and is read-only; ` +
            "unset that environment variable in the launcher if you want the settings page to manage the key instead",
        };
      }
    }
    if (value === undefined) await credentials.unset(credentialRef(ref));
    else await credentials.set(credentialRef(ref), value);
    return { ok: true };
  } catch (error) {
    return { ok: false, message: String(error?.message ?? error) };
  }
}

/** Endpoint presets offered by the settings page (both verified against the official docs). */
export const ENDPOINT_PRESETS = Object.freeze([
  { id: "mainland", endpoint: DEFAULT_ENDPOINT, label: { zh: "中国大陆 (open.bigmodel.cn)", en: "Mainland China (open.bigmodel.cn)" } },
  { id: "international", endpoint: INTERNATIONAL_ENDPOINT, label: { zh: "国际 (api.z.ai)", en: "International (api.z.ai)" } },
]);

// `credentialRef` is a plain identity helper from the credentials package, which a
// plugin cannot import by bare specifier; the wire grammar is a POSIX identifier.
function credentialRef(name) {
  return typeof name === "string" && /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ? name : undefined;
}
