/**
 * S1–S8 / M6 / M7 / M13 — the security checklist, with one concrete check each.
 *
 * The theme: the credential is written only through the host credential service,
 * the browser can only ever learn whether a key exists, and no client-controlled
 * field can widen what the plugin reads.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  DEFAULT_CONFIG_PATH,
  describeApiKey,
  normalizeEndpoint,
  normalizeModel,
  parseConfigDocument,
  readConfig,
  resolveApiKey,
  writeApiKey,
  writeConfig,
} from '../lib/config.js';
import { CREDENTIAL_REF } from '../lib/defaults.js';
import { describeFailure } from '../lib/glm.js';
import { buildState, readJsonBody, registerRoutes, sameOrigin, runConnectionTest } from '../lib/routes.js';
import { endpointLabel, redact } from '../lib/safe.js';
import { AnalysisCache } from '../lib/cache.js';
import { completionBody, makeCredentials, makeCtx, findSentinel, ALL_SENTINELS, SENTINEL_KEY, SENTINEL_SK, SENTINEL_UNCOVERED, queuedFetch } from './fixtures/harness.mjs';

const BASE = Object.freeze({ endpoint: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4.6v-flash', enabled: true });
const tempDir = () => mkdtempSync(join(tmpdir(), 'relay-cfg-'));

/** A minimal incoming-request double that readJsonBody can iterate. */
function fakeRequest({ method = 'GET', headers = {}, body } = {}) {
  return {
    method,
    headers,
    async *[Symbol.asyncIterator]() {
      if (body !== undefined) yield Buffer.from(body);
    },
  };
}

/** A minimal server-response double that records status and body. */
function fakeResponse() {
  const response = {
    status: undefined,
    responseHeaders: undefined,
    body: '',
    writeHead(status, responseHeaders) {
      response.status = status;
      response.responseHeaders = responseHeaders;
      return response;
    },
    end(chunk) {
      if (chunk !== undefined) response.body += String(chunk);
      return response;
    },
    get json() {
      return JSON.parse(response.body);
    },
  };
  return response;
}

/** Mount the four settings routes and return a caller per path. */
function mountRoutes({ configPath, credentials, fetchImpl, cache = new AnalysisCache({ now: () => 0 }) }) {
  const handlers = new Map();
  // The service is registered as `super(ctx, "webServer")` in
  // dsh-host-webserver/lib/index.js:158 — capital S. Only that spelling exists.
  const webServer = {
    register(spec) {
      handlers.set(spec.path, spec.handler);
      return () => undefined;
    },
  };
  const harness = makeCtx({
    modelInfo: { inputModalities: ['text'] },
    credentials,
    webServer,
  });
  const logs = { info: [], warn: [], debug: [] };
  const logger = { info: (m) => logs.info.push(m), warn: (m) => logs.warn.push(m), debug: () => undefined };
  const dispose = registerRoutes({ ctx: harness.ctx, configPath, baseConfig: BASE, cache, logger, fetchImpl });
  // Loud on purpose: without this, a wrong service name leaves `handlers` empty
  // and every assertion below becomes vacuous instead of failing.
  assert.notEqual(dispose, undefined, 'the settings routes must actually mount for these tests to mean anything');
  return {
    logs,
    call: async (path, request) => {
      const response = fakeResponse();
      await handlers.get(path)(request, response);
      return response;
    },
  };
}

// --- S7: redaction -----------------------------------------------------------

test('S7 redact removes every credential shape the plugin documents', () => {
  assert.equal(redact(`Authorization: Bearer ${SENTINEL_SK}`), 'Authorization: [redacted]');
  assert.match(redact(`key=${SENTINEL_KEY} done`), /\[redacted\]/);
  assert.ok(!redact(`key=${SENTINEL_KEY} done`).includes(SENTINEL_KEY));
  assert.ok(!redact(`bearer ${SENTINEL_SK}`).includes(SENTINEL_SK));
  assert.equal(redact('nothing secret here'), 'nothing secret here');
  assert.equal(redact(undefined), '');
  assert.equal(redact(null), '');
  assert.equal(redact(12345), '12345');
  assert.ok(redact('x'.repeat(900)).length <= 501, 'redaction also bounds the length');
});

