// Gemini CLI (Cloud Code PA) shares its daily request pool and reset timer per
// model tier (Pro / Flash / Flash Lite), not per model. These tests pin the
// grouping in the usage parser, the Provider Limits key normalization, the
// fixed display order, and tier-scoped exhaustion in the quota cache.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omni-gemini-cli-quota-groups-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = process.env.API_KEY_SECRET || "test-gemini-cli-quota-groups-secret";

const coreDb = await import("../../src/lib/db/core.ts");
const { parseGeminiCliQuotaResponse, getGeminiCliQuotaTier } =
  await import("../../open-sse/services/usage/gemini-cli.ts");
const { getGeminiCliTierForQuotaKey } =
  await import("../../open-sse/services/geminiCliQuotaTier.ts");
const quotaNormalize = await import("../../src/lib/usage/providerLimits/quotaNormalize.ts");
const quotaParsing =
  await import("../../src/app/(dashboard)/dashboard/usage/components/ProviderLimits/quotaParsing.ts");
const quotaCache = await import("../../src/domain/quotaCache.ts");
const quotaSnapshotsDb = await import("../../src/lib/db/quotaSnapshots.ts");
const providersDb = await import("../../src/lib/db/providers.ts");
const providerLimitsDb = await import("../../src/lib/db/providerLimits.ts");
const providerLimits = await import("../../src/lib/usage/providerLimits.ts");

