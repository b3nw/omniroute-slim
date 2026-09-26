---
title: Quality Gates Reference
---

# Quality Gates Reference

This document is the authoritative reference for all CI quality gates in OmniRoute.
It describes each gate, what it validates, which CI job it runs in, whether it uses
a ratchet baseline or a pass/fail policy, and whether it blocks the build or is advisory.

For a short summary and the allowlist policy, see the "Quality Gates & Ratchets" section
in `CLAUDE.md`. For the critical assessment, maturity classification, and tool-agnostic
replication plan of the same system, see the
[Quality Gate Playbook](../ops/QUALITY_GATE_PLAYBOOK.md).

---

## Gate Inventory (~50 scripts)

Scripts live under `scripts/check/` (policy gates) and `scripts/quality/` (ratchet engine).
The CI source of truth is `.github/workflows/ci.yml`.

### Release PR fast-path (`quality.yml`)

`.github/workflows/quality.yml` runs on PRs targeting `release/**`. It keeps contributor
branches moving with path-filtered fast gates, plus one advisory production-build signal for code
changes:

| Job                           | Scope                                                                                                                                                                                        | Blocking                               |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| `Docs Gates (fast-path)`      | Docs/code PRs; API docs refs and docs-all                                                                                                                                                    | Yes                                    |
| `Fast Quality Gates`          | Code PRs; static checks, typecheck, dashboard typecheck, impacted unit tests                                                                                                                 | Yes                                    |
| `Forgotten sibling tests`     | Code PRs; changed modules traced to static consumers and candidate sibling tests; barrel and dynamic-import paths are reported as advisory diagnostics, with referenced allowlist exceptions | **Advisory**                           |
| `Vitest (fast-path)`          | Code PRs; fast vitest suite                                                                                                                                                                  | Yes                                    |
| `Unit Tests fast-path`        | Code PRs; 4-shard unit suite                                                                                                                                                                 | Yes                                    |
| `No new ESLint warnings`      | Code PRs; suppressions-aware lint guard                                                                                                                                                      | Yes for own-origin, advisory for forks |
| `Merge integrity (changelog)` | Non-draft PRs; CHANGELOG integrity across the merge result                                                                                                                                   | Yes for own-origin, advisory for forks |

#### Forgotten sibling tests report

`npm run check:forgotten-sibling-tests` reuses the import resolver behind the test-impact map.
For every changed production module, it reports deterministic
`changed module/symbol -> static consumer -> candidate sibling test` chains when the candidate
test is absent from the pull-request diff. The Markdown summary and JSON result are retained as
the `forgotten-sibling-tests` workflow artifact for calibration before any blocking rollout.

Barrel re-exports and dynamic imports are resolution diagnostics only; they never create a
blocking finding. Reviewed exceptions live in
`config/quality/forgotten-sibling-allowlist.json`. Each entry must name the consumer and candidate
test, give a specific rationale, and link a GitHub issue or pull request. Malformed entries fail
closed. Exceptions cannot suppress a deleted candidate test or a diff that adds `.skip`/`.todo`;
assertion weakening and other masking remain owned by the independently blocking
`check:test-masking` gate.

### Public CI (`.github/workflows/ci.yml`)

`ci.yml` runs on pushes to `main`, on pull requests into `main`, and on manual
dispatch. Every job runs on GitHub-hosted `ubuntu-latest` and needs no repository
secret beyond the default `GITHUB_TOKEN`, so it works unchanged on forks and on
pull requests from forks.

A `changes` job classifies the diff first, so a docs-only pull request skips the
code jobs without skipping the docs job.

