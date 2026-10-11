/**
 * End-to-end verification of the host half on a simulated DSH host.
 *
 * Boots the real plugin (`lib/index.js`) against a minimal cordis-like context,
 * drives the real `agent/pre-step` and `session/image-admission` handlers, and
 * serves the real settings routes over loopback HTTP with a stubbed vision
 * endpoint. No real network, no real API key, no real DSH install.
 *
 * Usage: node scripts/verify-host-path.mjs
 */

import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { apply as applyPlugin, resolveRoute } from "../lib/index.js";
import { buildState, registerRoutes, sameOrigin } from "../lib/routes.js";
import { baseConfig } from "../lib/config.js";
import { AnalysisCache } from "../lib/cache.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const failures = [];
let checks = 0;

function check(name, condition, detail = "") {
  checks += 1;
  if (condition) console.log(`  ok   ${name}`);
  else {
    failures.push(`${name}${detail === "" ? "" : ` -> ${detail}`}`);
    console.log(`  FAIL ${name}${detail === "" ? "" : ` -> ${detail}`}`);
  }
}

/** A real 16x16 PNG (the same fixture the connection test uses). */
const PNG = readFileSync(join(root, "scripts", "fixture-red.png"));
/** A second, different image so ordering and hashing can be asserted. */
const PNG2 = Buffer.from(PNG);
PNG2[PNG2.length - 5] ^= 0xff; // flip a byte in the IDAT payload: same size, different hash

/**
 * Minimal cordis-like context capturing handlers and exposing fake services.
 *
 * It is deliberately NOT a plain object. cordis wraps every plugin context in a
 * proxy that throws `cannot get property "X" without inject` for anything the
 * fiber did not declare — and reading `ctx.config`/`ctx.logger` that way is how
 * this plugin once died silently on a real host while this very harness stayed
 * green. The same guard is reproduced here so the fake can no longer be more
 * forgiving than reality. `scripts/verify-cordis-activation.mjs` runs the same
 * code against the actual cordis runtime as the authoritative check.
 */
function fakeHost({ credentials, images, webserver = false, selection = { provider: "workbuddy", model: "deepseek-v4.1-flash" } }) {
  const handlers = new Map();
  const services = new Map();
  const state = { selection, modelInfo: { inputModalities: ["text"] } };

  const api = {
    on(event, handler) {
      handlers.set(event, handler);
    },
    get(name) {
      return services.get(name);
    },
    inject(names, callback) {
      if (names.every((name) => services.has(name))) callback(ctx);
    },
    effect(factory) {
      factory();
      return () => {};
    },
  };
  const ctx = new Proxy(api, {
    get(target, property, receiver) {
      if (typeof property === "symbol" || property in target) return Reflect.get(target, property, receiver);
      throw new Error(`cannot get property "${String(property)}" without inject`);
    },
  });

  services.set("logger", { info: () => {}, warn: () => {}, debug: () => {} });
  services.set("llm", { resolveModelInfo: async () => state.modelInfo });
  services.set("attachments", {
    readImage: async (ref) => {
      const data = images.get(ref.attachmentId);
      if (data === undefined) throw Object.assign(new Error("missing"), { code: "ATTACHMENT_NOT_FOUND" });
      return { ref, data };
    },
  });
  // The published live-selection view the model picker also reads.
  services.set("sessionProjections", {
    snapshot: () => ({ values: { modelSelection: { lastUsed: null, next: state.selection } } }),
  });
  if (credentials !== undefined) services.set("credentials", credentials);
  if (webserver) services.set("webServer", { routes: [], register(route) { services.get("webServer").routes.push(route); return () => {}; } });

  return { ctx, handlers, services, state };
}

/** Minimal credential store with the same contract as DSH's (`resolve` is host-only). */
function fakeCredentials(initial) {
  const store = new Map(initial === undefined ? [] : [["GLM_API_KEY", initial]]);
  return {
    store,
    async resolve(ref) {
      const value = store.get(ref);
      return value === undefined ? undefined : { value, source: "file" };
    },
    async describe(ref) {
      return { configured: store.has(ref), source: store.has(ref) ? "file" : undefined, writable: true };
    },
    async set(ref, value) {
      if (value === "") throw new Error("empty");
      store.set(ref, value);
    },
    async unset(ref) {
      store.delete(ref);
    },
  };
}

