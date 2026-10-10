/**
 * Build (or rebuild) the core extension patch from an unpacked DSH install.
 *
 * The patch adds exactly one thing: a `session/image-admission` waterfall around
 * the host's text-only image rejection, so a plugin can declare that the images
 * will be handled by a converter instead of being rejected. Default behaviour is
 * unchanged when no plugin answers.
 *
 * Usage: node patches/build-patch.mjs <dsh-src-root> [out.patch]
 * where <dsh-src-root> contains node_modules/@deepseek-ai/dsh-api-session-controller.
 */

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(process.argv[2] ?? join(here, "..", "..", "..", "dsh-src", "dsh"));
const outPath = resolve(process.argv[3] ?? join(here, "0001-session-image-admission.patch"));

const PACKAGE = "dsh-api-session-controller";
/** Files carrying the text-only image rejection in 0.2.0-rc.2. */
export const TARGETS = ["lib/index.js", "lib/types/commands.js"];

/** The exact rejection this patch wraps. */
const REJECTION_MARKER = [/does not support image input/, /MODEL_DOES_NOT_SUPPORT_IMAGES/];

/**
 * Rewrite the text-only image rejection into the admission waterfall, keeping
 * the surrounding shape of the compiled file.
 *
 * Two shapes exist in 0.2.0-rc.2: a single-line `if (...) throw ...`, and a
 * multi-line `if (...) { throw ... }`. Only the guard body is replaced, so the
 * enclosing condition, its indentation, and its quote style are preserved.
 * @param {string} source file text.
 * @param {string} label file label for errors.
 * @returns {string} patched text.
 */
export function patchSource(source, label) {
  const lines = source.split("\n");
  const hits = lines
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => REJECTION_MARKER.every((pattern) => pattern.test(line)));
  if (hits.length !== 1) {
    throw new Error(`${label}: expected exactly one image-rejection line, found ${hits.length}`);
  }
  const { line, index } = hits[0];
  const indent = line.slice(0, line.length - line.trimStart().length);
  const outer = `${indent}if (`;
  // Single quotes are used by the TypeScript-authored module; keep that style.
  const q = line.includes("'session/attachment-invalid'") ? "'" : '"';
  const admission = (body) => [
    `${body}const admission = await this.ctx.waterfall(this, "session/image-admission", {`,
    `${body}  agent,`,
    `${body}  provider: current.provider,`,
    `${body}  model: current.model,`,
    `${body}  modelInfo: model`,
    `${body}}, () => Promise.resolve(void 0));`,
    `${body}if (admission?.admit !== true) throw new RemoteError(${q}session/attachment-invalid${q}, admission?.message ?? \`Model "\${current.model}" does not support image input.\`, { reason: admission?.code ?? ${q}MODEL_DOES_NOT_SUPPORT_IMAGES${q} });`,
  ];
  const replacement = line.trimStart().startsWith("if (")
    ? // Shape A: the guard and the throw share one line.
      [
        `${outer}model.inputModalities !== void 0 && !model.inputModalities.includes(${q}image${q})) {`,
        ...admission(`${indent}\t`),
        `${indent}}`,
      ]
    : // Shape B: the throw already sits inside its own guard.
      admission(indent);
  return [...lines.slice(0, index), ...replacement, ...lines.slice(index + 1)].join("\n");
}

/** Apply {@link patchSource} to one installed file. */
function patchFile(packageRoot, relative) {
  const path = join(packageRoot, relative);
  return patchSource(readFileSync(path, "utf8"), relative);
}

function main() {
  const packageRoot = join(root, "node_modules", "@deepseek-ai", PACKAGE);
  const workRoot = join(here, ".work");
  rmSync(workRoot, { recursive: true, force: true });
  const chunks = [];
  for (const relative of TARGETS) {
    const original = readFileSync(join(packageRoot, relative), "utf8");
    const patched = patchSource(original, relative);
    const a = join(workRoot, "a", relative);
    const b = join(workRoot, "b", relative);
    mkdirSync(dirname(a), { recursive: true });
    mkdirSync(dirname(b), { recursive: true });
    writeFileSync(a, original);
    writeFileSync(b, patched);
    // `git diff --no-index` exits 1 whenever the files differ, which is normal here.
    const args = ["-c", "core.autocrlf=false", "diff", "--no-index", "--no-prefix", "--binary", "-U3", `a/${relative}`, `b/${relative}`];
    let diff;
    try {
      diff = execFileSync("git", args, { cwd: workRoot, encoding: "utf8" });
    } catch (error) {
      if (typeof error?.stdout !== "string" || error.stdout === "") throw error;
      diff = error.stdout;
    }
    chunks.push(diff);
  }
  const banner = [
    `# dsh-vision-better - core extension: session/image-admission`,
    `# Target: @deepseek-ai/dsh-api-session-controller (DSH 0.2.0-rc.2, compiled lib/)`,
    `# Apply from the package root:  git apply -p1 patches/0001-session-image-admission.patch`,
    `# Regenerate:                   node patches/build-patch.mjs <dsh-src-root>`,
    ``,
  ].join("\n");
  writeFileSync(outPath, banner + chunks.join(""));
  rmSync(workRoot, { recursive: true, force: true });
  console.log(`wrote ${outPath}`);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) main();