| Job                           | Scope                                                                           | Blocking                 |
| ----------------------------- | ------------------------------------------------------------------------------- | ------------------------ |
| `Lint & Format`               | Code PRs; ESLint, Prettier (changed files), hadolint on the `Dockerfile`        | Yes                      |
| `Typecheck (core + open-sse)` | Code PRs; `typecheck:core`, `check:open-sse-typecheck`, dashboard ratchet       | Yes                      |
| `Security & SSRF Tests`       | Code PRs; outbound-guard SSRF suite, security unit tests, secret scan           | Yes                      |
| `Env / Docs Sync`             | Docs or code PRs; env-var and docs contract                                     | Yes                      |
| `Unit Tests (n/4)`            | Code PRs; 4-shard `node --test` unit suite                                      | **Advisory** — see below |
| `CI Summary`                  | Always; renders a per-job result table and fails if any **blocking** job failed | Yes                      |

#### Job: `Lint & Format`

| Script (`npm run ...`) | Validates                                                                                                                                                                                                                                        | Blocking                                                                                                                          |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| `check:node-runtime`   | Node.js version is within the supported range                                                                                                                                                                                                    | Yes                                                                                                                               |
| `lint`                 | ESLint across the tree, suppressions-aware                                                                                                                                                                                                       | **Advisory** (`continue-on-error: true`) — 111 pre-existing errors and a drifted suppressions file; flip to blocking once cleared |
| `format:check`         | Prettier — **scoped to files changed in the PR**, because the tree carries a large unformatted legacy baseline and Prettier has only ever run through `lint-staged`. The npm script itself checks the full tree for the eventual one-time sweep. | Yes                                                                                                                               |
| hadolint (inline)      | `Dockerfile` lint, `--failure-threshold error`                                                                                                                                                                                                   | Yes                                                                                                                               |

#### Job: `Typecheck (core + open-sse)`

| Script (`npm run ...`)      | Validates                                                                                                                                                                                                    | Blocking |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------- |
| `typecheck:core`            | TypeScript compilation of the curated core file set                                                                                                                                                          | Yes      |
| `check:open-sse-typecheck`  | TypeScript compilation of the `open-sse/` tree                                                                                                                                                               | Yes      |
| `check:dashboard-typecheck` | `tsc` scoped to `src/app/(dashboard)/**` — `typecheck:core`'s allowlist covers no dashboard TSX and `next.config.mjs` sets `ignoreBuildErrors: true`. Diffs against a frozen baseline; only NEW errors fail. | Yes      |

#### Job: `Security & SSRF Tests`

| Script                                               | Validates                                           | Blocking |
| ---------------------------------------------------- | --------------------------------------------------- | -------- |
| `node --test tests/unit/outbound-guard-ssrf.test.ts` | Outbound request guard rejects SSRF targets         | Yes      |
| `test:security`                                      | Security unit suite (`security-fase01`)             | Yes      |
| `check:secrets`                                      | Secret scanning (gitleaks) — skips if binary absent | Yes      |

#### Job: `Env / Docs Sync`

| Script (`npm run ...`) | Validates                                                                                                          | Blocking |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------ | -------- |
| `check:env-doc-sync`   | Every env var referenced in code is in `.env.example` and `docs/reference/ENVIRONMENT.md`, and the two files agree | Yes      |
| `check:docs-sync`      | CHANGELOG version, OpenAPI version, and `llm.txt` are in sync                                                      | Yes      |

#### Why `Unit Tests` is advisory

The unit suite is red on the pre-existing tree — 38 test files fail in shard 1/4
alone. A large share are leftovers that still assert on subsystems this fork
excised, or on parent-repo workflows that do not exist here:

| Test                                 | Asserts on                                       |
| ------------------------------------ | ------------------------------------------------ |
| `mitm-passthrough-real-host-10479`   | the excised MITM local-cert proxy                |
| `docs/skillManifestsLint`            | the excised generated-skills subsystem           |
| `v388-phase3-memory`                 | the excised vector memory / RAG store            |
| `router-eval-search`                 | the excised eval surface                         |
| `nightly-compat-node26-webpack-8090` | `nightly-*.yml`, which this fork does not have   |
| `npm-publish-artifact-provenance`    | `npm-publish.yml`, which this fork does not have |
| `vps-runner-variable-scope`          | the `USE_VPS_RUNNER` internal-runner variable    |

