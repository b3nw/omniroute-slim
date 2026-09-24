import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { makeManagementSessionRequest } from "../helpers/managementSession.ts";

// #3496 — docs/reference/API_REFERENCE.md documented a `/api/guardrails*` and
// `/api/shadow*` surface that did not exist (doc-fiction, frozen in the
// check-docs-symbols allowlist). The guardrail pipeline itself is real
// (src/lib/guardrails), so the fix implements the two routes that map to real
// behavior — GET /api/guardrails (list) and POST /api/guardrails/test (dry-run
// the pre-call hooks) — removes the fictional enable/disable/logs + shadow rows
// from the docs, and drops them from KNOWN_STALE_DOC_REFS.

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-guardrails-3496-"));
process.env.DATA_DIR = TEST_DATA_DIR;
if (!process.env.JWT_SECRET) process.env.JWT_SECRET = "test-guardrails-3496-jwt-secret";
if (!process.env.API_KEY_SECRET) process.env.API_KEY_SECRET = "test-guardrails-3496-apikey-secret";

const core = await import("../../src/lib/db/core.ts");

test.after(() => {
  try {
    core.getDbInstance().close();
  } catch {
    /* ignore */
  }
  try {
    core.resetDbInstance();
  } catch {
    /* ignore */
  }
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

// Regression guard for the quality gate: the docs no longer reference any
// non-existent guardrails/shadow route, and the allowlist no longer freezes them.
test("#3496 check-docs-symbols no longer freezes guardrails/shadow + API_REFERENCE is clean", async () => {
  const { KNOWN_STALE_DOC_REFS, collectRouteFiles, extractDocApiPaths, findStaleDocApiRefs } =
    await import("../../scripts/check/check-docs-symbols.mjs");

  // (1) allowlist no longer freezes any guardrails/shadow path
  for (const frozen of [...KNOWN_STALE_DOC_REFS]) {
    assert.ok(
      !frozen.startsWith("/api/guardrails") && !frozen.startsWith("/api/shadow"),
      `allowlist should not still freeze ${frozen}`
    );
  }

  // (2) API_REFERENCE.md no longer references a non-existent guardrails/shadow route
  const routeFiles = collectRouteFiles();
  const apiRefRel = "docs/reference/API_REFERENCE.md";
  const src = fs.readFileSync(path.join(process.cwd(), apiRefRel), "utf8");
  const docPathsByFile = [{ file: apiRefRel, paths: extractDocApiPaths(src) }];
  const misses = findStaleDocApiRefs(docPathsByFile, routeFiles, KNOWN_STALE_DOC_REFS);
  const ghosts = misses.filter((m) => m.includes("/api/guardrails") || m.includes("/api/shadow"));
  assert.deepEqual(ghosts, [], `stale guardrails/shadow refs remain: ${ghosts.join("; ")}`);
});
