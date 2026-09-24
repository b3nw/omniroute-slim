---
title: "Slim Reduction Metrics"
version: 3.9.0
lastUpdated: 2026-09-24
---

# Slim Reduction Metrics

> **What OmniRoute-Slim removed relative to upstream OmniRoute, and why.**

`OmniRoute-Slim` is a streamlined fork of [OmniRoute](https://github.com/b3nw/OmniRoute). It keeps the
proxying, routing, and streaming core intact and excises peripheral subsystems. This document records
the measured footprint reduction and the per-subsystem rationale.

---

## 1. Macro Reduction & Footprint

Baseline is the fork-point commit `75fd0bd` (the imported upstream OmniRoute snapshot); "Slim" is the
current `HEAD`. Line counts cover git-tracked files only, excluding lockfiles and binary assets.

| Metric                                                     | Upstream OmniRoute (`75fd0bd`) | OmniRoute-Slim (HEAD)        | Reduction                   |
| ---------------------------------------------------------- | ------------------------------ | ---------------------------- | --------------------------- |
| **All tracked text lines**                                 | ~3.58M lines (3,583,374)       | **~1.77M lines (1,766,748)** | **-1.82M lines (-50.7%)**   |
| **Core `src/` + `open-sse/` TypeScript** _(`.ts`/`.tsx`)_  | ~861k lines (860,803)          | **~713k lines (713,109)**    | **-148k lines (-17.2%)**    |
| **Localization assets** _(42 non-English locales removed)_ | 606,078 lines (37.0 MB)        | **15,292 lines (773 KB)**    | **-590,786 lines (-97.5%)** |
| **Disk footprint** _(excl. `node_modules`, `.git`)_        | —                              | **~74 MB on disk**           | —                           |
| **Third-party dependencies**                               | 77 runtime / 55 dev            | **71 runtime / 54 dev**      | **-6 runtime / -1 dev**     |

Localization figures span both dictionary sets — `src/i18n/messages/` and `bin/cli/locales/`. Each
retains only `en.json` (723 KB and 49 KB respectively); the 42 non-English locales were dropped from
both, eliminating 84 JSON files.

---

## 2. Subsystem Boundary

```
                        ┌──────────────────────────────────────────────┐
                        │              OmniRoute-Slim                  │
                        ├──────────────────────────────────────────────┤
  RETAINED CORE         │  • Universal SSE Streaming Format Engine     │
  (High-Throughput      │  • Upstream TLS JA3/JA4 Emulation (opt-in)   │
   Proxying & Routing)  │  • Live Dynamic Catalog & models.dev Sync    │
                        │  • Quota Pools & Antigravity Dual-Window Cap │
                        │  • Combos, Load Balancing & Reasoning Router │
                        │  • Prompt Compression (extractive + ladder)  │
                        │  • Operational WebUI Dashboard               │
                        └──────────────────────┬───────────────────────┘
                                               │
               EXCISED SUBSYSTEMS              ▼
       ┌───────────────────────────────────────────────────────────────┐
       │ ❌ 42 Non-English Locales (-591k LOC across both dict sets)   │
       │ ❌ MITM Transparent CA Generator & Tunnels (Tailscale/ngrok)  │
       │ ❌ IDE/CLI Helpers & Config Injectors (Cursor/VSCode)         │
       │ ❌ Autonomous Agent Frameworks (A2A, Conductor, Skills)       │
       │ ❌ Vector Memory & Local Corpus RAG (sqlite-vec, onnxruntime) │
       │ ❌ Guardrails Subsystem & Modality Bridge API Surface         │
       │ ❌ Real-Time Radar 3D Visualizer & Chaos Engineering          │
       │ ❌ Gamification, Badges, XP & Third-Party Sync (Notion/Obs)   │
       │ ❌ Desktop (Electron) Shell & Browser Pool                    │
       │ ❌ Heavy Packages (express, lowdb, transformers, http-proxy)  │
       └───────────────────────────────────────────────────────────────┘
```

**Upstream TLS fingerprint emulation is opt-in, not default-on.** It activates only when
`ENABLE_TLS_FINGERPRINT="true"` and the `wreq-js` transport is loadable. For traffic that also
traverses a forward proxy, an explicit `TLS_FINGERPRINT_PROVIDERS` allowlist is additionally
required — absent that allowlist, fingerprinting stays confined to direct (non-proxied) egress so
enabling the flag cannot silently alter proxied traffic (`open-sse/utils/proxyFetch.ts`).

---

## 3. Retained & Hardened Features

- **Universal Streaming & Translation Engine (`open-sse/`):**
  - Zero-allocation bidirectional streaming SSE format conversion across **OpenAI, Anthropic, Google Gemini, DeepSeek, xAI, Groq, Mistral, Ollama, and Cohere**.
  - Complete normalization for reasoning deltas (`thinking`, `reasoning_content`), tool call chunk reassembly, and usage tracking.
- **Upstream Forward Proxying & TLS Fingerprint Emulation (`proxyFetch.ts`, `proxyEgress.ts`):**
  - Full outbound HTTP, HTTPS, and SOCKS5 (with remote DNS resolution) egress proxy support.
  - Browser and curl TLS JA3/JA4 fingerprint emulation on upstream requests, gated behind `ENABLE_TLS_FINGERPRINT` plus a provider allowlist for proxied egress (see §2).
- **Dynamic Catalog Synchronization (`src/lib/catalog/`):**
  - Live model discovery, pricing ingestion, and capability mapping directly from provider endpoints and `models.dev`.
  - Context window definitions, model aliasing, and tokenizer metadata.
- **Combos, Load Balancing & Reasoning Routing:**
  - Model aliasing, sequential fallback chains, weighted load distribution, and reasoning model selection.
  - Circuit breaking, provider cooldowns, and automatic failover.
- **Quota Pools & Antigravity Dual-Quota Tracking (`src/lib/quota/`):**
  - Hard and soft spend budgets with auto-cutoff.
  - Dual-window quota tracking supporting both 5-hour rolling session allocations and 7-day rolling weekly caps.
  - Single-flight OAuth refresh locks to eliminate token invalidation races.
- **Prompt Compression Engine (`open-sse/services/compression/`):**
  - **Extractive token compression** — the engine registry under `engines/` (relevance, LLMLingua, RTK, CCR, session-dedup, headroom, Omniglyph, Caveman) prunes and rewrites context rather than re-encoding it.
  - **Adaptive relevance ladder** (`adaptiveCompression/ladder.ts`) escalates compression tiers against a computed token target, backed by a fidelity gate, hard budget, and worker pool.
  - `src/lib/compression/` retains only the judge-model client used to score compression fidelity.
- **Operational WebUI Dashboard (`src/app/(dashboard)/`):**
  - Primary operational surfaces: **Providers** (`/dashboard/providers`), **Combos & Routing** (`/dashboard/combos`), **API Keys & Quotas** (`/dashboard/api-manager`), **Usage & Costs** (`/dashboard/usage`, `/dashboard/costs`), **Prompt Compression** (`/dashboard/compression`, `/dashboard/context`), and **System Health & Settings** (`/dashboard/health`, `/dashboard/settings`).
  - These are the surfaces the Slim fork actively maintains, not an exhaustive route list — the tree also ships analytics, logs, cache, and discovery views inherited from upstream.
- **Retained surfaces worth calling out explicitly:**
  - **Interactive Playground** — the provider playground component library lives at `/dashboard/providers/playground/` and is mounted inside the provider detail page (`/dashboard/providers/[id]`) and the provider test slide-over; it has no standalone `page.tsx` of its own. A navigable combo playground route does exist at `/dashboard/combos/playground`.
  - **Batch API** — `/api/v1/batches` (plus `/[id]`, `/[id]/cancel`, `/delete-completed`) remains fully wired to `src/lib/db/batches`. Batch processing was **not** excised.

---

## 4. Removed Subsystems & Trade-off Rationale

| Excised Subsystem                    | Location(s) Removed                                                                  | Why Excised & Operational Impact                                                                                                                                                                                                                                                 |
| ------------------------------------ | ------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **42 Non-English Locales**           | `src/i18n/messages/*.json`, `bin/cli/locales/*.json`                                 | Static JSON dictionaries accounted for ~591k lines (97.5% of all localization content). Standardized on an English-only runtime (`en.json` in both dictionary sets).                                                                                                             |
| **MITM Transparent Proxy & Tunnels** | `src/mitm/`, `tailscaleTunnel.ts`, `cloudflaredTunnel.ts`, `ngrokTunnel.ts`          | Local root CA generation and OS DNS hijacking require high privileges and are fragile in server environments. Upstream forward proxying is preserved.                                                                                                                            |
| **CLI Helpers & IDE Injectors**      | `src/lib/cli-helper/`, `src/lib/cursor/`, `src/lib/vscode/`                          | External editor configuration injectors are outside the scope of dedicated proxy infrastructure.                                                                                                                                                                                 |
| **Autonomous Agent Systems**         | `src/lib/a2a/`, `src/lib/conductor/`, `src/lib/skills/`, `src/lib/acp/`              | Agent-to-agent protocols and background issue-fixing bots add complex state machines unrelated to low-latency proxying.                                                                                                                                                          |
| **Vector Memory & Local RAG**        | `src/lib/memory/`, `sqlite-vec`, `onnxruntime-node`                                  | Heavy native binary dependencies and embedding chunkers bloated memory and build artifacts.                                                                                                                                                                                      |
| **Guardrails & Modality Bridge**     | `src/lib/guardrails/`, `/api/modality-bridge`                                        | Both directories and the API route are gone, and the P1 dangling imports they left behind are resolved. Residual settings-schema fields (`modalityBridge*`) and the post-call `reconcileGuardrailReroute` hook in `src/sse/handlers/` are retained as inert compatibility shims. |
| **Real-time Diagnostics & Toys**     | `src/lib/radar/`, `src/lib/chaos/`, `src/lib/vncSession/`, `src/lib/evals/`          | WebSocket 3D graph animations, fault injectors, remote VNC canvases, and LMSYS Elo scrapers excised.                                                                                                                                                                             |
| **Gamification & Third-Party Sync**  | `src/lib/gamification/`, `src/lib/notion/`, `src/lib/obsidian/`, `src/lib/telegram/` | Badges, XP points, and note-taking sync integrations removed.                                                                                                                                                                                                                    |
| **Desktop Shell & Browser Pool**     | `electron/`, browser-pool runtime                                                    | The Electron desktop wrapper and the headless browser pool are unnecessary for a headless server deployment and carried large native dependency trees.                                                                                                                           |
| **Excised Dependencies**             | `package.json`                                                                       | Removed packages including `express`, `http-proxy-middleware`, `https-proxy-agent`, `lowdb`, `selfsigned`, `@ngrok/ngrok`, `@huggingface/transformers`, `onnxruntime-node`, `sqlite-vec`, and `node-loader`.                                                                     |

> **Note:** `src/lib/jobs/` is **retained** — it holds scheduled maintenance jobs (backup, budget reset, reasoning-cache cleanup, token health checks), not an async batch queue registry.
