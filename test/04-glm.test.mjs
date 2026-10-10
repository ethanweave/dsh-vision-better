/**
 * M8 / M12 / S3 / S8 — the GLM client: the whole HTTP failure matrix, bounded
 * retries, exactly-once accounting, and the credential's transport controls.
 *
 * Every failure here is produced by a stub. No test contacts the real API.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { VISION_CODES, buildBody, callVision, classifyStatus, describeFailure, detailOf, parseCompletion, retryAfterMs } from '../lib/glm.js';
import { SENTINEL_KEY, SENTINEL_UNCOVERED, completionBody, fastLimits, queuedFetch, startStub, stubJson } from './fixtures/harness.mjs';
import { imageBytes } from './fixtures/images.mjs';

const ENDPOINT = 'https://open.bigmodel.cn/api/paas/v4';
const images = [{ mediaType: 'image/png', base64: imageBytes('png').toString('base64') }];
const limits = fastLimits({ maxAttempts: 3, baseRetryDelayMs: 1, maxRetryAfterMs: 5 });

const call = (overrides = {}) =>
  callVision({ endpoint: ENDPOINT, model: 'glm-4.6v-flash', apiKey: SENTINEL_KEY, images, prompt: 'describe', maxTokens: 64, limits, ...overrides });

test('M8 classifyStatus maps every documented class to a stable code', () => {
  assert.deepEqual(classifyStatus(401), { code: VISION_CODES.UNAUTHORIZED, retryable: false, message: 'the vision API rejected the API key' });
  assert.equal(classifyStatus(403).code, VISION_CODES.UNAUTHORIZED);
  assert.deepEqual(classifyStatus(404).code, VISION_CODES.MODEL_NOT_FOUND);
  assert.equal(classifyStatus(429).code, VISION_CODES.RATE_LIMITED);
  assert.equal(classifyStatus(429).retryable, true);
  assert.equal(classifyStatus(500).code, VISION_CODES.UPSTREAM_ERROR);
  assert.equal(classifyStatus(503).code, VISION_CODES.UPSTREAM_ERROR);
  assert.equal(classifyStatus(503).retryable, true);
  assert.equal(classifyStatus(400).code, VISION_CODES.BAD_REQUEST);
  assert.equal(classifyStatus(413).code, VISION_CODES.BAD_REQUEST);
  assert.equal(classifyStatus(422).code, VISION_CODES.BAD_REQUEST);
  assert.equal(classifyStatus(400).retryable, false);
  assert.equal(classifyStatus(418).code, VISION_CODES.FAILED);
  assert.equal(classifyStatus(418).retryable, false);
});

test('M8 retryAfterMs parses seconds and HTTP-dates, and rejects unparseable junk', () => {
  assert.equal(retryAfterMs(new Headers({ 'retry-after': '2' })), 2000);
  assert.equal(retryAfterMs(new Headers({ 'retry-after': '0' })), 0);
  assert.equal(retryAfterMs(new Headers({ 'retry-after': '' })), undefined);
  assert.equal(retryAfterMs(new Headers({ 'retry-after': 'soon' })), undefined);
  assert.equal(retryAfterMs(undefined), undefined);
  assert.equal(retryAfterMs(new Headers({ 'retry-after': '999999' })), 999_999_000, 'the raw value is unbounded; the CALLER caps it');
  // V8 parses "-5" as a year, so the HTTP-date fallback turns this junk into a
  // past date and yields 0. Benign only because backoff() caps the delay.
  assert.equal(retryAfterMs(new Headers({ 'retry-after': '-5' })), 0);
  const future = new Date(Date.now() + 5000).toUTCString();
  const parsed = retryAfterMs(new Headers({ 'retry-after': future }));
  assert.ok(parsed > 0 && parsed <= 5000, `HTTP-date form should yield a bounded delay, got ${parsed}`);
});

test('M8 parseCompletion accepts both answer shapes and rejects the wrong ones', () => {
  assert.equal(parseCompletion(completionBody('  hello  ')), 'hello');
  assert.equal(parseCompletion(JSON.stringify({ choices: [{ message: { content: [{ type: 'text', text: 'a' }, 'b'] } }] })), 'ab');
  assert.equal(parseCompletion(JSON.stringify({ content: 'flat' })), 'flat');
  assert.equal(parseCompletion('<!doctype html><html>nope</html>'), undefined);
  assert.equal(parseCompletion('{"choices":[]}'), undefined);
  assert.equal(parseCompletion('{"choices":[{"message":{}}]}'), undefined);
  assert.equal(parseCompletion('null'), undefined);
  assert.equal(parseCompletion('{"choices":[{"message":{"content":""}}]}'), '', 'empty string is a real answer; the caller decides');
});

test('M8/S3 buildBody sends real image bytes, in order, and never a URL reference', () => {
  const body = JSON.parse(buildBody({ model: 'glm-4.6v-flash', images: [images[0], images[0]], prompt: 'p', maxTokens: 10, imageUrlMode: 'data-uri' }));
  assert.equal(body.model, 'glm-4.6v-flash');
  assert.equal(body.stream, false);
  assert.equal(body.max_tokens, 10);
  assert.equal(body.messages.length, 1);
  assert.deepEqual(body.messages[0].content.map((part) => part.type), ['image_url', 'image_url', 'text']);
  const first = body.messages[0].content[0].image_url.url;
  const second = body.messages[0].content[1].image_url.url;
  assert.equal(first, `data:image/png;base64,${images[0].base64}`);
  assert.equal(second, first, 'duplicate images are each sent, in order (no dedup)');
  assert.ok(!/^https?:/i.test(first), 'must never send a remote URL instead of bytes');
  const bare = JSON.parse(buildBody({ model: 'm', images: [images[0]], prompt: 'p', imageUrlMode: 'base64' }));
  assert.equal(bare.messages[0].content[0].image_url.url, images[0].base64, 'base64 mode carries no data: prefix');
  assert.ok(!('max_tokens' in JSON.parse(buildBody({ model: 'm', images: [images[0]], prompt: 'p', imageUrlMode: 'base64' }))));
});

test('M12 exactly one request when nothing goes wrong, with the credential on the right header', async () => {
  const fetchImpl = queuedFetch([{ status: 200, body: completionBody('a red square') }]);
  const result = await call({ fetchImpl });
  assert.equal(fetchImpl.calls.length, 1, 'EXACTLY-ONCE: one billed request');
  assert.equal(result.text, 'a red square');
  assert.equal(result.attempts, 1);
  assert.equal(result.imageUrlMode, 'data-uri');
  const [request] = fetchImpl.calls;
  assert.equal(request.url, `${ENDPOINT}/chat/completions`);
  assert.equal(request.init.method, 'POST');
  assert.equal(request.init.headers.authorization, `Bearer ${SENTINEL_KEY}`);
  assert.equal(request.init.headers['content-type'], 'application/json');
  assert.equal(request.init.redirect, 'error', 'S3: a credential must never follow a redirect');
  assert.ok(request.body.includes(images[0].base64), 'the image bytes really are in the request');
});

test('M8 no key configured means no request at all', async () => {
  const fetchImpl = queuedFetch([{ status: 200 }]);
  await assert.rejects(() => call({ fetchImpl, apiKey: undefined }), (error) => error.code === VISION_CODES.UNCONFIGURED);
  assert.equal(fetchImpl.calls.length, 0, 'ZERO network calls without a credential');
});

test('M8 401 and 403 are terminal: one attempt, no retry storm', async () => {
  for (const status of [401, 403]) {
    const fetchImpl = queuedFetch([{ status, body: JSON.stringify({ error: { message: 'bad key' } }) }]);
    await assert.rejects(() => call({ fetchImpl }), (error) => error.code === VISION_CODES.UNAUTHORIZED && error.status === status);
    assert.equal(fetchImpl.calls.length, 1, `status ${status} must not be retried`);
  }
});

test('M8 404 is terminal', async () => {
  const fetchImpl = queuedFetch([{ status: 404, body: '{}' }]);
  await assert.rejects(() => call({ fetchImpl }), (error) => error.code === VISION_CODES.MODEL_NOT_FOUND);
  assert.equal(fetchImpl.calls.length, 1);
});

test('M8 429 honours Retry-After and stays within the attempt bound', async () => {
  const fetchImpl = queuedFetch([{ status: 429, headers: { 'retry-after': '0' }, body: '{}' }]);
  await assert.rejects(() => call({ fetchImpl }), (error) => error.code === VISION_CODES.RATE_LIMITED && error.attempts === 3);
  assert.equal(fetchImpl.calls.length, 3, 'bounded by maxAttempts, never unbounded');
});

test('M8 5xx retries then fails with the upstream code', async () => {
  const fetchImpl = queuedFetch([{ status: 503, body: 'upstream down' }]);
  await assert.rejects(() => call({ fetchImpl }), (error) => error.code === VISION_CODES.UPSTREAM_ERROR && error.status === 503);
  assert.equal(fetchImpl.calls.length, 3);
});

test('M8 a 400 retries once with the bare-base64 encoding, then succeeds', async () => {
  const fetchImpl = queuedFetch([
    { status: 400, body: '{"error":"unsupported image encoding"}' },
    { status: 200, body: completionBody('ok on the second encoding') },
  ]);
  const result = await call({ fetchImpl });
  assert.equal(result.imageUrlMode, 'base64');
  assert.equal(fetchImpl.calls.length, 2);
  assert.ok(fetchImpl.calls[0].body.includes(`data:image/png;base64,`), 'first attempt used the data URI');
  assert.ok(!fetchImpl.calls[1].body.includes('data:image/png'), 'second attempt used bare base64');
});

test('M8 a repeated 400 walks every request variant, then ends as BAD_REQUEST', async () => {
  const fetchImpl = queuedFetch([{ status: 400, body: '{}' }, { status: 400, body: '{}' }, { status: 400, body: '{}' }]);
  await assert.rejects(() => call({ fetchImpl }), (error) => error.code === VISION_CODES.BAD_REQUEST);
  assert.equal(fetchImpl.calls.length, 3, 'data-uri, then bare base64, then without the thinking field, then stop');
  const bodies = fetchImpl.calls.map((entry) => JSON.parse(entry.init.body));
  assert.deepEqual(
    bodies.map((body) => body.thinking?.type ?? 'omitted'),
    ['disabled', 'disabled', 'omitted'],
    'the third variant must omit thinking for endpoints that reject the field',
  );
  assert.match(bodies[1].messages[0].content[0].image_url.url, /^[\w+/=]+$/, 'the second variant sends bare base64');
});

test('M8 a hostile Retry-After cannot stall the turn: the delay is capped', async () => {
  const fetchImpl = queuedFetch([{ status: 429, headers: { 'retry-after': '999999' }, body: '{}' }]);
  const startedAt = Date.now();
  await assert.rejects(() => call({ fetchImpl }), (error) => error.code === VISION_CODES.RATE_LIMITED);
  const elapsed = Date.now() - startedAt;
  assert.equal(fetchImpl.calls.length, 3);
  assert.ok(elapsed < 1000, `a 999999-second Retry-After must be clamped to maxRetryAfterMs, took ${elapsed}ms`);
});

test('M8 a 200 with an unparseable body is BAD_RESPONSE, not a silent empty analysis', async () => {
  const fetchImpl = queuedFetch([{ status: 200, body: '<!doctype html><html>gateway</html>' }]);
  await assert.rejects(() => call({ fetchImpl }), (error) => error.code === VISION_CODES.BAD_RESPONSE);
  assert.equal(fetchImpl.calls.length, 1, 'a successful HTTP status is not retried');
});

test('M8 a cancelled turn never reaches the network', async () => {
  const fetchImpl = queuedFetch([{ status: 200 }]);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(() => call({ fetchImpl, signal: controller.signal }), (error) => error.code === VISION_CODES.ABORTED);
  assert.equal(fetchImpl.calls.length, 0);
});

test('M8 transport failures classify as NETWORK/TIMEOUT and stay bounded', async () => {
  const network = queuedFetch([new Error('getaddrinfo ENOTFOUND open.bigmodel.cn')]);
  await assert.rejects(() => call({ fetchImpl: network }), (error) => error.code === VISION_CODES.NETWORK && error.retryable === true);
  assert.equal(network.calls.length, 3);

  const timeoutError = new Error('the operation was aborted due to timeout');
  timeoutError.name = 'TimeoutError';
  const timedOut = queuedFetch([timeoutError]);
  await assert.rejects(() => call({ fetchImpl: timedOut }), (error) => error.code === VISION_CODES.TIMEOUT);
  assert.equal(timedOut.calls.length, 3);
});

test('M8 a real hung endpoint times out inside the configured budget', async () => {
  const stub = await startStub(() => {
    /* never respond */
  });
  try {
    const startedAt = Date.now();
    await assert.rejects(
      () => call({ endpoint: stub.endpoint, fetchImpl: undefined, limits: fastLimits({ maxAttempts: 1, requestTimeoutMs: 150 }) }),
      (error) => error.code === VISION_CODES.TIMEOUT,
    );
    const elapsed = Date.now() - startedAt;
    assert.ok(elapsed < 3000, `must abort promptly, took ${elapsed}ms`);
    assert.equal(stub.calls.length, 1);
  } finally {
    await stub.close();
  }
});

