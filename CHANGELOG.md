# Changelog

All notable changes to OmniRoute-Slim are documented here.

## [Unreleased]

## [3.8.52] — 2026-11-02

OmniRoute-Slim v3.8.52 upstream alignment and stability release. Reconciles upstream OmniRoute v3.8.52 Phase A core proxy, security, routing, model catalog, and dashboard enhancements with OmniRoute-Slim's streamlined architecture, alongside critical production reliability and diagnostics upgrades.

### Upstream v3.8.52 Alignment (Phase A)
- **Security & Authentication**:
  - Implemented timing-safe API key comparison ([#14546](https://github.com/diegosouzapw/OmniRoute/pull/14546)) to eliminate timing side-channel attacks during key validation.
  - Enforced cryptographically secure CSPRNG state and nonce generation for OIDC login flows ([#14612](https://github.com/diegosouzapw/OmniRoute/pull/14612)).
  - Bounded Redis connection (2s) and command (1s) timeouts with explicit `withTimeout` fallbacks to prevent authentication hangs during cache latency.
  - Hardened client API route authentication with fallback support for ungated `x-api-key` and `x-goog-api-key` headers ([#17103](https://github.com/diegosouzapw/OmniRoute/pull/17103)).
- **Providers & Flagship Model Specs**:
  - Registered Claude Opus 5.5 with 1M context window, 5 reasoning effort tiers, and Claude Fast Mode passthrough ([#16643](https://github.com/diegosouzapw/OmniRoute/pull/16643), [#16622](https://github.com/diegosouzapw/OmniRoute/pull/16622)).
  - Registered OpenAI / Codex GPT-6 Sol and Luna with 1.05M context window specs ([#16680](https://github.com/diegosouzapw/OmniRoute/pull/16680)) and dedicated OAuth pricing tiers ([#16648](https://github.com/diegosouzapw/OmniRoute/pull/16648)).
  - Added Gemini tool call `$ref` sanitization ([#16153](https://github.com/diegosouzapw/OmniRoute/pull/16153)) and DSML tool call flush logic ([#16606](https://github.com/diegosouzapw/OmniRoute/pull/16606)).
- **Combos & Compression**:
  - Refactored combo strategies into typed `StrategyTraits` with backward compatibility ([#16206](https://github.com/diegosouzapw/OmniRoute/pull/16206)).
  - Added family wire alias locking to protect internal aliases from model family drift ([#17113](https://github.com/diegosouzapw/OmniRoute/pull/17113)).
  - Implemented compression live-zone calculation preserving current conversation turns ([#17097](https://github.com/diegosouzapw/OmniRoute/pull/17097)).
  - Prioritized persisted auto-combos (exact and fuzzy) before virtual built-ins in alias resolution ([#12967](https://github.com/diegosouzapw/OmniRoute/pull/12967)), falling back to built-ins when persisted combos have empty model lists.
- **Streaming Lifecycle & Error Resilience**:
  - Classified upstream Responses 400/403 safety stops as pre-content and kept streams alive ([#17049](https://github.com/diegosouzapw/OmniRoute/pull/17049)).
  - Implemented terminal safety stop latch ([#17072](https://github.com/diegosouzapw/OmniRoute/pull/17072)) that peeks past opening role-only frames but disarms immediately on substantive reasoning chunks (`thinking`, `thought`, `reasoning_details`).
  - Added nested upstream error payload unnesting (`response.error`) for clear diagnostics ([#16438](https://github.com/diegosouzapw/OmniRoute/pull/16438)).
- **Usage & Analytics**:
  - Fixed `SlicedString` memory retention in high-throughput JSON parsers ([#15961](https://github.com/diegosouzapw/OmniRoute/pull/15961)).
  - Added lightweight `getApiKeysUsageTotals` summary view ([#15688](https://github.com/diegosouzapw/OmniRoute/pull/15688)).
  - Incorporated `call_logs` timestamps into `lastUsed` reporting ([#15687](https://github.com/diegosouzapw/OmniRoute/pull/15687)).
- **Dashboard & Locales**:
  - Added `excludeTests` toggle filter to Request Timeline ([#10897](https://github.com/diegosouzapw/OmniRoute/pull/10897)).
  - Upgraded sidebar and nested UI elements to WCAG 2 AA contrast tokens ([#17154](https://github.com/diegosouzapw/OmniRoute/pull/17154)).
  - Differentiated click vs drag interactions in Request Timeline ([#17024](https://github.com/diegosouzapw/OmniRoute/pull/17024)).
  - Propagated `skipped` model status in batch model testing to exempt generation-only models from auto-hiding.

### Core Features & Diagnostics
- **Call-Log Artifact Previews**:
  - Oversized call-log artifacts now retain prompt and response previews (up to `CALL_LOG_ARTIFACT_PREVIEW_KB`, default 8 KiB, with 2 KiB degraded fallback) and real error text (up to 4 KiB) instead of wholesale omission markers.
  - Replaced red error styling with neutral amber notices for size-limited payload entries in Request Logger Detail.
- **Build Identity & Ledger Governance**:
  - Baked dynamic OCI labels, monotonic tag grammar (`{tier}.{upstream}.{seq}.{sha8}`), and runtime build receipts into `/api/system/version`.
  - Added machine-checkable feature ledger (`ops/features.json`) and automated matrix verification (`docs/FEATURES.md`).
- **Production Resilience & Lifecycle Hardening**:
  - Restored Undici keep-alive pooling with pipelining 1 and clean first-byte stream/abort reference release.
  - Prevented heap pressure deadlocks via dynamic health evaluation and automatic 2-strike timeout pin eviction.
  - Added Nvidia `forceStream` override and startup timeout disarming prior to SSE drain.
  - Enabled per-target timeout attribution to the dispatched connection and gated universal handoff to multi-turn bodies.

## [3.9.0] — 2026-09-27

OmniRoute-Slim initial public release. A focused, lightweight distribution of OmniRoute preserving core proxy, routing, combo, quota, and compression engines while streamlining peripheral subsystems.

### Features & Improvements
- **Gemini CLI / Code Assist Revival**:
  - Bumped client User-Agent to `0.61.0`.
  - Added automatic 429 capacity exhaustion fallback routing to handle Google Cloud resource limits gracefully.
  - Implemented model tier quota grouping and cache isolation (`geminiCliQuotaTier.ts`) across Flash, Pro, and Experimental tiers.
- **Antigravity & Provider Family Quota Cutoffs**:
  - Enforced scope-aware quota cutoffs in the preflight evaluator (`quotaCutoffScope.ts`), preventing retry thrashing when model tiers are exhausted.
- **Client Version Gating Overrides**:
  - Added `CLAUDE_CODE_CLIENT_VERSION` (alongside `CODEX_CLIENT_VERSION`) environment variable overrides to seamlessly adapt to upstream Anthropic and OpenAI client-version gates without requiring proxy rebuilds.
- **SSE Streaming & Pipeline Reliability**:
  - Fixed pending request leaks on SSE stream `flush()` errors.
  - Guarded against null chunks in translator streams and resolved an audit context error on authentication failure.
- **Localization**:
  - Retained clean Tier 1 localizations (EN, ES, FR, DE, JA, ZH) for retained proxy features while pruning dead strings from excised modules.
- **CI/CD & Packaging**:
  - Multi-arch Docker publishing pipeline (`linux/amd64`, `linux/arm64`) to GitHub Container Registry (`ghcr.io/b3nw/omniroute-slim`).
  - Swapped out heavy upstream CI steps for fast, public GitHub Actions workflows.

## [3.8.51] — 2026-09-07

OmniRoute-Slim is the focused standalone distribution of OmniRoute. It preserves the
core proxy, routing, combo, quota, and compression functionality while removing
peripheral subsystems that are not part of the slim runtime.

- Reduced the source tree by approximately 66% (about 1.7 million lines).
- Retained the core OpenAI-compatible proxy and provider routing paths.
- Retained combos, quota-aware routing, and RTK/Caveman compression.
- Excised MITM proxy infrastructure, agent bridges, desktop/electron integrations,
  Radar/news UI, multilingual mirrors, and other upstream-only tooling.
- Established a smaller, independently maintainable package with focused quality
  gates for the slim runtime.
