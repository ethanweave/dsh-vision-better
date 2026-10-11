/**
 * M10 / M11 / M14 — the pre-step hook contract and non-interference.
 *
 * The load-bearing invariant: the plugin may APPEND one hidden context message,
 * and must leave the host's decision, the user's claimed messages, the provider,
 * the model and the session identity exactly as they were.
 *
 * Route resolution contract (0.2.0-rc.2): the live selection comes from DSH's
 * published projection view, then the logged request header, then the agent's
 * creation options. `agents.selectionFor` does NOT exist in this DSH build, so
 * every harness below injects it as a throwing decoy — if the plugin ever
 * consults it again, these tests fail loudly instead of passing by accident.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { apply, contextForStep, resolveRoute } from '../lib/index.js';
import { AnalysisCache } from '../lib/cache.js';
import { registerRoutes } from '../lib/routes.js';
import { imageBytes, imageRef } from './fixtures/images.mjs';
import { attachmentMap, makeAttachments, makeCredentials, makeCtx, okFetch, userMessage } from './fixtures/harness.mjs';

const TEXT_ONLY = { inputModalities: ['text'] };
const NATIVE = { inputModalities: ['text', 'image'] };

/** A live agent whose session makes the projection path reachable. */
const AGENT = { session: { id: 'session-1', requestHeader: () => undefined } };

/** The decoy that must never be consulted. */
const agentsDecoy = () => ({
  selectionFor() {
    throw new Error('agents.selectionFor must not be consulted: it does not exist in 0.2.0-rc.2');
  },
});

/** The live selection as DSH publishes it for the test session. */
const liveProjection = (provider = 'deepseek', model = 'deepseek-chat') => ({
  values: { modelSelection: { next: { provider, model } } },
});

/** Wire up apply() against a fake ctx and return everything a test needs. */
function mount({ modelInfo = TEXT_ONLY, key = 'sentinel-not-a-real-key', images = ['png'], config = {}, fetchImpl, projection } = {}) {
  const attachments = makeAttachments(
    attachmentMap(images.map((name, index) => [`id-${index}`, { data: imageBytes(name) }])),
  );
  const credentials = key === null ? makeCredentials({}) : makeCredentials({ GLM_API_KEY: key });
  const harness = makeCtx({ agents: agentsDecoy(), projection: projection ?? liveProjection(), modelInfo, attachments, credentials });
  const transport = fetchImpl ?? okFetch('a red square');
  // The row config is the SECOND ARGUMENT, exactly as cordis passes it. The fake
  // ctx deliberately has no `config` property: reading one throws in a real
  // fiber, which is how the plugin once failed to activate at all.
  apply(harness.ctx, { configPath: 'C:\\nonexistent\\vision-better.json', fetchImpl: transport, ...config });
  return { ...harness, attachments, credentials, transport };
}

/**
 * Records the decision `next()` produced, so identity of the returned object can
 * be asserted against what the host actually handed the waterfall.
 */
function nextRecorder(messages) {
  const state = {};
  return { state, next: async () => (state.decision = { kind: 'enter', messages }) };
}

const preStep = (handlers, payload, next) => handlers.get('agent/pre-step')[0](payload, next);
const admission = (handlers, payload, next) => handlers.get('session/image-admission')[0](payload, next);
const enterNext = (messages) => async () => ({ kind: 'enter', messages });

test('M14 apply() registers the pre-step and image-admission hooks', () => {
  const { handlers } = mount();
  assert.ok(handlers.has('agent/pre-step'), 'agent/pre-step must be registered');
  assert.ok(handlers.has('session/image-admission'), 'session/image-admission must be registered');
});

test('M1/M2 a native-image model gets the decision back, byte for byte, with ZERO requests', async () => {
  const { handlers, transport, logs } = mount({ modelInfo: NATIVE });
  const messages = [userMessage({ images: [imageRef('png', 'id-0')] })];
  const { state, next } = nextRecorder(messages);
  const result = await preStep(handlers, { agent: AGENT, messages, signal: undefined }, next);
  assert.equal(result, state.decision, 'the host decision object is returned untouched');
  assert.equal(transport.calls.length, 0, 'ZERO vision requests for a native route');
  assert.deepEqual(messages, [userMessage({ images: [imageRef('png', 'id-0')] })], 'messages untouched');
  assert.ok(logs.debug.some((line) => /declares image input/.test(line)));
});