test('S3/S8 a redirect is refused, and the credential never reaches the redirect target', async () => {
  const target = await startStub((_call, response) => stubJson(response, 200, { choices: [{ message: { content: 'leaked' } }] }));
  const origin = await startStub((_call, response) => {
    response.writeHead(302, { location: `${target.origin}/chat/completions` });
    response.end();
  });
  try {
    await assert.rejects(
      () => call({ endpoint: origin.endpoint, limits: fastLimits({ maxAttempts: 2, baseRetryDelayMs: 1 }) }),
      (error) => error.code === VISION_CODES.NETWORK || error.code === VISION_CODES.TIMEOUT,
    );
    assert.equal(target.calls.length, 0, 'the redirect target must receive ZERO requests');
    assert.ok(origin.calls.length <= 2, 'retries stay bounded');
    for (const received of origin.calls) {
      assert.equal(received.headers.authorization, `Bearer ${SENTINEL_KEY}`);
    }
  } finally {
    await origin.close();
    await target.close();
  }
});

test('S7 a provider error body that echoes the key never reaches the failure object', async () => {
  const fetchImpl = queuedFetch([
    { status: 401, body: JSON.stringify({ error: { message: `invalid api key: ${SENTINEL_KEY}` } }) },
  ]);
  const failure = describeFailure(await call({ fetchImpl }).catch((error) => error));
  assert.equal(failure.code, VISION_CODES.UNAUTHORIZED);
  assert.ok(!JSON.stringify(failure).includes(SENTINEL_KEY), 'the echoed key must not survive');
  assert.equal(failure.message, 'the vision API rejected the API key', 'fixed, provider-independent text');
  assert.equal(JSON.stringify(failure).includes(SENTINEL_KEY.slice(0, 12)), false, 'no prefix either');
});

