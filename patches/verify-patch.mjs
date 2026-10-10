/**
 * Verify the core extension patch against the real DSH 0.2.0-rc.2 artifacts.
 *
 * Two independent checks:
 *  1. `git apply` the committed patch onto pristine copies of the shipped files
 *     (proves the diff is valid and applies byte-exactly).
 *  2. Execute the patched `if (hasImage) { ... }` guard in isolation with a fake
 *     cordis context, for every admission outcome (proves the semantics: default
 *     behaviour is preserved, an admitting listener lets the prompt through).
 *
 * Usage: node patches/verify-patch.mjs [dsh-src-root]
 */

import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const sourceRoot = resolve(process.argv[2] ?? join(here, "..", "..", "..", "dsh-src", "dsh"));
const packageDir = join(sourceRoot, "node_modules", "@deepseek-ai", "dsh-api-session-controller");
const patchPath = join(here, "0001-session-image-admission.patch");

const failures = [];
function check(name, condition, detail = "") {
  if (condition) console.log(`  ok   ${name}`);
  else {
    failures.push(`${name}${detail === "" ? "" : `: ${detail}`}`);
    console.log(`  FAIL ${name}${detail === "" ? "" : `: ${detail}`}`);
  }
}

/** Apply the committed patch onto pristine copies and return the temp root. */
function applyPatch() {
  const work = join(tmpdir(), `vision-better-patch-${process.pid}`);
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
  for (const relative of ["lib/index.js", "lib/types/commands.js"]) {
    const target = join(work, relative);
    mkdirSync(dirname(target), { recursive: true });
    cpSync(join(packageDir, relative), target);
  }
  writeFileSync(join(work, "patch.diff"), readFileSync(patchPath));
  execFileSync("git", ["apply", "-p1", "--verbose", "patch.diff"], { cwd: work, stdio: "pipe" });
  return work;
}

/** Extract the balanced `if (hasImage) { ... }` guard from a patched file. */
export function extractGuard(source) {
  const lines = source.split("\n");
  const start = lines.findIndex((line) => line.trim() === "if (hasImage) {");
  if (start < 0) throw new Error("could not locate the image guard");
  let depth = 0;
  for (let index = start; index < lines.length; index += 1) {
    for (const character of lines[index]) {
      if (character === "{") depth += 1;
      else if (character === "}") depth -= 1;
    }
    if (depth === 0) return lines.slice(start, index + 1).join("\n");
  }
  throw new Error("unbalanced image guard");
}

/** Execute the extracted guard with a fake context. */
async function runGuard(guard, { waterfall, modelInfo }) {
  const calls = { waterfall: 0, resolveModelInfo: 0 };
  const self = {
    agents: { selectionFor: () => ({ current: { provider: "workbuddy", model: "deepseek-v4.1-flash" } }) },
    ctx: {
      llm: {
        resolveModelInfo: async () => {
          calls.resolveModelInfo += 1;
          return modelInfo;
        },
      },
      waterfall: async (...args) => {
        calls.waterfall += 1;
        return waterfall(...args);
      },
    },
  };
  class FakeRemoteError extends Error {
    constructor(code, message, data) {
      super(message);
      this.code = code;
      this.data = data;
    }
  }
  const body = new Function("self", "RemoteError", "hasImage", "agent", `return (async () => {\n${guard}\n})();`);
  let thrown;
  try {
    await body.call(self, self, FakeRemoteError, true, { id: "session-1" });
  } catch (error) {
    thrown = error;
  }
  return { thrown, calls };
}

async function main() {
  console.log(`patch:  ${patchPath}`);
  console.log(`target: ${packageDir}\n`);

  console.log("1. git apply");
  const work = applyPatch();
  check("patch applies cleanly to pristine lib/index.js and lib/types/commands.js", true);

  console.log("\n2. patched guard semantics");
  const guard = extractGuard(readFileSync(join(work, "lib/index.js"), "utf8"));
  check("guard mentions the waterfall", guard.includes('"session/image-admission"'));
  check("guard is the only new decision point", (guard.match(/waterfall\(/g) ?? []).length === 1);

  const textOnly = { inputModalities: ["text"] };

  const silent = await runGuard(guard, { waterfall: () => undefined, modelInfo: textOnly });
  check("no listener -> rejection preserved", silent.thrown?.data?.reason === "MODEL_DOES_NOT_SUPPORT_IMAGES", JSON.stringify(silent.thrown?.message));
  check("no listener -> waterfall is consulted", silent.calls.waterfall === 1);

  const admitted = await runGuard(guard, { waterfall: () => ({ admit: true }), modelInfo: textOnly });
  check("admit:true -> prompt is admitted", admitted.thrown === undefined);

  const guided = await runGuard(guard, {
    waterfall: () => ({ admit: false, code: "VISION_RELAY_UNCONFIGURED", message: "configure the relay" }),
    modelInfo: textOnly,
  });
  check("admit:false + code -> styled rejection", guided.thrown?.data?.reason === "VISION_RELAY_UNCONFIGURED");
  check("admit:false + message -> message passes through", guided.thrown?.message === "configure the relay");

  const native = await runGuard(guard, { waterfall: () => ({ admit: true }), modelInfo: { inputModalities: ["text", "image"] } });
  check("image-capable model -> no waterfall, no throw", native.calls.waterfall === 0 && native.thrown === undefined);

  rmSync(work, { recursive: true, force: true });

  console.log(`\n${failures.length === 0 ? "PASS" : `FAIL (${failures.length})`}`);
  if (failures.length > 0) {
    for (const failure of failures) console.error(` - ${failure}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  await main();
}
