/**
 * Local verification gate: everything that can be checked in this workspace.
 *
 * Honest about its limits: there is no TypeScript toolchain and no bundler in
 * this environment, so "static" here is `node --check` (syntax only) — never
 * call it a type check.
 *
 * Usage: node scripts/check.mjs [--dsh-src <root>]
 */

import { execFileSync } from "node:child_process";
import { existsSync, globSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const dshSrcIndex = args.indexOf("--dsh-src");
const dshSrc = dshSrcIndex >= 0 ? resolve(args[dshSrcIndex + 1]) : resolve(root, "..", "..", "dsh-src", "dsh");

/** Run one step and report it; a throw is a failure, not a crash. */
function step(label, command, commandArgs, options = {}) {
  process.stdout.write(`\n=== ${label} ===\n`);
  try {
    execFileSync(command, commandArgs, { cwd: root, stdio: "inherit", ...options });
    return true;
  } catch {
    console.error(`\n[check] FAILED: ${label}`);
    return false;
  }
}

let ok = true;

const sources = [...globSync("lib/**/*.js", { cwd: root }), ...globSync("client/**/*.js", { cwd: root }), ...globSync("scripts/**/*.js", { cwd: root }), ...globSync("patches/**/*.mjs", { cwd: root }), ...globSync("test/**/*.mjs", { cwd: root })];
process.stdout.write(`=== syntax (node --check, syntax only — no type checker exists here) ===\n`);
for (const file of sources) {
  try {
    execFileSync(process.execPath, ["--check", file], { cwd: root, stdio: "pipe" });
    console.log(`  ok   ${file}`);
  } catch (error) {
    ok = false;
    console.error(`  FAIL ${file}\n${String(error?.stderr ?? error)}`);
  }
}

if (existsSync(join(dshSrc, "node_modules", "@deepseek-ai", "dsh-api-session-controller"))) {
  ok = step("core patch (applies + semantics)", process.execPath, ["patches/verify-patch.mjs", dshSrc]) && ok;
  ok = step("service names (cross-checked against the DSH source)", process.execPath, ["scripts/verify-service-names.mjs", dshSrc, "--self-test"]) && ok;
} else {
  console.log(`\n=== core patch ===\n  SKIP: no DSH source at ${dshSrc}; pass --dsh-src <root> to verify the patch`);
}

ok = step("host path (end to end on a simulated DSH host)", process.execPath, ["scripts/verify-host-path.mjs"]) && ok;

ok = step("cordis activation (the real runtime, not a fake context)", process.execPath, ["scripts/verify-cordis-activation.mjs", dshSrc]) && ok;

ok = step("client bundle (module-loader contract + render smoke test)", process.execPath, ["scripts/verify-client-bundle.mjs"]) && ok;

if (existsSync(join(root, "test", "run.mjs"))) {
  ok = step("unit/integration suite", process.execPath, ["test/run.mjs"]) && ok;
} else {
  console.log("\n=== unit/integration suite ===\n  SKIP: test/run.mjs is not present");
}

console.log(`\n[check] ${ok ? "PASS" : "FAIL"}`);
process.exitCode = ok ? 0 : 1;
