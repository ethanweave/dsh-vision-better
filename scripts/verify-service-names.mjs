/**
 * Cross-check every Cordis service name this plugin uses against the package
 * that registers it in the installed DSH source.
 *
 * This exists because "webserver" instead of "webServer" cost a debugging
 * round-trip: the wrong name makes `ctx.inject` wait forever and `ctx.get`
 * return undefined, so the settings API silently never mounted while the
 * settings page rendered normally.
 *
 * Usage: node scripts/verify-service-names.mjs [dsh-src-root] [--self-test]
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const selfTest = args.includes("--self-test");
const dshSrc = resolve(args.find((argument) => !argument.startsWith("--")) ?? join(root, "..", "..", "dsh-src", "dsh"));

/** service name -> the package that registers it. */
const SERVICES = {
  llm: "dsh-llm",
  attachments: "dsh-attachment",
  credentials: "dsh-credentials",
  sessionProjections: "dsh-session-projection",
  webServer: "dsh-host-webserver",
};

const failures = [];
function check(name, condition, detail = "") {
  if (condition) console.log(`  ok   ${name}`);
  else {
    failures.push(`${name}${detail === "" ? "" : `: ${detail}`}`);
    console.log(`  FAIL ${name}${detail === "" ? "" : `: ${detail}`}`);
  }
}

/** Every `super(ctx, "<name>")` a package registers. */
function registeredNames(packageName) {
  const file = join(dshSrc, "node_modules", "@deepseek-ai", packageName, "lib", "index.js");
  if (!existsSync(file)) return undefined;
  return [...readFileSync(file, "utf8").matchAll(/super\(ctx,\s*"([^"]+)"\)/g)].map((match) => match[1]);
}

function main() {
  console.log(`DSH source: ${dshSrc}`);
  const values = new Set();
  for (const [service, packageName] of Object.entries(SERVICES)) {
    const names = registeredNames(packageName);
    if (names === undefined) {
      console.log(`  SKIP ${service}: ${packageName} not present at this source root`);
      continue;
    }
    check(`${packageName} registers "${service}"`, names.includes(service), `registered: ${names.join(", ")}`);
    values.add(service);
  }
  // The plugin must reference the same constants, not loose literals.
  const defaults = readFileSync(join(root, "lib", "defaults.js"), "utf8");
  check("WEB_SERVER_SERVICE matches the registered name", /WEB_SERVER_SERVICE\s*=\s*"webServer"/.test(defaults));
  const sources = ["lib/index.js", "lib/routes.js", "lib/config.js", "lib/relay.js"].map((file) => readFileSync(join(root, file), "utf8"));
  check("no file looks up the misspelled \"webserver\"", !sources.some((text) => /["']webserver["']/.test(text)));
  console.log(`  (${values.size} service(s) cross-checked)`);
  return failures.length === 0;
}

if (selfTest) {
  // Negative control: with the constant flipped, the harness MUST fail. Target the
  // assignment, never the first occurrence of the string (the JSDoc quotes it too).
  const path = join(root, "lib", "defaults.js");
  const before = readFileSync(path, "utf8");
  const flipped = before.replace(/export const WEB_SERVER_SERVICE = "webServer";/, 'export const WEB_SERVER_SERVICE = "webserver";');
  if (flipped === before) {
    console.log("self-test: could not flip WEB_SERVER_SERVICE (guard would be meaningless)");
    process.exitCode = 1;
  } else {
    writeFileSync(path, flipped);
    let caught = false;
    try {
      execFileSync(process.execPath, [join(root, "scripts", "verify-host-path.mjs")], { stdio: "pipe" });
    } catch {
      caught = true;
    } finally {
      writeFileSync(path, before);
    }
    console.log(`\nself-test: flipping the service name ${caught ? "is caught by the host-path harness" : "is NOT caught - the harness is blind to it"}`);
    if (!caught) process.exitCode = 1;
  }
}

const ok = main();
console.log(`\n${ok ? "PASS" : `FAIL (${failures.length})`}`);
if (!ok) process.exitCode = 1;
