import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omni-quota-antigravity-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const coreDb = await import("../../src/lib/db/core.ts");
const quotaCache = await import("../../src/domain/quotaCache.ts");

test.after(() => {
  coreDb.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test("isQuotaExhaustedForRequest isolates Claude and Gemini quota families for antigravity & agy", () => {
  const connectionId = "conn-antigravity-test";

  // Simulate Claude Opus being exhausted, while Gemini is NOT.
  quotaCache.setQuotaCache(connectionId, "antigravity", {
    "claude-opus-4-6-thinking": { remainingPercentage: 0, resetAt: null },
    "gemini-3.7-flash-high": { remainingPercentage: 100, resetAt: null },
  });

  // Verify that Claude models are considered exhausted.
  assert.equal(
    quotaCache.isQuotaExhaustedForRequest(
      connectionId,
      "antigravity",
      "antigravity/claude-opus-4-6-thinking"
    ),
    true,
    "Claude Opus should be exhausted"
  );
  assert.equal(
    quotaCache.isQuotaExhaustedForRequest(
      connectionId,
      "antigravity",
      "antigravity/claude-sonnet-4-6"
    ),
    true,
    "Claude Sonnet should share Claude family quota and be exhausted"
  );

  // Verify that Gemini models are NOT considered exhausted.
  assert.equal(
    quotaCache.isQuotaExhaustedForRequest(
      connectionId,
      "antigravity",
      "antigravity/gemini-3.7-flash-high"
    ),
    false,
    "Gemini Flash should NOT be exhausted"
  );
  assert.equal(
    quotaCache.isQuotaExhaustedForRequest(
      connectionId,
      "antigravity",
      "antigravity/gemini-pro-agent"
    ),
    false,
    "Gemini Pro should share Gemini family quota and NOT be exhausted"
  );

  // Test that 'agy' spelling behaves the exact same way.
  const connectionIdAgy = "conn-agy-test";
  quotaCache.setQuotaCache(connectionIdAgy, "agy", {
    "claude-opus-4-6-thinking": { remainingPercentage: 0, resetAt: null },
    "gemini-3.7-flash-high": { remainingPercentage: 100, resetAt: null },
  });

  assert.equal(
    quotaCache.isQuotaExhaustedForRequest(connectionIdAgy, "agy", "agy/claude-opus-4-6-thinking"),
    true,
    "Claude Opus under 'agy' should be exhausted"
  );
  assert.equal(
    quotaCache.isQuotaExhaustedForRequest(connectionIdAgy, "agy", "agy/gemini-3.7-flash-high"),
    false,
    "Gemini Flash under 'agy' should NOT be exhausted"
  );

  // Test that unknown models (family 'other') preserve exact-model scoping.
  const connectionIdOther = "conn-other-test";
  quotaCache.setQuotaCache(connectionIdOther, "antigravity", {
    "unknown-model-a": { remainingPercentage: 0, resetAt: null },
    "unknown-model-b": { remainingPercentage: 100, resetAt: null },
  });

  assert.equal(
    quotaCache.isQuotaExhaustedForRequest(
      connectionIdOther,
      "antigravity",
      "antigravity/unknown-model-a"
    ),
    true,
    "Unknown model A should be exhausted"
  );
  assert.equal(
    quotaCache.isQuotaExhaustedForRequest(
      connectionIdOther,
      "antigravity",
      "antigravity/unknown-model-b"
    ),
    false,
    "Unknown model B should NOT be exhausted"
  );
});

test("isQuotaExhaustedForRequest scopes gemini exhaustion to the requested model, not sibling models, when weekly quota remains", () => {
  const connectionId = "conn-gemini-sibling-test";
  quotaCache.setQuotaCache(connectionId, "antigravity", {
    "gemini-3.7-flash-medium": { remainingPercentage: 0, resetAt: null },
    "gemini-pro-agent": { remainingPercentage: 100, resetAt: null },
    gemini_weekly: { remainingPercentage: 50, resetAt: null },
  });

  assert.equal(
    quotaCache.isQuotaExhaustedForRequest(
      connectionId,
      "antigravity",
      "antigravity/gemini-3.7-flash-medium"
    ),
    true,
    "gemini-3.7 at 0% should be exhausted even when gemini-pro-agent still has quota"
  );
  assert.equal(
    quotaCache.isQuotaExhaustedForRequest(
      connectionId,
      "antigravity",
      "antigravity/gemini-pro-agent"
    ),
    false,
    "gemini-pro-agent should remain available when only gemini-3.7 Flash is depleted and weekly has quota"
  );
});

test("isQuotaExhaustedForRequest blocks all family models if weekly quota is exhausted (OR condition)", () => {
  const connectionId = "conn-gemini-weekly-exhausted";
  quotaCache.setQuotaCache(connectionId, "antigravity", {
    "gemini-3.7-flash-medium": { remainingPercentage: 100, resetAt: null },
    "gemini-pro-agent": { remainingPercentage: 100, resetAt: null },
    gemini_weekly: { remainingPercentage: 0, resetAt: null },
  });

  assert.equal(
    quotaCache.isQuotaExhaustedForRequest(
      connectionId,
      "antigravity",
      "antigravity/gemini-3.7-flash-medium"
    ),
    true,
    "gemini-3.7 Flash should be exhausted when family weekly quota is 0%"
  );
  assert.equal(
    quotaCache.isQuotaExhaustedForRequest(
      connectionId,
      "antigravity",
      "antigravity/gemini-pro-agent"
    ),
    true,
    "gemini-pro-agent should also be exhausted when family weekly quota is 0%"
  );
});

test("isQuotaExhaustedForRequest blocks Claude family models if either 5h or weekly quota is exhausted", () => {
  const connectionId = "conn-claude-dual-window";
  // 5h is 0%, weekly is 80%
  quotaCache.setQuotaCache(connectionId, "antigravity", {
    claude_gpt_5h: { remainingPercentage: 0, resetAt: null },
    claude_gpt_weekly: { remainingPercentage: 80, resetAt: null },
  });

  assert.equal(
    quotaCache.isQuotaExhaustedForRequest(
      connectionId,
      "antigravity",
      "antigravity/claude-opus-4-6-thinking"
    ),
    true,
    "Claude Opus should be exhausted when 5h family quota is 0%"
  );

  // 5h is 80%, weekly is 0%
  quotaCache.setQuotaCache(connectionId, "antigravity", {
    claude_gpt_5h: { remainingPercentage: 80, resetAt: null },
    claude_gpt_weekly: { remainingPercentage: 0, resetAt: null },
  });

  assert.equal(
    quotaCache.isQuotaExhaustedForRequest(
      connectionId,
      "antigravity",
      "antigravity/claude-sonnet-4-6"
    ),
    true,
    "Claude Sonnet should be exhausted when weekly family quota is 0%"
  );
});

test("isQuotaExhaustedForRequest does not falsely block un-cached Gemini model when a sibling is exhausted and summary quota is missing", () => {
  const connectionId = "conn-gemini-no-summary-test";
  // Only gemini-3.7-flash-medium is in cache and exhausted, no summary quotas present
  quotaCache.setQuotaCache(connectionId, "antigravity", {
    "gemini-3.7-flash-medium": { remainingPercentage: 0, resetAt: null },
  });

  assert.equal(
    quotaCache.isQuotaExhaustedForRequest(
      connectionId,
      "antigravity",
      "antigravity/gemini-3.7-flash-medium"
    ),
    true,
    "gemini-3.7-flash-medium should be exhausted"
  );
  assert.equal(
    quotaCache.isQuotaExhaustedForRequest(
      connectionId,
      "antigravity",
      "antigravity/gemini-pro-agent"
    ),
    false,
    "un-cached gemini-pro-agent must NOT be blocked by sibling gemini-3.7 exhaustion"
  );
});
