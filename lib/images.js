/**
 * Image access for the relay.
 *
 * Every image comes from a durable attachment reference carried by the user's
 * own message batch. The plugin never accepts a path, URL, or id from a client,
 * and never reads the attachment directory directly: bytes are obtained through
 * the host attachment service, which is what authorizes and normalizes them.
 */

import { createHash } from "node:crypto";
import { LIMITS } from "./defaults.js";

/** Media types the vision model accepts (mirrors DSH's own normalized image set). */
const SUPPORTED_MEDIA_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

/** Sniff the container so a declared media type cannot smuggle another format. */
export function sniffMediaType(bytes) {
  const data = bytes;
  if (data.length >= 8 && data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47) return "image/png";
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return "image/jpeg";
  if (data.length >= 6 && data[0] === 0x47 && data[1] === 0x49 && data[2] === 0x46 && data[3] === 0x38) return "image/gif";
  if (
    data.length >= 12 &&
    data[0] === 0x52 && data[1] === 0x49 && data[2] === 0x46 && data[3] === 0x46 &&
    data[8] === 0x57 && data[9] === 0x45 && data[10] === 0x42 && data[11] === 0x50
  ) {
    return "image/webp";
  }
  return undefined;
}

/** Content hash of the normalized bytes: the cache identity of one image. */
export function imageHash(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Collect image blocks in order from a batch of messages, including images
 * nested in tool results. Only refs carried by these messages are returned.
 * @param {readonly object[]} messages claimed messages for this step.
 * @returns {{ block: object, ref: object }[]} ordered image occurrences.
 */
export function collectImageBlocks(messages) {
  const found = [];
  const walk = (content) => {
    if (!Array.isArray(content)) return;
    for (const block of content) {
      if (block?.type === "image" && block.attachment !== undefined) found.push({ block, ref: block.attachment });
      else if (block?.type === "tool-result") walk(block.content);
    }
  };
  for (const message of Array.isArray(messages) ? messages : []) walk(message?.content);
  return found;
}

/**
 * Concatenate the text the user typed in this batch; used to condition the
 * vision request and to keep question-specific answers from being reused.
 * @param {readonly object[]} messages claimed messages.
 * @returns {string} the user's question text, trimmed.
 */
export function questionText(messages) {
  const parts = [];
  for (const message of Array.isArray(messages) ? messages : []) {
    if (!Array.isArray(message?.content)) continue;
    if (message.role !== undefined && message.role !== "user") continue;
    for (const block of message.content) if (block?.type === "text" && typeof block.text === "string") parts.push(block.text);
  }
  // Trimmed as a whole: internal formatting is the user's, but surrounding
  // whitespace must not split the cache key into a second billed request.
  return parts.join("\n").trim();
}

/**
 * Read one authorized image through the attachment service and validate it.
 * @param {object} attachments host attachment service.
 * @param {object} ref durable attachment reference.
 * @param {AbortSignal} [signal] cancellation.
 * @param {object} [limits] limits from {@link ./defaults.js}.
 * @returns {Promise<{ id: string, mediaType: string, base64: string, bytes: number }>}
 * @throws {{ code: string, message: string }} a stable, secret-free failure.
 */
export async function readAuthorizedImage(attachments, ref, signal, limits = LIMITS) {
  if (attachments === undefined || typeof attachments.readImage !== "function") {
    throw { code: "VISION_RELAY_IMAGE_UNSUPPORTED", message: "the attachment service is unavailable" };
  }
  let stored;
  try {
    stored = await attachments.readImage(ref, signal);
  } catch (error) {
    throw {
      code: "VISION_RELAY_IMAGE_UNSUPPORTED",
      message: `the image referenced by this message could not be read (${String(error?.code ?? "unreadable")})`,
    };
  }
  const bytes = stored?.data;
  if (bytes === undefined || bytes === null) {
    throw { code: "VISION_RELAY_IMAGE_UNSUPPORTED", message: "the attachment service returned no image data" };
  }
  if (bytes.byteLength > limits.maxImageBytes) {
    throw {
      code: "VISION_RELAY_IMAGE_TOO_LARGE",
      message: `the image is ${bytes.byteLength} bytes, above this plugin's ${limits.maxImageBytes}-byte limit`,
    };
  }
  const sniffed = sniffMediaType(bytes);
  const declared = stored.ref?.mediaType ?? ref?.mediaType;
  if (sniffed === undefined || !SUPPORTED_MEDIA_TYPES.has(sniffed)) {
    throw { code: "VISION_RELAY_IMAGE_UNSUPPORTED", message: "the attached image is not a png, jpeg, webp, or gif" };
  }
  if (typeof declared === "string" && declared !== sniffed) {
    throw {
      code: "VISION_RELAY_IMAGE_UNSUPPORTED",
      message: `the image declares ${declared} but its bytes are ${sniffed}`,
    };
  }
  return {
    id: imageHash(bytes),
    mediaType: sniffed,
    base64: Buffer.from(bytes).toString("base64"),
    bytes: bytes.byteLength,
  };
}

/**
 * Escape text the relay wraps around model output or a filename, so image
 * content can never break out of its own line and forge plugin instructions.
 * @param {unknown} value raw text.
 * @returns {string} single-line, delimiter-free text.
 */
export function escapeForContext(value) {
  return String(value ?? "")
    .replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, " ")
    .replace(/```/g, "'''")
    .replace(/-----/g, "—")
    .trim();
}

/**
 * Sanitize multi-line model output before it is embedded. Line breaks survive
 * (an analysis is unreadable without them), but every character that could
 * break out of a line, reorder text, or hide content is removed.
 * @param {unknown} value raw analysis text.
 * @returns {string} sanitized text.
 */
export function sanitizeAnalysisText(value) {
  return String(value ?? "")
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u2028\u2029]/g, "")
    .replace(/^-----[^\n]*$/gm, (line) => line.replace(/^-----/, "—"));
}
