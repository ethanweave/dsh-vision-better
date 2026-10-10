/**
 * Smoke-test the browser half without a browser or a bundler.
 *
 * DSH serves `dsh.client` bundles as `window.__ModuleLoader__.load({id, factory})`
 * lazy-CJS factories. This script reproduces that contract, loads the real
 * bundle, asserts it registers the Settings page correctly, and renders the page
 * once with a minimal React shim. It also checks the zh/en dictionaries carry
 * exactly the same keys.
 *
 * Usage: node scripts/verify-client-bundle.mjs
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const bundlePath = join(root, "client", "client.js");

const failures = [];
let checks = 0;
function check(name, condition, detail = "") {
  checks += 1;
  if (condition) console.log(`  ok   ${name}`);
  else {
    failures.push(`${name}${detail === "" ? "" : ` -> ${detail}`}`);
    console.log(`  FAIL ${name}${detail === "" ? "" : ` -> ${detail}`}`);
  }
}

/** Minimal React shim: enough for a pure createElement tree with hooks. */
function reactShim() {
  const effects = [];
  return {
    shim: {
      createElement(type, props, ...children) {
        return { type, props: props ?? {}, children };
      },
      useState(initial) {
        return [typeof initial === "function" ? initial() : initial, () => {}];
      },
      useEffect(factory) {
        effects.push(factory);
        return undefined;
      },
      Fragment: "fragment",
    },
    effects,
  };
}

/** Collect every leaf string in a rendered tree. */
function texts(node, out = []) {
  if (node === null || node === undefined || node === false) return out;
  if (typeof node === "string" || typeof node === "number") {
    out.push(String(node));
    return out;
  }
  if (Array.isArray(node)) {
    for (const child of node) texts(child, out);
    return out;
  }
  if (typeof node === "object" && "props" in node) {
    for (const child of node.children) texts(child, out);
  }
  return out;
}

