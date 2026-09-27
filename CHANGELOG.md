# Changelog

All notable changes to OmniRoute-Slim are documented here.

## [Unreleased]

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
