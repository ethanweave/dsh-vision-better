/**
 * M5 / S6 — analysis cache: hit, invalidate, order sensitivity, bounds, TTL.
 *
 * The cache key is the guard against the "silently switch the model" hazard:
 * every component that changes what an analysis MEANS must change the key.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { AnalysisCache } from '../lib/cache.js';

const SCOPE = { endpoint: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4.6v-flash', version: 'vision-better-analysis-v1' };

test('M5 cache key changes for every component that changes the meaning', () => {
  const base = AnalysisCache.key(['h1'], SCOPE);
  assert.notEqual(AnalysisCache.key(['h2'], SCOPE), base, 'image identity');
  assert.notEqual(AnalysisCache.key(['h1', 'h2'], SCOPE), base, 'image count');
  assert.notEqual(AnalysisCache.key(['h2', 'h1'], SCOPE), base, 'IMAGE ORDER');
  assert.notEqual(AnalysisCache.key(['h1'], { ...SCOPE, model: 'glm-other' }), base, 'MODEL SWITCH');
  assert.notEqual(AnalysisCache.key(['h1'], { ...SCOPE, endpoint: 'https://api.z.ai/api/paas/v4' }), base, 'endpoint switch');
  assert.notEqual(AnalysisCache.key(['h1'], { ...SCOPE, version: 'v2' }), base, 'prompt version');
  assert.notEqual(AnalysisCache.key(['h1'], { ...SCOPE, question: 'different question' }), base, 'question');
  assert.equal(AnalysisCache.key(['h1'], { ...SCOPE, question: '' }), base, 'absent question equals empty question');
  assert.equal(AnalysisCache.key(['h1'], SCOPE), base, 'stable');
});

test('M5 hit returns the stored text and counts; miss returns undefined', () => {
  const cache = new AnalysisCache({ maxEntries: 4, ttlMs: 1000, now: () => 0 });
  assert.equal(cache.get('k'), undefined);
  cache.set('k', 'a red square');
  assert.equal(cache.get('k'), 'a red square');
  assert.deepEqual(cache.stats(), { size: 1, hits: 1, misses: 1 });
});

test('M5 re-setting a key does not grow the cache', () => {
  const cache = new AnalysisCache({ maxEntries: 4, now: () => 0 });
  cache.set('k', 'one');
  cache.set('k', 'two');
  assert.equal(cache.stats().size, 1);
  assert.equal(cache.get('k'), 'two', 'latest write wins');
});

test('M5/S6 eviction is bounded and drops the least recently used entry', () => {
  const cache = new AnalysisCache({ maxEntries: 3, ttlMs: 10_000, now: () => 0 });
  cache.set('a', '1');
  cache.set('b', '2');
  cache.set('c', '3');
  assert.equal(cache.get('a'), '1', 'touch "a" so "b" becomes the oldest');
  cache.set('d', '4');
  assert.equal(cache.stats().size, 3, 'never exceeds maxEntries');
  assert.equal(cache.get('b'), undefined, 'oldest evicted');
  assert.equal(cache.get('a'), '1', 'recently used survives');
  assert.equal(cache.get('d'), '4');
});

test('S6 cache stays bounded under sustained load', () => {
  const cache = new AnalysisCache({ maxEntries: 8, ttlMs: 10_000, now: () => 0 });
  for (let index = 0; index < 500; index += 1) cache.set(`k${index}`, `t${index}`);
  assert.equal(cache.stats().size, 8);
});

test('M5 TTL expiry invalidates an entry and counts as a miss', () => {
  let clock = 1000;
  const cache = new AnalysisCache({ maxEntries: 4, ttlMs: 500, now: () => clock });
  cache.set('k', 'text');
  clock = 1500;
  assert.equal(cache.get('k'), 'text', 'at exactly ttl still valid');
  clock = 1501;
  assert.equal(cache.get('k'), undefined, 'past ttl');
  assert.deepEqual(cache.stats(), { size: 0, hits: 1, misses: 1 });
});

test('M5 clear empties the cache (the settings route relies on this)', () => {
  const cache = new AnalysisCache({ now: () => 0 });
  cache.set('k', 'text');
  cache.clear();
  assert.equal(cache.stats().size, 0);
  assert.equal(cache.get('k'), undefined);
});

test('S6 the cache is in-memory only: nothing is written to disk', () => {
  const text = readFileSync(new URL('../lib/cache.js', import.meta.url), 'utf8');
  assert.doesNotMatch(text, /node:fs|writeFile|createWriteStream/);
});

test('M5 maxEntries is floored at 1 so a misconfiguration cannot disable the bound', () => {
  const cache = new AnalysisCache({ maxEntries: 0, now: () => 0 });
  cache.set('a', '1');
  cache.set('b', '2');
  assert.equal(cache.stats().size, 1);
});
