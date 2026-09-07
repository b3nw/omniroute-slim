# OmniRoute-Slim

**OmniRoute-Slim** is a high-performance, ultra-lean, multi-provider LLM proxy and intelligent router. Derived from [OmniRoute](https://github.com/b3nw/OmniRoute), it removes peripheral subsystems (MITM local interception, autonomous agent orchestrators, vector memory/RAG, gamification, and multi-lingual dictionary overhead) to provide a resilient, single-purpose routing core.

---

## 1. Macro Reduction & Footprint Metrics

| Metric                                              | Upstream OmniRoute     | OmniRoute-Slim             | Reduction                   |
| --------------------------------------------------- | ---------------------- | -------------------------- | --------------------------- |
| **Disk Footprint** _(excl. `node_modules`, `.git`)_ | **1.6 GB**             | **~84 MB**                 | **-1.51 GB (-94.7%)**       |
| **Source Code Lines (LOC)**                         | ~1,147,000 lines       | **~385,000 lines**         | **-762,000 lines (-66.4%)** |
| **`src/` Directory Size**                           | 41 MB                  | **17 MB**                  | **-24 MB (-58.5%)**         |
| **Localization Assets**                             | 18.5 MB (43 languages) | **~1.2 MB (English-only)** | **-17.3 MB (-93.5%)**       |
| **Third-Party Dependencies**                        | ~85 packages           | **~50 packages**           | **-35 packages**            |

---

## 2. Architecture & Subsystem Boundary

```
                        ┌──────────────────────────────────────────────┐
                        │              OmniRoute-Slim                  │
                        ├──────────────────────────────────────────────┤
  RETAINED CORE         │  • Universal SSE Streaming Format Engine     │
  (High-Throughput      │  • Upstream TLS JA3/JA4 Fingerprint Emulation│
   Proxying & Routing)  │  • Live Dynamic Catalog & models.dev Sync    │
                        │  • Quota Pools & Antigravity Dual-Window Cap │
                        │  • Combos, Load Balancing & Reasoning Router │
                        │  • Prompt Compression Engine (AST/Extractive)│
                        │  • Streamlined 6-Surface Operational WebUI   │
                        └──────────────────────┬───────────────────────┘
                                               │
               EXCISED SUBSYSTEMS              ▼
       ┌───────────────────────────────────────────────────────────────┐
       │ ❌ 42 Non-English Locales (-586k LOC)                         │
       │ ❌ MITM Transparent CA Generator & Tunnels (Tailscale/ngrok) │
       │ ❌ IDE/CLI Helpers & Config Injectors (Cursor/VSCode)         │
       │ ❌ Autonomous Agent Frameworks (A2A, Conductor, Skills)       │
       │ ❌ Vector Memory & Local Corpus RAG (sqlite-vec, onnxruntime) │
       │ ❌ Guardrails, Modality Bridge (Audio/Video OCR)              │
       │ ❌ Async Batch Runner & Queue Registry                        │
       │ ❌ Real-Time Radar 3D Visualizer & Chaos Engineering         │
       │ ❌ Gamification, Badges, XP & Third-Party Sync (Notion/Obs)   │
       │ ❌ Heavy Packages (express, lowdb, transformers, http-proxy)  │
       └───────────────────────────────────────────────────────────────┘
```

---

## 3. Feature Analysis: Available vs. Removed

### 3.1 Available & Hardened Features

- **Universal Streaming & Translation Engine (`open-sse/`):**
  - Zero-allocation bidirectional streaming SSE format conversion across **OpenAI, Anthropic, Google Gemini, DeepSeek, xAI, Groq, Mistral, Ollama, and Cohere**.
  - Complete normalization for reasoning deltas (`thinking`, `reasoning_content`), tool call chunk reassembly, and usage tracking.
- **Upstream Forward Proxying & TLS Fingerprint Emulation (`proxyFetch.ts`, `proxyEgress.ts`):**
  - Full outbound HTTP, HTTPS, and SOCKS5 (with remote DNS resolution) egress proxy support.
  - Browser and curl TLS JA3/JA4 fingerprint emulation on upstream requests to bypass Cloudflare/Akamai bot detection.
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
- **Prompt Compression Engine (`src/lib/compression/`):**
  - Built-in AST parsing and extractive token compression to reduce upstream context size and token costs.
- **Streamlined WebUI Dashboard (`src/app/(dashboard)/`):**
  - Focused exclusively on 6 operational surfaces:
    1. **Providers** (`/dashboard/providers`)
    2. **Combos & Routing** (`/dashboard/combos`)
    3. **API Keys & Quotas** (`/dashboard/api-manager`)
    4. **Usage & Costs** (`/dashboard/usage`, `/dashboard/costs`)
    5. **Prompt Compression** (`/dashboard/compression`)
    6. **System Health & Runtime** (`/dashboard/health`, `/dashboard/settings`)

---

### 3.2 Features Removed & Trade-off Rationale

| Excised Subsystem                    | Location(s) Removed                                                                  | Why Excised & Operational Impact                                                                                                                                                                             |
| ------------------------------------ | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **42 Non-English Locales**           | `src/i18n/messages/*.json`                                                           | Static JSON dictionaries accounted for over 51% of upstream lines of code. Standardized on English-only runtime (`en.json`).                                                                                 |
| **MITM Transparent Proxy & Tunnels** | `src/mitm/`, `tailscaleTunnel.ts`, `cloudflaredTunnel.ts`, `ngrokTunnel.ts`          | Local root CA generation and OS DNS hijacking require high privileges and are fragile in server environments. Upstream forward proxying is preserved.                                                        |
| **CLI Helpers & IDE Injectors**      | `src/lib/cli-helper/`, `src/lib/cursor/`, `src/lib/vscode/`                          | External editor configuration injectors are outside the scope of dedicated proxy infrastructure.                                                                                                             |
| **Autonomous Agent Systems**         | `src/lib/a2a/`, `src/lib/conductor/`, `src/lib/skills/`, `src/lib/acp/`              | Agent-to-agent protocols and background issue-fixing bots add complex state machines unrelated to low-latency proxying.                                                                                      |
| **Vector Memory & Local RAG**        | `src/lib/memory/`, `sqlite-vec`, `onnxruntime-node`                                  | Heavy native binary dependencies and embedding chunkers bloated memory and build artifacts.                                                                                                                  |
| **Guardrails & Modality Bridge**     | `src/lib/guardrails/`, `/api/modality-bridge`                                        | Audio/video transcription pipelines and regex content-moderation filters belong in dedicated external stages.                                                                                                |
| **Batch Runner & Queue Registry**    | `src/lib/batches/`, `src/lib/jobs/`                                                  | Bulk asynchronous file jobs bypassed the real-time proxy flow.                                                                                                                                               |
| **Real-time Diagnostics & Toys**     | `src/lib/radar/`, `src/lib/chaos/`, `src/lib/vncSession/`, `src/lib/evals/`          | WebSocket 3D graph animations, fault injectors, remote VNC canvases, and LMSYS Elo scrapers excised.                                                                                                         |
| **Gamification & Third-Party Sync**  | `src/lib/gamification/`, `src/lib/notion/`, `src/lib/obsidian/`, `src/lib/telegram/` | Badges, XP points, and note-taking sync integrations removed.                                                                                                                                                |
| **Excised Dependencies**             | `package.json`                                                                       | Removed packages including `express`, `http-proxy-middleware`, `https-proxy-agent`, `lowdb`, `selfsigned`, `@ngrok/ngrok`, `@huggingface/transformers`, `onnxruntime-node`, `sqlite-vec`, and `node-loader`. |

---

## 4. Testing Policy & Homelab Verification

- **Mandatory Testing Model:** All automated tests, live verification probes, and homolog checks must strictly target **`inferx/*`** models (e.g. `inferx/deepseek-v4-flash-0731`, `inferx/glm-5.3-flash`).
- **OAuth Testing Prohibition:** Never test against Anthropic or OpenAI/Codex OAuth tokens.

---

## 5. Operational Commands

```bash
# Install dependencies
npm install

# Run development server (port 20128)
npm run dev

# Run quality gates
npm run typecheck:core               # Strict TypeScript check for proxy core
npm run check:open-sse-typecheck     # Open-SSE typecheck validation (0 errors baseline)
npm run test:security                # Security and secrets validator tests
npm run test:plan3                   # Core routing and executor tests
npm run check:env-doc-sync           # Contract sync between code, docs, and .env.example

# Production standalone build
npm run build
```
