/**
 * Image fixtures: one real, structurally valid tiny image per supported media
 * type, plus the mismatch/oversize cases.
 *
 * These are genuine container bytes (not just magic-number stubs): the fixture
 * self-test at the top of 02-images.test.mjs asserts the SOI/EOI, GIF trailer and
 * RIFF/WEBP structure, so a corrupted base64 constant fails loudly instead of
 * silently weakening every downstream test.
 */

/** Real 16x16 solid red PNG (the same image the plugin's connection test sends). */
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAFklEQVR42mO4IydHEmIY1TCqYfhqAACaMxgQdrf9VwAAAABJRU5ErkJggg==';

/** Real 1x1 transparent GIF89a. */
const GIF = 'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

/** Real 1x1 lossy WebP (RIFF/WEBP + VP8 chunk). */
const WEBP = 'UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEAAUAmJaQAA3AA/vuUAAA=';

/** Real 1x1 baseline JPEG. */
const JPEG = '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/9oACAEBAAA/APn+iiigD//Z';

export const FIXTURES = Object.freeze({
  png: { mediaType: 'image/png', base64: PNG },
  jpeg: { mediaType: 'image/jpeg', base64: JPEG },
  gif: { mediaType: 'image/gif', base64: GIF },
  webp: { mediaType: 'image/webp', base64: WEBP },
});

/** @param {keyof typeof FIXTURES} name */
export const imageBytes = (name) => Buffer.from(FIXTURES[name].base64, 'base64');

/** @param {keyof typeof FIXTURES} name */
export const imageDataUri = (name) => `data:${FIXTURES[name].mediaType};base64,${FIXTURES[name].base64}`;

/**
 * A durable attachment reference as a session message carries it.
 * @param {keyof typeof FIXTURES} name fixture the ref points at
 * @param {string} [attachmentId] opaque id; defaults to one derived from the name
 */
export const imageRef = (name, attachmentId = `sha256:${name}-attachment`) => ({
  attachmentId,
  mediaType: FIXTURES[name].mediaType,
});

/** Bytes of a non-image file (a PDF header), for the unsupported-type case. */
export const notAnImage = () => Buffer.from('%PDF-1.7\nnot an image at all\n', 'utf8');

/** Bytes with an unsupported-but-real image container (BMP magic), for sniff failure. */
export const bmpBytes = () => Buffer.from([0x42, 0x4d, 0x36, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x36, 0x00, 0x00, 0x00]);

/** A PNG byte string padded past a byte cap, for the oversize case. */
export const oversizedPng = (size) => {
  const base = imageBytes('png');
  const out = Buffer.alloc(size, 0x89);
  base.copy(out, 0);
  return out;
};