test.after(() => {
  quotaCache.__clearForTests();
  coreDb.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

const FUTURE_RESET = new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString();

// ─── Tier classification ────────────────────────────────────────────────────

test("classifies Gemini CLI models into pro / flash / flash_lite tiers", () => {
  for (const id of ["gemini-2.5-pro", "gemini-3-pro-preview", "gemini-3.1-pro-preview"]) {
    assert.equal(getGeminiCliQuotaTier(id), "pro", id);
  }
  for (const id of [
    "gemini-2.0-flash",
    "gemini-2.5-flash",
    "gemini-3-flash-preview",
    "gemini-3-flash",
    "gemini-3.5-flash",
    "gemini-3.6-flash",
  ]) {
    assert.equal(getGeminiCliQuotaTier(id), "flash", id);
  }
  for (const id of [
    "gemini-2.5-flash-lite",
    "gemini-3.1-flash-lite",
    "gemini-3.1-flash-lite-preview",
    "gemini-3.5-flash-lite",
  ]) {
    assert.equal(getGeminiCliQuotaTier(id), "flash_lite", id);
  }
  assert.equal(getGeminiCliQuotaTier("gemini-cli/gemini-3.1-pro-preview"), "pro");
  assert.equal(getGeminiCliQuotaTier("GEMINI-2.5-FLASH"), "flash");
  assert.equal(getGeminiCliQuotaTier("gemini-embedding-001"), null);
  assert.equal(getGeminiCliQuotaTier(""), null);
  assert.equal(getGeminiCliQuotaTier(undefined), null);
});

test("maps canonical and alias quota keys back to their tier", () => {
  assert.equal(getGeminiCliTierForQuotaKey("gemini_cli_pro"), "pro");
  assert.equal(getGeminiCliTierForQuotaKey("gemini_flash"), "flash");
  assert.equal(getGeminiCliTierForQuotaKey("lite"), "flash_lite");
  assert.equal(getGeminiCliTierForQuotaKey("gemini_cli_flash_lite"), "flash_lite");
  assert.equal(getGeminiCliTierForQuotaKey("gemini-2.5-pro"), null);
});

// ─── Parser grouping ────────────────────────────────────────────────────────

test("groups buckets into one quota per tier and omits per-model quota keys", () => {
  const snap = parseGeminiCliQuotaResponse(
    {
      buckets: [
        { modelId: "gemini-2.5-pro", remainingFraction: 0.8, resetTime: FUTURE_RESET },
        { modelId: "gemini-3.1-pro-preview", remainingFraction: 0.8, resetTime: FUTURE_RESET },
        { modelId: "gemini-2.5-flash", remainingFraction: 0.5, resetTime: FUTURE_RESET },
        { modelId: "gemini-3-flash-preview", remainingFraction: 0.5 },
        { modelId: "gemini-2.5-flash-lite", remainingFraction: 1, resetTime: FUTURE_RESET },
        { modelId: "gemini-embedding-001", remainingFraction: 0.1 },
      ],
    },
    "FREE"
  );

  assert.deepEqual(Object.keys(snap.quotas), [
    "gemini_cli_pro",
    "gemini_cli_flash",
    "gemini_cli_flash_lite",
  ]);
  // Per-model telemetry is still available.
  assert.equal(Object.keys(snap.models).length, 6);
  assert.equal(snap.models["gemini-embedding-001"].remainingFraction, 0.1);

  const pro = snap.quotas.gemini_cli_pro;
  assert.deepEqual(
    {
      used: pro.used,
      total: pro.total,
      remaining: pro.remaining,
      remainingPercentage: pro.remainingPercentage,
      unlimited: pro.unlimited,
      fractionReported: pro.fractionReported,
      quotaSource: pro.quotaSource,
      displayName: pro.displayName,
    },
    {
      used: 200,
      total: 1000,
      remaining: 800,
      remainingPercentage: 80,
      unlimited: false,
      fractionReported: true,
      quotaSource: "retrieveUserQuota",
      displayName: "Gemini Pro Models",
    }
  );
  assert.equal(pro.resetAt, new Date(FUTURE_RESET).toISOString());
  assert.equal(snap.quotas.gemini_cli_flash.displayName, "Gemini Flash Models");
  assert.equal(snap.quotas.gemini_cli_flash.resetAt, new Date(FUTURE_RESET).toISOString());
  assert.equal(snap.quotas.gemini_cli_flash_lite.displayName, "Gemini Flash Lite Models");
  assert.equal(snap.quotas.gemini_cli_flash_lite.used, 0);
});

test("tier total follows the account tier (FREE 1000 / PRO 1500 / ULTRA 2000)", () => {
  const payload = { buckets: [{ modelId: "gemini-2.5-pro", remainingFraction: 0.25 }] };
  const expected = { FREE: [1000, 250, 750], PRO: [1500, 375, 1125], ULTRA: [2000, 500, 1500] };
  for (const [tier, [total, remaining, used]] of Object.entries(expected)) {
    const q = parseGeminiCliQuotaResponse(payload, tier as "FREE" | "PRO" | "ULTRA").quotas
      .gemini_cli_pro;
    assert.equal(q.total, total, tier);
    assert.equal(q.remaining, remaining, tier);
    assert.equal(q.used, used, tier);
  }
});

test("shared pool uses the minimum reported fraction and its reset time", () => {
  const laterReset = new Date(Date.now() + 20 * 60 * 60 * 1000).toISOString();
  const snap = parseGeminiCliQuotaResponse(
    {
      buckets: [
        { modelId: "gemini-2.5-flash", remainingFraction: 0.9, resetTime: FUTURE_RESET },
        { modelId: "gemini-3.5-flash", remainingFraction: 0.3, resetTime: laterReset },
        { modelId: "gemini-2.0-flash", remainingFraction: 0.6, resetTime: FUTURE_RESET },
      ],
    },
    "PRO"
  );
  const flash = snap.quotas.gemini_cli_flash;
  assert.equal(flash.remainingPercentage, 30);
  assert.equal(flash.remaining, 450);
  assert.equal(flash.used, 1050);
  assert.equal(flash.resetAt, new Date(laterReset).toISOString());
});

test("a bucket without a fraction never overrides a reported one in the same tier", () => {
  const snap = parseGeminiCliQuotaResponse(
    {
      buckets: [
        { modelId: "gemini-2.5-pro" },
        { modelId: "gemini-3-pro-preview", remainingFraction: 0.4 },
        { modelId: "gemini-3.1-pro-preview" },
      ],
    },
    "PRO"
  );
  assert.equal(snap.quotas.gemini_cli_pro.remainingPercentage, 40);
  assert.equal(snap.quotas.gemini_cli_pro.fractionReported, true);

  const unreported = parseGeminiCliQuotaResponse(
    { buckets: [{ model_id: "gemini-2.5-flash-lite" }] },
    "PRO"
  );
  assert.equal(unreported.quotas.gemini_cli_flash_lite.fractionReported, false);
  assert.equal(unreported.quotas.gemini_cli_flash_lite.remainingPercentage, 100);
});

test("corrupted / boundary payloads are clamped or skipped", () => {
  const snap = parseGeminiCliQuotaResponse(
    {
      buckets: [
        null as unknown as Record<string, unknown>,
        {},
        { modelId: "" },
        { remainingFraction: 0.1 },
        { modelId: "gemini-2.5-pro", remainingFraction: -3 },
        { modelId: "gemini-2.5-flash", remainingFraction: 7 },
        { modelId: "gemini-2.5-flash-lite", remainingFraction: Number.NaN },
        { modelId: "gemini-3.1-flash-lite", resetTime: "not-a-date" },
      ],
    },
    "ULTRA"
  );
  assert.equal(snap.quotas.gemini_cli_pro.remaining, 0);
  assert.equal(snap.quotas.gemini_cli_pro.used, 2000);
  assert.equal(snap.quotas.gemini_cli_flash.remaining, 2000);
  assert.equal(snap.quotas.gemini_cli_flash.used, 0);
  assert.equal(snap.quotas.gemini_cli_flash_lite.fractionReported, false);
  assert.equal(snap.quotas.gemini_cli_flash_lite.remainingPercentage, 100);

  assert.deepEqual(parseGeminiCliQuotaResponse({}, "PRO").quotas, {});
  assert.deepEqual(
    parseGeminiCliQuotaResponse({ buckets: "nope" } as unknown as { buckets: [] }, "PRO").quotas,
    {}
  );
});

// ─── Provider Limits normalization ──────────────────────────────────────────

test("isGeminiCliSummaryQuotaKey accepts tier keys and rejects per-model keys", () => {
  for (const key of [
    "gemini_cli_pro",
    "gemini_cli_flash",
    "gemini_cli_flash_lite",
    "gemini_pro",
    "gemini_flash_lite",
    "pro",
    "flash",
    "lite",
  ]) {
    assert.equal(quotaNormalize.isGeminiCliSummaryQuotaKey(key), true, key);
  }
  for (const key of ["gemini-2.5-pro", "gemini_cli_weekly", "gemini_5h", "flash-lite", ""]) {
    assert.equal(quotaNormalize.isGeminiCliSummaryQuotaKey(key), false, key);
  }
});

test("quota key filtering drops legacy per-model keys for all Gemini CLI provider ids", () => {
  for (const provider of ["gemini-cli", "gemini_cli", "gcli"]) {
    assert.equal(quotaNormalize.isUsageQuotaKeyAllowed(provider, "gemini_cli_pro"), true);
    assert.equal(quotaNormalize.isUsageQuotaKeyAllowed(provider, "credits"), true);
    assert.equal(quotaNormalize.isUsageQuotaKeyAllowed(provider, "models"), true);
    assert.equal(quotaNormalize.isUsageQuotaKeyAllowed(provider, "gemini-2.5-pro"), false);
    assert.equal(
      quotaNormalize.normalizeUsageQuotaKey(provider, "gemini_flash"),
      "gemini_cli_flash"
    );
    assert.equal(quotaNormalize.normalizeUsageQuotaKey(provider, "gemini-3-flash"), null);

    const normalized = quotaNormalize.normalizeUsageQuotasForProvider(provider, {
      gemini_cli_pro: { used: 1 },
      "gemini-2.5-pro": { used: 1 },
      "gemini-3-flash": { used: 1 },
    });
    assert.deepEqual(Object.keys(normalized || {}), ["gemini_cli_pro"]);

    const sanitized = quotaNormalize.sanitizeUsageQuotasForProvider(provider, {
      plan: "Pro",
      quotas: { gemini_cli_flash: { used: 2 }, "gemini-2.5-flash": { used: 2 } },
    });
    assert.deepEqual(Object.keys(sanitized.quotas as object), ["gemini_cli_flash"]);
    assert.equal(sanitized.plan, "Pro");
  }
  // Other providers keep arbitrary keys.
  assert.equal(quotaNormalize.isUsageQuotaKeyAllowed("gemini", "gemini-2.5-pro"), true);
});

// ─── Provider Limits display order ──────────────────────────────────────────

test("Gemini CLI quotas have a fixed Pro → Flash → Flash Lite order", () => {
  for (const provider of ["gemini-cli", "gemini_cli", "gcli", "GEMINI-CLI"]) {
    assert.equal(quotaParsing.hasFixedQuotaOrder(provider), true, provider);
  }

  const reset = FUTURE_RESET;
  const data = {
    quotas: {
      gemini_cli_flash_lite: { used: 0, total: 1000, remainingPercentage: 100, resetAt: reset },
      gemini_cli_flash: { used: 900, total: 1000, remainingPercentage: 10, resetAt: reset },
      gemini_cli_pro: {
        used: 100,
        total: 1000,
        remainingPercentage: 90,
        resetAt: reset,
        displayName: "Gemini Pro Models",
      },
    },
  };
  for (const provider of ["gemini-cli", "gemini_cli", "gcli"]) {
    const parsed = quotaParsing.parseQuotaData(provider, data);
    assert.deepEqual(
      parsed.map((q: { name: string }) => q.name),
      ["gemini_cli_pro", "gemini_cli_flash", "gemini_cli_flash_lite"],
      provider
    );
    assert.equal(parsed[0].displayName, "Gemini Pro Models");
  }

  const aliases = quotaParsing.parseQuotaData("gemini-cli", {
    quotas: {
      lite: { used: 0, total: 1 },
      flash: { used: 0, total: 1 },
      pro: { used: 0, total: 1 },
    },
  });
  assert.deepEqual(
    aliases.map((q: { name: string }) => q.name),
    ["pro", "flash", "lite"]
  );
});

// ─── Tier-scoped exhaustion ─────────────────────────────────────────────────

test("resolveGeminiCliQuotaWindowsForModel maps a model to its tier window only", () => {
  const names = ["gemini_cli_pro", "gemini_cli_flash", "gemini_cli_flash_lite", "credits"];
  const { resolveGeminiCliQuotaWindowsForModel } = quotaCache;
  assert.deepEqual(resolveGeminiCliQuotaWindowsForModel(names, "gemini-3.1-pro-preview"), [
    "gemini_cli_pro",
  ]);
  assert.deepEqual(resolveGeminiCliQuotaWindowsForModel(names, "gemini-cli/gemini-3.5-flash"), [
    "gemini_cli_flash",
  ]);
  assert.deepEqual(resolveGeminiCliQuotaWindowsForModel(names, "gcli/gemini-3.1-flash-lite"), [
    "gemini_cli_flash_lite",
  ]);
  assert.deepEqual(resolveGeminiCliQuotaWindowsForModel(["gemini_pro", "lite"], "gemini-2.5-pro"), [
    "gemini_pro",
  ]);
  assert.deepEqual(resolveGeminiCliQuotaWindowsForModel(names, "gemini-embedding-001"), []);
  // Legacy per-model windows (e.g. hydrated from old snapshots) match exactly.
  assert.deepEqual(
    resolveGeminiCliQuotaWindowsForModel(["gemini-2.5-pro", "gemini-2.5-flash"], "gemini-2.5-pro"),
    ["gemini-2.5-pro"]
  );
});

test("an exhausted Pro tier blocks Pro requests only; Flash and Flash Lite stay available", () => {
  for (const provider of ["gemini-cli", "gemini_cli", "gcli"]) {
    const connectionId = `gcli-tier-${provider}`;
    const snap = parseGeminiCliQuotaResponse(
      {
        buckets: [
          { modelId: "gemini-2.5-pro", remainingFraction: 0, resetTime: FUTURE_RESET },
          { modelId: "gemini-2.5-flash", remainingFraction: 0.6, resetTime: FUTURE_RESET },
          { modelId: "gemini-2.5-flash-lite", remainingFraction: 0.9, resetTime: FUTURE_RESET },
        ],
      },
      "PRO"
    );
    quotaCache.setQuotaCache(connectionId, provider, snap.quotas);

    assert.equal(
      quotaCache.isQuotaExhaustedForRequest(connectionId, provider, "gemini-2.5-pro"),
      true
    );
    assert.equal(
      quotaCache.isQuotaExhaustedForRequest(connectionId, provider, "gemini-3.1-pro-preview"),
      true,
      "sibling pro model shares the exhausted pool"
    );
    assert.equal(
      quotaCache.isQuotaExhaustedForRequest(connectionId, provider, "gemini-3.5-flash"),
      false
    );
    assert.equal(
      quotaCache.isQuotaExhaustedForRequest(connectionId, provider, "gemini-3.1-flash-lite"),
      false
    );
    // No requested model → connection-wide semantics (not every window is exhausted).
    assert.equal(quotaCache.isQuotaExhaustedForRequest(connectionId, provider), false);
  }
});

test("connection-wide fallback when every tier is exhausted and no model is given", () => {
  const connectionId = "gcli-all-exhausted";
  const snap = parseGeminiCliQuotaResponse(
    {
      buckets: [
        { modelId: "gemini-2.5-pro", remainingFraction: 0, resetTime: FUTURE_RESET },
        { modelId: "gemini-2.5-flash", remainingFraction: 0, resetTime: FUTURE_RESET },
        { modelId: "gemini-2.5-flash-lite", remainingFraction: 0, resetTime: FUTURE_RESET },
      ],
    },
    "FREE"
  );
  quotaCache.setQuotaCache(connectionId, "gemini-cli", snap.quotas);
  assert.equal(quotaCache.isQuotaExhaustedForRequest(connectionId, "gemini-cli"), true);
  assert.equal(
    quotaCache.isQuotaExhaustedForRequest(connectionId, "gemini-cli", "gemini-3.5-flash-lite"),
    true
  );
  // Unknown model → no tier window matches → connection-wide aggregate.
  assert.equal(
    quotaCache.isQuotaExhaustedForRequest(connectionId, "gemini-cli", "gemini-embedding-001"),
    true
  );
});

test("an unreported tier fraction is never treated as exhaustion", () => {
  const connectionId = "gcli-unreported";
  quotaCache.setQuotaCache(connectionId, "gemini-cli", {
    gemini_cli_pro: {
      used: 1500,
      total: 1500,
      remainingPercentage: 0,
      resetAt: FUTURE_RESET,
      fractionReported: false,
    },
  });
  assert.equal(
    quotaCache.isQuotaExhaustedForRequest(connectionId, "gemini-cli", "gemini-2.5-pro"),
    false
  );
});

// ─── Review remediation ─────────────────────────────────────────────────────

test("tier classification requires whole hyphen/underscore segments", () => {
  for (const id of [
    "gemini-prototype",
    "gemini-flashcards",
    "gemini-litehouse",
    "gemini-profile",
    "gemini-flashy-2",
    "gemini-sprout",
    "gemini-reflash",
  ]) {
    assert.equal(getGeminiCliQuotaTier(id), null, id);
  }
  assert.equal(getGeminiCliQuotaTier("gemini-2.5-flash-lite-preview-06-17"), "flash_lite");
  assert.equal(getGeminiCliQuotaTier("gemini_2_5_flash_lite"), "flash_lite");
  assert.equal(getGeminiCliQuotaTier("gemini-2.5-pro-exp-03-25"), "pro");
  assert.equal(getGeminiCliQuotaTier("gemini-2.5-flash-image"), "flash");
});

test("staggered tier resets: Pro unblocks at its reset while Flash stays blocked", (t) => {
  const connectionId = "gcli-staggered-reset";
  const base = Date.now();
  const proReset = new Date(base + 60 * 60 * 1000).toISOString();
  const flashReset = new Date(base + 2 * 60 * 60 * 1000).toISOString();
  const liteReset = new Date(base + 3 * 60 * 60 * 1000).toISOString();
  quotaCache.setQuotaCache(connectionId, "gemini-cli", {
    gemini_cli_pro: { used: 1000, total: 1000, remainingPercentage: 0, resetAt: proReset },
    gemini_cli_flash: { used: 1000, total: 1000, remainingPercentage: 0, resetAt: flashReset },
    gemini_cli_flash_lite: { used: 1000, total: 1000, remainingPercentage: 0, resetAt: liteReset },
  });

  assert.equal(quotaCache.isQuotaExhaustedForRequest(connectionId, "gemini-cli"), true);
  assert.equal(
    quotaCache.isQuotaExhaustedForRequest(connectionId, "gemini-cli", "gemini-2.5-pro"),
    true
  );

  // Advance past the Pro reset only.
  t.mock.method(Date, "now", () => base + 60 * 60 * 1000 + 60 * 1000);
  assert.equal(
    quotaCache.isQuotaExhaustedForRequest(connectionId, "gemini-cli", "gemini-2.5-pro"),
    false,
    "Pro reset has passed"
  );
  assert.equal(
    quotaCache.isQuotaExhaustedForRequest(connectionId, "gemini-cli", "gemini-3-flash-preview"),
    true,
    "Flash reset is still in the future"
  );
  assert.equal(
    quotaCache.isQuotaExhaustedForRequest(connectionId, "gemini-cli", "gemini-3.1-flash-lite"),
    true,
    "Flash Lite reset is still in the future"
  );
  // Flash must stay blocked even after the model-less check cleared the connection flag.
  assert.equal(quotaCache.isQuotaExhaustedForRequest(connectionId, "gemini-cli"), false);
  assert.equal(
    quotaCache.isQuotaExhaustedForRequest(connectionId, "gemini-cli", "gemini-2.5-flash"),
    true
  );

  // Past every reset → nothing is exhausted.
  t.mock.method(Date, "now", () => base + 3 * 60 * 60 * 1000 + 60 * 1000);
  assert.equal(
    quotaCache.isQuotaExhaustedForRequest(connectionId, "gemini-cli", "gemini-2.5-flash"),
    false
  );
  assert.equal(
    quotaCache.isQuotaExhaustedForRequest(connectionId, "gemini-cli", "gemini-3.1-flash-lite"),
    false
  );
});

test("hydrated snapshots: a canonical tier window overrides a stale legacy per-model row", () => {
  const connectionId = "gcli-hydrate-conflict";
  const stale = {
    provider: "gemini-cli",
    connection_id: connectionId,
    window_key: "gemini-2.5-pro",
    remaining_percentage: 0,
    is_exhausted: 1,
    next_reset_at: FUTURE_RESET,
    window_duration_ms: null,
    raw_data: null,
  };
  quotaSnapshotsDb.saveQuotaSnapshot(stale as never);
  quotaSnapshotsDb.saveQuotaSnapshot({
    ...stale,
    window_key: "gemini_cli_pro",
    remaining_percentage: 80,
    is_exhausted: 0,
  } as never);

  const names = quotaSnapshotsDb
    .getLatestQuotaSnapshotsForConnection(connectionId)
    .map((row) => (row as unknown as { windowKey: string }).windowKey)
    .sort();
  assert.deepEqual(names, ["gemini-2.5-pro", "gemini_cli_pro"]);
  assert.deepEqual(quotaCache.resolveGeminiCliQuotaWindowsForModel(names, "gemini-2.5-pro"), [
    "gemini_cli_pro",
  ]);
  // Alias tier keys also take precedence over legacy rows.
  assert.deepEqual(
    quotaCache.resolveGeminiCliQuotaWindowsForModel(["gemini-2.5-pro", "pro"], "gemini-2.5-pro"),
    ["pro"]
  );

  assert.equal(quotaCache.getQuotaCache(connectionId), null, "not cached before hydration");
  assert.equal(
    quotaCache.isQuotaExhaustedForRequest(connectionId, "gemini-cli", "gemini-2.5-pro"),
    false
  );
});

test("a recognized tier with no cached window is not blocked by another tier's exhaustion", () => {
  const exhausted = { used: 1000, total: 1000, remainingPercentage: 0, resetAt: FUTURE_RESET };

  const tierOnly = "gcli-only-pro-tier";
  quotaCache.setQuotaCache(tierOnly, "gemini-cli", { gemini_cli_pro: exhausted });
  assert.equal(
    quotaCache.isQuotaExhaustedForRequest(tierOnly, "gemini-cli", "gemini-2.5-pro"),
    true
  );
  assert.equal(
    quotaCache.isQuotaExhaustedForRequest(tierOnly, "gemini-cli", "gemini-3.5-flash"),
    false
  );

  const legacyOnly = "gcli-only-legacy-pro";
  quotaCache.setQuotaCache(legacyOnly, "gemini-cli", { "gemini-2.5-pro": exhausted });
  assert.equal(
    quotaCache.isQuotaExhaustedForRequest(legacyOnly, "gemini-cli", "gemini-3.5-flash"),
    false
  );
});

test("quota alias keys canonicalize to one entry per tier", () => {
  for (const provider of ["gemini-cli", "gemini_cli", "gcli"]) {
    assert.equal(quotaNormalize.normalizeUsageQuotaKey(provider, "pro"), "gemini_cli_pro");
    assert.equal(quotaNormalize.normalizeUsageQuotaKey(provider, "gemini_pro"), "gemini_cli_pro");
    assert.equal(quotaNormalize.normalizeUsageQuotaKey(provider, "lite"), "gemini_cli_flash_lite");
    assert.equal(
      quotaNormalize.normalizeUsageQuotaKey(provider, "gemini_flash_lite"),
      "gemini_cli_flash_lite"
    );

    const normalized = quotaNormalize.normalizeUsageQuotasForProvider(provider, {
      pro: { used: 1, total: 10 },
      gemini_cli_pro: { used: 2, total: 10 },
      gemini_flash: { used: 3, total: 10 },
    });
    assert.deepEqual(Object.keys(normalized || {}).sort(), ["gemini_cli_flash", "gemini_cli_pro"]);
    assert.deepEqual((normalized as Record<string, unknown>).gemini_cli_flash, {
      used: 3,
      total: 10,
    });
  }
});

test("alias/canonical collisions keep the higher-ranked source and drop the alias key", () => {
  const cases: Array<{ name: string; quotas: Record<string, unknown> }> = [
    {
      name: "canonical first (higher rank), alias second (lower rank)",
      quotas: {
        gemini_cli_pro: { used: 1, total: 10, quotaSource: "retrieveUserQuota" },
        pro: { used: 9, total: 10, quotaSource: "localUsageHistory" },
      },
    },
    {
      name: "alias first (lower rank), canonical second (higher rank)",
      quotas: {
        pro: { used: 9, total: 10, quotaSource: "localUsageHistory" },
        gemini_cli_pro: { used: 1, total: 10, quotaSource: "retrieveUserQuota" },
      },
    },
    {
      name: "alias first (higher rank), canonical second (lower rank)",
      quotas: {
        pro: { used: 1, total: 10, quotaSource: "retrieveUserQuota" },
        gemini_cli_pro: { used: 9, total: 10, quotaSource: "localUsageHistory" },
      },
    },
  ];

  for (const provider of ["gemini-cli", "gemini_cli", "gcli"]) {
    for (const { name, quotas } of cases) {
      const normalized = quotaNormalize.normalizeUsageQuotasForProvider(provider, quotas);
      assert.deepEqual(Object.keys(normalized || {}), ["gemini_cli_pro"], `${provider}: ${name}`);
      assert.deepEqual(
        (normalized as Record<string, unknown>).gemini_cli_pro,
        { used: 1, total: 10, quotaSource: "retrieveUserQuota" },
        `${provider}: ${name}`
      );
    }
  }
});

test("persisted Gemini CLI provider-limits cache drops legacy per-model keys", async () => {
  const legacyQuotas = {
    gemini_cli_pro: { used: 1, total: 1000 },
    "gemini-2.5-pro": { used: 1, total: 1000 },
    "gemini-2.5-flash": { used: 2, total: 1000 },
    flash: { used: 2, total: 1000 },
  };
  const entry = {
    quotas: legacyQuotas,
    plan: null,
    message: null,
    fetchedAt: new Date(0).toISOString(),
    source: null,
  };

  const direct = providerLimits.sanitizeProviderLimitsCacheForConnection(
    { id: "x", provider: "gemini-cli" } as never,
    entry as never
  );
  assert.deepEqual(Object.keys(direct?.quotas || {}).sort(), [
    "gemini_cli_flash",
    "gemini_cli_pro",
  ]);
  // Non-sanitized providers pass through untouched.
  assert.equal(
    providerLimits.sanitizeProviderLimitsCacheForConnection(
      { id: "y", provider: "openai" } as never,
      entry as never
    ),
    entry
  );

  const conn = (await providersDb.createProviderConnection({
    provider: "gemini-cli",
    authType: "oauth",
    name: "Gemini CLI acct",
    email: "gcli@example.test",
    accessToken: "gcli-access",
    refreshToken: "gcli-refresh",
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  })) as { id: string };
  providerLimitsDb.setProviderLimitsCache(conn.id, entry as never);

  const out = await providerLimits.getSanitizedCachedProviderLimitsMap();
  assert.deepEqual(Object.keys((out[conn.id]?.quotas as object) || {}).sort(), [
    "gemini_cli_flash",
    "gemini_cli_pro",
  ]);
});
