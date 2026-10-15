// #14359 — a successful upstream dispatch must arm a healthy override so the
// quota predicates stand down for the park window, and a genuine upstream 429
// must clear it again. This is the live-proven half of the fix: a connection
// that is actually serving traffic is, by definition, not quota-exhausted.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omni-quota-healthy-14359-"));
process.env.DATA_DIR = TEST_DATA_DIR;

// Dynamic imports are required: DATA_DIR must be set before the db modules
// open SQLite (same pattern as tests/unit/quota-cache-hydrate-5015.test.ts).
const coreDb = await import("../../src/lib/db/core.ts");
const quotaCache = await import("../../src/domain/quotaCache.ts");

// The park window under test (30 minutes — mirrors EXHAUSTED_MAX_PARK_MS).
const MAX_PARK_MS = 30 * 60 * 1000;

test.after(() => {
  coreDb.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test("#14359 markQuotaHealthy stands both predicates down on an exhausted entry", () => {
  quotaCache.__clearForTests();
  quotaCache.markAccountExhaustedFrom429("ho-14359", "qwen-cloud-token-plan");
  assert.equal(quotaCache.isAccountQuotaExhausted("ho-14359"), true);
  assert.equal(quotaCache.isQuotaExhaustedForRequest("ho-14359", "qwen-cloud-token-plan"), true);

  // A successful dispatch arms the override (chat.ts success hook).
  quotaCache.markQuotaHealthy("ho-14359");
  assert.equal(
    quotaCache.isAccountQuotaExhausted("ho-14359"),
    false,
    "healthy override must stand isAccountQuotaExhausted down"
  );
  assert.equal(
    quotaCache.isQuotaExhaustedForRequest("ho-14359", "qwen-cloud-token-plan"),
    false,
    "healthy override must stand isQuotaExhaustedForRequest down"
  );
});

test("#14359 a genuine 429 clears the healthy override", () => {
  quotaCache.__clearForTests();
  quotaCache.markQuotaHealthy("ho-429-14359");
  assert.equal(quotaCache.isAccountQuotaExhausted("ho-429-14359"), false);

  quotaCache.markAccountExhaustedFrom429("ho-429-14359", "zai");
  assert.equal(
    quotaCache.isAccountQuotaExhausted("ho-429-14359"),
    true,
    "a real 429 must clear the override and re-park immediately"
  );
});

test("#14359 the healthy override expires after the park window", () => {
  quotaCache.__clearForTests();
  quotaCache.markAccountExhaustedFrom429("ho-exp-14359", "qwen-cloud-token-plan");
  quotaCache.markQuotaHealthy("ho-exp-14359");
  assert.equal(quotaCache.isAccountQuotaExhausted("ho-exp-14359"), false);

  // The healthy map is a deliberate globalThis anchor (#8065 — chunk-shared
  // singleton); reach it via a named reference so the test can simulate time.
  interface QuotaCacheTestState {
    healthyScopes: Map<string, Map<string, number>>;
  }
  const state: QuotaCacheTestState | undefined = (
    globalThis as {
      __omnirouteQuotaCacheState?: QuotaCacheTestState;
    }
  ).__omnirouteQuotaCacheState;
  const scopes = state?.healthyScopes.get("ho-exp-14359");
  assert.ok(scopes?.has("*"), "override armed in shared state");
  assert.ok(
    (scopes!.get("*") ?? 0) - Date.now() <= MAX_PARK_MS,
    "override lifetime must equal the park window"
  );
  scopes!.set("*", Date.now() - 1);

  assert.equal(
    quotaCache.isAccountQuotaExhausted("ho-exp-14359"),
    true,
    "an expired override must not stand the predicates down any more"
  );
});

const { resolveQuotaHealthyScope } = await import("../../open-sse/services/quotaHealthyScope.ts");

function markSuccess(connectionId: string, provider: string, model: string) {
  // Mirrors the chat.ts success hook.
  quotaCache.markQuotaHealthy(connectionId, resolveQuotaHealthyScope(provider, model));
}

test("Antigravity Gemini success does not stand down an exhausted Claude family", () => {
  quotaCache.__clearForTests();
  const id = "ho-agy-family-14359";
  quotaCache.setQuotaCache(id, "antigravity", {
    "claude-opus-4-6-thinking": { remainingPercentage: 0, resetAt: null },
    "gemini-3.7-flash-high": { remainingPercentage: 100, resetAt: null },
  });
  markSuccess(id, "antigravity", "gemini-3.7-flash-high");
  assert.equal(
    quotaCache.isQuotaExhaustedForRequest(
      id,
      "antigravity",
      "antigravity/claude-opus-4-6-thinking"
    ),
    true,
    "a Gemini success must not clear Claude-family exhaustion"
  );

  // A Claude success does stand the Claude family down.
  markSuccess(id, "antigravity", "claude-opus-4-6-thinking");
  assert.equal(
    quotaCache.isQuotaExhaustedForRequest(
      id,
      "antigravity",
      "antigravity/claude-opus-4-6-thinking"
    ),
    false
  );
});

test("Codex standard success does not stand down an exhausted Spark bucket (and vice versa)", () => {
  quotaCache.__clearForTests();
  const id = "ho-codex-spark-14359";
  quotaCache.setQuotaCache(id, "codex", {
    session: { remainingPercentage: 80, resetAt: null },
    weekly: { remainingPercentage: 80, resetAt: null },
    gpt_5_3_codex_spark_session: { remainingPercentage: 0, resetAt: null },
    gpt_5_3_codex_spark_weekly: { remainingPercentage: 0, resetAt: null },
  });
  assert.equal(quotaCache.isQuotaExhaustedForRequest(id, "codex", "gpt-5.3-codex-spark"), true);
  markSuccess(id, "codex", "gpt-5.5");
  assert.equal(
    quotaCache.isQuotaExhaustedForRequest(id, "codex", "gpt-5.3-codex-spark"),
    true,
    "a standard Codex success must not clear Spark exhaustion"
  );
  markSuccess(id, "codex", "gpt-5.3-codex-spark");
  assert.equal(quotaCache.isQuotaExhaustedForRequest(id, "codex", "gpt-5.3-codex-spark"), false);
});

test("a model-scoped success does not stand down the connection-wide predicate", () => {
  quotaCache.__clearForTests();
  const id = "ho-agy-wide-14359";
  quotaCache.markAccountExhaustedFrom429(id, "antigravity");
  markSuccess(id, "antigravity", "gemini-3.7-flash-high");
  assert.equal(quotaCache.isAccountQuotaExhausted(id), true);
});

test("resolveQuotaHealthyScope buckets", () => {
  assert.equal(resolveQuotaHealthyScope("openai", "gpt-4.1"), "*");
  assert.equal(resolveQuotaHealthyScope("antigravity", null), "*");
  assert.equal(
    resolveQuotaHealthyScope("antigravity", "antigravity/gemini-3-pro"),
    resolveQuotaHealthyScope("agy", "gemini-3.7-flash-high")
  );
  assert.notEqual(
    resolveQuotaHealthyScope("antigravity", "gemini-3-pro"),
    resolveQuotaHealthyScope("antigravity", "claude-opus-4-6-thinking")
  );
  assert.notEqual(
    resolveQuotaHealthyScope("codex", "gpt-5.5"),
    resolveQuotaHealthyScope("codex", "gpt-5.3-codex-spark")
  );
  assert.notEqual(
    resolveQuotaHealthyScope("gemini-cli", "gemini-2.5-pro"),
    resolveQuotaHealthyScope("gemini-cli", "gemini-2.5-flash")
  );
});
