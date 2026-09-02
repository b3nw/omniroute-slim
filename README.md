# OmniRoute-Slim

**OmniRoute-Slim** is a high-performance, streamlined, multi-provider LLM proxy and intelligent router. It is derived from [OmniRoute](https://github.com/b3nw/OmniRoute) by excising non-core peripheral subsystems (MITM local interception, autonomous agent orchestrators, vector memory/RAG, gamification, and multi-lingual dictionary bloat) to focus purely on routing, catalog synchronization, resilient proxying, quota monitoring, and cost tracking.

---

## Core Value Proposition

- **~66% Code Reduction**: Eliminates ~760,000 lines of non-core overhead and 17+ MB of static translation assets.
- **Ultra-Fast & Modular**: Focuses on core routing, streaming translation, and rate-limiting.
- **Universal Provider Translation**: Native streaming SSE format conversion across OpenAI, Anthropic, Google Gemini, xAI, Groq, DeepSeek, Mistral, Ollama, Cohere, etc.
- **Intelligent Routing & Combos**: Dynamic model aliasing, fallback chains, weighted load balancing, and reasoning router.
- **Upstream Forward Proxies & TLS Fingerprint Emulation**: Complete HTTP, HTTPS, SOCKS5 (with remote DNS) egress proxy support, rotating proxy pools, and TLS JA3/JA4 fingerprint emulation to prevent upstream CDN/Cloudflare bot blocks.
- **Comprehensive Quota & Token Health Monitoring**: Hard/soft spend budgets, Antigravity dual-window tracking (5h session + 7-day rolling weekly cap), single-flight OAuth token refreshes, and proactive background credential health probing.
- **Prompt Compression Pipeline**: Built-in AST and extractive token compression to reduce upstream token burn.
- **Streamlined WebUI Dashboard**: 6 core operational dashboards (**Providers**, **Combos**, **API Keys**, **Usage & Costs**, **Prompt Compression**, and **System Settings**).

---

## Architecture at a Glance

| Layer                      | Location                                                  | Purpose                                                                                                |
| -------------------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| **API Endpoints**          | `src/app/api/`                                            | Next.js App Router endpoints for `/v1/chat/completions`, `/v1/models`, `/v1/messages`, auth & settings |
| **Streaming & Proxy Core** | `src/sse/` & `open-sse/`                                  | High-throughput streaming transforms, format translation, and connection pipelines                     |
| **Egress & TLS Emulation** | `src/lib/proxyEgress.ts` & `open-sse/utils/proxyFetch.ts` | Upstream forward proxy dispatcher, proxy pools, and JA3/JA4 fingerprinting                             |
| **Catalog & Model Sync**   | `src/lib/catalog/` & `src/lib/modelsDevSync.ts`           | Dynamic metadata and pricing discovery from upstream APIs and `models.dev`                             |
| **Persistence & Quota**    | `src/lib/db/` & `src/lib/quota/`                          | Cleaned SQLite schema for accounts, combos, keys, rate limits, and token usage                         |
| **WebUI Dashboard**        | `src/app/(dashboard)/`                                    | Focused Next.js dashboard for operational management                                                   |

---

## What Was Excluded in Slim

To maintain a lean and robust core, the following peripheral subsystems from upstream OmniRoute are omitted:

1. **45 Non-English Locales** (English-only runtime saves 586k lines of JSON).
2. **MITM Transparent Proxy & Tunnels** (Local root CA generator and DNS hijacker removed; upstream egress proxying is 100% preserved).
3. **Autonomous Agent Systems** (A2A, Conductor, CloudAgent, IssueAgent, ACP, agent skills).
4. **Vector Memory & Local Corpus RAG** (SQLite vector store and embeddings chunker).
5. **Guardrails & Modality Bridge** (Regex/LLM moderation filters and OCR bridges).
6. **Auxiliary Tools & Toys** (Gamification, Radar 3D node graph visualizer, Chaos fault injector, VNC session viewer, LMSYS Arena Elo scraper, Obsidian/Notion/Telegram bots).
7. **Interactive Chat Playground** (Standalone multi-model chat UI).
8. **Batch Processing API & Queue Runner** (Async file batch scheduler).
9. **External Log Exporters & Webhooks** (S3/Datadog sinks and outgoing webhook dispatcher).

---

## Getting Started

```bash
npm install
npm run dev        # Starts development server at http://localhost:20128
npm run build      # Production Next.js standalone build
npm run test       # Run core test suite
```
