/**
 * Apply (or restore) the `session/image-admission` core extension on an
 * *installed* DeepSeek Harness desktop app, by rewriting its `app.asar`.
 *
 * This modifies the user's application, so it is deliberately explicit:
 *  - `--check`   only inspects: locates the archive, verifies its structure,
 *                reports whether it is already patched and whether it is writable.
 *  - `--apply`   backs the archive up to `app.asar.vision-better.bak`, rebuilds it
 *                with the two patched files, then re-reads it and verifies that
 *                the new code is present and an untouched file is byte-identical.
 *  - `--restore` copies the backup back.
 *
 * A running DSH keeps the old code in memory until it is restarted, so the
 * running session is never disrupted by this script.
 *
 * Usage:
 *   node patches/apply-installed.mjs --check
 *   node patches/apply-installed.mjs --apply   [--asar <path>]
 *   node patches/apply-installed.mjs --restore [--asar <path>]
 */

import { closeSync, copyFileSync, createReadStream, createWriteStream, existsSync, openSync, readSync, renameSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { patchSource, TARGETS } from "./build-patch.mjs";

const PACKAGE = "dsh-api-session-controller";
const ASAR_PREFIX = `dsh/node_modules/@deepseek-ai/${PACKAGE}/`;
const BLOCK_SIZE = 4194304;
const MARKER = "session/image-admission";

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const mode = args.includes("--apply") ? "apply" : args.includes("--restore") ? "restore" : "check";
const asarArg = args.indexOf("--asar");
const asarPath = resolve(asarArg >= 0 ? args[asarArg + 1] : defaultAsarPath());
const waitArg = args.indexOf("--wait-seconds");
const waitSeconds = waitArg >= 0 ? Math.max(0, Number(args[waitArg + 1]) || 0) : 900;

/** Best-effort discovery of the installed archive. */
function defaultAsarPath() {
  const candidates = [
    join(process.env.LOCALAPPDATA ?? "", "Programs", "DeepSeek Harness", "resources", "app.asar"),
    "/Applications/DeepSeek Harness.app/Contents/Resources/app.asar",
    join(process.env.HOME ?? "", ".local", "share", "deepseek-harness", "resources", "app.asar"),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0];
}

/** Read the asar header (a Pickle: [payload][headerLen][jsonLen+4][jsonLen][json…pad]). */
function readArchive(path) {
  const fd = openSync(path, "r");
  const head = Buffer.alloc(16);
  readSync(fd, head, 0, 16, 0);
  const headerPickleLen = head.readUInt32LE(4);
  const jsonSize = head.readUInt32LE(12);
  const json = Buffer.alloc(jsonSize);
  readSync(fd, json, 0, jsonSize, 16);
  return { fd, header: JSON.parse(json.toString("utf8")), dataStart: 8 + headerPickleLen, headerPickleLen, jsonSize };
}

/** Flatten the header's file tree into { path, entry } in original layout order. */
function collectFiles(header) {
  const files = [];
  const walk = (node, prefix) => {
    for (const [name, entry] of Object.entries(node.files ?? {})) {
      const path = prefix === "" ? name : `${prefix}/${name}`;
      if (entry.files !== undefined) walk(entry, path);
      else if (entry.unpacked !== true) files.push({ path, entry });
    }
  };
  walk(header, "");
  return files.sort((left, right) => Number(left.entry.offset) - Number(right.entry.offset));
}

function readFileFromArchive(fd, dataStart, entry) {
  const size = Number(entry.size);
  const buffer = Buffer.alloc(size);
  if (size > 0) readSync(fd, buffer, 0, size, dataStart + Number(entry.offset));
  return buffer;
}

/** Serialize the header the way asar does, keeping the data section 4-byte aligned. */
function serializeHeader(header) {
  const json = Buffer.from(JSON.stringify(header), "utf8");
  const padding = (4 - ((8 + json.length) % 4)) % 4;
  const pickle = Buffer.alloc(8 + json.length + padding);
  pickle.writeUInt32LE(4 + json.length, 0); // payload size: length prefix + json
  pickle.writeUInt32LE(json.length, 4);
  json.copy(pickle, 8);
  const outer = Buffer.alloc(8);
  outer.writeUInt32LE(4, 0); // size pickle payload size
  outer.writeUInt32LE(pickle.length, 4);
  return Buffer.concat([outer, pickle]);
}

/** Recompute an asar entry's integrity the way @electron/asar records it. */
function integrityOf(buffer) {
  const blocks = [];
  for (let offset = 0; offset < buffer.length; offset += BLOCK_SIZE) {
    blocks.push(createHash("sha256").update(buffer.subarray(offset, Math.min(offset + BLOCK_SIZE, buffer.length))).digest("hex"));
  }
  return { algorithm: "SHA256", hash: createHash("sha256").update(buffer).digest("hex"), blockSize: BLOCK_SIZE, blocks };
}

/** Copy one byte range from the old archive into the new stream. */
function copyRange(sourceFd, target, sourceOffset, length) {
  return new Promise((resolvePromise, reject) => {
    if (length === 0) {
      resolvePromise();
      return;
    }
    const stream = createReadStream(null, { fd: sourceFd, start: sourceOffset, end: sourceOffset + length - 1, autoClose: false });
    stream.on("data", (chunk) => target.write(chunk));
    stream.on("end", resolvePromise);
    stream.on("error", reject);
  });
}

/** Whether the archive already carries the extension. */
function isPatched(path) {
  const { fd, header, dataStart } = readArchive(path);
  try {
    const entry = collectFiles(header).find(({ path: file }) => file === `${ASAR_PREFIX}lib/index.js`);
    if (entry === undefined) return false;
    return readFileFromArchive(fd, dataStart, entry.entry).toString("utf8").includes(MARKER);
  } finally {
    closeSync(fd);
  }
}

async function apply() {
  const backup = `${asarPath}.vision-better.bak`;
  if (!existsSync(asarPath)) throw new Error(`archive not found: ${asarPath}`);
  if (isPatched(asarPath)) {
    console.log("already patched - nothing to do");
    return;
  }
  if (!existsSync(backup)) {
    copyFileSync(asarPath, backup);
    console.log(`backup written: ${backup}`);
  } else {
    console.log(`backup already present, kept: ${backup}`);
  }

  const { fd, header, dataStart } = readArchive(asarPath);
  const files = collectFiles(header);
  const sourceOffsets = files.map(({ entry }) => Number(entry.offset));

  // Pass 1: produce the patched contents and record their new sizes.
  const patched = new Map();
  for (const relative of TARGETS) {
    const index = files.findIndex(({ path }) => path === `${ASAR_PREFIX}${relative}`);
    if (index < 0) throw new Error(`archive does not contain ${ASAR_PREFIX}${relative}`);
    const original = readFileFromArchive(fd, dataStart, files[index].entry).toString("utf8");
    const replacement = Buffer.from(patchSource(original, relative), "utf8");
    patched.set(files[index].path, replacement);
    files[index].entry.size = replacement.length;
    if (files[index].entry.integrity !== undefined) files[index].entry.integrity = integrityOf(replacement);
  }

  // Pass 2: entry offsets are relative to the start of the data section, so the
  // layout starts at 0. The header length still depends on the digit counts of
  // those offsets, so iterate to the fixed point.
  let headerBuffer = serializeHeader(header);
  for (let attempt = 0; attempt < 6; attempt += 1) {
    let cursor = 0;
    for (const { entry } of files) {
      entry.offset = String(cursor);
      cursor += Number(entry.size);
    }
    const next = serializeHeader(header);
    const settled = next.length === headerBuffer.length;
    headerBuffer = next;
    if (settled) break;
  }

  // Pass 3: write the new archive, copying untouched files straight from the old one.
  const temporary = `${asarPath}.vision-better.new`;
  const target = createWriteStream(temporary);
  target.write(headerBuffer);
  for (const index of files.keys()) {
    const replacement = patched.get(files[index].path);
    if (replacement !== undefined) target.write(replacement);
    else await copyRange(fd, target, dataStart + sourceOffsets[index], Number(files[index].entry.size));
  }
  closeSync(fd);
  await new Promise((resolvePromise, reject) => {
    target.end(resolvePromise);
    target.on("error", reject);
  });

  verify(temporary);
  await swap(temporary, asarPath);
  console.log(`patched: ${asarPath}`);
  console.log("restart DeepSeek Harness for the extension to take effect");
}

/**
 * Replace the archive, waiting for a running DeepSeek Harness to exit. Windows
 * refuses to replace a file the running app has mapped, so this retries instead
 * of failing: the operator can start it, close DeepSeek Harness, and let it
 * finish.
 */
async function swap(temporary, targetPath) {
  const deadline = Date.now() + waitSeconds * 1000;
  let announced = false;
  for (;;) {
    try {
      renameSync(temporary, targetPath);
      return;
    } catch (error) {
      if (!["EPERM", "EBUSY", "EACCES"].includes(error.code)) throw error;
      if (Date.now() > deadline) {
        console.log(`\nthe rebuilt archive is verified and waiting at:\n  ${temporary}`);
        console.log(`Close DeepSeek Harness completely and re-run this script (waited ${waitSeconds}s).`);
        process.exitCode = 3;
        return;
      }
      if (!announced) {
        console.log("\nDeepSeek Harness is still running and holds app.asar open.");
        console.log("Close it completely now - this script will finish the swap automatically...");
        announced = true;
      }
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 2000));
    }
  }
}

