# Implementation plan (≤1 page)

Target: DSH desktop **0.2.0-rc.2** (packaged runtime), verified against the shipped `@deepseek-ai/*` sources.
Deliverable: one DSH bundle `dsh-vision-better` (Host half + Client half) plus one separated core patch.

## What runs where

| Piece | Type | File |
|---|---|---|
| Vision sidecar (GLM call, cache, validation, logging) | **pure plugin**, Host | `lib/*.js` |
| Hidden vision context injection for the current turn | **pure plugin**, Host — `agent/pre-step` | `lib/relay.js` |
| Settings page ("图像识别") | **pure plugin**, Client (lazy-CJS bundle) | `client/client.js` |
| API key storage | **pure plugin** — `ctx.credentials` (host) / `credentials.describe` (client) | `lib/config.js` |
| Image admission for a text-only model | **DSH core patch** (one waterfall) | `patches/` |

## Core gap (evidence)

`@deepseek-ai/dsh-api-session-controller/lib/index.js:870-874` (and `lib/types/commands.js:313-318`) rejects any
prompt carrying an image when `resolveModelInfo(...).inputModalities` is defined and lacks `"image"`.
The rejection happens **before** `admitPromptContent` and before the `user/message` event, so the image never
enters the session. `resolveModelInfo` is a plain method with no hook, so no plugin can influence it, and
faking `inputModalities` is explicitly out of bounds.

Minimal upstream extension (~12 lines, no capability faking): a `session/image-admission` waterfall around
that one check. Default = today's behaviour. A listener may return `{admit:true}` (a converter takes
responsibility for the images) or a replacement `{code,message}` for the rejection.

## Hidden-context mechanism (no core change needed)

`agent/pre-step` is a public waterfall (`dsh-tool-cordis/.../api-catalog.js:3764-3770`); its decision's
`messages` are appended as `user/message` events by `dsh-agent-loop/lib/index.js:1061`, and
`dsh-client-ui-chat/lib/client.js:9276` classifies any `user/message` whose `source.kind !== "user"` as a
hidden **context** node (same channel DSH uses for its runtime-context snapshot). The user's own message is
never touched, so the visible bubble, the image and the session log stay byte-identical.

## Routing

`native` (declared image support) → 0 GLM calls. `text-only` → 1 batched GLM call/turn.
`undefined` → **treated as not-natively-capable** (spec: never assume support): relay runs, nothing is stripped.

## Failure policy

A `pre-step` throw would drop the claimed user message before it is logged (input loss). Therefore the plugin
never throws: it injects an explicit, model-visible failure notice with a stable code
(`VISION_RELAY_UNAUTHORIZED`, `..._RATE_LIMITED`, `..._TIMEOUT`, `..._FAILED`, `..._UNCONFIGURED`) and instructs
the model not to guess. Image + input stay in the session and the user can retry.

## Out of scope (v1)

Downscaling/re-encoding (DSH already normalizes attachments), image generation, video, OCR product,
telemetry, auto-update, an on-demand re-analysis tool, and any change to the model picker or chat UI.
