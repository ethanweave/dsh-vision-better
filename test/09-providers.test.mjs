import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { baseConfig, describeApiKey, readConfig, resolveApiKey, writeApiKey, writeConfig } from '../lib/config.js';
import { callVision } from '../lib/glm.js';
import { buildProviderRequest, listProviderModels, parseProviderResponse } from '../lib/providers.js';
import { makeCredentials, makeCtx } from './fixtures/harness.mjs';
import { registerRoutes } from '../lib/routes.js';
import { AnalysisCache } from '../lib/cache.js';

const images = [{ mediaType: 'image/png', base64: 'aGVsbG8=' }];
const KEY = 'provider-test-key';

test('provider adapters emit the expected endpoint, auth header and image body for each protocol', () => {
  const common = { endpoint: 'https://api.example/v1', model: 'vision-model', apiKey: KEY, images, prompt: 'describe image', maxTokens: 99 };

  const openai = buildProviderRequest({ ...common, provider: 'openai-compatible' });
  assert.equal(openai.url, 'https://api.example/v1/chat/completions');
  assert.equal(openai.headers.authorization, `Bearer ${KEY}`);
  assert.equal(JSON.parse(openai.body).messages[0].content[0].image_url.url, 'data:image/png;base64,aGVsbG8=');

  const anthropic = buildProviderRequest({ ...common, provider: 'anthropic' });
  assert.equal(anthropic.url, 'https://api.example/v1/messages');
  assert.equal(anthropic.headers['x-api-key'], KEY);
  assert.equal(JSON.parse(anthropic.body).messages[0].content[0].source.data, 'aGVsbG8=');

  const google = buildProviderRequest({ ...common, provider: 'google' });
  assert.equal(google.url, 'https://api.example/v1/models/vision-model:generateContent');
  assert.equal(google.headers['x-goog-api-key'], KEY);
  assert.equal(JSON.parse(google.body).contents[0].parts[0].inlineData.data, 'aGVsbG8=');
});

test('each protocol parser extracts answer text and ignores reasoning-only payloads', () => {
  assert.equal(parseProviderResponse('openai-compatible', JSON.stringify({ choices: [{ message: { content: 'OpenAI answer' } }] })), 'OpenAI answer');
  assert.equal(parseProviderResponse('anthropic', JSON.stringify({ content: [{ type: 'thinking', thinking: 'hidden' }, { type: 'text', text: 'Anthropic answer' }] })), 'Anthropic answer');
  assert.equal(parseProviderResponse('google', JSON.stringify({ candidates: [{ content: { parts: [{ text: 'Gemini answer' }] } }] })), 'Gemini answer');
  assert.equal(parseProviderResponse('anthropic', '{bad json}'), undefined);
});

test('model catalogs use protocol-specific auth without putting the key in the URL', async () => {
  const seen = [];
  const fetchImpl = async (url, options) => {
    seen.push({ url, options });
    const body = url.includes('generativelanguage')
      ? { models: [{ name: 'models/gemini-2.5-flash', supportedGenerationMethods: ['generateContent'] }] }
      : url.includes('anthropic')
        ? { data: [{ id: 'claude-vision' }] }
        : { data: [{ id: 'vision-a' }, { id: 'vision-b' }] };
    return { ok: true, status: 200, text: async () => JSON.stringify(body) };
  };
  const endpoint = 'https://api.example/v1';
  assert.deepEqual(await listProviderModels({ provider: 'openai-compatible', endpoint, apiKey: KEY, fetchImpl }), ['vision-a', 'vision-b']);
  assert.deepEqual(await listProviderModels({ provider: 'anthropic', endpoint: 'https://api.anthropic.com/v1', apiKey: KEY, fetchImpl }), ['claude-vision']);
  assert.deepEqual(await listProviderModels({ provider: 'google', endpoint: 'https://generativelanguage.googleapis.com/v1beta', apiKey: KEY, fetchImpl }), ['gemini-2.5-flash']);
  assert.ok(seen.every(({ url }) => !url.includes(KEY)), 'API key must never appear in URL');
  assert.equal(seen[0].options.headers.authorization, `Bearer ${KEY}`);
  assert.equal(seen[1].options.headers['x-api-key'], KEY);
  assert.equal(seen[2].options.headers['x-goog-api-key'], KEY);
});

test('vision requests can complete through Anthropic and Google protocols', async () => {
  for (const [provider, endpoint, model, answer] of [
    ['anthropic', 'https://api.anthropic.com/v1', 'claude-vision', { content: [{ type: 'text', text: 'visible details' }] }],
    ['google', 'https://generativelanguage.googleapis.com/v1beta', 'gemini-vision', { candidates: [{ content: { parts: [{ text: 'visible details' }] } }] }],
  ]) {
    let request;
    const result = await callVision({
      provider, endpoint, model, apiKey: KEY, images, prompt: 'describe', maxTokens: 64,
      fetchImpl: async (url, options) => {
        request = { url, options };
        return { ok: true, status: 200, headers: new Headers(), text: async () => JSON.stringify(answer) };
      },
      limits: { maxRequestBytes: 10000, maxAttempts: 1, requestTimeoutMs: 500, baseRetryDelayMs: 1, maxRetryAfterMs: 1 },
    });
    assert.equal(result.text, 'visible details');
    assert.ok(!request.url.includes(KEY));
  }
});