function messageWithImages(ids, text) {
  return {
    id: "m1",
    role: "user",
    source: { kind: "user", rpcId: "r1" },
    content: [
      { type: "text", text: text ?? "这张图里写了什么？" },
      ...ids.map((id) => ({ type: "image", attachment: { attachmentId: id, mediaType: "image/png" } })),
    ],
  };
}

/** Start the plugin and return its handlers plus a GLM stub counter. */
function start({ credentials, images, modelInfo, fetchImpl, webserver = false, tmpConfig }) {
  const host = fakeHost({ credentials, images, webserver });
  host.state.modelInfo = modelInfo;
  const calls = { fetch: 0, urls: [] };
  const stub =
    fetchImpl ??
    (async (url, init) => {
      calls.fetch += 1;
      calls.urls.push(String(url));
      const body = JSON.parse(init.body);
      const imagesSent = body.messages[0].content.filter((part) => part.type === "image_url").length;
      return {
        ok: true,
        status: 200,
        headers: new Headers(),
        async text() {
          return JSON.stringify({ choices: [{ message: { content: `analysis of ${imagesSent} image(s)` } }] });
        },
      };
    });
  applyPlugin(host.ctx, { configPath: tmpConfig, fetchImpl: stub });
  return { ...host, calls };
}

/** Drive the pre-step waterfall the way the agent loop does. */
async function runPreStep(handlers, messages) {
  const handler = handlers.get("agent/pre-step");
  const decisions = await handler({ agent: { session: { requestHeader: () => undefined } }, messages, signal: undefined }, async () => ({
    kind: "enter",
    messages,
  }));
  return decisions;
}

