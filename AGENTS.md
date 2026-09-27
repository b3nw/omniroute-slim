# OmniRoute-Slim Agent Guidelines & Workflow Rules

> **Single source of truth.** This file holds project rules, conventions, architectural boundaries, and workflow instructions for agents working on `OmniRoute-Slim`.

---

## 1. Project Boundaries & Identity

`OmniRoute-Slim` is a streamlined, decoupled LLM proxy and router forked from `OmniRoute`. It preserves all core proxying, streaming format translation, catalog sync, model combos, upstream forward proxies (with TLS fingerprint emulation), quota tracking, and WebUI management, while excising all peripheral subsystems (MITM local cert proxy, autonomous agents, vector memory/RAG, gamification, 45 translation bundles).

### Core Invariants:

1. **Never Re-introduce Excluded Subsystems**: Do not add back MITM root CA interception, multi-agent frameworks (A2A/Conductor/ACP), vector memory stores, or gamification.
2. **Preserve Upstream Proxying & TLS Emulation**: Upstream forward proxies (HTTP, HTTPS, SOCKS5 with remote DNS), proxy pools, and TLS JA3/JA4 fingerprinting in `proxyFetch.ts` are core features.
3. **Preserve Quota & Credential Health Systems**: Quota pools, spend limits, Antigravity dual-quota tracking, single-flight OAuth locks, and credential health probing are core features.
4. **Tier 1 Localization**: Maintain the streamlined Tier 1 localization runtime (English default + German, Spanish, French, Japanese, Brazilian Portuguese, and Simplified Chinese) strictly aligned to retained features; do not re-import unpruned or non-Tier-1 locale bundles.

---

## 2. Development Workflow & Git Norms

1. **Worktree-First Development**:
   - All feature work, refactoring, and bug fixes must happen in dedicated topic branches in git worktrees under `OmniRoute-Slim/worktrees/<short-name>`.
2. **Local Documentation**:
   - Local scratchpads, PR notes, checklists, and design docs must live in `local-ops/docs/`.
   - Never commit temporary files or draft notes to source control.
3. **Remote Operations & Deployments**:
   - Never push directly to remote git repositories without explicit user confirmation.
   - All docker management and deployments must be performed via `komodo` MCP server tools.

---

## 3. Tooling & Verification Commands

```bash
# Install dependencies
npm install

# Start development server
npm run dev

# Run TypeScript checks
npm run typecheck:core

# Run unit tests
npm run test

# Run a single focused unit test
node --import tsx/esm --test tests/unit/your-file.test.ts

# Production build
npm run build
```
