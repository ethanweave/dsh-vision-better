/**
 * Redaction and untrusted-text helpers. Everything that can reach a log line,
 * an error message, or the user passes through here.
 */

/** Patterns that must never survive into a log, error string, or snapshot. */
const SECRET_PATTERNS = [
  // `Bearer <token>` in any casing.
  /(bearer)\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  // Zhipu keys and lookalikes.
  /\b[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{16,}\b/g,
  /\bsk-[A-Za-z0-9_-]{8,}\b/g,
];

/**
 * Remove credential-looking substrings from arbitrary text.
 * @param {unknown} value any value; non-strings are stringified first.
 * @returns {string} the redacted text, never longer than 500 chars.
 */
export function redact(value) {
  let text = typeof value === "string" ? value : String(value ?? "");
  for (const pattern of SECRET_PATTERNS) text = text.replace(pattern, "[redacted]");
  return text.length > 500 ? `${text.slice(0, 500)}…` : text;
}

/**
 * Reduce an endpoint to its origin + path so a log line can identify the target
 * without carrying query strings or credentials planted in them.
 * @param {string} url configured endpoint.
 * @returns {string} `origin/path`, or a redacted fallback when unparsable.
 */
export function endpointLabel(url) {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return redact(url);
  }
}

/** Clamp/escape model text before it is embedded in the injected context. */
export function clampAnalysis(text, maxChars = 12_000) {
  const trimmed = String(text ?? "").trim();
  if (trimmed.length === 0) return "";
  return trimmed.length > maxChars ? `${trimmed.slice(0, maxChars)}\n[analysis truncated]` : trimmed;
}
