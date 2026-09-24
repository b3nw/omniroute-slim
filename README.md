# OmniRoute-Slim

**Streamlined AI Model Gateway & Proxy**

A high-performance, single-purpose proxy and intelligent router for large language models — one
OpenAI-compatible endpoint in front of every provider you use.

---

## What is OmniRoute-Slim?

OmniRoute-Slim sits between your application and your model providers. Point your client at it once,
and it handles authentication, routing, failover, quota accounting, and streaming format translation
for you.

Its core is a zero-allocation streaming SSE conversion engine that translates request and response
formats bidirectionally across **OpenAI, Anthropic, Google Gemini, DeepSeek, xAI, Groq, Mistral,
Ollama, and Cohere** — including reasoning deltas (`thinking`, `reasoning_content`), tool-call chunk
reassembly, and usage accounting. A client that speaks the OpenAI Chat Completions API can drive an
Anthropic or Gemini model without changing a line of code.

## Why "Slim"?

OmniRoute-Slim is a fork of [OmniRoute](https://github.com/b3nw/OmniRoute) with the peripheral
subsystems removed: the desktop (Electron) shell, agent-to-agent frameworks, vector memory and local
RAG, MITM certificate interception, gamification, and 42 non-English dictionary bundles. What remains
is focused entirely on fast, dependable, low-latency API routing and proxying.

The measured footprint reduction and the full per-subsystem rationale live in
[`docs/architecture/SLIM_REDUCTION_METRICS.md`](docs/architecture/SLIM_REDUCTION_METRICS.md).

## Status

**Alpha — external testers wanted.** The core proxy and routing paths are exercised by the test suite
and running in real deployments, but the project is young and the API surface may still shift.
Feedback, bug reports, and pull requests are very welcome — please
[open an issue](https://github.com/b3nw/OmniRoute-Slim/issues).

---

## Quick Start

### Docker Compose

```bash
git clone https://github.com/b3nw/OmniRoute-Slim.git
cd OmniRoute-Slim
cp .env.example .env     # then set JWT_SECRET, API_KEY_SECRET, STORAGE_ENCRYPTION_KEY
docker compose --profile base up -d omniroute-base
```

### Docker (single container)

```bash
docker build --target runner-base -t omniroute-slim .

docker run -d --name omniroute-slim \
  -p 20128:20128 \
  -v omniroute-data:/app/data \
  -e JWT_SECRET="$(openssl rand -base64 48)" \
  -e API_KEY_SECRET="$(openssl rand -hex 32)" \
  -e STORAGE_ENCRYPTION_KEY="$(openssl rand -hex 32)" \
  omniroute-slim
```

By default the dashboard and the `/v1/*` API are served together on **port 20128**. Set `API_PORT`
(conventionally `20129`) to split the proxy API onto its own listener.

The `runner-base` image is the lean server runtime. Build `--target runner-web` instead if you need
the Playwright-backed browser-session providers.

### From Source

```bash
git clone https://github.com/b3nw/OmniRoute-Slim.git
cd OmniRoute-Slim
npm install
cp .env.example .env
npm run dev
```

Then open <http://localhost:20128> for the dashboard, and send traffic to
`http://localhost:20128/v1/chat/completions`.

Runnable client snippets for curl, Python, Node.js, and PHP are in
[`examples/quickstart/`](examples/quickstart/).

---

## Configuration

Every setting is an environment variable. [`.env.example`](.env.example) is the annotated,
authoritative template — each variable is documented inline with its default and the module that
reads it. The generated cross-reference is in
[`docs/reference/ENVIRONMENT.md`](docs/reference/ENVIRONMENT.md).

At minimum, set `JWT_SECRET`, `API_KEY_SECRET`, and `STORAGE_ENCRYPTION_KEY` before exposing the
service. Provider credentials can be supplied via environment variables or added through the
dashboard at runtime.

---

## Core Features

- **Universal SSE format translation** — bidirectional streaming conversion across every supported
  provider dialect, with reasoning deltas, tool-call reassembly, and normalized usage reporting.
- **Combo models & fallback chains** — alias one logical model onto an ordered chain of real ones,
  with weighted load distribution, circuit breaking, provider cooldowns, and automatic failover.
- **Dynamic model catalog sync** — live model discovery, pricing ingestion, context-window and
  capability mapping pulled directly from provider endpoints and `models.dev`.
- **Spend & token quota tracking** — hard and soft budgets with auto-cutoff, quota pools, dual-window
  (rolling session + weekly) accounting, and single-flight OAuth refresh locks.
- **Prompt compression** — an extractive engine registry plus an adaptive relevance ladder that
  escalates compression tiers against a computed token target, behind a fidelity gate.
- **Upstream forward proxying** — HTTP, HTTPS, and SOCKS5 (with remote DNS) egress, proxy pools, and
  opt-in TLS JA3/JA4 fingerprint emulation.
- **Operational dashboard** — providers, combos and routing, API keys and quotas, usage and costs,
  compression, health, and settings.

---

## Deployment & Examples

- [`examples/quickstart/`](examples/quickstart/) — minimal client snippets (curl, Python, Node.js, PHP).
- [`contrib/vps/`](contrib/vps/) — hardened single-host Docker Compose deployment for a VPS.
- [`contrib/podman/`](contrib/podman/) — rootless Podman Quadlet units.
- [`docs/`](docs/) — architecture, routing policy, provider notes, security, and the full
  environment reference.

---

## Contributing

Contributions are welcome. See [`CONTRIBUTING.md`](CONTRIBUTING.md) for the development setup, the
quality gates a pull request must pass, and the commit conventions. Please also read the
[Code of Conduct](CODE_OF_CONDUCT.md). Security issues should follow the process in
[`SECURITY.md`](SECURITY.md) rather than being filed as public issues.

## License

[MIT](LICENSE).