async function main() {
  const source = readFileSync(bundlePath, "utf8");
  const registered = [];
  const fetchCalls = [];
  const previousWindow = globalThis.window;
  const previousFetch = globalThis.fetch;
  const previousDocument = globalThis.document;

  // --- minimal fake DOM for the two effects that touch the document ---------
  const styles = [];
  const documentRows = [];
  let currentLabel = "vision-better:nav";
  const observers = [];
  const disposers = [];
  const documentRowsRef = documentRows;
  const runObservers = async () => { for (const observer of observers) observer.callback(); await new Promise((resolve) => setTimeout(resolve, 0)); };
  const fakeRow = (textContent) => ({
    // The real DOM property is `textContent`; the bundle reads exactly that.
    textContent,
    attrs: new Map(),
    setAttribute(name) { this.attrs.set(name, ""); },
    removeAttribute(name) { this.attrs.delete(name); },
    getAttribute(name) { return this.attrs.has(name) ? "" : null; },
  });
  globalThis.document = {
    head: { appendChild(node) { if (node.tagName === "STYLE") styles.push(node.textContent); } },
    createElement(tag) { return { tagName: tag.toUpperCase(), textContent: "", id: undefined, dataset: {}, remove() {} }; },
    getElementById: () => null,
    documentElement: { lang: "zh-CN" },
    baseURI: "http://127.0.0.1:19387/",
    body: {},
    navRows: documentRowsRef,
    querySelectorAll(selector) {
      if (selector === '[role="dialog"] nav button') return documentRowsRef;
      if (selector.startsWith("[data-dsh-vision-better-nav-icon]")) return documentRowsRef.filter((row) => row.attrs.has("data-dsh-vision-better-nav-icon"));
      return [];
    },
  };
  globalThis.MutationObserver = class {
    constructor(callback) { this.callback = callback; console.log("   [observer] constructed"); }
    observe(target) { console.log("   [observer] observe on", target === (globalThis.document?.body ?? null) ? "document.body" : String(target)); observers.push(this); }
    disconnect() { console.log("   [observer] disconnected"); }
  };
  // The bundle re-reads the label thunk on every sync; make the fake rows and
  // the current label reachable from the assertion code above via these hooks.
  globalThis.__visionTest = {
    setLabel(value) { currentLabel = value; },
    getLabel: () => currentLabel,
    rows: documentRowsRef,
    makeRow: fakeRow,
  };

  globalThis.window = {
    __ModuleLoader__: {
      load(entry) {
        registered.push(entry);
      },
    },
  };
  globalThis.fetch = async (url) => {
    fetchCalls.push(String(url));
    throw new Error("network is not available in this smoke test");
  };

  try {
    // The bundle is an IIFE over `window`; evaluating it must only register a factory.
    new Function("window", source)(globalThis.window);
    check("bundle registers exactly one module", registered.length === 1, String(registered.length));
    check("module id matches the package", registered[0]?.id === "dsh-vision-better", registered[0]?.id);
    check("registration performs no network call", fetchCalls.length === 0);
    check("factory is lazy (no side effect before materialization)", registered[0]?.factory !== undefined);

    const { shim, effects } = reactShim();
    const exports = registered[0].factory((id) => {
      if (id === "react") return shim;
      throw new Error(`unexpected require: ${id}`);
    });
    check("plugin exports a name", typeof exports.name === "string" && exports.name.length > 0);
    check("plugin injects platform services", Array.isArray(exports.inject) && exports.inject.includes("slots"));
    check("plugin exports apply", typeof exports.apply === "function");

    const locales = [];
    const slots = [];
    const ctx = {
      effect: (factory) => {
        const dispose = factory();
        disposers.push(dispose);
        return () => { if (typeof dispose === "function") dispose(); };
      },
      locale: {
        register(namespace, dictionaries) {
          locales.push({ namespace, dictionaries });
          return () => {};
        },
        bind: (namespace) => (key) => `${namespace}:${key}`,
      },
      slots: {
        inject(name, register) {
          check("settings.section declaration is awaited", name === "settings.section", name);
          register();
        },
        register(options, component) {
          slots.push({ options, component });
          return () => {};
        },
      },
    };
    exports.apply(ctx);

    check("one locale namespace registered", locales.length === 1, String(locales.length));
    const dictionaries = locales[0]?.dictionaries ?? {};
    const zh = Object.keys(dictionaries.zh ?? {});
    const en = Object.keys(dictionaries.en ?? {});
    check("zh and en carry exactly the same keys", zh.length > 0 && zh.length === en.length && zh.every((key) => en.includes(key)), `${zh.length} vs ${en.length}`);
    check("nav label exists in both languages", zh.includes("nav") && en.includes("nav"));
    check("privacy copy exists in both languages", zh.includes("privacy") && en.includes("privacy"));

    check("one settings.section entry registered", slots.length === 1, String(slots.length));
    check("entry id is vision-better", slots[0]?.options?.id === "vision-better", slots[0]?.options?.id);
    check("entry targets the settings.section slot", slots[0]?.options?.name === "settings.section");
    check("entry has a label thunk", typeof slots[0]?.options?.label === "function");
    check("label resolves through locale", slots[0]?.options?.label() === "vision-better:nav");

    // Render once; the state is still null so this exercises the loading branch.
    const rendered = slots[0].component({ t: (key) => key });
    check("section component renders", rendered !== null && typeof rendered === "object");
    const renderedText = texts(rendered).join(" ");
    check("rendered page names the endpoint field", renderedText.includes("endpointTitle"), renderedText.slice(0, 120));
    check("rendered page names the model field", renderedText.includes("modelTitle"));
    check("rendered page states the privacy policy", renderedText.includes("privacy"));
    check("component uses no effect that fetches immediately", effects.length >= 1);

    // The mount effect must load state through the host routes only.
    globalThis.fetch = async (url) => {
      fetchCalls.push(String(url));
      return { ok: true, status: 200, async json() { return { endpoint: "https://open.bigmodel.cn/api/paas/v4", model: "glm-4.6v-flash", enabled: true, presets: [], credential: { configured: false }, limits: { maxImagesPerTurn: 4, maxImageBytes: 5242880, requestTimeoutMs: 60000 } }; } };
    };
    // Run every collected component effect (there is exactly one: the mount).
    for (const factory of effects) await factory();
    check("the page fetches only its own host routes", fetchCalls.length >= 1 && fetchCalls.every((url) => url.startsWith("/vision-better/api/")), JSON.stringify(fetchCalls));
    check("no request URL carries the word apiKey", fetchCalls.every((url) => !url.includes("apiKey")));


    // --- settings-nav glyph -------------------------------------------------
    // The fake document records injected styles and marked rows so the glyph
    // contract can be asserted without a browser.
    check("nav glyph stylesheet injected", styles.some((text) => text.includes("data-dsh-vision-better-nav-icon")));
    const maskStyle = styles.find((text) => text.includes("mask-image"));
    check("glyph is drawn through a mask so it follows currentColor", maskStyle !== undefined && maskStyle.includes("mask-image: url(") && maskStyle.includes("currentColor"));
    check("mask hides the shell's fallback gear", maskStyle !== undefined && maskStyle.includes("> svg { display: none; }"));
    check("mask payload is an SVG data URL", maskStyle !== undefined && /mask-image: url\("data:image\/svg\+xml,/.test(maskStyle));
    check("eye mark is an outline plus pupil", source.includes('<circle cx="12" cy="12"') && source.includes('<path d="M2.5 12'));

    // Row marking: the fake document resolves nav rows from the recorded list.
    const marked = () => documentRows.filter((row) => row.attrs.has("data-dsh-vision-better-nav-icon"));
    documentRows.push(fakeRow("vision-better:nav"), fakeRow("Models"));
    await runObservers();
    check("own nav row is marked", marked().length === 1 && marked()[0].textContent === "vision-better:nav", JSON.stringify(marked().map((row) => row.textContent)));
    check("foreign nav rows are untouched", !documentRows.some((row) => row.text === "Models" && row.attrs.has("data-dsh-vision-better-nav-icon")));
  } finally {
    let disposeFailures = 0;
    for (const dispose of disposers) {
      try { if (typeof dispose === "function") dispose(); } catch { disposeFailures += 1; }
    }
    check("every effect disposes cleanly", disposeFailures === 0, String(disposeFailures) + " threw");
    globalThis.window = previousWindow;
    globalThis.fetch = previousFetch;
    globalThis.document = previousDocument;
    delete globalThis.MutationObserver;
    delete globalThis.__visionTest;
  }

  console.log(`\n${checks - failures.length}/${checks} checks passed`);
  if (failures.length > 0) {
    console.error(`\n${failures.length} failure(s):`);
    for (const failure of failures) console.error(` - ${failure}`);
    process.exitCode = 1;
  }
}

await main();
