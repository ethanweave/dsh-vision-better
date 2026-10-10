/**
 * M3 / M4 — image access, ordering, and the "only authorized bytes" boundary.
 *
 * The relay's only byte source is the host attachment service. These tests
 * assert that structurally (the module imports no filesystem API) and
 * behaviourally (a ref may carry a path or url and it is still never used).
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  collectImageBlocks,
  escapeForContext,
  imageHash,
  questionText,
  readAuthorizedImage,
  sniffMediaType,
} from '../lib/images.js';
import { FIXTURES, bmpBytes, imageBytes, imageRef, notAnImage, oversizedPng } from './fixtures/images.mjs';
import { attachmentMap, fastLimits, makeAttachments, userMessage } from './fixtures/harness.mjs';

const source = (file) => readFileSync(new URL(`../lib/${file}`, import.meta.url), 'utf8');

test('fixtures are real, structurally valid images (self-test)', () => {
  const png = imageBytes('png');
  assert.deepEqual([...png.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47], 'PNG signature');
  assert.deepEqual([...png.subarray(png.length - 8, png.length - 4)], [0x49, 0x45, 0x4e, 0x44], 'PNG IEND');

  const jpeg = imageBytes('jpeg');
  assert.deepEqual([...jpeg.subarray(0, 3)], [0xff, 0xd8, 0xff], 'JPEG SOI');
  assert.deepEqual([...jpeg.subarray(jpeg.length - 2)], [0xff, 0xd9], 'JPEG EOI');

  const gif = imageBytes('gif');
  assert.equal(gif.subarray(0, 6).toString('latin1'), 'GIF89a', 'GIF header');
  assert.equal(gif[gif.length - 1], 0x3b, 'GIF trailer');

  const webp = imageBytes('webp');
  assert.equal(webp.subarray(0, 4).toString('latin1'), 'RIFF', 'RIFF header');
  assert.equal(webp.subarray(8, 12).toString('latin1'), 'WEBP', 'WEBP fourcc');

  for (const [name, fixture] of Object.entries(FIXTURES)) {
    assert.ok(imageBytes(name).length > 20, `${name} fixture should not be a bare magic stub`);
    assert.equal(sniffMediaType(imageBytes(name)), fixture.mediaType, `${name} sniffs as declared`);
  }
});

test('sniffMediaType rejects non-images and truncated headers', () => {
  assert.equal(sniffMediaType(notAnImage()), undefined);
  assert.equal(sniffMediaType(bmpBytes()), undefined);
  assert.equal(sniffMediaType(Buffer.alloc(0)), undefined);
  assert.equal(sniffMediaType(Buffer.from([0x89, 0x50, 0x4e])), undefined, 'truncated PNG header');
  assert.equal(sniffMediaType(Buffer.from([0xff, 0xd8])), undefined, 'truncated JPEG header');
});

test('imageHash is a stable sha256 of the bytes', () => {
  const bytes = imageBytes('png');
  assert.equal(imageHash(bytes), createHash('sha256').update(bytes).digest('hex'));
  assert.match(imageHash(bytes), /^[0-9a-f]{64}$/);
  assert.equal(imageHash(bytes), imageHash(Buffer.from(bytes)), 'same bytes, same id');
  const changed = Buffer.from(bytes);
  changed[changed.length - 1] ^= 0xff;
  assert.notEqual(imageHash(changed), imageHash(bytes), 'one byte changed, new id');
});

test('M3 collectImageBlocks preserves message order and reaches into tool results', () => {
  const messages = [
    userMessage({ images: [imageRef('png', 'a')], text: 'first' }),
    { id: 'm2', role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
    {
      id: 'm3',
      role: 'tool',
      content: [
        { type: 'tool-result', content: [{ type: 'image', attachment: imageRef('gif', 'b') }] },
        { type: 'image', attachment: imageRef('jpeg', 'c') },
      ],
    },
  ];
  const found = collectImageBlocks(messages);
  assert.deepEqual(
    found.map((entry) => entry.ref.attachmentId),
    ['a', 'b', 'c'],
    'ordered, with the nested tool-result image between the two direct ones',
  );
  assert.equal(found[0].block.type, 'image');
});

test('M3 collectImageBlocks ignores malformed input instead of throwing', () => {
  assert.deepEqual(collectImageBlocks(undefined), []);
  assert.deepEqual(collectImageBlocks([]), []);
  assert.deepEqual(collectImageBlocks([{ content: undefined }]), []);
  assert.deepEqual(collectImageBlocks([{ content: [{ type: 'image' }] }]), [], 'image block with no attachment');
  assert.deepEqual(collectImageBlocks([{ content: 'not an array' }]), []);
});

test('questionText collects only the user-role text and trims the whole result', () => {
  const messages = [
    { id: 'a', role: 'user', content: [{ type: 'text', text: '  what is this?  ' }] },
    { id: 'b', role: 'assistant', content: [{ type: 'text', text: 'ignored' }] },
    { id: 'c', role: 'user', content: [{ type: 'text', text: 'and this?' }, { type: 'text', text: 'second part' }] },
  ];
  // Whitespace INSIDE a text block is preserved: only the joined result is
  // trimmed. That whitespace is part of the cache key, so the same question with
  // a trailing space is a different key (and a second billed request).
  assert.equal(questionText(messages), 'what is this?  \nand this?\nsecond part');
  assert.equal(questionText(undefined), '');
  assert.equal(questionText([{ role: 'user', content: [{ type: 'image', attachment: {} }] }]), '');
  assert.equal(questionText([{ role: 'user', content: [{ type: 'text', text: 'q' }] }]), questionText([{ role: 'user', content: [{ type: 'text', text: 'q' }] }]));
});

test('questionText latent risk: a relay context message with role "user" counts as the question', () => {
  // Documented current behaviour, not an assertion that it is right. The host
  // claims only the fresh inbox batch for a step, so today this message is not
  // normally re-claimed; if that ever changes, the relay would condition a new
  // analysis on its own previous analysis (and churn the cache key each turn).
  const relayContext = {
    id: 'ctx',
    role: 'user',
    source: { kind: 'vision-better' },
    content: [{ type: 'text', text: '[dsh-vision-better] previous analysis text' }],
  };
  const messages = [relayContext, userMessage({ images: [imageRef('png', 'a')], text: 'new question' })];
  assert.match(questionText(messages), /previous analysis text/, 'source kind is not consulted');
});

test('readAuthorizedImage returns normalized bytes for every supported type', async () => {
  for (const name of Object.keys(FIXTURES)) {
    const bytes = imageBytes(name);
    const attachments = makeAttachments(attachmentMap([[`id-${name}`, { data: bytes }]]));
    const image = await readAuthorizedImage(attachments, imageRef(name, `id-${name}`));
    assert.equal(image.mediaType, FIXTURES[name].mediaType, name);
    assert.equal(image.id, createHash('sha256').update(bytes).digest('hex'), name);
    assert.equal(image.bytes, bytes.length, name);
    assert.equal(image.base64, bytes.toString('base64'), name);
    assert.deepEqual(Buffer.from(image.base64, 'base64'), Buffer.from(bytes), name);
  }
});

test('readAuthorizedImage fails closed: no service, service error, no data', async () => {
  await assert.rejects(
    () => readAuthorizedImage(undefined, imageRef('png')),
    (error) => error.code === 'VISION_RELAY_IMAGE_UNSUPPORTED' && /attachment service is unavailable/.test(error.message),
  );
  await assert.rejects(
    () => readAuthorizedImage({}, imageRef('png')),
    (error) => error.code === 'VISION_RELAY_IMAGE_UNSUPPORTED',
  );
  await assert.rejects(
    () => readAuthorizedImage(makeAttachments(attachmentMap([])), imageRef('png')),
    (error) => error.code === 'VISION_RELAY_IMAGE_UNSUPPORTED' && /could not be read \(ENOENT\)/.test(error.message),
  );
  await assert.rejects(
    () => readAuthorizedImage({ readImage: async () => ({}) }, imageRef('png')),
    (error) => error.code === 'VISION_RELAY_IMAGE_UNSUPPORTED' && /returned no image data/.test(error.message),
  );
});

test('readAuthorizedImage rejects an oversized image with its own code', async () => {
  const bytes = oversizedPng(4096);
  const attachments = makeAttachments(attachmentMap([['big', { data: bytes }]]));
  await assert.rejects(
    () => readAuthorizedImage(attachments, imageRef('png', 'big'), undefined, fastLimits({ maxImageBytes: 1024 })),
    (error) => error.code === 'VISION_RELAY_IMAGE_TOO_LARGE' && error.message.includes('4096') && error.message.includes('1024'),
  );
});

test('readAuthorizedImage rejects an unsupported container and a declared/sniffed mismatch', async () => {
  const pdf = makeAttachments(attachmentMap([['pdf', { data: notAnImage(), mediaType: 'image/png' }]]));
  await assert.rejects(
    () => readAuthorizedImage(pdf, imageRef('png', 'pdf')),
    (error) => error.code === 'VISION_RELAY_IMAGE_UNSUPPORTED' && /not a png, jpeg, webp, or gif/.test(error.message),
  );

  const bmp = makeAttachments(attachmentMap([['bmp', { data: bmpBytes(), mediaType: 'image/png' }]]));
  await assert.rejects(
    () => readAuthorizedImage(bmp, imageRef('png', 'bmp')),
    (error) => error.code === 'VISION_RELAY_IMAGE_UNSUPPORTED',
  );

  // Bytes are a JPEG, the message declares PNG: the sniff wins and the mismatch fails.
  const mismatch = makeAttachments(attachmentMap([['m', { data: imageBytes('jpeg'), mediaType: 'image/png' }]]));
  await assert.rejects(
    () => readAuthorizedImage(mismatch, imageRef('png', 'm')),
    (error) =>
      error.code === 'VISION_RELAY_IMAGE_UNSUPPORTED' &&
      /declares image\/png but its bytes are image\/jpeg/.test(error.message),
  );
});

test('M4 the attachment service is the only byte source (no filesystem access in images.js)', async () => {
  assert.doesNotMatch(source('images.js'), /node:fs|node:fs\/promises|readFileSync|createReadStream/, 'images.js must not touch the filesystem');

  // A ref that carries a real host path and a file: URL must still yield nothing,
  // because only attachments.readImage is ever consulted.
  const dir = mkdtempSync(join(tmpdir(), 'relay-fixture-'));
  try {
    const path = join(dir, 'secret.png');
    writeFileSync(path, imageBytes('png'));
    const attachments = makeAttachments(attachmentMap([]));
    await assert.rejects(
      () =>
        readAuthorizedImage(attachments, {
          attachmentId: 'not-in-this-session',
          mediaType: 'image/png',
          path,
          url: `file://${path.replaceAll('\\', '/')}`,
        }),
      (error) => error.code === 'VISION_RELAY_IMAGE_UNSUPPORTED' && !error.message.includes(path),
    );
    assert.equal(attachments.calls.length, 1, 'exactly one authorization attempt');
    assert.equal(attachments.calls[0].attachmentId, 'not-in-this-session');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('escapeForContext strips control characters and fences, and trims', () => {
  assert.equal(escapeForContext('  hello  '), 'hello');
  assert.equal(escapeForContext('a\u0000b\u0007c'), 'a b c');
  assert.equal(escapeForContext('before ``` after'), "before ''' after");
  assert.equal(escapeForContext(undefined), '');
  assert.equal(escapeForContext(null), '');
  assert.equal(escapeForContext(42), '42');
});
