/**
 * Shared test harness: sentinels, fast limits, a queue-driven fake fetch, a real
 * loopback HTTP stub, an attachment-service fake, and a fake Cordis ctx.
 *
 * No test in this suite opens a socket to anything but 127.0.0.1, and no test
 * ever holds or prints a real credential. SENTINEL_KEY is a fabricated string
 * shaped like a Zhipu key precisely so redaction can be asserted on it.
 */

import http from 'node:http';

/** Fabricated credential, shaped like `<32 hex>.<32 alnum>` so redaction rules apply. */
export const SENTINEL_KEY = '0123456789abcdef0123456789abcdef.SENTINEL0123456789abcdef';

/** Fabricated second credential shape (`sk-…`). */
export const SENTINEL_SK = 'sk-SENTINEL-not-a-real-key-0123456789';

/**
 * A credential shape the plugin's redaction patterns do NOT cover (`+` and `/`
 * are outside every pattern's character class). Used to document the boundary of
 * pattern-based redaction, never to hold a real secret.
 */
export const SENTINEL_UNCOVERED = 'AIza-SENTINEL+value/with+slashes';

/** Every sentinel that must never reach a log line, a client payload, or an error. */
export const ALL_SENTINELS = [SENTINEL_KEY, SENTINEL_SK, SENTINEL_UNCOVERED];

/** Loopback-safe limits: same shape as LIMITS, but short enough to keep tests fast. */
const FAST_LIMITS = Object.freeze({
  maxImageBytes: 5 * 1024 * 1024,
  maxImagesPerTurn: 4,
  maxTokens: 64,
  requestTimeoutMs: 400,
  maxAttempts: 2,
  baseRetryDelayMs: 1,
  maxRetryAfterMs: 5,
  cacheEntries: 8,
  cacheTtlMs: 60_000,
  maxRequestBytes: 24 * 1024 * 1024,
});

/** @param {object} [overrides] */
export const fastLimits = (overrides = {}) => ({ ...FAST_LIMITS, ...overrides });

/** An OpenAI-compatible success body. */
export const completionBody = (text) =>
  JSON.stringify({ choices: [{ index: 0, message: { role: 'assistant', content: text } }] });

/**
 * Fake fetch driven by a queue. Each call records `{ url, init, body }`.
 * @param {(object | Error | ((call: number, init: object) => object | Error))[]} queue
 *   per-call response descriptors; the last entry repeats once exhausted.
 *   A descriptor is `{ status?, body?, headers? }`; an Error is thrown instead.
 */
export function queuedFetch(queue) {
  const calls = [];
  const impl = async (url, init = {}) => {
    calls.push({ url, init, body: init.body, headers: init.headers ?? {} });
    const index = Math.min(calls.length - 1, queue.length - 1);
    const entry = queue[index];
    const resolved = typeof entry === 'function' ? entry(calls.length, init) : entry;
    if (resolved instanceof Error) throw resolved;
    const { status = 200, body = completionBody('a description'), headers = { 'content-type': 'application/json' } } = resolved ?? {};
    return new Response(body, { status, headers });
  };
  impl.calls = calls;
  return impl;
}

/** A fetch that always succeeds with one description. */
export const okFetch = (text = 'A small red square.') => queuedFetch([{ status: 200, body: completionBody(text) }]);

/**
 * Real loopback HTTP server. `respond(call, response, index)` writes the reply.
 * Returns an object with the recorded calls and a `close()`.
 * @param {(call: { method: string, url: string, headers: object, body: string }, response: http.ServerResponse, index: number) => void} respond
 */
export async function startStub(respond) {
  const calls = [];
  const server = http.createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => {
      body += chunk;
    });
    request.on('end', () => {
      const call = { method: request.method, url: request.url, headers: request.headers, body };
      calls.push(call);
      respond(call, response, calls.length);
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    port,
    origin: `http://127.0.0.1:${port}`,
    endpoint: `http://127.0.0.1:${port}/api/paas/v4`,
    calls,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve(undefined));
      }),
  };
}

/** Standard JSON reply helper for a stub. */
export const stubJson = (response, status, payload) => {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(typeof payload === 'string' ? payload : JSON.stringify(payload));
};

/**
 * Attachment-service fake. `byId` maps an attachment id to `{ data, mediaType }`.
 * Records every ref it was asked for so tests can assert the only byte source.
 * @param {Map<string, { data: Buffer|Uint8Array, mediaType?: string }>} byId
 */
export function makeAttachments(byId) {
  const calls = [];
  return {
    calls,
    async readImage(ref) {
      calls.push(ref);
      const entry = byId.get(ref?.attachmentId);
      if (entry === undefined) {
        const error = new Error('unknown attachment');
        error.code = 'ENOENT';
        throw error;
      }
      return { data: entry.data, ref: { mediaType: entry.mediaType ?? ref?.mediaType } };
    },
  };
}

/** Convenience: an attachment map built from fixture names. */
export const attachmentMap = (entries) => new Map(entries);