function verify(path) {
  const { fd, header, dataStart } = readArchive(path);
  try {
    const files = collectFiles(header);
    for (const relative of TARGETS) {
      const found = files.find(({ path: file }) => file === `${ASAR_PREFIX}${relative}`);
      const text = readFileFromArchive(fd, dataStart, found.entry).toString("utf8");
      if (!text.includes(MARKER)) throw new Error(`verification failed: ${relative} has no ${MARKER}`);
      if (!text.includes("MODEL_DOES_NOT_SUPPORT_IMAGES")) throw new Error(`verification failed: ${relative} lost its default rejection`);
    }
    // One untouched file must be byte-identical to the original archive.
    const sample = files.find(({ path: file }) => file === `${ASAR_PREFIX}package.json`);
    if (sample !== undefined && existsSync(`${asarPath}.vision-better.bak`)) {
      const backup = readArchive(`${asarPath}.vision-better.bak`);
      try {
        const before = readFileFromArchive(backup.fd, backup.dataStart, collectFiles(backup.header).find(({ path: file }) => file === `${ASAR_PREFIX}package.json`).entry);
        const after = readFileFromArchive(fd, dataStart, sample.entry);
        if (!before.equals(after)) throw new Error("verification failed: an untouched file changed");
      } finally {
        closeSync(backup.fd);
      }
    }
    console.log(`verified: both target files carry ${MARKER}; an untouched file is byte-identical`);
  } finally {
    closeSync(fd);
  }
}

