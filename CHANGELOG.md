# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.0.0] — 2026-10-10

First release, targeting DeepSeek Harness 0.2.0-rc.2.

### Added

- Host half (`lib/`): turn-level vision relay for text-only models.
  - `agent/pre-step` integration that appends a hidden context message
    (`source.kind: "vision-better"`) without touching the user's own message.
  - Capability routing on the live session selection: 0 requests for
    image-capable models and for turns without images, 1 batched request per
    turn otherwise; undeclared capability is never treated as support.
  - GLM client: OpenAI-compatible `/chat/completions`, `Authorization: Bearer`,
    multiple images in one request, `thinking` disabled by default (a thinking
    pass otherwise consumes the whole token budget and returns an empty
    `content`), bounded retry for 429/5xx/network/timeout honouring
    `Retry-After`, no retry for auth/model/image errors, `redirect: "error"`,
    cancellation propagated from the session.
  - Local pre-flight validation (media type sniffing, byte caps) and a bounded
    in-memory analysis cache keyed by image hash + endpoint + model + analysis
    version + question.
  - Stable, secret-free failure codes surfaced to the model as an explicit
    hidden notice instead of a silent placeholder.
- Client half (`client/`): the "图像识别 / Vision Better" page under Settings,
  hand-written, no build step, zh/en copy, endpoint presets, API key save/clear
  with presence-only status, enable toggle, and a connection test that uses a
  built-in sample image. The settings-nav entry carries an eye glyph.
- Core extension (`patches/0001-session-image-admission.patch`): a
  `session/image-admission` waterfall in `@deepseek-ai/dsh-api-session-controller`
  so a plugin can declare that images are handled by a converter. Default
  behaviour is unchanged when nothing answers.
- Verification: `scripts/verify-host-path.mjs` (44 end-to-end checks on a
  simulated host), `scripts/verify-cordis-activation.mjs` (activation inside the
  real cordis runtime), `scripts/verify-service-names.mjs` (service names
  cross-checked against the shipped sources), `scripts/verify-client-bundle.mjs`
  (32 checks), and the `test/` suite.

[Unreleased]: https://github.com/ethanweave/dsh-vision-better/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/ethanweave/dsh-vision-better/releases/tag/v1.0.0
