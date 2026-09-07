# Changelog

All notable changes to OmniRoute-Slim are documented here.

## [Unreleased]

- Excised dangling guardrails, purged dead UI routes, and aligned test globs (Phase 1-3).

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
