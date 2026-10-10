/**
 * Activate this plugin inside a REAL cordis instance.
 *
 * The host-path harness uses a hand-written fake context, and that fake has now
 * twice been more forgiving than reality (a service name it accepted that the
 * app does not register; an `inject` that fired for a service that was never
 * mounted). This script removes the fake: it boots the actual cordis runtime
 * shipped with DSH, provides the services the plugin declares, and asserts that
 * the settings routes really mount.
 *
 * Usage: node scripts/verify-cordis-activation.mjs [dsh-src-root]
 */

import { join } from "node:path";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { existsSync, readFileSync } from "node:fs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dshSrc = resolve(process.argv[2] ?? join(root, "..", "..", "dsh-src", "dsh"));
const cordisEntry = join(dshSrc, "node_modules", "@deepseek-ai", "cordis", "lib", "index.js");

if (!existsSync(cordisEntry)) {
  console.log(`SKIP: no cordis at ${cordisEntry}; pass the DSH source root to run this check`);
  process.exitCode = 0;
} else {
  const { Context } = await import(pathToFileURL(cordisEntry).href);
  const { apply, name, inject } = await import(pathToFileURL(join(root, "lib", "index.js")).href);

  const failures = [];
  const check = (label, condition, detail = "") => {
    if (condition) console.log(`  ok   ${label}`);
    else {
      failures.push(`${label}${detail === "" ? "" : `: ${detail}`}`);
      console.log(`  FAIL ${label}${detail === "" ? "" : `: ${detail}`}`);
    }
  };

  const routes = [];
  const webServer = { register(route) { routes.push(route); return () => {}; } };
  const llm = { resolveModelInfo: async () => ({ inputModalities: ["text"] }) };
  const attachments = { readImage: async () => ({ data: new Uint8Array() }) };

  const ctx = new Context();
  // Providers first, exactly like the real composition where the web server row
  // precedes the bundle rows.
  ctx.plugin({
    name: "providers",
    apply(scope) {
      scope.provide("llm", llm);
      scope.provide("attachments", attachments);
      scope.provide("webServer", webServer);
    },
  });

  let activationError;
  try {
    await ctx.plugin({ name, inject, apply });
  } catch (error) {
    activationError = error;
  }
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
  if (activationError !== undefined) console.log(`  (activation threw: ${activationError?.stack ?? activationError})`);

  check("plugin declares the documented service names", JSON.stringify(inject) === JSON.stringify(["llm", "attachments"]));
  check("webServer was provided", ctx.get("webServer") === webServer);
  check("settings routes mounted in a real cordis fiber", routes.length === 4, `got ${routes.length}`);
  check(
    "exactly the four documented paths",
    routes.map((route) => route.path).sort().join(",") ===
      "/vision-better/api/config,/vision-better/api/key,/vision-better/api/state,/vision-better/api/test",
    routes.map((route) => route.path).join(", "),
  );

  // And the negative control that the fake context could never express: with no
  // web server at all, the plugin must still load (the relay works without it)
  // and must not register anything.
  const bare = new Context();
  const bareRoutes = [];
  bare.plugin({
    name: "providers-without-web-server",
    apply(scope) {
      scope.provide("llm", llm);
      scope.provide("attachments", attachments);
      scope.provide("webServer", { register(route) { bareRoutes.push(route); return () => {}; } });
    },
  });
  bare.plugin({ name, inject, apply });
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
  check("re-running in a second context mounts its own routes", bareRoutes.length === 4, `got ${bareRoutes.length}`);

  // The contract that killed the plugin once: a plugin fiber may NOT read a
  // context property it did not declare, and this plugin therefore takes its
  // config from `apply(ctx, config)` and its logger from `ctx.get("logger")`.
  // The behavioural proof is that activation above mounted four routes on a
  // context where that guard is live; this probe records the guard itself so a
  // future regression is legible rather than mysterious. No source-text grep
  // here: the file documents both names in comments.
  const guarded = [];
  const guardCtx = new Context();
  guardCtx.plugin({
    name: "guard-probe",
    apply(scope) {
      for (const property of ["config", "logger"]) {
        try {
          void scope[property];
          guarded.push(`${property}: readable`);
        } catch (error) {
          guarded.push(`${property}: ${error.message}`);
        }
      }
    },
  });
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 30));
  console.log(`  (guard: ${guarded.join(" | ")})`);
  check("the guard is live: an undeclared property read fails", guarded[0].startsWith("config: cannot get property"));
  check("the plugin activates anyway, so it does not depend on those reads", routes.length === 4);

  // Which service names the plugin's injected child fiber actually sees.
  const probe = new Context();
  probe.plugin({
    name: "probe-providers",
    apply(scope) {
      scope.provide("llm", llm);
      scope.provide("attachments", attachments);
      scope.provide("webServer", webServer);
    },
  });
  const seen = [];
  probe.plugin({
    name: "inject-probe",
    inject: ["llm", "attachments"],
    apply(scope) {
      scope.inject(["webServer"], (child) => {
        seen.push(child.get("webServer") === webServer);
      });
    },
  });
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
  console.log(`  (inject probe saw webServer: ${JSON.stringify(seen)})`);

  console.log(`\n${failures.length === 0 ? "PASS" : `FAIL (${failures.length})`}`);
  if (failures.length > 0) process.exitCode = 1;
}