test('M2 a turn without images gets the decision back with ZERO requests and zero service lookups', async () => {
  const { handlers, transport, calls } = mount();
  const messages = [userMessage({ images: [], text: 'no image here' })];
  const { state, next } = nextRecorder(messages);
  const result = await preStep(handlers, { agent: AGENT, messages, signal: undefined }, next);
  assert.equal(result, state.decision);
  assert.equal(transport.calls.length, 0);
  assert.equal(calls.projections.length, 0, 'the no-image gate runs before ANY service lookup');
  assert.equal(calls.resolveModelInfo.length, 0);
});

test('M10 the relay path APPENDS exactly one hidden message and rewrites nothing', async () => {
  const { handlers, transport } = mount();
  const messages = [userMessage({ images: [imageRef('png', 'id-0')], text: 'what colour is it?' })];
  const decision = { kind: 'enter', messages };
  const before = JSON.stringify(decision);

  const result = await preStep(handlers, { agent: AGENT, messages, signal: undefined }, enterNext(messages));

  assert.notEqual(result, decision, 'a new decision object is returned');
  assert.notEqual(result.messages, decision.messages, 'a new messages array is returned');
  assert.equal(result.messages.length, messages.length + 1, 'exactly one message appended');
  assert.equal(result.messages[0], messages[0], 'the original message object is reused, not copied or mutated');
  assert.equal(JSON.stringify(decision), before, 'the host decision is not mutated in place');
  assert.equal(transport.calls.length, 1, 'ONE batched vision request');

  const injected = result.messages[result.messages.length - 1];
  assert.equal(injected.role, 'user');
  assert.equal(injected.source.kind, 'vision-better');
  assert.equal(injected.content.length, 1);
  assert.equal(injected.content[0].type, 'text');
  assert.match(injected.content[0].text, /BEGIN UNTRUSTED IMAGE ANALYSIS/);
  assert.match(injected.content[0].text, /a red square/);

  const extraKeys = Object.keys(result).filter((key) => !Object.keys(decision).includes(key));
  assert.deepEqual(extraKeys, [], 'no new top-level keys on the decision');
  const { messages: _dropped, ...rest } = result;
  const { messages: _decisionMessages, ...decisionRest } = decision;
  assert.deepEqual(rest, decisionRest, 'every other decision field is identical');
});

test('M10 the route the session is running is never changed by the relay', async () => {
  const { handlers, calls, transport } = mount();
  const messages = [userMessage({ images: [imageRef('png', 'id-0')] })];
  await preStep(handlers, { agent: AGENT, messages, signal: undefined }, enterNext(messages));
  assert.equal(calls.resolveModelInfo.length, 1);
  assert.deepEqual(calls.resolveModelInfo[0].provider, 'deepseek', 'the main provider is only ever read');
  assert.deepEqual(calls.resolveModelInfo[0].model, 'deepseek-chat', 'the main model is only ever read');
  assert.deepEqual(Object.keys(calls.resolveModelInfo[0]).sort(), ['model', 'provider', 'signal']);
  assert.equal(calls.projections.length, 1, 'the live projection is the route source');
  assert.equal(transport.calls.length, 1);
  assert.match(transport.calls[0].url, /chat\/completions$/, 'the request goes to the configured vision endpoint, not the main provider');
});

test('M2 an unconfigured key produces a failure context and ZERO requests', async () => {
  const { handlers, transport } = mount({ key: null });
  const messages = [userMessage({ images: [imageRef('png', 'id-0')] })];
  const result = await preStep(handlers, { agent: AGENT, messages, signal: undefined }, enterNext(messages));
  assert.equal(result.messages.length, 2);
  const text = result.messages[1].content[0].text;
  assert.match(text, /VISION_RELAY_UNCONFIGURED/);
  assert.equal(result.messages[1].source.kind, 'vision-better');
  assert.equal(transport.calls.length, 0, 'ZERO network calls before the key is configured');
});

test('M2 a disabled plugin never touches the turn', async () => {
  const { handlers, transport, logs } = mount({ config: { enabled: false } });
  const messages = [userMessage({ images: [imageRef('png', 'id-0')] })];
  const { state, next } = nextRecorder(messages);
  const result = await preStep(handlers, { agent: AGENT, messages, signal: undefined }, next);
  assert.equal(result, state.decision);
  assert.equal(transport.calls.length, 0);
  assert.deepEqual(logs.info.filter((line) => /analysis/.test(line)), []);
});

