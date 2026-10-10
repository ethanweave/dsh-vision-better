# Core extension: `session/image-admission`

This directory is deliberately separate from the plugin. The plugin is a normal DSH bundle; the patch in this
directory changes DSH itself and has to be reviewed, versioned, and upstreamed on its own.

## Why it is required

`@deepseek-ai/dsh-api-session-controller` rejects a prompt that carries an image when the active model does
not declare image support:

```
lib/index.js:870-874   (and lib/types/commands.js:313-318)

if (hasImage) {
    const current = this.agents.selectionFor(agent).current;
    const model = await this.ctx.llm.resolveModelInfo(current.provider, current.model);
    if (model.inputModalities !== void 0 && !model.inputModalities.includes("image"))
        throw new RemoteError("session/attachment-invalid",
            `Model "${current.model}" does not support image input.`,
            { reason: "MODEL_DOES_NOT_SUPPORT_IMAGES" });
}
```

Facts that make a pure-plugin workaround impossible (verified in 0.2.0-rc.2):

- The check runs **before** `attachments.admitPromptContent` and before the `user/message` event is appended
  (`dsh-agent-loop/lib/index.js:1061`), so the image never enters the session.
- `llm.resolveModelInfo` is a plain method with no waterfall and no registration hook, so a plugin cannot
  contribute to the answer. Monkey-patching it would fake model capability, which this project refuses to do.
- No public event surrounds prompt admission (`dsh-tool-cordis/.../api-catalog.js` lists every extension
  point; there is no `session/prompt` or attachment-admission hook).

## What the patch adds

One public waterfall, consulted only in the branch that would otherwise reject:

```js
const admission = await this.ctx.waterfall(this, "session/image-admission", {
    agent,
    provider: current.provider,
    model: current.model,
    modelInfo: model,
}, () => Promise.resolve(void 0));

if (admission?.admit !== true)
    throw new RemoteError("session/attachment-invalid",
        admission?.message ?? `Model "${current.model}" does not support image input.`,
        { reason: admission?.code ?? "MODEL_DOES_NOT_SUPPORT_IMAGES" });
```

Listener contract:

| Return | Effect |
|---|---|
| `undefined` (nobody answers) | today's behaviour, byte for byte |
| `{ admit: true }` | the prompt is admitted; the answering plugin takes responsibility for the images |
| `{ admit: false, code, message }` | rejected with the plugin's own code and message |

It does not change `inputModalities`, the model catalogue, the provider route, or any adapter. The check
itself is still evaluated identically; only the outcome of a would-be rejection becomes extensible.

## Files

| File | Purpose |
|---|---|
| `0001-session-image-admission.patch` | the diff, against the compiled `lib/` of the shipped package |
| `build-patch.mjs` | regenerates the diff from any unpacked DSH tree (`node patches/build-patch.mjs <dsh-src-root>`) |
| `verify-patch.mjs` | `git apply`s the diff onto pristine copies and executes the patched guard for every outcome |

## Apply

### To a source checkout

```bash
# from the package root of @deepseek-ai/dsh-api-session-controller
git apply -p1 <this-repo>/patches/0001-session-image-admission.patch
```

For a source checkout, the same change belongs in the TypeScript original; the inserted block is identical
apart from indentation and quote style.

### To an installed desktop app (no source checkout)

`app.asar` inside the installation holds the compiled package. Two double-clickable helpers rewrite it
safely; both stage, verify, and only then swap, and both wait for DeepSeek Harness to exit because Windows
refuses to replace an archive a running app has mapped.

| Script | Effect |
|---|---|
| `apply-core-patch.cmd` | back up `app.asar` to `app.asar.vision-better.bak`, rebuild it with the patched files, re-read it, verify the extension is present and an untouched file is byte-identical, then swap |
| `restore-core-patch.cmd` | copy the backup back |

Command line equivalents:

```bash
node patches/apply-installed.mjs --check     # locate the archive, report patched/writable/version
node patches/apply-installed.mjs --apply     # apply (waits for the app to exit)
node patches/apply-installed.mjs --restore   # restore from the backup
```

Notes:

- Run it, then **close DeepSeek Harness completely** if it is open; the script finishes the swap and says so.
  Start DeepSeek Harness again afterwards.
- A running app keeps the old code in memory until restarted, so an open session is never disrupted.
- The rebuilt archive is written to `app.asar.vision-better.new` first and left in place if the swap cannot
  happen yet, so nothing is half-applied: the original is either untouched or fully replaced.
- Uninstalling the plugin does not remove the extension; use `restore-core-patch.cmd` for that.

## Verify

```bash
node patches/verify-patch.mjs <dsh-src-root>
```

Prints nine checks: the diff applies cleanly; a silent plugin preserves the rejection; `admit: true` admits;
`admit: false` styles the rejection; an image-capable model never reaches the waterfall.

## Upstream status

Not submitted. The patch targets **DSH 0.2.0-rc.2** and is written to be the smallest change that supports a
converter-based admission policy. The plugin detects its absence: without the hook it is never asked and DSH
keeps its original behaviour, so an unpatched install is unaffected.