test('S7 redaction is pattern-based: a credential of an unknown shape is NOT covered', () => {
  // Documents the boundary honestly rather than claiming blanket protection.
  // This is why no error path may embed a raw provider/user string at all.
  assert.equal(redact(SENTINEL_UNCOVERED), SENTINEL_UNCOVERED);
});

test('S7 endpointLabel drops query strings and any credentials planted in them', () => {
  assert.equal(endpointLabel('https://open.bigmodel.cn/api/paas/v4?key=abc'), 'https://open.bigmodel.cn/api/paas/v4');
  assert.equal(endpointLabel('https://user:pass@open.bigmodel.cn/api'), 'https://open.bigmodel.cn/api');
  assert.equal(endpointLabel('https://open.bigmodel.cn/api/paas/v4/'), 'https://open.bigmodel.cn/api/paas/v4/');
  assert.equal(endpointLabel('not a url'), 'not a url');
  assert.ok(!endpointLabel(`https://h/p?token=${SENTINEL_KEY}`).includes(SENTINEL_KEY));
});

test('S7 describeFailure never carries an unknown error’s payload verbatim', () => {
  const failure = describeFailure(new Error(`request failed with Bearer ${SENTINEL_SK}`));
  assert.ok(!JSON.stringify(failure).includes(SENTINEL_SK));
  assert.equal(failure.code, 'VISION_RELAY_FAILED');
  assert.equal(describeFailure(undefined).code, 'VISION_RELAY_FAILED');
});

// --- S1 / M6: credential storage --------------------------------------------

test('S1 the credential is only ever reached through the host credential service', async () => {
  assert.match(CREDENTIAL_REF, /^[A-Za-z_][A-Za-z0-9_]*$/, 'the ref must be a plain identifier');
  assert.equal(CREDENTIAL_REF, 'GLM_API_KEY');

  const credentials = makeCredentials({});
  const harness = makeCtx({ credentials });
  assert.equal(await resolveApiKey({ get: () => undefined }), undefined, 'no provider means no key, never a file read');

  assert.deepEqual(await resolveApiKey(harness.ctx), undefined, 'unset');
  await writeApiKey(harness.ctx, SENTINEL_KEY);
  assert.deepEqual(await resolveApiKey(harness.ctx), { value: SENTINEL_KEY });
  assert.deepEqual(credentials.mutations, [{ op: 'set', ref: CREDENTIAL_REF, value: SENTINEL_KEY }]);
});

test('S1 the plugin never writes a credentials document of its own', () => {
  for (const file of ['config.js', 'routes.js', 'index.js', 'relay.js', 'glm.js']) {
    const text = readFileSync(new URL(`../lib/${file}`, import.meta.url), 'utf8');
    assert.doesNotMatch(text, /\.credentials\.yaml/, `${file} must not address the credentials document`);
  }
  const config = readFileSync(new URL('../lib/config.js', import.meta.url), 'utf8');
  assert.doesNotMatch(config, /chmod|0o600[\s\S]{0,80}credential/i, 'the plugin must not manage credential file permissions');
});