test('M10 a rejected decision is passed straight through', async () => {
  const { handlers, transport } = mount();
  const messages = [userMessage({ images: [imageRef('png', 'id-0')] })];
  const decision = { kind: 'reject', messages: [] };
  const result = await preStep(handlers, { agent: AGENT, messages, signal: undefined }, async () => decision);
  assert.equal(result, decision);
  assert.equal(transport.calls.length, 0);
});

test('M10 a decision with no messages array degrades safely instead of throwing', async () => {
  const { handlers, logs } = mount();
  const messages = [userMessage({ images: [imageRef('png', 'id-0')] })];
  const decision = { kind: 'enter' };
  const result = await preStep(handlers, { agent: AGENT, messages, signal: undefined }, async () => decision);
  assert.equal(result, decision, 'fail-safe: the default decision is returned');
  assert.ok(logs.warn.some((line) => /step handling failed/.test(line)), 'the failure is reported');
});

test('M9 the pre-step NEVER throws when the service layer does', async () => {
  const messages = [userMessage({ images: [imageRef('png', 'id-0')] })];
  const decision = { kind: 'enter', messages };
  // A resolvable route, so the turn gets far enough to reach the credential
  // lookup — whose ctx.get is NOT wrapped in a try, making it the reachable path
  // to the pre-step catch-all. Built from the shared fake so the cordis
  // property guard applies here too.
  const { ctx, handlers, logs } = makeCtx({
    projection: liveProjection('p', 'm'),
    modelInfo: TEXT_ONLY,
    agents: agentsDecoy(),
    attachments: makeAttachments(attachmentMap([['id-0', { data: imageBytes('png') }]])),
    faults: { get: (name) => (name === 'credentials' ? new Error('credentials service exploded') : undefined) },
  });
  apply(ctx, { configPath: 'C:\\nonexistent\\vision-better.json', fetchImpl: okFetch() });
  const result = await preStep(handlers, { agent: AGENT, messages, signal: undefined }, async () => decision);
  assert.equal(result, decision, 'the turn proceeds with the host decision');
  assert.ok(logs.warn.some((line) => /step handling failed/.test(line)), 'and the failure is reported, not swallowed silently');
});

test('M1 an unreadable capability declaration routes to the relay (unknown is never native)', async () => {
  const { handlers, transport } = mount({ modelInfo: new Error('capability lookup failed') });
  const messages = [userMessage({ images: [imageRef('png', 'id-0')] })];
  const result = await preStep(handlers, { agent: AGENT, messages, signal: undefined }, enterNext(messages));
  assert.equal(result.messages.length, 2);
  assert.equal(transport.calls.length, 1);
});

test('M11 tool calls and their results survive a relayed turn unchanged', async () => {
  const { handlers, transport } = mount();
  const toolResult = {
    id: 'msg-tool',
    role: 'tool',
    content: [{ type: 'tool-result', toolName: 'screenshot', toolCallId: 'call-1', content: [{ type: 'image', attachment: imageRef('png', 'id-0') }] }],
  };
  const messages = [userMessage({ images: [], text: 'look at the screenshot' }), toolResult];
  const decision = { kind: 'enter', messages };
  const before = JSON.stringify(decision);
  const result = await preStep(handlers, { agent: AGENT, messages, signal: undefined }, enterNext(messages));
  assert.equal(result.messages.length, 3, 'the tool result is preserved and one context message appended');
  assert.equal(result.messages[1], toolResult);
  assert.equal(result.messages[1].content[0].toolCallId, 'call-1');
  assert.equal(JSON.stringify(decision), before);
  assert.equal(result.messages[2].source.kind, 'vision-better');
  assert.equal(transport.calls.length, 1, 'the nested tool-result image is analyzed');
});

