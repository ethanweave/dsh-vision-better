/**
 * dsh-vision-better — browser half.
 *
 * One thing only: the "图像识别 / Vision relay" page under Settings. It edits
 * the relay's endpoint and model through the host's own routes, saves or clears
 * the API key through the same routes (the host stores it in DSH's credential
 * service), and runs a connectivity test. The key is written to the host and
 * never read back: the page only ever learns whether one is configured.
 *
 * This file is the bundle DSH serves for `dsh.client`. It is hand-written
 * lazy-CJS — DSH's module loader registers the factory and materializes it on
 * demand — and needs no build step and no dependency beyond the platform's own
 * `react`. It adds no chat UI of any kind.
 */

window.__ModuleLoader__.load({
  id: "dsh-vision-better",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    var React = require("react");
    var h = React.createElement;

    /** Locale namespace for this page. */
    var NS = "vision-better";

    var copy = {
      zh: {
        nav: "图像识别",
        title: "图像识别",
        intro:
          "当前模型不支持图片时，本插件会在后台调用你配置的视觉模型理解图片，再由原模型继续回答。图片分析和原图都会留在当前会话里。",
        statusConfigured: "已配置",
        statusMissing: "未配置",
        statusSource: "来源",
        keyTitle: "API Key",
        keyHint: "保存在 DSH 的凭证服务中（主机端）。本页面只显示是否已配置，不会回显密钥。",
        keyPlaceholderConfigured: "已保存，输入新值可替换",
        keyPlaceholder: "粘贴你的智谱 API Key",
        save: "保存",
        clear: "清除凭证",
        saving: "保存中…",
        saved: "已保存",
        cleared: "凭证已清除",
        endpointTitle: "Endpoint",
        endpointHint: "默认值对应智谱开放平台（中国大陆）。国际账号请改用 api.z.ai，或填写你的兼容地址。",
        modelTitle: "模型 ID",
        modelHint: "默认 glm-4.6v-flash（免费档）。可填写其他兼容视觉模型 ID。",
        enabledTitle: "启用图像识别",
        enabledHint: "关闭后插件完全不工作，也不会发起任何视觉请求。",
        test: "测试连接",
        testing: "测试中…",
        testOk: "连接正常",
        testFail: "连接失败",
        testImageNote: "测试使用内置的小图，不会使用你会话中的任何图片。",
        rateLimitHint: "这是服务方限流：免费档的额度与并发都很低。等一两分钟再试，或到智谱控制台查看额度；也可以换用其他视觉模型。",
        providerTitle: "供应商 / 协议",
        providerHint: "OpenAI 兼容协议适用于智谱、反代、中转与自托管端点；Anthropic 与 Google Gemini 使用各自的原生协议。",
        modelsFetch: "获取模型列表",
        modelsLoading: "获取中…",
        modelsPick: "从目录中选择…",
        modelsEmpty: "目录为空",
        modelsFail: "获取模型失败",
        diagnosticTitle: "配置文件问题",
        privacyTitle: "隐私与额度",
        privacy:
          "只有当前模型不支持图片、且本轮确实带图片时，图片才会发送到你填写的视觉 API。图片不会发送给 DeepSeek 或其他未配置的服务。免费额度、速率限制与云端数据处理政策以服务方当前规则为准，本插件不承诺额度永久或无限。",
        saveFailed: "保存失败",
        loadFailed: "无法读取插件状态，请确认插件已启用并重启 DSH。",
        apply: "应用",
        applied: "已生效",
        limits: "本地上限",
      },
      en: {
        nav: "Vision relay",
        title: "Vision relay",
        intro:
          "When the active model cannot accept images, this plugin asks your configured vision model to read them in the background and lets the original model answer. The image and the analysis both stay in the conversation.",
        statusConfigured: "Configured",
        statusMissing: "Not configured",
        statusSource: "source",
        keyTitle: "API key",
        keyHint: "Stored by DSH's credential service on the host. This page only shows whether one is configured and never echoes the key.",
        keyPlaceholderConfigured: "Saved — type a new value to replace it",
        keyPlaceholder: "Paste your Zhipu API key",
        save: "Save",
        clear: "Clear credential",
        saving: "Saving…",
        saved: "Saved",
        cleared: "Credential cleared",
        endpointTitle: "Endpoint",
        endpointHint: "The default is the Zhipu open platform (mainland China). Use api.z.ai for an international account, or enter your own compatible base URL.",
        modelTitle: "Model ID",
        modelHint: "Defaults to glm-4.6v-flash (free tier). Any compatible vision model id may be used.",
        enabledTitle: "Enable vision relay",
        enabledHint: "When off, the plugin does nothing and makes no vision request at all.",
        test: "Test connection",
        testing: "Testing…",
        testOk: "Connection OK",
        testFail: "Connection failed",
        testImageNote: "The test uses a built-in sample image, never an image from your conversation.",
        rateLimitHint: "This is the provider's rate limit: free-tier quota and concurrency are low. Wait a minute and retry, check your quota in the Zhipu console, or try another vision model.",
        providerTitle: "Provider / protocol",
        providerHint: "The OpenAI-compatible protocol covers Zhipu, reverse proxies, relays and self-hosted endpoints; Anthropic and Google Gemini use their native protocols.",
        modelsFetch: "Fetch models",
        modelsLoading: "Fetching…",
        modelsPick: "Pick from the catalogue…",
        modelsEmpty: "the catalogue is empty",
        modelsFail: "could not fetch models",
        diagnosticTitle: "Config file problem",
        privacyTitle: "Privacy and quota",
        privacy:
          "Images are sent to the vision API you configure, and only when the active model cannot read images and the turn actually carries one. They are never sent to DeepSeek or to any service you did not configure. Free quota, rate limits, and cloud processing terms follow the provider's current policy; this plugin does not promise that free access is permanent or unlimited.",
        saveFailed: "Could not save",
        loadFailed: "Could not read plugin state. Check that the plugin is enabled and restart DSH.",
        apply: "Apply",
        applied: "Applied",
        limits: "Local limits",
      },
    };

    /** Resolve one host route against the page's base path. */
    function apiUrl(path) {
      var relative = path.replace(/^\/+/, "");
      if (typeof document === "undefined") return "/" + relative;
      return new URL(relative, document.baseURI).pathname;
    }

    async function call(path, body) {
      var response = await fetch(apiUrl(path), {
        method: body === undefined ? "GET" : "POST",
        headers: body === undefined ? {} : { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        credentials: "same-origin",
      });
      var payload = undefined;
      try {
        payload = await response.json();
      } catch {
        payload = undefined;
      }
      if (payload === undefined) throw new Error("unexpected response");
      if (!response.ok) throw new Error(payload.error || payload.message || "request failed");
      return payload;
    }

    function statusLine(t, state) {
      var configured = state && state.credential && state.credential.configured === true;
      return h(
        "p",
        { className: "vision-better-status" },
        h("span", {
          className: configured ? "vision-better-dot vision-better-dot-ok" : "vision-better-dot vision-better-dot-missing",
        }),
        configured ? t("statusConfigured") : t("statusMissing"),
        configured && state.credential.source ? " (" + t("statusSource") + ": " + state.credential.source + ")" : "",
      );
    }

    function field(t, label, hint, input) {
      return h(
        "div",
        { className: "vision-better-field" },
        h("label", { className: "vision-better-label" }, label),
        input,
        hint ? h("p", { className: "vision-better-hint" }, hint) : null,
      );
    }

    function VisionRelaySection(props) {
      var t = props.t;
      var [state, setState] = React.useState(null);
      var [key, setKey] = React.useState("");
      var [provider, setProvider] = React.useState("");
      var [endpoint, setEndpoint] = React.useState("");
      var [model, setModel] = React.useState("");
      var [busy, setBusy] = React.useState("");
      var [notice, setNotice] = React.useState(null);
      var [test, setTest] = React.useState(null);
      var [models, setModels] = React.useState(null);

      function adopt(next) {
        setState(next);
        setProvider(next.provider);
        setEndpoint(next.endpoint);
        setModel(next.model);
        setModels(null);
      }

      /** The provider entry the page is currently editing (draft values only). */
      function providerEntry() {
        return (state?.providers ?? []).find((entry) => entry.id === provider) ?? null;
      }

      React.useEffect(() => {
        var live = true;
        call("/vision-better/api/state")
          .then((next) => {
            if (live) adopt(next);
          })
          .catch((error) => {
            if (live) setNotice({ kind: "error", text: t("loadFailed") + " (" + error.message + ")" });
          });
        return () => {
          live = false;
        };
      }, []);

      async function run(kind, task, okText) {
        setBusy(kind);
        setNotice(null);
        try {
          var result = await task();
          if (result !== undefined && result.endpoint !== undefined) adopt(result);
          if (okText !== undefined) setNotice({ kind: "ok", text: okText });
          return result;
        } catch (error) {
          // A failed connection test is not a failed save: name the action that
          // actually failed so the banner is not misleading.
          setNotice({ kind: "error", text: (kind === "test" ? t("testFail") : t("saveFailed")) + ": " + error.message });
          return undefined;
        } finally {
          setBusy("");
        }
      }

      var configured = state?.credential?.configured === true;

      return h(
        "section",
        { className: "vision-better-section" },
        h("h2", { className: "vision-better-title" }, t("title")),
        h("p", { className: "vision-better-intro" }, t("intro")),

        h(
          "div",
          { className: "vision-better-card" },
          statusLine(t, state),
          h("input", {
            type: "password",
            className: "vision-better-input",
            autoComplete: "off",
            spellCheck: false,
            value: key,
            placeholder: configured ? t("keyPlaceholderConfigured") : t("keyPlaceholder"),
            onChange: (event) => setKey(event.target.value),
          }),
          h(
            "div",
            { className: "vision-better-actions" },
            h(
              "button",
              {
                type: "button",
                className: "vision-better-primary",
                disabled: busy !== "" || key.trim() === "",
                onClick: async () => {
                  var value = key;
                  var result = await run("save", () => call("/vision-better/api/key", { apiKey: value }), t("saved"));
                  if (result !== undefined) setKey("");
                },
              },
              busy === "save" ? t("saving") : t("save"),
            ),
            h(
              "button",
              {
                type: "button",
                className: "vision-better-secondary",
                disabled: busy !== "" || !configured,
                onClick: () => run("clear", () => call("/vision-better/api/key", { clear: true }), t("cleared")),
              },
              t("clear"),
            ),
          ),
          h("p", { className: "vision-better-hint" }, t("keyHint")),
        ),

        h(
          "div",
          { className: "vision-better-card" },
          field(
            t,
            t("providerTitle"),
            t("providerHint"),
            h(
              "select",
              {
                className: "vision-better-input",
                value: provider,
                onChange: (event) => {
                  var id = event.target.value;
                  setProvider(id);
                  setModels(null);
                  // Switching protocol fills in that provider's own defaults so
                  // the user never has to know its base URL by heart.
                  var entry = (state?.providers ?? []).find((item) => item.id === id);
                  if (entry !== null && entry !== undefined) {
                    setEndpoint(entry.endpoint);
                    setModel(entry.model);
                  }
                },
              },
              (state?.providers ?? []).map((entry) =>
                h("option", { key: entry.id, value: entry.id }, entry.label?.[currentLocale()] ?? entry.id),
              ),
            ),
          ),
          field(
            t,
            t("endpointTitle"),
            t("endpointHint"),
            h("input", {
              type: "text",
              className: "vision-better-input",
              spellCheck: false,
              value: endpoint,
              onChange: (event) => setEndpoint(event.target.value),
            }),
          ),
          provider === "openai-compatible"
            ? h(
                "div",
                { className: "vision-better-actions" },
                (state?.presets ?? []).map((preset) =>
                  h(
                    "button",
                    {
                      key: preset.id,
                      type: "button",
                      className: "vision-better-secondary",
                      onClick: () => setEndpoint(preset.endpoint),
                    },
                    preset.label?.zh !== undefined || preset.label?.en !== undefined
                      ? currentLocale() === "zh"
                        ? preset.label.zh
                        : preset.label.en
                      : preset.endpoint,
                  ),
                ),
              )
            : null,
          field(
            t,
            t("modelTitle"),
            t("modelHint"),
            h("input", {
              type: "text",
              className: "vision-better-input",
              spellCheck: false,
              value: model,
              placeholder: "glm-4.6v-flash",
              onChange: (event) => setModel(event.target.value),
            }),
          ),
          h(
            "div",
            { className: "vision-better-actions" },
            h(
              "button",
              {
                type: "button",
                className: "vision-better-secondary",
                disabled: busy !== "" || state === null || endpoint.trim() === "",
                onClick: async () => {
                  setModels(null);
                  await run("models", async () => {
                    var result = await call("/vision-better/api/models", { provider, endpoint, apiKey: key.trim() === "" ? undefined : key.trim() });
                    if (result.ok === true) setModels(result.models);
                    else setNotice({ kind: "error", text: t("modelsFail") + ": " + (result.error ?? "unknown") });
                    return undefined;
                  });
                },
              },
              busy === "models" ? t("modelsLoading") : t("modelsFetch"),
            ),
            models === null
              ? null
              : models.length === 0
                ? h("span", { className: "vision-better-hint" }, t("modelsEmpty"))
                : h(
                    "select",
                    {
                      className: "vision-better-input",
                      value: models.includes(model) ? model : "",
                      onChange: (event) => setModel(event.target.value),
                    },
                    [h("option", { key: "", value: "" }, t("modelsPick"))].concat(
                      models.map((id) => h("option", { key: id, value: id }, id)),
                    ),
                  ),
          ),
          h(
            "div",
            { className: "vision-better-actions" },
            h(
              "button",
              {
                type: "button",
                className: "vision-better-primary",
                disabled: busy !== "" || state === null,
                onClick: () =>
                  run("apply", () => call("/vision-better/api/config", { provider, endpoint, model, enabled: state.enabled }), t("applied")),
              },
              busy === "apply" ? t("saving") : t("apply"),
            ),
            h(
              "label",
              { className: "vision-better-toggle" },
              h("input", {
                type: "checkbox",
                checked: state?.enabled === true,
                disabled: busy !== "" || state === null,
                onChange: (event) =>
                  run("toggle", () => call("/vision-better/api/config", { enabled: event.target.checked }), t("applied")),
              }),
              t("enabledTitle"),
            ),
          ),
          h("p", { className: "vision-better-hint" }, t("enabledHint")),
          h(
            "div",
            { className: "vision-better-actions" },
            h(
              "button",
              {
                type: "button",
                className: "vision-better-secondary",
                disabled: busy !== "" || !configured || state === null,
                onClick: async () => {
                  setTest(null);
                  await run("test", async () => {
                    var result = await call("/vision-better/api/test", {});
                    setTest(result);
                    return undefined;
                  });
                },
              },
              busy === "test" ? t("testing") : t("test"),
            ),
            test === null
              ? null
              : h(
                  "span",
                  { className: test.ok ? "vision-better-test-ok" : "vision-better-test-fail" },
                  (test.ok ? t("testOk") : t("testFail")) +
                    (test.durationMs === undefined ? "" : ` (${test.durationMs}ms)`) +
                    (test.message === undefined ? "" : ` — ${test.message}`) +
                    (test.code === undefined ? "" : ` [${test.code}]`),
                ),
          ),
          test?.code === "VISION_RELAY_RATE_LIMITED"
            ? h("p", { className: "vision-better-hint" }, t("rateLimitHint"))
            : null,
          h("p", { className: "vision-better-hint" }, t("testImageNote")),
        ),

        state === null
          ? null
          : h(
              "p",
              { className: "vision-better-hint" },
              `${t("limits")}: ≤ ${state.limits.maxImagesPerTurn} images, ${Math.round(state.limits.maxImageBytes / 1048576)} MiB each, ` +
                `${Math.round(state.limits.requestTimeoutMs / 1000)}s timeout`,
            ),

        notice === null
          ? null
          : h("p", { className: notice.kind === "ok" ? "vision-better-notice-ok" : "vision-better-notice-error" }, notice.text),

        state?.diagnostic !== undefined
          ? h("p", { className: "vision-better-notice-error" }, t("diagnosticTitle") + ": " + state.diagnostic)
          : null,
        h("h3", { className: "vision-better-subtitle" }, t("privacyTitle")),
        h("p", { className: "vision-better-hint" }, t("privacy")),
      );
    }

    /** Current UI locale, used only to pick a preset label. */
    function currentLocale() {
      var value = typeof document !== "undefined" ? document.documentElement?.lang : undefined;
      return typeof value === "string" && value.toLowerCase().startsWith("zh") ? "zh" : "en";
    }

    /** Page-scoped styles; the shell owns every global token. */
    function ensureStyles() {
      if (typeof document === "undefined" || document.getElementById("dsh-vision-better-style") !== null) return;
      var style = document.createElement("style");
      style.id = "dsh-vision-better-style";
      style.textContent = [
        ".vision-better-section{max-width:720px;display:flex;flex-direction:column;gap:12px;color:var(--dsw-alias-label-primary)}",
        ".vision-better-title{margin:0;font-size:16px;font-weight:500;line-height:24px}",
        ".vision-better-subtitle{margin:8px 0 0;font-size:14px;font-weight:500}",
        ".vision-better-intro{margin:0;font-size:14px;line-height:22px;color:var(--dsw-alias-label-tertiary)}",
        ".vision-better-card{display:flex;flex-direction:column;gap:10px;padding:12px 14px;border:.5px solid var(--dsw-alias-settings-card-stroke);background:var(--dsw-alias-settings-card-fill);border-radius:var(--dsw-radius-xl)}",
        ".vision-better-field{display:flex;flex-direction:column;gap:6px}",
        ".vision-better-label{font-size:14px;font-weight:500;line-height:22px}",
        ".vision-better-input{box-sizing:border-box;width:100%;height:36px;padding:0 10px;font:inherit;font-size:14px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base);border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-md)}",
        ".vision-better-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}",
        ".vision-better-primary,.vision-better-secondary{box-sizing:border-box;height:36px;padding:0 14px;font:inherit;font-size:14px;border:none;border-radius:var(--dsw-radius-md);cursor:pointer}",
        ".vision-better-primary{background:var(--dsw-alias-interactive-bg-hover-solid);color:var(--dsw-alias-label-primary)}",
        ".vision-better-secondary{background:transparent;color:var(--dsw-alias-label-secondary);border:.5px solid var(--dsw-alias-border-l3)}",
        ".vision-better-primary:disabled,.vision-better-secondary:disabled{opacity:.5;cursor:default}",
        ".vision-better-toggle{display:inline-flex;align-items:center;gap:6px;font-size:14px}",
        ".vision-better-hint{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}",
        ".vision-better-status{display:flex;align-items:center;gap:6px;margin:0;font-size:13px;color:var(--dsw-alias-label-secondary)}",
        ".vision-better-dot{width:8px;height:8px;border-radius:50%;display:inline-block}",
        ".vision-better-dot-ok{background:var(--dsw-alias-state-success-primary)}",
        ".vision-better-dot-missing{background:var(--dsw-alias-state-error-primary)}",
        ".vision-better-notice-ok{margin:0;font-size:12px;color:var(--dsw-alias-state-success-primary)}",
        ".vision-better-notice-error{margin:0;font-size:12px;color:var(--dsw-alias-state-error-primary)}",
        ".vision-better-test-ok{font-size:12px;color:var(--dsw-alias-state-success-primary)}",
        ".vision-better-test-fail{font-size:12px;color:var(--dsw-alias-state-error-primary)}",
      ].join("");
      document.head.appendChild(style);
    }

    /**
     * Settings-nav glyph.
     *
     * The settings shell picks nav icons from a closed list of section ids and
     * falls back to its gear for every other id — `settings.section` projects
     * only id/order/label, so a registrant has no icon to pass. The same
     * solution three shipped plugins use (dshmarket, dsh-better-sidebar,
     * dsh-skill-mcp-panel): mark the one nav row whose visible text is this
     * section's localized label, hide the gear, and draw an eye through a CSS
     * mask so the colour follows the shell's currentColor in both states.
     */
    var NAV_ROW_SELECTOR = '[role="dialog"] nav button';
    var NAV_ICON_MARKER = "data-dsh-vision-better-nav-icon";
    var NAV_ICON_SIZE = 16;

    /** Eye mark as a standalone SVG for a CSS mask (pure black: masks read alpha). */
    function eyeMaskSvg() {
      return (
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#000" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">'
        + '<path d="M2.5 12s3.6-6.5 9.5-6.5S21.5 12 21.5 12s-3.6 6.5-9.5 6.5S2.5 12 2.5 12Z"/>'
        + '<circle cx="12" cy="12" r="2.8" fill="#000" stroke="none"/>'
        + "</svg>"
      );
    }

    function eyeMaskUrl() {
      return `data:image/svg+xml,${encodeURIComponent(eyeMaskSvg())}`;
    }

    /** Whether a nav row is this plugin's own: visible text equals the section label. */
    function isOwnNavRow(rowText, wantedLabel) {
      var wanted = String(wantedLabel ?? "").trim();
      if (wanted.length === 0) return false;
      return String(rowText ?? "").trim() === wanted;
    }

    function navIconCss(maskUrl) {
      return [
        `[${NAV_ICON_MARKER}] > svg { display: none; }`,
        `[${NAV_ICON_MARKER}]::before {`,
        "  content: '';",
        "  flex: none;",
        `  width: ${NAV_ICON_SIZE}px;`,
        `  height: ${NAV_ICON_SIZE}px;`,
        "  background-color: currentColor;",
        `  -webkit-mask-image: url("${maskUrl}");`,
        `  mask-image: url("${maskUrl}");`,
        "  -webkit-mask-repeat: no-repeat;",
        "  mask-repeat: no-repeat;",
        "  -webkit-mask-position: center;",
        "  mask-position: center;",
        `  -webkit-mask-size: ${NAV_ICON_SIZE}px ${NAV_ICON_SIZE}px;`,
        `  mask-size: ${NAV_ICON_SIZE}px ${NAV_ICON_SIZE}px;`,
        "}",
      ].join("\n");
    }

    /**
     * Install the nav glyph for as long as this fiber lives: inject the
     * stylesheet, keep the own row marked through DOM mutations (settings open,
     * close, locale switch), and remove everything on disposal.
     */
    function installNavIcon(ctx, resolveLabel) {
      if (typeof document === "undefined") return;
      ctx.effect(() => {
        var style = document.createElement("style");
        style.id = "dsh-vision-better-nav-icon-style";
        style.textContent = navIconCss(eyeMaskUrl());
        document.head.appendChild(style);

        var disposed = false;
        var scheduled = false;
        var sync = () => {
          scheduled = false;
          if (disposed) return;
          var wanted = resolveLabel();
          for (var row of document.querySelectorAll(NAV_ROW_SELECTOR)) {
            if (isOwnNavRow(row.textContent, wanted)) row.setAttribute(NAV_ICON_MARKER, "");
            else row.removeAttribute(NAV_ICON_MARKER);
          }
        };
        var schedule = () => {
          if (scheduled || disposed) return;
          scheduled = true;
          queueMicrotask(sync);
        };

        sync();
        var observer = new MutationObserver(schedule);
        observer.observe(document.body, { childList: true, subtree: true, characterData: true });

        return () => {
          disposed = true;
          observer.disconnect();
          for (var row of document.querySelectorAll(`[${NAV_ICON_MARKER}]`)) row.removeAttribute(NAV_ICON_MARKER);
          style.remove();
        };
      }, "vision-better: settings nav icon");
    }

    exports.name = "vision-better-client";
    exports.inject = ["slots", "locale"];

    exports.apply = function apply(ctx) {
      ensureStyles();
      ctx.effect(() => ctx.locale.register(NS, copy), "vision-better: copy dictionaries");
      var t = ctx.locale.bind(NS);
      installNavIcon(ctx, () => t("nav"));
      ctx.slots.inject("settings.section", () =>
        ctx.slots.register(
          {
            name: "settings.section",
            id: "vision-better",
            order: 40,
            label: () => t("nav"),
            locale: NS,
            inject: () => ({ t }),
          },
          VisionRelaySection,
        ),
      );
    };

    return module.exports;
  },
});