test('S1 the plugin config file holds no credential, only endpoint/model/enabled', () => {
  const dir = tempDir();
  try {
    const configPath = join(dir, 'vision-better.json');
    assert.equal(writeConfig({ endpoint: BASE.endpoint, model: BASE.model, enabled: true }, configPath).ok, true);
    const written = JSON.parse(readFileSync(configPath, 'utf8'));
    assert.deepEqual(Object.keys(written).sort(), ['enabled', 'endpoint', 'model']);
    const raw = readFileSync(configPath, 'utf8');
    assert.equal(findSentinel(raw), undefined, 'no sentinel may ever appear in the config file');
    assert.doesNotMatch(raw, /apiKey|api_key|token|secret/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('S1 describeApiKey reports presence only and never the secret', async () => {
  const harness = makeCtx({ credentials: makeCredentials({ GLM_API_KEY: SENTINEL_KEY }) });
  const described = await describeApiKey(harness.ctx);
  assert.deepEqual(Object.keys(described).sort(), ['configured', 'source', 'writable']);
  assert.equal(findSentinel(described), undefined);
  assert.equal(await describeApiKey({ get: () => undefined }).then((info) => info.configured), false);
});

test('M6 key save, replace and delete all go through the provider', async () => {
  const dir = tempDir();
  try {
    const credentials = makeCredentials({});
    const configPath = join(dir, 'vision-better.json');
    const { call } = mountRoutes({ configPath, credentials, fetchImpl: queuedFetch([{ status: 200, body: completionBody('red') }]) });

    const saved = await call('/vision-better/api/key', fakeRequest({ method: 'POST', body: JSON.stringify({ apiKey: 'first-not-a-real-key' }) }));
    assert.equal(saved.status, 200);
    assert.equal(credentials.store.get(CREDENTIAL_REF), 'first-not-a-real-key');
    assert.equal(saved.json.credential.configured, true);

    const replaced = await call('/vision-better/api/key', fakeRequest({ method: 'POST', body: JSON.stringify({ apiKey: 'second-not-a-real-key' }) }));
    assert.equal(replaced.status, 200);
    assert.equal(credentials.store.get(CREDENTIAL_REF), 'second-not-a-real-key', 'replace overwrites');
    assert.equal(credentials.store.size, 1);

    const cleared = await call('/vision-better/api/key', fakeRequest({ method: 'POST', body: JSON.stringify({ clear: true }) }));
    assert.equal(cleared.status, 200);
    assert.equal(credentials.store.size, 0, 'clear removes the credential');
    assert.equal(cleared.json.credential.configured, false);

    for (const bad of [{}, { apiKey: '' }, { apiKey: '   ' }, { apiKey: 42 }]) {
      const refused = await call('/vision-better/api/key', fakeRequest({ method: 'POST', body: JSON.stringify(bad) }));
      assert.equal(refused.status, 400, `must refuse ${JSON.stringify(bad)}`);
    }
    assert.equal(credentials.store.size, 0, 'a refused write changes nothing');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('M6 a missing credential provider is reported, not thrown', async () => {
  const harness = makeCtx({ credentials: undefined });
  const result = await writeApiKey(harness.ctx, 'x-not-a-real-key');
  assert.equal(result.ok, false);
  assert.match(result.message, /no credential provider/);
  assert.equal(findSentinel(result), undefined);
});

// --- S2 / M7: nothing secret reaches a client --------------------------------

test('S2/M7 the settings state payload contains no secret', async () => {
  const credentials = makeCredentials({ GLM_API_KEY: SENTINEL_KEY });
  const harness = makeCtx({ credentials });
  const state = await buildState({ ctx: harness.ctx, configPath: 'C:\\nonexistent\\vision-better.json', baseConfig: BASE, cache: new AnalysisCache({ now: () => 0 }) });
  const text = JSON.stringify(state);
  assert.equal(findSentinel(text), undefined, 'no sentinel may appear in the state payload');
  assert.equal(state.credential.configured, true);
  assert.deepEqual(Object.keys(state.credential).sort(), ['configured', 'ref', 'source', 'writable']);
  assert.ok(!('value' in state.credential) && !('apiKey' in state.credential));
  assert.ok(!('length' in state.credential), 'not even the length is exposed');
});

test('S2/M7 a key POST response never echoes the key it just stored', async () => {
  const dir = tempDir();
  try {
    const credentials = makeCredentials({});
    const { call } = mountRoutes({ configPath: join(dir, 'vision-better.json'), credentials, fetchImpl: queuedFetch([{ status: 200 }]) });
    const response = await call('/vision-better/api/key', fakeRequest({ method: 'POST', body: JSON.stringify({ apiKey: SENTINEL_KEY }) }));
    assert.equal(credentials.store.get(CREDENTIAL_REF), SENTINEL_KEY, 'the value really was stored');
    assert.equal(findSentinel(response.body), undefined, 'and it never comes back out');
    assert.equal(findSentinel(response.responseHeaders), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('S2/M7 a provider error body that echoes the key is not forwarded to the client', async () => {
  const dir = tempDir();
  try {
    const credentials = makeCredentials({ GLM_API_KEY: SENTINEL_KEY });
    const fetchImpl = queuedFetch([{ status: 401, body: JSON.stringify({ error: { message: `bad key ${SENTINEL_KEY}` } }) }]);
    const { call } = mountRoutes({ configPath: join(dir, 'vision-better.json'), credentials, fetchImpl });
    const response = await call('/vision-better/api/test', fakeRequest({ method: 'POST', body: '{}' }));
    // A failed connection test is a RESULT, not a transport failure: the page
    // renders code + message inline and reserves its error banner for real
    // transport problems.
    assert.equal(response.status, 200, 'a failed test answers 200 with ok:false, not 502');
    assert.equal(response.json.ok, false);
    assert.equal(response.json.code, 'VISION_RELAY_UNAUTHORIZED');
    assert.equal(findSentinel(response.body), undefined, 'the echoed key must not reach the browser');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('S2/M7 the 429 path scrubs an echoed key by exact match, not by pattern shape', async () => {
  // The 401 case above is excluded from quoting at all, so it never exercises
  // the scrub. A 429 does quote the body — this is where an arbitrary provider
  // shape has to be compared against the credential this request carried.
  const dir = tempDir();
  try {
    const credentials = makeCredentials({ GLM_API_KEY: SENTINEL_KEY });
    const fetchImpl = queuedFetch([
      {
        status: 429,
        headers: { 'retry-after': '0' },
        body: JSON.stringify({ error: { code: '1301', message: `concurrency limit reached for ${SENTINEL_KEY}` } }),
      },
    ]);
    const { call } = mountRoutes({ configPath: join(dir, 'vision-better.json'), credentials, fetchImpl });
    const response = await call('/vision-better/api/test', fakeRequest({ method: 'POST', body: '{}' }));
    assert.equal(response.status, 200);
    assert.equal(response.json.ok, false);
    assert.equal(response.json.code, 'VISION_RELAY_RATE_LIMITED');
    assert.equal(findSentinel(response.body), undefined, 'the echoed credential must be scrubbed');
    assert.equal(findSentinel(response.json.message), undefined, 'and not survive in the message the page renders');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- S3 / S8: endpoint and transport ----------------------------------------

test('S8 normalizeEndpoint refuses plain http except on loopback', () => {
  assert.deepEqual(normalizeEndpoint('https://open.bigmodel.cn/api/paas/v4'), { ok: true, value: 'https://open.bigmodel.cn/api/paas/v4' });
  assert.deepEqual(normalizeEndpoint('https://open.bigmodel.cn/api/paas/v4/'), { ok: true, value: 'https://open.bigmodel.cn/api/paas/v4' }, 'trailing slash trimmed');
  for (const loopback of ['http://127.0.0.1:8080/v1', 'http://localhost:8080/v1', 'http://[::1]:8080/v1']) {
    assert.equal(normalizeEndpoint(loopback).ok, true, loopback);
  }
  for (const refused of ['http://open.bigmodel.cn/api', 'http://192.168.1.10/v1', 'http://0.0.0.0:8080', 'ftp://h/x', 'file:///etc/passwd', 'javascript:alert(1)', 'not a url', '', '   ']) {
    assert.equal(normalizeEndpoint(refused).ok, false, `${refused} must be refused`);
  }
});

test('S3 normalizeEndpoint refuses embedded credentials and query/fragment smuggling', () => {
  assert.equal(normalizeEndpoint('https://open.bigmodel.cn@evil.example/api').ok, false, 'userinfo must be refused');
  assert.equal(normalizeEndpoint('https://user:pass@open.bigmodel.cn/api').ok, false);
  assert.equal(normalizeEndpoint(`https://open.bigmodel.cn/api?key=${SENTINEL_KEY}`).ok, false, 'the key must never ride in a query');
  assert.equal(normalizeEndpoint('https://open.bigmodel.cn/api#frag').ok, false);
});

test('S3 a different https host IS accepted: the endpoint is a user setting, not an allowlist', () => {
  // Documented consequence — the SSRF boundary is the same-origin check on the
  // settings route, asserted below, not a host allowlist.
  assert.equal(normalizeEndpoint('https://vision.internal.example/v1').ok, true);
  assert.equal(normalizeEndpoint('https://open.bigmodel.cn.evil.example/api').ok, true);
});

test('S3 sameOrigin refuses a foreign origin and allows the app’s own / the desktop shell', () => {
  assert.equal(sameOrigin({ headers: {} }), true, 'no Origin: desktop shell / same-origin GET');
  assert.equal(sameOrigin({ headers: { origin: '', host: '127.0.0.1:19387' } }), true);
  assert.equal(sameOrigin({ headers: { origin: 'http://127.0.0.1:19387', host: '127.0.0.1:19387' } }), true);
  assert.equal(sameOrigin({ headers: { origin: 'https://evil.example', host: '127.0.0.1:19387' } }), false, 'a foreign page must be refused');
  assert.equal(sameOrigin({ headers: { origin: 'http://127.0.0.1:19388', host: '127.0.0.1:19387' } }), false, 'a different port is a different origin');
  assert.equal(sameOrigin({ headers: { origin: 'not a url', host: '127.0.0.1:19387' } }), false);
  assert.equal(sameOrigin({ headers: { origin: 'null', host: '127.0.0.1:19387' } }), false, 'a sandboxed page sends null and must be refused');
  assert.equal(sameOrigin({ headers: { origin: 'http://127.0.0.1:19387' } }), false, 'a browser origin with no Host to match is refused');
});

test('REGRESSION S3: the routes refuse a null/foreign origin and a non-JSON browser POST', async () => {
  const dir = tempDir();
  try {
    const credentials = makeCredentials({});
    const configPath = join(dir, 'vision-better.json');
    const { call } = mountRoutes({ configPath, credentials, fetchImpl: queuedFetch([{ status: 200, body: completionBody('red') }]) });
    const browserHost = '127.0.0.1:19387';

    const nullOrigin = await call(
      '/vision-better/api/key',
      fakeRequest({ method: 'POST', headers: { origin: 'null', host: browserHost }, body: JSON.stringify({ apiKey: SENTINEL_KEY }) }),
    );
    assert.equal(nullOrigin.status, 403, 'a null origin is refused');
    assert.equal(credentials.store.size, 0, 'and writes nothing');
    assert.equal(findSentinel(nullOrigin.body), undefined);

    const foreign = await call(
      '/vision-better/api/config',
      fakeRequest({
        method: 'POST',
        headers: { origin: 'https://attacker.example', host: browserHost, 'content-type': 'application/json' },
        body: JSON.stringify({ endpoint: 'https://attacker.example/v1' }),
      }),
    );
    assert.equal(foreign.status, 403, 'a foreign origin is refused');

    const simplePost = await call(
      '/vision-better/api/config',
      fakeRequest({
        method: 'POST',
        headers: { origin: 'http://127.0.0.1:19387', host: browserHost, 'content-type': 'text/plain;charset=UTF-8' },
        body: JSON.stringify({ endpoint: 'https://attacker.example/v1' }),
      }),
    );
    assert.equal(simplePost.status, 415, 'a no-cors simple POST cannot reach the config writer');

    const browserJson = await call(
      '/vision-better/api/config',
      fakeRequest({
        method: 'POST',
        headers: { origin: 'http://127.0.0.1:19387', host: browserHost, 'content-type': 'application/json' },
        body: JSON.stringify({ enabled: false }),
      }),
    );
    assert.equal(browserJson.status, 200, 'the real settings page still works');
    assert.equal(browserJson.json.enabled, false);

    assert.doesNotMatch(readFileSync(configPath, 'utf8'), /attacker\.example/, 'the attacker endpoint never reached the config file');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('S8 readJsonBody caps the request size and accepts only a JSON object', async () => {
  assert.deepEqual(await readJsonBody(fakeRequest({ body: '{"a":1}' })), { a: 1 });
  assert.equal(await readJsonBody(fakeRequest({ body: '[1,2,3]' })), undefined, 'arrays are refused');
  assert.equal(await readJsonBody(fakeRequest({ body: '"text"' })), undefined);
  assert.equal(await readJsonBody(fakeRequest({ body: 'null' })), undefined);
  assert.equal(await readJsonBody(fakeRequest({ body: '{broken' })), undefined);
  assert.equal(await readJsonBody(fakeRequest({ body: 'x'.repeat(9 * 1024) })), undefined, 'above the 8 KiB cap');
  const justUnder = `{"pad":"${'x'.repeat(8 * 1024 - 20)}"}`;
  assert.notEqual(await readJsonBody(fakeRequest({ body: justUnder })), undefined, 'just under the cap is accepted');
});

test('S4 a client cannot inject a path, url, or extra field into the stored config', async () => {
  const dir = tempDir();
  try {
    const configPath = join(dir, 'vision-better.json');
    const { call } = mountRoutes({ configPath, credentials: makeCredentials({}), fetchImpl: queuedFetch([{ status: 200 }]) });
    const response = await call(
      '/vision-better/api/config',
      fakeRequest({
        method: 'POST',
        body: JSON.stringify({ model: 'glm-4.6v-flash', path: 'C:\\Users\\Admin\\.dsh\\.credentials.yaml', apiKey: SENTINEL_KEY, url: 'file:///etc/passwd' }),
      }),
    );
    assert.equal(response.status, 200);
    const raw = readFileSync(configPath, 'utf8');
    const written = JSON.parse(raw);
    assert.deepEqual(Object.keys(written).sort(), ['enabled', 'endpoint', 'model'], 'only known fields are persisted');
    assert.doesNotMatch(raw, /credentials\.yaml|passwd/);
    assert.equal(findSentinel(raw), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('S4 the config route validates every field and refuses bad input', async () => {
  const dir = tempDir();
  try {
    const { call } = mountRoutes({ configPath: join(dir, 'vision-better.json'), credentials: makeCredentials({}), fetchImpl: queuedFetch([{ status: 200 }]) });
    for (const body of [
      { endpoint: 'http://evil.example/v1' },
      { endpoint: 'https://user:pass@h/v1' },
      { model: 'not a model!' },
      { model: '' },
      { enabled: 'yes' },
    ]) {
      const response = await call('/vision-better/api/config', fakeRequest({ method: 'POST', body: JSON.stringify(body) }));
      assert.equal(response.status, 400, `must refuse ${JSON.stringify(body)}`);
      assert.equal(findSentinel(response.body), undefined);
    }
    const badJson = await call('/vision-better/api/config', fakeRequest({ method: 'POST', body: '{oops' }));
    assert.equal(badJson.status, 400);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('S4 wrong method is refused with Allow, so a GET cannot mutate state', async () => {
  const dir = tempDir();
  try {
    const { call } = mountRoutes({ configPath: join(dir, 'vision-better.json'), credentials: makeCredentials({}), fetchImpl: queuedFetch([{ status: 200 }]) });
    const response = await call('/vision-better/api/key', fakeRequest({ method: 'GET' }));
    assert.equal(response.status, 405);
    assert.equal(response.responseHeaders.allow, 'POST');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- M13: no secrets in logs or artifacts ------------------------------------

test('M13 no log line emitted by the settings routes carries a secret', async () => {
  const dir = tempDir();
  try {
    const credentials = makeCredentials({});
    const fetchImpl = queuedFetch([{ status: 401, body: JSON.stringify({ error: { message: `bad ${SENTINEL_KEY}` } }) }]);
    const { call, logs } = mountRoutes({ configPath: join(dir, 'vision-better.json'), credentials, fetchImpl });
    await call('/vision-better/api/key', fakeRequest({ method: 'POST', body: JSON.stringify({ apiKey: SENTINEL_KEY }) }));
    await call('/vision-better/api/test', fakeRequest({ method: 'POST', body: '{}' }));
    await call('/vision-better/api/state', fakeRequest({ method: 'GET' }));
    const joined = [...logs.info, ...logs.warn, ...logs.debug].join('\n');
    assert.equal(findSentinel(joined), undefined, `a sentinel reached a log line:\n${joined}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('M13 the connection test never uses a conversation image and never returns the key', async () => {
  const dir = tempDir();
  try {
    const credentials = makeCredentials({ GLM_API_KEY: SENTINEL_KEY });
    const fetchImpl = queuedFetch([{ status: 200, body: completionBody('red') }]);
    const harness = makeCtx({ credentials });
    const result = await runConnectionTest({ ctx: harness.ctx, configPath: join(dir, 'none.json'), baseConfig: BASE, fetchImpl });
    assert.equal(result.ok, true);
    assert.equal(result.reply, 'red');
    assert.equal(result.endpoint, 'https://open.bigmodel.cn/api/paas/v4');
    assert.equal(findSentinel(result), undefined);
    const sent = JSON.parse(fetchImpl.calls[0].body);
    const url = sent.messages[0].content[0].image_url.url;
    assert.ok(url.startsWith('data:image/png;base64,'), 'the connection test uses its own embedded 16x16 PNG');
    assert.ok(!url.includes(SENTINEL_KEY));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- config document handling ------------------------------------------------

test('S1 readConfig falls back to defaults on a missing, corrupt, or hostile document', () => {
  const dir = tempDir();
  try {
    const base = { ...BASE };
    assert.deepEqual(readConfig(base, join(dir, 'missing.json')), base, 'missing file falls back');

    const path = join(dir, 'vision-better.json');
    for (const text of ['{broken', '[]', 'null', '"string"', '', '   ']) {
      writeFileSync(path, text, 'utf8');
      assert.deepEqual(readConfig(base, path), base, `corrupt document ${JSON.stringify(text)} falls back`);
    }

    writeFileSync(path, '{"endpoint":"http://evil.example/v1","model":"glm-4.6v-other"}', 'utf8');
    const merged = readConfig(base, path);
    assert.equal(merged.endpoint, base.endpoint, 'an invalid endpoint is dropped, not honoured');
    assert.equal(merged.model, 'glm-4.6v-other', 'a valid sibling field still applies');

    assert.deepEqual(parseConfigDocument('{"unknown":1,"apiKey":"leak"}'), {}, 'unknown and secret-shaped keys are dropped');
    assert.equal(parseConfigDocument('{broken'), undefined);
    assert.equal(parseConfigDocument('[]'), undefined);
    assert.equal(parseConfigDocument('null'), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('S1 normalizeModel refuses anything that could smuggle structure into the request body', () => {
  assert.deepEqual(normalizeModel('glm-4.6v-flash'), { ok: true, value: 'glm-4.6v-flash' });
  assert.deepEqual(normalizeModel('  glm-4.6v-flash  '), { ok: true, value: 'glm-4.6v-flash' });
  assert.deepEqual(normalizeModel('vendor:model.v2_beta'), { ok: true, value: 'vendor:model.v2_beta' });
  for (const bad of ['', '  ', 'a'.repeat(65), 'model/../other', 'model\nX: y', '{"model":"x"}', 'glm 4.6v', 'model"quote']) {
    assert.equal(normalizeModel(bad).ok, false, `${JSON.stringify(bad)} must be refused`);
  }
  assert.equal(normalizeModel(42).ok, false);
  assert.equal(normalizeModel(undefined).ok, false);
});

test('S1 DEFAULT_CONFIG_PATH lives in the harness home, not the workspace', () => {
  assert.match(DEFAULT_CONFIG_PATH, /vision-better\.json$/);
  assert.doesNotMatch(DEFAULT_CONFIG_PATH, /deepseek-harness[\\/]default-workspace/, 'never inside a repo that could be committed');
});