Delete or port those, get the suite green, then remove `continue-on-error: true`
from the `test-unit` job so a real regression is a red.

### Gates that exist but are not wired into CI

These scripts are maintained and runnable locally, but are **not** steps in any
workflow because they currently fail on the pre-existing tree. Fix the underlying
violation first, then add the step — a permanently red gate produces no signal.

| Script (`npm run ...`) | Why it is unwired                                                                                                                        |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `check:public-creds`   | `open-sse/executors/zcodeProtocol.ts` builds a literal `clientId` instead of going through `resolvePublicCred()` (Hard Rule #11).        |
| `check:doc-links`      | Dead internal links to files this fork excised — `src/lib/a2a/README.md` and the removed locale READMEs.                                 |
| `check:api-docs-refs`  | `docs/openapi.yaml` documents paths with no `route.ts`, including excised surfaces such as `/api/evals` and `/api/compliance/audit-log`. |

The broader ratchet engine (`quality:collect` / `quality:ratchet`,
`check:duplication`, `check:complexity`, `check:dead-code`, `check:type-coverage`,
`check:codeql-ratchet`) and the extended scanners (`check:circular-deps`,
`check:bundle-size`, `check:vuln-ratchet`, `check:workflows`,
`check:openapi-breaking`) remain available as npm scripts and still run on the
release fast-path via `quality.yml`. They are not part of the public `ci.yml`.

### Standalone workflows

| Workflow                       | Trigger                        | Purpose                                                                       |
| ------------------------------ | ------------------------------ | ----------------------------------------------------------------------------- |
| `api-route-typecheck.yml`      | PRs into `main` / `release/**` | Rejects new API-route TypeScript diagnostics                                  |
| `docker-publish.yml`           | `main`, `v*` tags, dispatch    | Builds and publishes the runtime image to GHCR (and Docker Hub if configured) |
| `build.yml`                    | Manual dispatch                | Raw (non-Docker) production build artefact                                    |
| `dast-smoke.yml`               | PRs into `main`, dispatch      | Schemathesis + promptfoo smoke against a live server (advisory)               |
| `codeql.yml`                   | Manual dispatch                | CodeQL analysis (advanced config; see the note in the workflow)               |
| `semgrep.yml`, `scorecard.yml` | Scheduled / PR                 | Static analysis and OpenSSF Scorecard                                         |

## Ratchet Baseline (`quality-baseline.json`)

The ratchet engine (`scripts/quality/check-quality-ratchet.mjs`) reads `quality-baseline.json`
and compares it against the freshly collected `quality-metrics.json`. Any metric that regresses
beyond its epsilon fails the build.

Current tracked metrics:

| Metric                | Direction | Meaning                            |
| --------------------- | --------- | ---------------------------------- |
| `eslintWarnings`      | `down`    | ESLint warning count must not grow |
| `coverage.statements` | `up`      | Statement coverage must not fall   |
| `coverage.lines`      | `up`      | Line coverage must not fall        |
| `coverage.functions`  | `up`      | Function coverage must not fall    |
| `coverage.branches`   | `up`      | Branch coverage must not fall      |

To update the baseline after a genuine improvement:

```bash
npm run quality:ratchet -- --update
git add quality-baseline.json
```

The `--update` flag writes the current measured values into `quality-baseline.json`.
Commit this file alongside the change that improved the metric. A PR that improves a
metric without updating the baseline will be caught by `--require-tighten` (Fase 6A.5,
pending implementation).

---

## Test Retry Policy (WS5.4, v3.8.49)

Retry is per-runner, never a global blanket — a blanket retry converts real regressions
into invisible flakes:

| Runner           | Policy                                                                                                     | Why                                                                                                                    |
| ---------------- | ---------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Playwright (e2e) | `retries: 1` in CI only, with `trace: on-first-retry`                                                      | Browser/network timing is genuinely nondeterministic; one retry with a trace turns a flake into a diagnosable artifact |
| Vitest           | NO global retry. A proven-flaky test gets an explicit per-test retry (visible in the diff, reviewed in PR) | Keeps the quarantine list in the repo, never opaque                                                                    |
| node:test (unit) | NO retry, ever                                                                                             | A flaky unit test is a bug in the test — fix it, don't re-roll it                                                      |

Target SLOs once flake telemetry lands (WS5.2/5.3): <1% flake rate per test
("fix now" threshold), ≥95% pass rate per pipeline. Industry reference values —
recalibrate against our own measurements.

## Release-Level Ratchet Drift (WS5.5, v3.8.49)

When a ratchet (file-size, complexity, eslint warnings) regresses on the PURE release
tip — i.e. the COMBINATION of merges regressed it, and no single PR reproduces the
regression on its own branch — the fix belongs to the **release captain, once, on the
release branch**: prefer extraction/refactor; rebaseline only with the documented
justification entry. Never push combination drift onto a contributor PR, and never
rebaseline per-PR (that hides real regressions). Discriminate first: reproduce the
red against the pure tip in a probe worktree before assuming your PR caused it.

## Banking Ratchet Shrinks — the downward direction (#8584)

The ratchet is only half automatic, and it is the wrong half. **Raising** a cap is a
manual JSON edit that takes ten seconds and is the fastest way to unblock a red PR.
**Lowering** one requires someone to run `--update` and commit the result — and until
the `bank-ratchet-shrinks` job landed, no workflow ran it. The measured consequence
(2026-07-25): 18 frozen files already at or under the 800-line new-file cap, the worst
at 132× (`src/shared/validation/schemas.ts`, 19 lines carrying a 2,523 cap); the
complexity ceiling walked `1794 → 2169` across ~37 rebaseline notes with exactly one
decrease (−1); and "tighten via `--update` next cycle" written 31 times and honoured
once. A cap that outlives the code that earned it silently converts every completed
decomposition into a growth allowance for whoever edits the file next.

`nightly-release-green.yml` → job **`bank-ratchet-shrinks`** closes that loop:

|          |                                                                                                        |
| -------- | ------------------------------------------------------------------------------------------------------ |
| Runs on  | `schedule` (3×/day) + `workflow_dispatch` — deliberately **not** `push`                                |
| Measures | the highest `release/vX.Y.Z`, same resolution + injection guard as `release-green`                     |
| Writes   | `check:file-size --update` and `check:complexity-ratchets --update` (both shrink-only by construction) |
| Verifies | `npm run check:ratchet-bank` (`scripts/quality/verify-ratchet-bank.mjs`)                               |
| Ships    | one always-current PR against the release branch — force-updated, never spammed                        |

Banking is batched rather than per-push because it has no latency requirement (a shrink
banked within 8h is fine) while a per-merge run would rebuild the PR branch repeatedly
during merge campaigns and pay for a full ESLint walk each time. Detection stays on
push (`release-green`); only banking is batched.

### The safety verifier

The job writes to the baselines unattended, so `verify-ratchet-bank.mjs` is what makes
that acceptable. It diffs the post-`--update` tree against `HEAD` and **aborts the job
before any commit exists** — opening no PR — unless every change is one of:

- a `frozen` / `testFrozen` numeric entry **lowered** or **removed**
- `complexity-baseline.json` → `count` **lowered**
- `quality-baseline.json` → `metrics.cognitiveComplexity.value` **lowered**

Anything else fails: raising a number, adding an entry, changing `cap`/`testCap`, or
deleting/rewriting a `_rebaseline_*` note (those notes are the audit trail for why each
ceiling exists and are stored inside the same `frozen` object as the file entries).
A bot that could raise a cap would be strictly worse than the status quo. Regression
guard: `tests/unit/verify-ratchet-bank.test.ts`.

The job never pushes to `release/*` — a human merges the PR, so a bad measurement
cannot land unreviewed.

## Allowlist Policy

Every gate that cannot fail on pre-existing violations uses a frozen allowlist
(e.g., `KNOWN_STALE_DOC_REFS`, `KNOWN_MISSING`, `KNOWN_RAW_SQL`). The policy is:

**Fix the root cause; use the allowlist only when the violation is pre-existing and
cannot be fixed in the same PR.**

When adding an entry to an allowlist:

1. Include a comment with the justification.
2. Reference the tracking issue (e.g., `// #3498 — Phase 2 feature, not yet implemented`).
3. Remove the entry in the same PR that fixes the violation — a stale entry that no longer
   suppresses an active violation is itself a defect (6A.3 stale-enforcement will
   fail the gate on an orphaned allowlist entry once implemented).

Do **not** add allowlist entries to make tests pass faster. A green gate with a growing
allowlist is a false sense of quality.

### When a gate fails on your PR

1. **Read the gate output carefully** — it tells you exactly which file or symbol violated
   the rule.
2. **Fix the violation** — most gates are deterministic filesystem checks that pass as soon
   as the code is correct.
3. **If the violation is pre-existing** (i.e., you did not introduce it but the gate now
   covers it): add an allowlist entry with a justification comment and a tracking issue.
4. **If the gate is a ratchet** (coverage, ESLint warnings, duplication, complexity):
   your change made the metric worse. Fix the underlying issue, or (rarely) run
   `npm run quality:ratchet -- --update` if the change is intentional and the metric
   degradation is acceptable — but document why in the PR description.
5. **Advisory gates** (`continue-on-error: true`) are informational — they do not block
   merge but appear in the CI summary. Fix them anyway.

---

## Adding a New Gate

1. Create `scripts/check/check-<name>.mjs` (or `.ts`). Policy gates exit 0/1.
   Ratchet-style gates emit a metric to `quality-metrics.json` via `collect-metrics.mjs`.
2. Add `"check:<name>": "node scripts/check/check-<name>.mjs"` to `package.json`.
3. Wire it in `.github/workflows/ci.yml` under the appropriate job
   (policy → `Lint & Format` or `Env / Docs Sync`; ratchet → the `quality.yml`
   fast-path). Confirm the gate is green on the current tree first.
4. If it has an allowlist, apply `reportStaleEntries()` from
   `scripts/check/lib/allowlist.mjs` so stale entries are detected automatically.
5. Write a test in `tests/unit/build/` covering the gate's detection logic.
6. Update this document (add a row to the relevant job table).

---

## Agent tooling: LSP-in-the-loop (opt-in)

Beyond the CI gates, OmniRoute ships an **opt-in** `agent-lsp` scaffold
(a project-level `.mcp.json`, Fase 7 Task 15). Create `.mcp.json`
to expose a TypeScript language server to coding agents, so they resolve symbols /
diagnostics **before** writing code — a compile-before-claim companion to
`typecheck:core` that cuts "invented symbol" errors at the source. It is intentionally
not auto-loaded (you pick and verify the MCP↔LSP bridge); a broken entry only logs a
connection error and never breaks sessions.

---

## Rationalization Backlog (ROI review — Fase 9 Onda 3)

This inventory was reconciled against `ci.yml` on 2026-06-17 (the prior version omitted
`audit:deps`, `check:tracked-artifacts`, `check:lockfile`, `check:licenses`,
`check:dead-code`, `check:cognitive-complexity`, `check:type-coverage`,
`check:codeql-ratchet`, `check:pr-evidence`). An ROI review of the reconciled set
identified the following rationalization candidates. **The merges are mechanical CI
changes; the flips/drops are policy decisions reserved for the operator.** Nothing below
is applied yet.

**Also undocumented above** (advisory, low signal): the standalone scanner workflows
`semgrep.yml` / `codeql.yml` / `scorecard.yml`. `semgrepFindings: 0` is in
`quality-baseline.json` but is not wired to a blocking ratchet — the metric is
currently orphaned.

### Merge / dedup (mechanical, lower risk)

Each candidate was validated against the live gate state on 2026-06-17 (trust-but-verify);
several "obvious" merges turned out to hide debt and are **not** clean drop-ins.

- **`check:docs-sync` runs twice** — in the `Env / Docs Sync` job and again inside `check:docs-all` on the `quality.yml` fast-path, plus the husky pre-commit hook. ✅ **DONE** — the duplicate `lint` invocation was removed.
- **CVE scanning** — ❌ **NOT a clean merge.** `audit:deps` hard-fails on any high/critical CVE; `check:vuln-ratchet` (osv) only fails on a _regression_ vs baseline (currently 1 MODERATE). Different semantics — dropping `audit:deps` would lose the absolute high/critical gate. Keep both.
- **Cycle detection** — ❌ **NOT a clean merge.** `check:circular-deps` (dpdm) reports **91 cycles** (that is why it is advisory); it cannot be promoted to blocking without first resolving them, and it has a broader scope than the green, curated `check:cycles`. Keep `check:cycles` blocking; resolving the 91 dpdm cycles is its own backlog.
- **Complexity** — ✅ **DONE** (`check:complexity-ratchets` / `eslint.complexity-ratchets.config.mjs`): one ESLint walk, counts by ruleId so cyclomatic+max-lines and cognitive baselines stay independent; individual `check:complexity` / `check:cognitive-complexity` remain for local `--update`.
- **`/api` anti-hallucination** — ✅ **DONE** (`check:api-docs-refs` + `scripts/check/lib/apiRoutes.mjs`): one FS inventory of `src/app/api`, openapi-routes + docs-symbols still report independently; individuals remain for local runs.
- **`check:node-runtime` runs in 11 jobs** — ⚠️ **low ROI.** Each is a separate runner and the check is <1s; total savings ~10s, against losing a cheap per-job guard. Not worth the churn.
- **`typecheck:noimplicit:core` on CI lint** — ✅ **removed from lint job** (was advisory `continue-on-error`); blocking type surface is `typecheck:core` + `check:type-coverage`. Local script retained.

### Flip / decide (operator policy)

- `check:openapi-security-tiers` (advisory) — ❌ **NOT cleanly flippable.** It exits 0 but warns that several `traffic-inspector` routes under `LOCAL_ONLY_API_PREFIXES` lack the `x-loopback-only: true` annotation. Enforcing it requires adding those annotations to `openapi.yaml` first.
- `typecheck:noimplicit:core` (advisory) — largely subsumed by the blocking `check:type-coverage` ratchet. Flip to a ratchet or drop the redundant second `tsc` pass.
- `test:vitest:ui` (now **blocking**) — pre-existing failures are explicitly excluded in `vitest.config.ts` with `// #8618` tracking comments; new failures fail the job.
- `check:secrets` (gitleaks, blocking ratchet frozen at 3 documented false-positives) — allowlist the 3 to reach 0, or demote to advisory. Overlaps GitHub native secret-scanning + `check:public-creds`.
- `check:pr-evidence` (blocking, greps PR-body prose) — high false-positive risk; weakens Hard Rule #18 enforcement if dropped, so this is a genuine policy call.
- `semgrep` (advisory standalone) — overlaps CodeQL for the OWASP families; wire its baseline to a ratchet or drop.

---

## Related Documentation

- Supply-chain (provenance, SBOM, Trivy, Scorecard): [`docs/security/SUPPLY_CHAIN.md`](../security/SUPPLY_CHAIN.md)