test('M14 resolveRoute reads the live projection, then the request header, then options', () => {
  const session = { id: 'session-1' };

  // 1. the published projection view wins — the value the model picker renders,
  // so a switch the user just made is already visible.
  const projected = makeCtx({ projection: liveProjection('p1', 'm1'), agents: agentsDecoy() });
  assert.deepEqual(resolveRoute(projected.ctx, { session }), { provider: 'p1', model: 'm1' });
  assert.equal(projected.calls.projections.length, 1, 'the projection was consulted');
  assert.deepEqual(projected.calls.projections[0].keys, ['modelSelection']);
  assert.equal(projected.calls.resolveModelInfo.length, 0);

  // `.lastUsed` is the fallback when nothing is queued as `.next`.
  const lastUsed = makeCtx({ projection: { values: { modelSelection: { lastUsed: { provider: 'p1b', model: 'm1b' } } } } });
  assert.deepEqual(resolveRoute(lastUsed.ctx, { session }), { provider: 'p1b', model: 'm1b' });

  // 2. the logged request header, when the projection is absent or throws.
  const headerOnly = makeCtx({ projection: new Error('projection not materializable') });
  assert.deepEqual(
    resolveRoute(headerOnly.ctx, { session: { requestHeader: () => ({ config: { provider: 'p2', model: 'm2' } }) } }),
    { provider: 'p2', model: 'm2' },
  );

  // 3. the agent's creation options.
  const optionsOnly = makeCtx({});
  assert.deepEqual(resolveRoute(optionsOnly.ctx, { options: { provider: 'p3', model: 'm3' } }), { provider: 'p3', model: 'm3' });

  // A malformed value at each level falls through instead of throwing.
  const malformed = makeCtx({ projection: { values: { modelSelection: { next: { provider: '', model: 'm' } } } } });
  assert.deepEqual(
    resolveRoute(malformed.ctx, { session: { requestHeader: () => ({ config: { provider: 42 } }) }, options: { provider: 'p4', model: 'm4' } }),
    { provider: 'p4', model: 'm4' },
  );

  // A malformed projection value must not shadow a good header.
  const partialProjection = makeCtx({ projection: { values: { modelSelection: { next: { provider: 'p5' } } } } });
  assert.deepEqual(
    resolveRoute(partialProjection.ctx, { session: { requestHeader: () => ({ config: { provider: 'p5', model: 'm5' } }) } }),
    { provider: 'p5', model: 'm5' },
  );

  // Nothing anywhere.
  assert.equal(resolveRoute(makeCtx({}).ctx, {}), undefined);
});

test('M14 a user switching to an image-capable model stops the relay on the next step', async () => {
  // The projection is read fresh on every step, so the capability decision
  // follows the live selection rather than a cached one.
  const { handlers, transport, calls } = mount({ modelInfo: (provider, model) => (model === 'vision-model' ? NATIVE : TEXT_ONLY) });
  const messages = [userMessage({ images: [imageRef('png', 'id-0')] })];
  await preStep(handlers, { agent: AGENT, messages, signal: undefined }, enterNext(messages));
  assert.equal(transport.calls.length, 1, 'text-only model: the relay runs');

  const switched = mount({
    modelInfo: (provider, model) => (model === 'vision-model' ? NATIVE : TEXT_ONLY),
    projection: liveProjection('deepseek', 'vision-model'),
  });
  const second = await preStep(switched.handlers, { agent: AGENT, messages, signal: undefined }, enterNext(messages));
  assert.equal(switched.transport.calls.length, 0, 'after the switch to an image-capable model the relay is silent');
  assert.equal(second.messages.length, 1, 'and no context message is appended');
  assert.equal(calls.projections.length, 1);
});