/**
 * A cordis-faithful fake context: services through `get()`, everything else guarded.
 *
 * Two rules the real runtime enforces, which this fake now enforces too:
 *  1. A plugin may only read a context property it DECLARED. Any other property
 *     read throws `cannot get property "X" without inject` — `ctx.config` in
 *     particular. A real host died at activation on exactly that read while this
 *     fake, being a plain object, returned `{}` and looked perfectly healthy.
 *  2. Services are reached only through `ctx.get(name)`, `logger` included. The
 *     `logger` service is callable and is minted with this plugin's scope.
 * A fake more forgiving than the runtime is how three separate defects in this
 * project stayed invisible. Before adding a passthrough property, check that a
 * real cordis fiber would be allowed to read it.
 *
 * `projection` is the live model selection as DSH publishes it:
 * `sessionProjections.snapshot(session, ['modelSelection']).values.modelSelection`
 * with `.next` preferred over `.lastUsed`. Pass an Error to make it throw.
 *
 * `agents` is a decoy: `agents.selectionFor` does not exist in 0.2.0-rc.2.
 *
 * `webServer` is exposed under that EXACT spelling only, because that is what
 * `dsh-host-webserver` registers (`super(ctx, "webServer")`, lib/index.js:158).
 * The lowercase `webserver` is a package-name suffix and the event namespace
 * `webserver/index-inject` — never a service. Accepting both is what let the
 * misspelling ship.
 *
 * `logger: null` mounts NO logger service, so a test can assert the plugin still
 * activates with a no-op logger. `faults.get(name)` returns an Error to throw
 * from `ctx.get(name)`, covering the reachable failure paths the plugin must
 * survive instead of throwing.
 *
 * @param {object} [options]
 * @param {object | Error | ((session: unknown, keys: string[]) => any)} [options.projection]
 * @param {{ selectionFor: (agent: unknown) => unknown } | undefined} [options.agents]
 * @param {object | Error | ((provider: string, model: string) => any)} [options.modelInfo]
 * @param {object} [options.attachments]
 * @param {object} [options.credentials]
 * @param {object} [options.webServer]
 * @param {Function | object | null} [options.logger] logger service; `null` omits it
 * @param {{ get?: (name: string) => Error | undefined }} [options.faults]
 */
export function makeCtx({ projection, agents, modelInfo, attachments, credentials, webServer, logger, faults = {} } = {}) {
  const handlers = new Map();
  const logs = { info: [], warn: [], debug: [] };
  const calls = { resolveModelInfo: [], projections: [], injects: [], scopes: [] };
  const scopedLogger = {
    info: (message) => logs.info.push(message),
    warn: (message) => logs.warn.push(message),
    debug: (message) => logs.debug.push(message),
  };
  /** The real `logger` service is callable, minting a scoped logger per name. */
  const loggerService = (scope) => {
    calls.scopes.push(scope);
    return scopedLogger;
  };
  const services = {
    logger: logger === null ? undefined : (logger ?? loggerService),
    llm: {
      async resolveModelInfo(provider, model, signal) {
        calls.resolveModelInfo.push({ provider, model, signal });
        if (modelInfo instanceof Error) throw modelInfo;
        return typeof modelInfo === 'function' ? modelInfo(provider, model, signal) : modelInfo;
      },
    },
    attachments,
    credentials,
    agents,
    sessionProjections:
      projection === undefined
        ? undefined
        : {
            snapshot(session, keys) {
              calls.projections.push({ session, keys });
              if (projection instanceof Error) throw projection;
              return typeof projection === 'function' ? projection(session, keys) : projection;
            },
          },
    webServer,
  };
  const target = {
    get: (name) => {
      const fault = faults.get?.(name);
      if (fault !== undefined) throw fault;
      return services[name];
    },
    on: (event, handler) => {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
      return () => undefined;
    },
    inject: (names, callback) => {
      calls.injects.push(names);
      if (names.some((name) => services[name] !== undefined)) callback(ctx);
      return () => undefined;
    },
    effect: (fn) => fn(),
  };
  /** Probed by the JS runtime itself; must not be mistaken for an injected service. */
  const SILENT = new Set(['then', 'constructor', 'toJSON', 'toString', 'valueOf', 'inspect']);
  const ctx = new Proxy(target, {
    get(object, property, receiver) {
      if (typeof property === 'symbol') return Reflect.get(object, property, receiver);
      if (property in object) return object[property];
      if (SILENT.has(property)) return undefined;
      throw new Error(`cannot get property "${property}" without inject`);
    },
    set(_object, property) {
      throw new Error(`cannot set property "${String(property)}" on a plugin context`);
    },
    has: (object, property) => (typeof property === 'symbol' ? false : property in object),
  });
  return { ctx, handlers, logs, calls, services, logger: scopedLogger };
}

/** A credentials-service fake backed by a Map, recording every mutation. */
export function makeCredentials(initial = {}) {
  const store = new Map(Object.entries(initial));
  const mutations = [];
  return {
    store,
    mutations,
    async resolve(ref) {
      return store.has(ref) ? { value: store.get(ref) } : undefined;
    },
    async describe(ref) {
      return { configured: store.has(ref), source: 'file', writable: true, ref };
    },
    async set(ref, value) {
      mutations.push({ op: 'set', ref, value });
      store.set(ref, value);
    },
    async unset(ref) {
      mutations.push({ op: 'unset', ref });
      store.delete(ref);
    },
  };
}

/**
 * The pre-step message batch the host claims for one step, in host shape.
 * @param {{ images?: object[], text?: string | null, role?: string, id?: string }} [options]
 */
export function userMessage({ images = [], text = 'what is in this image?', role = 'user', id = 'msg-1' } = {}) {
  const content = images.map((attachment) => ({ type: 'image', attachment }));
  if (text !== null) content.push({ type: 'text', text });
  return { id, role, source: { kind: 'user' }, content };
}

/** The default pre-step `next()` the host's waterfall provides. */
export const hostNext = (messages) => async () => ({ kind: 'enter', messages });

/** A signal that is already aborted. */
export const abortedSignal = () => {
  const controller = new AbortController();
  controller.abort();
  return controller.signal;
};

/** Whether any sentinel appears anywhere in a value (string or JSON-able). */
export function findSentinel(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? null);
  return ALL_SENTINELS.find((sentinel) => text.includes(sentinel));
}

/** Every log line emitted by a fake ctx, joined. */
export const allLogs = (logs) => [...logs.info, ...logs.warn, ...logs.debug].join('\n');
