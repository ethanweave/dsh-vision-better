/**
 * Bounded in-memory analysis cache.
 *
 * Key composition (all four, per the spec): image content hashes + endpoint +
 * model id + analysis-prompt version, plus a question discriminator so a
 * question-specific answer can never be replayed for a different question.
 * Nothing here is written to disk and no image bytes are retained.
 */

/** @typedef {{ key: string, text: string, at: number }} Entry */

export class AnalysisCache {
  /** @param {{ maxEntries?: number, ttlMs?: number, now?: () => number }} [options] */
  constructor({ maxEntries = 64, ttlMs = 30 * 60_000, now = Date.now } = {}) {
    this.maxEntries = Math.max(1, maxEntries);
    this.ttlMs = Math.max(1, ttlMs);
    this.now = now;
    /** @type {Map<string, Entry>} insertion-ordered, used as an LRU. */
    this.entries = new Map();
    this.hits = 0;
    this.misses = 0;
  }

  /**
   * @param {string[]} imageIds content hashes of the images in order.
   * @param {{ endpoint: string, model: string, version: string, question?: string }} scope
   * @returns {string} cache key.
   */
  static key(imageIds, { endpoint, model, version, question = "" }) {
    return JSON.stringify([imageIds, endpoint, model, version, question]);
  }

  /**
   * @param {string} key cache key.
   * @returns {string | undefined} cached analysis, or undefined on miss/expiry.
   */
  get(key) {
    const entry = this.entries.get(key);
    if (entry === undefined) {
      this.misses += 1;
      return undefined;
    }
    if (this.now() - entry.at > this.ttlMs) {
      this.entries.delete(key);
      this.misses += 1;
      return undefined;
    }
    this.entries.delete(key);
    this.entries.set(key, entry); // refresh recency
    this.hits += 1;
    return entry.text;
  }

  /**
   * @param {string} key cache key.
   * @param {string} text analysis text.
   */
  set(key, text) {
    this.entries.delete(key);
    this.entries.set(key, { key, text, at: this.now() });
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next();
      if (oldest.done === true) break;
      this.entries.delete(oldest.value);
    }
  }

  /** @returns {{ size: number, hits: number, misses: number }} */
  stats() {
    return { size: this.entries.size, hits: this.hits, misses: this.misses };
  }

  clear() {
    this.entries.clear();
  }
}