test('M14 contextForStep skips entirely when no provider/model can be resolved', async () => {
  const attachments = makeAttachments(attachmentMap([['id-0', { data: imageBytes('png') }]]));
  const harness = makeCtx({ modelInfo: TEXT_ONLY, attachments, credentials: makeCredentials({ GLM_API_KEY: 'k' }) });
  const result = await contextForStep({
    ctx: harness.ctx,
    agent: { options: {} },
    messages: [userMessage({ images: [imageRef('png', 'id-0')] })],
    configPath: 'C:\\nonexistent\\vision-better.json',
    baseConfig: { endpoint: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4.6v-flash', enabled: true },
    cache: undefined,
    logger: harness.logger,
    fetchImpl: okFetch(),
  });
  assert.equal(result, undefined);
});

test('M1 image admission: the host’s own answer always wins', async () => {
  const { handlers } = mount();
  const decided = { admit: true, code: 'HOST_SAID_SO' };
  assert.equal(await admission(handlers, { agent: AGENT }, async () => decided), decided);
});

test('M1 image admission decides on config alone and never resolves a route', async () => {
  // mount() injects a throwing agents decoy, so a green result here also proves
  // admission does not re-derive the model or its capability.
  const { handlers, calls } = mount();
  assert.deepEqual(await admission(handlers, { agent: AGENT }, async () => undefined), { admit: true });
  assert.equal(calls.projections.length, 0, 'admission must not resolve a route');
  assert.equal(calls.resolveModelInfo.length, 0, 'admission must not look up a capability');
});

test('M1 image admission: a missing key is refused explicitly, disabled defers to stock', async () => {
  const keyless = mount({ key: null });
  const refusal = await admission(keyless.handlers, { agent: AGENT }, async () => undefined);
  assert.equal(refusal.admit, false);
  assert.equal(refusal.code, 'VISION_RELAY_UNCONFIGURED');
  assert.match(refusal.message, /Settings/);
  assert.match(refusal.message, /still here/, 'the user is told the image is not lost');

  const disabled = mount({ key: null, config: { enabled: false } });
  assert.equal(await admission(disabled.handlers, { agent: AGENT }, async () => undefined), undefined, 'disabled means stock DSH behaviour');
});

test('M14 the settings routes mount through the webServer inject, under its exact name', () => {
  const registered = [];
  const attachments = makeAttachments(attachmentMap([]));
  const harness = makeCtx({
    modelInfo: TEXT_ONLY,
    attachments,
    credentials: makeCredentials({ GLM_API_KEY: 'sentinel-not-a-real-key' }),
    webServer: {
      register(spec) {
        registered.push(spec);
        return () => undefined;
      },
    },
  });
  apply(harness.ctx, { configPath: 'C:\\nonexistent\\vision-better.json', fetchImpl: okFetch() });

  // The name is pinned as a LITERAL on purpose. Asserting it via the plugin's own
  // constant would move both sides together and hide a rename — which is exactly
  // how the lowercase misspelling shipped. dsh-host-webserver/lib/index.js:158
  // registers `super(ctx, "webServer")`.
  assert.deepEqual(harness.calls.injects, [['webServer']], 'the plugin must ask for exactly "webServer" (capital S)');
  assert.equal(harness.ctx.get('webserver'), undefined, 'the lowercase spelling is not a service; a regression to it must mount nothing');
  assert.deepEqual(
    registered.map((spec) => spec.path).sort(),
    ['/vision-better/api/config', '/vision-better/api/key', '/vision-better/api/models', '/vision-better/api/state', '/vision-better/api/test'],
  );
  assert.ok(registered.every((spec) => spec.kind === 'exact'));
  assert.ok(harness.logs.info.some((line) => /settings API mounted/.test(line)));
});

test('REGRESSION webServer: a service mounted only under the misspelling receives nothing', () => {
  // The injected fake answers ONLY to the lowercase spelling — the shape of the
  // bug. The faithful inject must refuse it, so no route is mounted.
  const registered = [];
  const harness = makeCtx({ modelInfo: TEXT_ONLY });
  harness.services.webserver = {
    register(spec) {
      registered.push(spec);
      return () => undefined;
    },
  };
  apply(harness.ctx, { configPath: 'C:\\nonexistent\\vision-better.json', fetchImpl: okFetch() });
  assert.deepEqual(harness.calls.injects, [['webServer']]);
  assert.deepEqual(registered, [], 'a lowercase-only service must never receive the routes');
});

test('REGRESSION webServer: registerRoutes returns undefined when the service is missing', () => {
  const args = {
    configPath: 'C:\\nonexistent\\vision-better.json',
    baseConfig: { endpoint: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4.6v-flash', enabled: true },
    cache: new AnalysisCache(),
    logger: { info: () => undefined, warn: () => undefined, debug: () => undefined },
    fetchImpl: okFetch(),
  };
  assert.equal(
    registerRoutes({ ...args, ctx: { get: () => undefined } }),
    undefined,
    'must not return a no-op disposer: the caller has to tell "mounted" from "not mounted"',
  );
  assert.equal(
    registerRoutes({ ...args, ctx: { get: (name) => (name === 'webserver' ? { register: () => () => undefined } : undefined) } }),
    undefined,
    'the lowercase spelling must not resolve a server',
  );
  assert.equal(registerRoutes({ ...args, ctx: { get: () => ({}) } }), undefined, 'a service without register() is not usable');
});

test('REGRESSION webServer: a present-but-unusable service is reported loudly, not silently ignored', () => {
  const harness = makeCtx({ modelInfo: TEXT_ONLY, webServer: {} });
  apply(harness.ctx, { configPath: 'C:\\nonexistent\\vision-better.json', fetchImpl: okFetch() });
  assert.ok(
    harness.logs.warn.some((line) => /no "webServer" service/.test(line)),
    'a settings page whose API never mounts must be reported: a broken save reads worse than a missing feature',
  );
  assert.deepEqual(harness.logs.info.filter((line) => /settings API mounted/.test(line)), []);
});

// --- REGRESSION: cordis activation ------------------------------------------

test('REGRESSION cordis: reading an undeclared context property throws, as the real fiber does', () => {
  const { ctx } = makeCtx({ modelInfo: TEXT_ONLY });
  // `ctx.config` is the read that killed the plugin at activation on a real host
  // while a plain-object fake quietly returned `{}`.
  assert.throws(() => ctx.config, /cannot get property "config" without inject/);
  assert.throws(() => ctx.logger, /cannot get property "logger" without inject/);
  assert.throws(() => ctx.webserver, /cannot get property "webserver" without inject/);
  assert.throws(() => {
    ctx.config = {};
  }, /cannot set property "config" on a plugin context/);
  // The declared surface, and the read-without-inject accessor, still work.
  assert.equal(typeof ctx.get, 'function');
  assert.equal(typeof ctx.on, 'function');
  assert.equal(typeof ctx.inject, 'function');
  assert.equal(typeof ctx.effect, 'function');
  assert.notEqual(ctx.get('logger'), undefined, 'services are reachable through get()');
});

test('REGRESSION cordis: apply activates from a config argument and a service-only ctx', () => {
  const harness = makeCtx({ modelInfo: TEXT_ONLY });
  apply(harness.ctx, { configPath: 'C:\\nonexistent\\vision-better.json', fetchImpl: okFetch(), enabled: false });

  // Activation itself is the assertion: had the plugin read `ctx.config`, the
  // proxy would have thrown before any hook or route was registered.
  assert.ok(harness.handlers.has('agent/pre-step'), 'activation reached the pre-step registration');
  assert.ok(harness.handlers.has('session/image-admission'), 'activation reached the admission registration');
  assert.deepEqual(harness.calls.injects, [['webServer']], 'activation reached the settings-route inject');
  assert.deepEqual(harness.calls.scopes, ['vision-better'], 'the logger service was minted with this plugin’s scope');
});

test('REGRESSION cordis: the logger is read with ctx.get and a missing one is a no-op, not a crash', () => {
  const harness = makeCtx({ modelInfo: TEXT_ONLY, logger: null });
  assert.equal(harness.ctx.get('logger'), undefined, 'this deployment mounts no logger service');
  assert.throws(() => harness.ctx.logger, /cannot get property "logger" without inject/, 'and the property is still undeclared');
  apply(harness.ctx, { configPath: 'C:\\nonexistent\\vision-better.json', fetchImpl: okFetch() });
  assert.ok(harness.handlers.has('agent/pre-step'), 'the plugin must still activate without a logger');
});

test('REGRESSION cordis: a full activation mounts the routes end to end', () => {
  const registered = [];
  const webServer = {
    register(spec) {
      registered.push(spec.path);
      return () => undefined;
    },
  };
  const harness = makeCtx({
    modelInfo: TEXT_ONLY,
    credentials: makeCredentials({ GLM_API_KEY: 'sentinel-not-a-real-key' }),
    webServer,
  });
  apply(harness.ctx, { configPath: 'C:\\nonexistent\\vision-better.json', fetchImpl: okFetch() });
  assert.deepEqual(registered.sort(), [
    '/vision-better/api/config',
    '/vision-better/api/key',
    '/vision-better/api/models',
    '/vision-better/api/state',
    '/vision-better/api/test',
  ]);
  assert.deepEqual(harness.calls.injects, [['webServer']]);
  assert.ok(harness.logs.info.some((line) => /settings API mounted/.test(line)));
});