test('S7 detailOf keeps the provider’s own reason so quota and concurrency stay distinguishable', () => {
  const json = detailOf(429, JSON.stringify({ error: { code: '1301', message: 'quota exhausted' } }), SENTINEL_KEY);
  assert.match(json, /quota exhausted/, 'the operator must be able to read the provider’s reason');
  assert.match(json, /1301/, 'and its numeric code');

  assert.match(detailOf(500, 'upstream temporarily unavailable', SENTINEL_KEY), /temporarily unavailable/, 'non-JSON bodies still yield a readable line');
  assert.equal(detailOf(401, JSON.stringify({ error: { message: 'bad key' } }), SENTINEL_KEY), undefined, '401 never quotes the body');
  assert.equal(detailOf(403, 'forbidden', SENTINEL_KEY), undefined, '403 never quotes the body');
  assert.equal(detailOf(500, '', SENTINEL_KEY), undefined);
  assert.equal(detailOf(500, '   ', SENTINEL_KEY), undefined);
  assert.equal(detailOf(500, undefined, SENTINEL_KEY), undefined);
  assert.equal(detailOf(500, '{"error":{"message":"   "}}', SENTINEL_KEY), undefined, 'whitespace-only detail is dropped');
  assert.ok(detailOf(500, 'x'.repeat(500), undefined).length <= 200, 'the detail is capped at 200 chars');
  assert.equal(detailOf(500, `failed for ${SENTINEL_KEY}`, undefined).includes(SENTINEL_KEY), false, 'recognised shapes are still pattern-redacted');
});