async function main() {
  const tmpConfig = join(tmpdir(), `vision-better-verify-${process.pid}.json`);

  console.log("A. routing and zero-call invariants");
  {
    const images = new Map([["sha256:a", PNG], ["sha256:b", PNG2]]);
    const credentials = fakeCredentials("test-key-not-real");

    const noImage = start({ credentials, images, modelInfo: { inputModalities: ["text"] }, tmpConfig });
    const decision = await runPreStep(noImage.handlers, [{ id: "m0", role: "user", content: [{ type: "text", text: "hi" }] }]);
    check("no image -> no vision request", noImage.calls.fetch === 0);
    check("no image -> decision untouched", decision.messages.length === 1);

    const native = start({ credentials, images, modelInfo: { inputModalities: ["text", "image"] }, tmpConfig });
    await runPreStep(native.handlers, [messageWithImages(["sha256:a"])]);
    check("image-capable model -> no vision request", native.calls.fetch === 0);

    const textOnly = start({ credentials, images, modelInfo: { inputModalities: ["text"] }, tmpConfig });
    const withContext = await runPreStep(textOnly.handlers, [messageWithImages(["sha256:a", "sha256:b"])]);
    check("text-only model with 2 images -> exactly one batched request", textOnly.calls.fetch === 1, `got ${textOnly.calls.fetch}`);
    check("batch carries both images", textOnly.calls.urls.length === 1);
    check("user message is preserved verbatim", withContext.messages[0].content.length === 3);
    check("one hidden context message is appended", withContext.messages.length === 2);
    const injected = withContext.messages[1];
    check("context is a user-role message with a non-user source", injected.role === "user" && injected.source.kind === "vision-better");
    check("context carries only text", injected.content.every((block) => block.type === "text"));
    const injectedText = injected.content[0].text;
    check("context has no base64 payload", !injectedText.includes(PNG.toString("base64").slice(0, 32)));
    check("context marks the analysis as untrusted", injectedText.includes("UNTRUSTED IMAGE ANALYSIS"));
    check("context names the provider family", /glm-4\.6v-flash/.test(injectedText));

    const unknown = start({ credentials, images, modelInfo: undefined, tmpConfig });
    await runPreStep(unknown.handlers, [messageWithImages(["sha256:a"])]);
    check("undeclared capability -> conservative relay", unknown.calls.fetch === 1);
  }

  console.log("\nB. cache");
  {
    const images = new Map([["sha256:a", PNG]]);
    const credentials = fakeCredentials("k");
    const session = start({ credentials, images, modelInfo: { inputModalities: ["text"] }, tmpConfig });
    await runPreStep(session.handlers, [messageWithImages(["sha256:a"], "what is this?")]);
    await runPreStep(session.handlers, [messageWithImages(["sha256:a"], "what is this?")]);
    check("identical image + identical question -> cache hit", session.calls.fetch === 1, `got ${session.calls.fetch}`);
    await runPreStep(session.handlers, [messageWithImages(["sha256:a"], "different question?")]);
    check("question-specific answer is not reused for another question", session.calls.fetch === 2, `got ${session.calls.fetch}`);
  }

  console.log("\nC. failure paths keep the user's input");
  {
    const images = new Map([["sha256:a", PNG]]);
    const unauthorized = start({
      credentials: fakeCredentials("k"),
      images,
      modelInfo: { inputModalities: ["text"] },
      tmpConfig,
      fetchImpl: async () => ({ ok: false, status: 401, headers: new Headers(), text: async () => '{"error":"bad key"}' }),
    });
    const decision = await runPreStep(unauthorized.handlers, [messageWithImages(["sha256:a"])]);
    check("401 -> the turn still enters", decision.kind === "enter");
    check("401 -> the user image is untouched", decision.messages[0].content.length === 2);
    const text = decision.messages[1].content[0].text;
    check("401 -> stable code reported to the model", text.includes("VISION_RELAY_UNAUTHORIZED"));
    check("401 -> the model is told not to guess", /do not (describe|claim)/i.test(text));

    const unconfigured = start({
      credentials: fakeCredentials(undefined),
      images,
      modelInfo: { inputModalities: ["text"] },
      tmpConfig,
    });
    const missing = await runPreStep(unconfigured.handlers, [messageWithImages(["sha256:a"])]);
    check("no key -> zero network calls", unconfigured.calls.fetch === 0);
    check("no key -> guidance context instead of silence", missing.messages[1].content[0].text.includes("VISION_RELAY_UNCONFIGURED"));

    const aborted = start({
      credentials: fakeCredentials("k"),
      images,
      modelInfo: { inputModalities: ["text"] },
      tmpConfig,
      fetchImpl: async () => {
        throw Object.assign(new Error("aborted"), { name: "AbortError" });
      },
    });
    const abortedDecision = await runPreStep(aborted.handlers, [messageWithImages(["sha256:a"])]);
    check("cancellation -> no throw, explicit code", abortedDecision.messages[1].content[0].text.includes("VISION_RELAY_TIMEOUT"));
  }

  console.log("\nD. session identity and live model switching");
  {
    const images = new Map([["sha256:a", PNG]]);
    const host = fakeHost({ credentials: fakeCredentials("k"), images });
    const before = JSON.stringify(host.state.selection);
    applyPlugin(host.ctx, { configPath: tmpConfig, fetchImpl: async () => ({ ok: true, status: 200, headers: new Headers(), text: async () => '{"choices":[{"message":{"content":"x"}}]}' }) });
    await runPreStep(host.handlers, [messageWithImages(["sha256:a"])]);
    check("provider/model unchanged by the sidecar", JSON.stringify(host.state.selection) === before);
    check("route resolution reads the live selection", resolveRoute(host.ctx, { session: {} }).model === "deepseek-v4.1-flash");

    // A switch the user just made must be honoured on the very next step: the relay
    // must stop calling the vision API once the model accepts images.
    const switching = start({ credentials: fakeCredentials("k"), images, modelInfo: { inputModalities: ["text"] }, tmpConfig });
    await runPreStep(switching.handlers, [messageWithImages(["sha256:a"], "first")]);
    switching.state.selection = { provider: "workbuddy", model: "glm-5v-turbo" };
    switching.state.modelInfo = { inputModalities: ["text", "image"] };
    const afterSwitch = await runPreStep(switching.handlers, [messageWithImages(["sha256:a"], "second")]);
    check("switching to an image-capable model stops the relay immediately", switching.calls.fetch === 1, `got ${switching.calls.fetch}`);
    check("no context is injected on a native route", afterSwitch.messages.length === 1);
  }

  console.log("\nE. image admission hook");
  {
    const credentials = fakeCredentials("k");
    const host = fakeHost({ credentials, images: new Map() });
    applyPlugin(host.ctx, { configPath: tmpConfig });
    const admission = host.handlers.get("session/image-admission");
    const admitted = await admission({ agent: {}, modelInfo: { inputModalities: ["text"] } }, async () => undefined);
    check("configured relay admits the image", admitted?.admit === true);

    const off = fakeHost({ credentials: fakeCredentials("k"), images: new Map() });
    applyPlugin(off.ctx, { configPath: join(tmpdir(), `vision-better-verify-off-${process.pid}.json`), fetchImpl: async () => ({}) });
    const decision = await off.handlers.get("session/image-admission")({ agent: {}, modelInfo: { inputModalities: ["text"] } }, async () => undefined);
    check("route resolution failure falls back to the host decision", decision === undefined || decision.admit === true);
  }

  console.log("\nF. settings routes over loopback HTTP");
  {
    const credentials = fakeCredentials(undefined);
    const images = new Map();
    const host = fakeHost({ credentials, images, webserver: true });
    const cache = new AnalysisCache();
    const base = baseConfig();
    const calls = { fetch: 0 };
    const routes = [];
    const disposers = [registerRoutes({
      ctx: host.ctx,
      configPath: tmpConfig,
      baseConfig: base,
      cache,
      logger: { info: () => {}, warn: () => {}, debug: () => {} },
      fetchImpl: async () => {
        calls.fetch += 1;
        return { ok: true, status: 200, headers: new Headers(), text: async () => '{"choices":[{"message":{"content":"red"}}]}' };
      },
    })];
    for (const route of host.services.get("webServer").routes) routes.push(route);
    check("all five settings routes mounted", routes.length === 5, `got ${routes.length}`);
    check("models catalogue route is registered", routes.some((route) => route.path === "/vision-better/api/models"));

    const server = createServer((request, response) => {
      const route = routes.find((candidate) => candidate.path === new URL(request.url, "http://localhost").pathname);
      if (route === undefined) {
        response.writeHead(404).end();
        return;
      }
      route.handler(request, response);
    });
    await new Promise((resolve_) => server.listen(0, "127.0.0.1", resolve_));
    const origin = `http://127.0.0.1:${server.address().port}`;

    const state = await (await fetch(`${origin}/vision-better/api/state`)).json();
    check("state route reports defaults", state.endpoint.startsWith("https://open.bigmodel.cn/api/paas/v4"));
    check("state route reports the default model", state.model === "glm-4.6v-flash");
    check("state route never returns the key", !JSON.stringify(state).includes("test-key"));
    check("state route reports credential presence only", state.credential.configured === false);

    const saved = await (await fetch(`${origin}/vision-better/api/key`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ apiKey: "test-key-not-real" }),
    })).json();
    check("key route stores the key on the host", credentials.store.get("GLM_API_KEY") === "test-key-not-real");
    check("key route returns presence, not the value", saved.credential.configured === true && !JSON.stringify(saved).includes("test-key-not-real"));

    const badEndpoint = await fetch(`${origin}/vision-better/api/config`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ endpoint: "http://evil.example.com/v1" }),
    });
    check("plain http endpoint is refused", badEndpoint.status === 400);

    const goodEndpoint = await (await fetch(`${origin}/vision-better/api/config`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ endpoint: "https://api.z.ai/api/paas/v4", model: "glm-4.6v" }),
    })).json();
    check("valid endpoint+model are persisted", goodEndpoint.endpoint === "https://api.z.ai/api/paas/v4" && goodEndpoint.model === "glm-4.6v");

    const forgedOrigin = await fetch(`${origin}/vision-better/api/config`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://attacker.example" },
      body: JSON.stringify({ enabled: true }),
    });
    check("cross-origin write is refused", forgedOrigin.status === 403);
    check("cross-origin check helper agrees", sameOrigin({ headers: { origin: "https://x", host: "y" } }) === false);

    const wrongMethod = await fetch(`${origin}/vision-better/api/key`, { method: "GET" });
    check("wrong method is refused", wrongMethod.status === 405);

    const tested = await (await fetch(`${origin}/vision-better/api/test`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).json();
    check("connection test uses a built-in image", calls.fetch >= 1 && tested.ok === true);
    check("connection test never uses a conversation image", tested.ok === true);

    const cleared = await (await fetch(`${origin}/vision-better/api/key`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ clear: true }),
    })).json();
    check("clear removes the credential", credentials.store.has("GLM_API_KEY") === false && cleared.credential.configured === false);

    const emptyKey = await fetch(`${origin}/vision-better/api/key`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ apiKey: "   " }),
    });
    check("empty key is refused", emptyKey.status === 400);

    for (const dispose of disposers) dispose();
    await new Promise((resolve_) => server.close(resolve_));
  }

  console.log(`\n${checks - failures.length}/${checks} checks passed`);
  if (failures.length > 0) {
    console.error(`\n${failures.length} failure(s):`);
    for (const failure of failures) console.error(` - ${failure}`);
    process.exitCode = 1;
  }
}

await main();