test('provider, endpoint and model survive a fresh configuration read after saving', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vision-provider-'));
  try {
    const path = join(dir, 'vision-better.json');
    const config = { provider: 'anthropic', endpoint: 'https://api.anthropic.com/v1', model: 'claude-vision', enabled: true };
    assert.equal(writeConfig(config, path).ok, true);
    const readAfterRestart = readConfig(baseConfig(), path);
    assert.deepEqual(readAfterRestart, config);
    assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), config);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('changing only the provider also selects that protocol default endpoint and model', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vision-provider-defaults-'));
  try {
    const path = join(dir, 'vision-better.json');
    assert.equal(writeConfig({ provider: 'anthropic' }, path).ok, true);
    assert.deepEqual(readConfig(baseConfig(), path), {
      provider: 'anthropic', endpoint: 'https://api.anthropic.com/v1', model: 'claude-3-5-sonnet-latest', enabled: true,
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('legacy GLM credentials remain readable and a newly saved generic key takes effect', async () => {
  const credentials = makeCredentials({ GLM_API_KEY: 'legacy-key' });
  const { ctx } = makeCtx({ credentials });
  assert.deepEqual(await resolveApiKey(ctx), { value: 'legacy-key' });
  assert.equal((await describeApiKey(ctx)).legacy, true);
  assert.equal((await writeApiKey(ctx, 'new-vision-key')).ok, true);
  assert.deepEqual(await resolveApiKey(ctx), { value: 'new-vision-key' });
  // `legacy` flags the *reference name* (the pre-provider GLM_API_KEY), so it
  // stays while that reference is the one in use; the value is never exposed.
  assert.equal((await describeApiKey(ctx)).legacy, true);
  assert.equal((await writeApiKey(ctx, undefined)).ok, true);
  assert.equal(credentials.store.size, 0);
  assert.equal((await describeApiKey(ctx)).legacy, undefined, 'unset: nothing is configured, so no flag');
});

test('a launch-environment key stays read-only and cannot be shadowed by a UI save', async () => {
  const mutations = [];
  const credentials = {
    async resolve(ref) { return ref === 'GLM_API_KEY' ? { value: 'environment-key', source: 'env' } : undefined; },
    async describe(ref) { return ref === 'GLM_API_KEY' ? { configured: true, source: 'env', writable: false } : { configured: false, writable: true }; },
    async set(...args) { mutations.push(args); },
    async unset() {},
  };
  const { ctx } = makeCtx({ credentials });
  const result = await writeApiKey(ctx, 'attempted-replacement');
  assert.equal(result.ok, false);
  assert.match(result.message, /launch environment/);
  assert.deepEqual(mutations, []);
  assert.deepEqual(await resolveApiKey(ctx), { value: 'environment-key' });
});

test('failed environment-key replacement rolls the provider/model form back to the last saved config', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'vision-env-rollback-'));
  try {
    const configPath = join(dir, 'vision-better.json');
    const oldConfig = { provider: 'openai-compatible', endpoint: 'https://proxy.example/v1', model: 'old-vision', enabled: true };
    assert.equal(writeConfig(oldConfig, configPath).ok, true);
    const credentials = {
      async resolve(ref) { return ref === 'GLM_API_KEY' ? { value: 'environment-key', source: 'env' } : undefined; },
      async describe(ref) { return ref === 'GLM_API_KEY' ? { configured: true, source: 'env', writable: false } : { configured: false, writable: true }; },
      async set() { throw new Error('must not attempt to shadow the environment'); },
      async unset() {},
    };
    const handlers = new Map();
    const { ctx } = makeCtx({ credentials, webServer: { register(spec) { handlers.set(spec.path, spec.handler); return () => {}; } } });
    registerRoutes({ ctx, configPath, baseConfig: baseConfig(), cache: new AnalysisCache(), logger: { warn() {}, info() {} } });
    const response = { writeHead(status) { this.status = status; return this; }, end(body) { this.body = body; } };
    await handlers.get('/vision-better/api/config')({
      method: 'POST', headers: { 'content-type': 'application/json' },
      async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify({ provider: 'anthropic', endpoint: 'https://api.anthropic.com/v1', model: 'claude-vision', enabled: true, apiKey: 'new-key' })); },
    }, response);
    assert.equal(response.status, 400);
    assert.deepEqual(readConfig(baseConfig(), configPath), oldConfig, 'a rejected key must not leave partially updated provider settings');
    assert.match(JSON.parse(response.body).error, /launch environment/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