test('S7 detailOf drops the whole detail when the body carries this request’s credential', () => {
  // Exact match is the only guard that survives an arbitrary provider body
  // shape: pattern redaction cannot know a provider's format.
  assert.equal(detailOf(429, `concurrency limit for ${SENTINEL_KEY}`, SENTINEL_KEY), undefined);
  assert.equal(
    detailOf(429, JSON.stringify({ error: { message: `key ${SENTINEL_KEY} rejected` } }), SENTINEL_KEY),
    undefined,
    'the guard also runs on the extracted code/message form, not only the raw body',
  );
  // A shape no pattern covers — slashes and pluses are outside every class:
  // with the secret supplied the detail is dropped, without it the value WOULD
  // survive. That is why every call site must pass the credential.
  assert.equal(detailOf(500, `bad credential ${SENTINEL_UNCOVERED}`, SENTINEL_UNCOVERED), undefined);
  assert.ok(
    detailOf(500, `bad credential ${SENTINEL_UNCOVERED}`, undefined).includes(SENTINEL_UNCOVERED),
    'documents why the exact-match argument is load-bearing rather than belt-and-braces',
  );
});

test('S7 a 429 that echoes the key yields the fixed rate-limit sentence, not a masked fragment', async () => {
  const fetchImpl = queuedFetch([
    {
      status: 429,
      headers: { 'retry-after': '0' },
      body: JSON.stringify({ error: { message: `rate limited for ${SENTINEL_KEY}` } }),
    },
  ]);
  const failure = describeFailure(await call({ fetchImpl }).catch((error) => error));
  assert.equal(failure.code, VISION_CODES.RATE_LIMITED);
  assert.equal(JSON.stringify(failure).includes(SENTINEL_KEY), false);
  assert.equal(
    failure.message,
    'the vision API rate-limited this request (account quota or concurrency); retrying shortly is safe',
    'the detail is dropped entirely, not partially masked',
  );
});

test('S7 a 429 with a harmless body keeps the provider’s reason end to end', async () => {
  const fetchImpl = queuedFetch([
    { status: 429, headers: { 'retry-after': '0' }, body: JSON.stringify({ error: { code: '1301', message: 'concurrency limit' } }) },
  ]);
  const failure = describeFailure(await call({ fetchImpl }).catch((error) => error));
  assert.equal(failure.code, VISION_CODES.RATE_LIMITED);
  assert.match(failure.message, /concurrency limit/, 'this is the whole point of adding the detail');
  assert.match(failure.message, /1301/);
});
