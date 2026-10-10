/**
 * M1 — routing. The relay must run for every model that has not explicitly
 * declared image input, and must stay completely silent for one that has.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { routeFor, routeReason } from '../lib/routing.js';

test('M1 native route: inputModalities explicitly includes "image"', () => {
  assert.equal(routeFor({ inputModalities: ['text', 'image'] }), 'native');
  assert.equal(routeFor({ inputModalities: ['image'] }), 'native');
  assert.equal(routeFor({ inputModalities: ['text', 'image', 'audio'] }), 'native');
  assert.equal(routeReason({ inputModalities: ['text', 'image'] }), 'declared-image');
});

test('M1 declared text-only route: modality list without "image"', () => {
  assert.equal(routeFor({ inputModalities: ['text'] }), 'relay');
  assert.equal(routeReason({ inputModalities: ['text'] }), 'declared-text-only');
});

test('M1 undeclared capability routes to the relay (unknown is never native)', () => {
  assert.equal(routeFor(undefined), 'relay');
  assert.equal(routeFor({}), 'relay');
  assert.equal(routeFor({ inputModalities: undefined }), 'relay');
  assert.equal(routeFor(null), 'relay');
  assert.equal(routeFor([]), 'relay');
  assert.equal(routeReason(undefined), 'undeclared');
  assert.equal(routeReason({}), 'undeclared');
});

test('M1 routing is case-sensitive and exact (documented, not an accident)', () => {
  // A model that declares "IMAGE" is not claiming the documented modality token.
  assert.equal(routeFor({ inputModalities: ['IMAGE'] }), 'relay');
  assert.equal(routeFor({ inputModalities: ['image/png'] }), 'relay');
});

test('M1 routing is a pure decision: no service, no network, no side effect', () => {
  const modelInfo = { inputModalities: ['text'] };
  const snapshot = JSON.stringify(modelInfo);
  assert.equal(routeFor(modelInfo), 'relay');
  assert.equal(routeReason(modelInfo), 'declared-text-only');
  assert.equal(JSON.stringify(modelInfo), snapshot, 'routing must not mutate model info');
});