async function restore() {
  const backup = `${asarPath}.vision-better.bak`;
  if (!existsSync(backup)) throw new Error(`no backup at ${backup}`);
  // Copy first, then swap by rename, so a locked archive is reported instead of
  // leaving a half-written application behind.
  const staged = `${asarPath}.vision-better.restore`;
  copyFileSync(backup, staged);
  await swap(staged, asarPath);
  console.log(`restored ${asarPath} from ${backup} (${statSync(asarPath).size} bytes)`);
  console.log("restart DeepSeek Harness for the restore to take effect");
}

/** Inspect the installed archive without changing it. */
function check() {
  console.log(`archive: ${asarPath}`);
  if (!existsSync(asarPath)) {
    console.log("  missing");
    return;
  }
  const { fd, header, dataStart } = readArchive(asarPath);
  try {
    const files = collectFiles(header);
    const targets = TARGETS.map((relative) => files.find(({ path }) => path === `${ASAR_PREFIX}${relative}`));
    console.log(`  entries: ${files.length}, targets found: ${targets.filter(Boolean).length}/${TARGETS.length}`);
    console.log(`  patched: ${isPatched(asarPath)}`);
    console.log(`  backup: ${existsSync(`${asarPath}.vision-better.bak`) ? "present" : "absent"}`);
    const version = readFileFromArchive(fd, dataStart, files.find(({ path }) => path === `${ASAR_PREFIX}package.json`).entry).toString("utf8");
    console.log(`  package:@deepseek-ai/${PACKAGE}@${JSON.parse(version).version}`);
  } finally {
    closeSync(fd);
  }
  try {
    const fd = openSync(asarPath, "r+");
    closeSync(fd);
    console.log("  writable: yes");
  } catch (error) {
    console.log(`  writable: NO (${error.code}) - close DeepSeek Harness completely, then retry`);
  }
}

if (mode === "apply") await apply();
else if (mode === "restore") restore();
else check();
