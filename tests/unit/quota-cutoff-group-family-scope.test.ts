import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { QuotaCutoffScope } from "../../open-sse/services/quotaCutoffScope.ts";
import type { QuotaInfo } from "../../open-sse/services/quotaPreflight.ts";

/**
 * Per-account "Quota cutoffs" (minimum remaining % per quota window) were
 * evaluated against the RAW window map returned by the provider quota fetcher:
 * `open-sse/services/quotaPreflight.ts` compared each provider-native window's
 * own `percentUsed` against the resolved threshold and never consulted either
 * aggregation layer OmniRoute puts on top of a provider quota —
 *
 *   • the DB quota-group abstraction (`qtSd/<group>/<provider>/<model>`,
 *     `quota_pools.group_id`), so a group whose sibling member connection is
 *     out of quota kept routing through the group's healthy-looking member;
 *   • the Antigravity family aggregates (`gemini_weekly` / `claude_gpt_weekly`,
 *     `gemini_5h` / `claude_gpt_5h`), so a cutoff configured on a family bucket
 *     never governed that family's per-model windows — and an exhausted Claude
 *     bucket could block an unrelated Gemini request.
 *
 * Regression guards for the group/family-aware evaluator (quotaCutoffScope.ts)
 * and for its wiring into BOTH cutoff gates: the direct chat path
 * (`getProviderCredentialsWithQuotaPreflight` → `preflightQuota`) and the combo
 * path (`resolveQuotaExhaustionCutoffForTarget` → `evaluateQuotaCutoff`).
 */

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-quota-cutoff-group-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = process.env.API_KEY_SECRET || "quota-cutoff-group-secret";

const dbCore = await import("../../src/lib/db/core.ts");
const providersDb = await import("../../src/lib/db/providers.ts");
const quotaGroupsDb = await import("../../src/lib/db/quotaGroups.ts");
const quotaPoolsDb = await import("../../src/lib/db/quotaPools.ts");
const quotaCache = await import("../../src/domain/quotaCache.ts");
const { quotaModelName, parseQuotaModelName } =
  await import("../../src/lib/quota/quotaModelNaming.ts");
const { buildQuotaCutoffScope } = await import("../../src/lib/quota/quotaGroupWindows.ts");
const { resolveQuotaCutoffIdentity, resolveQuotaCutoffWindows, quotaWindowThresholdLookupNames } =
  await import("../../open-sse/services/quotaCutoffScope.ts");
const { evaluateQuotaCutoff, preflightQuota, registerQuotaFetcher } =
  await import("../../open-sse/services/quotaPreflight.ts");
const { buildAutoQuotaThresholds, resolveQuotaExhaustionCutoffForTarget } =
  await import("../../open-sse/services/combo/quotaExhaustionCutoff.ts");
const { resolveResetWindowConfig } = await import("../../open-sse/services/combo/quotaScoring.ts");
const { handleComboChat } = await import("../../open-sse/services/combo.ts");
const auth = await import("../../src/sse/services/auth.ts");

type ResilienceSettingsArg = Parameters<typeof buildAutoQuotaThresholds>[2];

test.after(() => {
  dbCore.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

const FAMILY_PROVIDER = "agy"; // Antigravity alias — same family classifier, no credits bypass.
const GROUP_NAME = "Team Alpha";
const GROUP_SLUG = "teamalpha";

function quota(
  windows: Record<string, { percentUsed: number; resetAt?: string | null }>
): QuotaInfo {
  const worst = Math.max(0, ...Object.values(windows).map((w) => w.percentUsed));
  return { used: 0, total: 0, percentUsed: worst, resetAt: null, windows };
}

function noopLog() {
  return { debug() {}, warn() {} };
}

// ── 1. qtSd parsing round-trip ─────────────────────────────────────────────

test("qtSd virtual model round-trips into the cutoff identity (group + provider + model)", () => {
  const name = quotaModelName(GROUP_NAME, FAMILY_PROVIDER, "gemini-3-pro");
  assert.equal(name, `qtSd/${GROUP_SLUG}/${FAMILY_PROVIDER}/gemini-3-pro`);
  assert.deepEqual(parseQuotaModelName(name), {
    groupSlug: GROUP_SLUG,
    provider: FAMILY_PROVIDER,
    model: "gemini-3-pro",
  });

  // The virtual name is authoritative — it overrides the caller's provider hint.
  assert.deepEqual(resolveQuotaCutoffIdentity({ provider: "openai", requestedModel: name }), {
    provider: FAMILY_PROVIDER,
    model: "gemini-3-pro",
    groupSlug: GROUP_SLUG,
  });

  // Namespaced model ids keep their slashes.
  const namespaced = quotaModelName(GROUP_NAME, FAMILY_PROVIDER, "google/gemini-3-pro");
  assert.equal(parseQuotaModelName(namespaced)?.model, "google/gemini-3-pro");
  assert.equal(parseQuotaModelName("gemini-3-pro"), null);
});

// ── 2. Antigravity family aggregate mapping ────────────────────────────────

test("Antigravity family windows map to their aggregate bucket and never mix families", () => {
  const antigravityQuota = quota({
    "gemini-3-pro": { percentUsed: 0.3 },
    gemini_weekly: { percentUsed: 0.985, resetAt: "2026-09-15T00:00:00.000Z" },
    "claude-sonnet-4-5": { percentUsed: 0.1 },
    claude_gpt_weekly: { percentUsed: 0.999 },
    credits: { percentUsed: 0.5 },
  });

  const geminiScope: QuotaCutoffScope = {
    provider: "antigravity",
    requestedModel: "gemini-3-pro",
  };
  const geminiWindows = resolveQuotaCutoffWindows(antigravityQuota, geminiScope);
  assert.deepEqual(Object.keys(geminiWindows.windows).sort(), [
    "credits",
    "gemini-3-pro",
    "gemini_weekly",
  ]);
  assert.ok(geminiWindows.aggregateWindowNames.includes("gemini_weekly"));

  // The Gemini family aggregate is at 1.5% remaining → blocked at the 2% default.
  const geminiCutoff = evaluateQuotaCutoff(antigravityQuota, undefined, geminiScope);
  assert.equal(geminiCutoff.proceed, false);
  assert.equal(geminiCutoff.quotaPercent, 0.985);
  assert.equal(geminiCutoff.resetAt, "2026-09-15T00:00:00.000Z");

  // Same connection, Claude request → judged by the Claude family aggregate.
  const claudeCutoff = evaluateQuotaCutoff(antigravityQuota, undefined, {
    provider: "antigravity",
    requestedModel: "claude-sonnet-4-5",
  });
  assert.equal(claudeCutoff.proceed, false);
  assert.equal(claudeCutoff.quotaPercent, 0.999);

  // The 5h family bucket naming is honored too.
  const sessionScoped = resolveQuotaCutoffWindows(
    quota({ "gemini-3-pro": { percentUsed: 0.1 }, gemini_5h: { percentUsed: 0.99 } }),
    geminiScope
  );
  assert.ok(sessionScoped.aggregateWindowNames.includes("gemini_5h"));
});

test("an exhausted Claude family bucket does not block a Gemini request (no cross-family mixing)", () => {
  const antigravityQuota = quota({
    "gemini-3-pro": { percentUsed: 0.1 },
    gemini_weekly: { percentUsed: 0.2 },
    claude_gpt_weekly: { percentUsed: 1 },
  });

  // Raw (scope-less) comparison blocks on the unrelated Claude bucket…
  assert.equal(evaluateQuotaCutoff(antigravityQuota).proceed, false);
  // …the family-aware evaluator lets the Gemini request through.
  assert.equal(
    evaluateQuotaCutoff(antigravityQuota, undefined, {
      provider: FAMILY_PROVIDER,
      requestedModel: "gemini-3-pro",
    }).proceed,
    true
  );
  // …and still blocks the Claude request.
  assert.equal(
    evaluateQuotaCutoff(antigravityQuota, undefined, {
      provider: FAMILY_PROVIDER,
      requestedModel: "claude-sonnet-4-5",
    }).proceed,
    false
  );
});

// ── 3. Group aggregation (two model types, one breached weekly window) ─────

test("two model types of one quota group share the group's breached weekly window", () => {
  // The selected member looks healthy (60% weekly remaining); a sibling member
  // of the same group is at 1% remaining. The group is one shared upstream
  // pool → its headroom is the MINIMUM across members, so both model types are
  // blocked.
  const selfQuota = quota({ weekly: { percentUsed: 0.4 }, session: { percentUsed: 0.1 } });
  const memberWindows = [{ weekly: { percentUsed: 0.99, resetAt: "2026-09-14T00:00:00.000Z" } }];

  for (const model of ["model-a", "model-b"]) {
    const scope: QuotaCutoffScope = {
      provider: "grpprov",
      requestedModel: `qtSd/${GROUP_SLUG}/grpprov/${model}`,
      memberWindows,
    };
    const resolved = resolveQuotaCutoffWindows(selfQuota, scope);
    // Minimum remaining, never a sum: 0.99 used, not 0.4 + 0.99.
    assert.equal(resolved.windows.weekly.percentUsed, 0.99);
    assert.equal(resolved.windows.session.percentUsed, 0.1);
    assert.ok(resolved.aggregated);

    const decision = evaluateQuotaCutoff(selfQuota, undefined, scope);
    assert.equal(decision.proceed, false, `${model} must be blocked by the group weekly window`);
    assert.equal(decision.quotaPercent, 0.99);
    assert.equal(decision.resetAt, "2026-09-14T00:00:00.000Z");
  }

  // Without the group's member facts the same connection proceeds — proving it
  // is the group aggregation (not the raw window) that blocks.
  assert.equal(
    evaluateQuotaCutoff(selfQuota, undefined, {
      provider: "grpprov",
      requestedModel: `qtSd/${GROUP_SLUG}/grpprov/model-a`,
    }).proceed,
    true
  );
});

test("a healthier group member never raises the group's headroom", () => {
  const selfQuota = quota({ weekly: { percentUsed: 0.995 } });
  const decision = evaluateQuotaCutoff(selfQuota, undefined, {
    provider: "grpprov",
    requestedModel: `qtSd/${GROUP_SLUG}/grpprov/model-a`,
    memberWindows: [{ weekly: { percentUsed: 0.01 } }],
  });
  assert.equal(decision.proceed, false);
  assert.equal(decision.quotaPercent, 0.995);
});

// ── 4. Threshold precedence with the new scope ─────────────────────────────

test("cutoff precedence stays connection override → provider/window default → global default", () => {
  const settings = {
    quotaPreflight: {
      enabled: true,
      defaultThresholdPercent: 2,
      warnThresholdPercent: 20,
      providerWindowDefaults: { [FAMILY_PROVIDER]: { gemini_weekly: 5 } },
    },
  } as unknown as ResilienceSettingsArg;

  const withOverride = buildAutoQuotaThresholds(
    FAMILY_PROVIDER,
    { quotaWindowThresholds: { gemini_weekly: 40 } },
    settings
  );
  // Connection override wins over the provider/window default…
  assert.equal(withOverride.resolveMinRemainingPercent?.("gemini_weekly"), 40);
  // …and governs that family's per-model windows through the family alias.
  assert.equal(withOverride.resolveMinRemainingPercent?.("gemini-3-pro"), 40);
  // A per-window override still wins over the family alias.
  const exactWindowOverride = buildAutoQuotaThresholds(
    FAMILY_PROVIDER,
    { quotaWindowThresholds: { gemini_weekly: 40, "gemini-3-pro": 7 } },
    settings
  );
  assert.equal(exactWindowOverride.resolveMinRemainingPercent?.("gemini-3-pro"), 7);

  const withoutOverride = buildAutoQuotaThresholds(FAMILY_PROVIDER, {}, settings);
  assert.equal(withoutOverride.resolveMinRemainingPercent?.("gemini_weekly"), 5);
  assert.equal(withoutOverride.resolveMinRemainingPercent?.("gemini-3-pro"), 5);
  // Unrelated windows and other families fall back to the global default.
  assert.equal(withoutOverride.resolveMinRemainingPercent?.("credits"), 2);
  assert.equal(withoutOverride.resolveMinRemainingPercent?.("claude_gpt_weekly"), 2);
  assert.equal(withoutOverride.resolveMinRemainingPercent?.(null), 2);

  // Non-Antigravity providers get no family aliases at all.
  assert.deepEqual(quotaWindowThresholdLookupNames("openai", "weekly"), ["weekly"]);
  assert.deepEqual(quotaWindowThresholdLookupNames(FAMILY_PROVIDER, "gemini-3-pro"), [
    "gemini-3-pro",
    "gemini_weekly",
    "gemini_5h",
  ]);
});

// ── 5. Non-group, non-family connections are untouched ─────────────────────

test("a non-group, non-family connection keeps the raw per-window comparison", () => {
  const rawQuota = quota({ session: { percentUsed: 0.5 }, weekly: { percentUsed: 0.99 } });
  const scope: QuotaCutoffScope = { provider: "openai", requestedModel: "gpt-4o-mini" };

  // Same window map object — no aggregation layer inserted.
  const resolved = resolveQuotaCutoffWindows(rawQuota, scope);
  assert.equal(resolved.windows, rawQuota.windows);
  assert.equal(resolved.aggregated, false);
  assert.deepEqual(resolved.aggregateWindowNames, []);

  // Identical verdicts with and without a scope.
  assert.deepEqual(
    evaluateQuotaCutoff(rawQuota, undefined, scope),
    evaluateQuotaCutoff(rawQuota, undefined)
  );
  assert.equal(evaluateQuotaCutoff(rawQuota, undefined, scope).proceed, false);

  const healthy = quota({ session: { percentUsed: 0.5 }, weekly: { percentUsed: 0.5 } });
  assert.deepEqual(
    evaluateQuotaCutoff(healthy, undefined, scope),
    evaluateQuotaCutoff(healthy, undefined)
  );
  assert.equal(evaluateQuotaCutoff(healthy, undefined, scope).proceed, true);
});

// ── 6/7. Both gates: direct chat path and combo target path ───────────────

test("direct chat path and combo target path both enforce the family cutoff", async () => {
  const connection = (await providersDb.createProviderConnection({
    provider: FAMILY_PROVIDER,
    authType: "apikey",
    name: "agy-family-cutoff",
    apiKey: "sk-agy-family-cutoff",
    isActive: true,
    testStatus: "active",
    // Operator cutoff typed against the FAMILY bucket in the cutoffs modal.
    quotaWindowThresholds: { gemini_weekly: 40 },
  })) as { id: string };

  // 30% remaining on the Gemini per-model window, 80% on the Gemini family
  // bucket, Claude family untouched. Before the fix the per-model window fell
  // back to the 2% factory default and the request went through.
  registerQuotaFetcher(FAMILY_PROVIDER, async () =>
    quota({
      "gemini-3-pro": { percentUsed: 0.7 },
      gemini_weekly: { percentUsed: 0.2 },
      "claude-sonnet-4-5": { percentUsed: 0.1 },
      claude_gpt_weekly: { percentUsed: 0.1 },
    })
  );

  // Direct chat path — getProviderCredentialsWithQuotaPreflight → preflightQuota.
  // The Claude request runs first: blocking the Gemini one puts the connection
  // into the normal preflight cooldown, which would mask the control case.
  const allowed = (await auth.getProviderCredentialsWithQuotaPreflight(
    FAMILY_PROVIDER,
    null,
    [connection.id],
    "claude-sonnet-4-5"
  )) as { allRateLimited?: boolean; connectionId?: string } | null;
  assert.equal(allowed?.allRateLimited, undefined);
  assert.equal(allowed?.connectionId, connection.id, "claude request must stay eligible");

  const blocked = (await auth.getProviderCredentialsWithQuotaPreflight(
    FAMILY_PROVIDER,
    null,
    [connection.id],
    "gemini-3-pro"
  )) as { allRateLimited?: boolean; connectionId?: string } | null;
  assert.equal(
    blocked?.allRateLimited,
    true,
    "gemini request must be blocked by the family cutoff"
  );

  // Combo target path — same evaluator, same verdicts.
  const settings = {
    quotaPreflight: {
      enabled: true,
      defaultThresholdPercent: 2,
      warnThresholdPercent: 20,
      providerWindowDefaults: {},
    },
  } as unknown as ResilienceSettingsArg;
  const resetWindowConfig = resolveResetWindowConfig(null);

  const comboBlocked = await resolveQuotaExhaustionCutoffForTarget(
    FAMILY_PROVIDER,
    connection.id,
    settings,
    resetWindowConfig,
    quotaModelName(GROUP_NAME, FAMILY_PROVIDER, "gemini-3-pro"),
    noopLog(),
    "gemini-3-pro"
  );
  assert.equal(comboBlocked.blocked, true);
  assert.equal(comboBlocked.reason, "quota_exhausted");

  const comboAllowed = await resolveQuotaExhaustionCutoffForTarget(
    FAMILY_PROVIDER,
    connection.id,
    settings,
    resetWindowConfig,
    quotaModelName(GROUP_NAME, FAMILY_PROVIDER, "claude-sonnet-4-5"),
    noopLog(),
    "claude-sonnet-4-5"
  );
  assert.equal(comboAllowed.blocked, false);
});

// ── 8. Group scope resolved from the DB ───────────────────────────────────

test("buildQuotaCutoffScope aggregates the group's member connections from the DB", async () => {
  const group = quotaGroupsDb.createGroup(GROUP_NAME);
  const primary = (await providersDb.createProviderConnection({
    provider: FAMILY_PROVIDER,
    authType: "apikey",
    name: "agy-group-primary",
    apiKey: "sk-agy-group-primary",
    isActive: true,
    testStatus: "active",
  })) as { id: string };
  const sibling = (await providersDb.createProviderConnection({
    provider: FAMILY_PROVIDER,
    authType: "apikey",
    name: "agy-group-sibling",
    apiKey: "sk-agy-group-sibling",
    isActive: true,
    testStatus: "active",
  })) as { id: string };
  const foreign = (await providersDb.createProviderConnection({
    provider: "openai",
    authType: "apikey",
    name: "openai-group-foreign",
    apiKey: "sk-openai-group-foreign",
    isActive: true,
    testStatus: "active",
  })) as { id: string };

  quotaPoolsDb.createPool({
    connectionId: primary.id,
    connectionIds: [primary.id, sibling.id],
    name: "alpha-pool",
    groupId: group.id,
  });
  quotaPoolsDb.createPool({
    connectionId: foreign.id,
    name: "alpha-foreign-pool",
    groupId: group.id,
  });

  // The sibling is nearly out of weekly quota; the foreign-provider member has
  // an unrelated quota that must never be folded in.
  quotaCache.setQuotaCache(sibling.id, FAMILY_PROVIDER, {
    gemini_weekly: { remainingPercentage: 1, resetAt: null, total: 1000, used: 990 },
  });
  quotaCache.setQuotaCache(foreign.id, "openai", {
    weekly: { remainingPercentage: 0, resetAt: null, total: 1000, used: 1000 },
  });

  const scope = await buildQuotaCutoffScope(
    FAMILY_PROVIDER,
    quotaModelName(GROUP_NAME, FAMILY_PROVIDER, "gemini-3-pro"),
    primary.id
  );
  assert.equal(scope?.groupSlug, GROUP_SLUG);
  assert.equal(scope?.provider, FAMILY_PROVIDER);
  assert.equal(scope?.memberWindows?.length, 1, "only same-provider members are aggregated");
  assert.ok(Math.abs((scope?.memberWindows?.[0].gemini_weekly.percentUsed ?? 0) - 0.99) < 1e-9);
  assert.equal(scope?.memberWindows?.[0].weekly, undefined);

  // The selected connection's own quota looks healthy — the group's most
  // depleted member is what blocks it.
  const selfQuota = quota({
    "gemini-3-pro": { percentUsed: 0.1 },
    gemini_weekly: { percentUsed: 0.1 },
  });
  assert.equal(evaluateQuotaCutoff(selfQuota, undefined).proceed, true);
  assert.equal(evaluateQuotaCutoff(selfQuota, undefined, scope).proceed, false);

  // A non-group model on the same provider resolves a scope without member
  // facts, so its verdict is the raw one.
  const bareScope = await buildQuotaCutoffScope(FAMILY_PROVIDER, "gemini-3-pro", primary.id);
  assert.equal(bareScope?.groupSlug, null);
  assert.equal(bareScope?.memberWindows, undefined);
  assert.equal(evaluateQuotaCutoff(selfQuota, undefined, bareScope).proceed, true);

  // A provider with neither layer gets no scope at all.
  assert.equal(await buildQuotaCutoffScope("openai", "gpt-4o-mini", foreign.id), undefined);
});

// ── 9. Cross-family leak through the group member merge (#12161 review) ────

test("a group member's exhausted Claude bucket never blocks a Gemini group request", () => {
  // Member facts come straight out of each sibling's quota cache, so they carry
  // EVERY family's windows. Merging them after the selected family was filtered
  // used to re-inject the unrelated family and block the request.
  const selfQuota = quota({
    "gemini-3-pro": { percentUsed: 0.1 },
    gemini_weekly: { percentUsed: 0.2 },
    claude_gpt_weekly: { percentUsed: 0.3 },
  });
  const memberWindows = [
    {
      gemini_weekly: { percentUsed: 0.25 },
      claude_gpt_weekly: { percentUsed: 1 },
      "claude-sonnet-4-5": { percentUsed: 1 },
      credits: { percentUsed: 0.4 },
    },
  ];

  const geminiScope: QuotaCutoffScope = {
    provider: FAMILY_PROVIDER,
    requestedModel: `qtSd/${GROUP_SLUG}/${FAMILY_PROVIDER}/gemini-3-pro`,
    memberWindows,
  };
  const resolved = resolveQuotaCutoffWindows(selfQuota, geminiScope);
  assert.deepEqual(Object.keys(resolved.windows).sort(), [
    "credits",
    "gemini-3-pro",
    "gemini_weekly",
  ]);
  assert.equal(resolved.windows.claude_gpt_weekly, undefined);
  assert.equal(resolved.windows["claude-sonnet-4-5"], undefined);
  // The MIN-% group merge still applies inside the selected family…
  assert.equal(resolved.windows.gemini_weekly.percentUsed, 0.25);
  // …and non-family keys still merge (credits: 0.3 self is absent → member 0.4).
  assert.equal(resolved.windows.credits.percentUsed, 0.4);
  assert.equal(resolved.family, "gemini");
  assert.equal(resolved.scoped, true);
  assert.equal(
    evaluateQuotaCutoff(selfQuota, undefined, geminiScope).proceed,
    true,
    "the sibling's Claude exhaustion is not this Gemini request's problem"
  );

  // The Claude request on the same group IS blocked by that same member.
  const claudeDecision = evaluateQuotaCutoff(selfQuota, undefined, {
    provider: FAMILY_PROVIDER,
    requestedModel: `qtSd/${GROUP_SLUG}/${FAMILY_PROVIDER}/claude-sonnet-4-5`,
    memberWindows,
  });
  assert.equal(claudeDecision.proceed, false);
  assert.equal(claudeDecision.quotaPercent, 1);
});

test("buildQuotaCutoffScope + family filtering: a sibling's other-family exhaustion is ignored", async () => {
  // Same intersection, end to end through the DB scope builder: the sibling's
  // real quota cache holds BOTH families, only the Claude one is exhausted.
  const MIXED_GROUP_NAME = "Mixed Family Group";
  const mixedGroup = quotaGroupsDb.createGroup(MIXED_GROUP_NAME);
  const primary = (await providersDb.createProviderConnection({
    provider: FAMILY_PROVIDER,
    authType: "apikey",
    name: "agy-mixed-primary",
    apiKey: "sk-agy-mixed-primary",
    isActive: true,
    testStatus: "active",
  })) as { id: string };
  const sibling = (await providersDb.createProviderConnection({
    provider: FAMILY_PROVIDER,
    authType: "apikey",
    name: "agy-mixed-sibling",
    apiKey: "sk-agy-mixed-sibling",
    isActive: true,
    testStatus: "active",
  })) as { id: string };
  quotaPoolsDb.createPool({
    connectionId: primary.id,
    connectionIds: [primary.id, sibling.id],
    name: "mixed-family-pool",
    groupId: mixedGroup.id,
  });

  quotaCache.setQuotaCache(sibling.id, FAMILY_PROVIDER, {
    gemini_weekly: { remainingPercentage: 55, resetAt: null, total: 1000, used: 450 },
    claude_gpt_weekly: { remainingPercentage: 0, resetAt: null, total: 1000, used: 1000 },
  });

  const selfQuota = quota({
    "gemini-3-pro": { percentUsed: 0.1 },
    gemini_weekly: { percentUsed: 0.2 },
    "claude-sonnet-4-5": { percentUsed: 0.1 },
    claude_gpt_weekly: { percentUsed: 0.1 },
  });

  const geminiScope = await buildQuotaCutoffScope(
    FAMILY_PROVIDER,
    quotaModelName(MIXED_GROUP_NAME, FAMILY_PROVIDER, "gemini-3-pro"),
    primary.id
  );
  assert.equal(geminiScope?.memberWindows?.length, 1);
  // The member map itself still carries both families — the FILTERING is the
  // resolver's job, so this asserts the fix is in the merge, not in the fetch.
  assert.ok(geminiScope?.memberWindows?.[0].claude_gpt_weekly);
  const geminiResolved = resolveQuotaCutoffWindows(selfQuota, geminiScope);
  assert.equal(geminiResolved.windows.claude_gpt_weekly, undefined);
  assert.equal(evaluateQuotaCutoff(selfQuota, undefined, geminiScope).proceed, true);

  // The Claude request on that same group IS blocked by the sibling.
  const claudeScope = await buildQuotaCutoffScope(
    FAMILY_PROVIDER,
    quotaModelName(MIXED_GROUP_NAME, FAMILY_PROVIDER, "claude-sonnet-4-5"),
    primary.id
  );
  const claudeDecision = evaluateQuotaCutoff(selfQuota, undefined, claudeScope);
  assert.equal(claudeDecision.proceed, false);
  assert.equal(claudeDecision.quotaPercent, 1);
});

// ── 10. `limitReached` must be derived AFTER scoping (#12161 review) ───────

test("a limitReached flag raised by the unrelated family does not block the request", () => {
  // `limitReached` is a whole-CONNECTION summary: on Antigravity it flips as
  // soon as ANY family bucket is exhausted. Honoring it before scoping blocked
  // a healthy Gemini request on an exhausted Claude bucket.
  const mixed: QuotaInfo = {
    ...quota({
      "gemini-3-pro": { percentUsed: 0.1 },
      gemini_weekly: { percentUsed: 0.2 },
      claude_gpt_weekly: { percentUsed: 1 },
    }),
    percentUsed: 1,
    limitReached: true,
  };

  // Scope-less: the flag keeps its original meaning and blocks.
  assert.equal(evaluateQuotaCutoff(mixed).proceed, false);
  // Gemini-scoped: exhaustion is derived from the Gemini windows → proceeds.
  assert.equal(
    evaluateQuotaCutoff(mixed, undefined, {
      provider: FAMILY_PROVIDER,
      requestedModel: "gemini-3-pro",
    }).proceed,
    true
  );
  // Claude-scoped: still blocked by its own family bucket.
  assert.equal(
    evaluateQuotaCutoff(mixed, undefined, {
      provider: FAMILY_PROVIDER,
      requestedModel: "claude-sonnet-4-5",
    }).proceed,
    false
  );
  // Group-scoped requests behave the same way.
  assert.equal(
    evaluateQuotaCutoff(mixed, undefined, {
      provider: FAMILY_PROVIDER,
      requestedModel: `qtSd/${GROUP_SLUG}/${FAMILY_PROVIDER}/gemini-3-pro`,
    }).proceed,
    true
  );

  // When scoping leaves NOTHING to compare, the flag must still block —
  // dropping it would silently stop blocking an exhausted connection.
  const noComparableWindows: QuotaInfo = {
    used: 0,
    total: 0,
    percentUsed: 1,
    resetAt: null,
    windows: {},
    limitReached: true,
  };
  assert.equal(
    evaluateQuotaCutoff(noComparableWindows, undefined, {
      provider: FAMILY_PROVIDER,
      requestedModel: "gemini-3-pro",
    }).proceed,
    false
  );
});

test("preflightQuota derives exhaustion after scoping too (same limitReached handling)", async () => {
  const PROVIDER = "antigravity";
  registerQuotaFetcher(PROVIDER, async () => ({
    ...quota({
      "gemini-3-pro": { percentUsed: 0.1 },
      gemini_weekly: { percentUsed: 0.2 },
      claude_gpt_weekly: { percentUsed: 1 },
    }),
    percentUsed: 1,
    limitReached: true,
  }));
  const connection: Record<string, unknown> = {};

  const gemini = await preflightQuota(PROVIDER, "agy-limitreached", connection, undefined, {
    provider: PROVIDER,
    requestedModel: "gemini-3-pro",
  });
  assert.equal(gemini.proceed, true, "the direct path must not block on the Claude bucket");

  const claude = await preflightQuota(PROVIDER, "agy-limitreached", connection, undefined, {
    provider: PROVIDER,
    requestedModel: "claude-sonnet-4-5",
  });
  assert.equal(claude.proceed, false);

  // No scope → unchanged legacy behavior.
  const unscoped = await preflightQuota(PROVIDER, "agy-limitreached", connection);
  assert.equal(unscoped.proceed, false);
});

// ── 11. Forced scope-builder failure → fail-open to the raw comparison ────

test("a scope-builder failure falls back to the raw per-window comparison", async () => {
  const FAIL_GROUP_NAME = "Fail Open Group";
  const failGroup = quotaGroupsDb.createGroup(FAIL_GROUP_NAME);
  const primary = (await providersDb.createProviderConnection({
    provider: FAMILY_PROVIDER,
    authType: "apikey",
    name: "agy-failopen-primary",
    apiKey: "sk-agy-failopen-primary",
    isActive: true,
    testStatus: "active",
  })) as { id: string };
  const sibling = (await providersDb.createProviderConnection({
    provider: FAMILY_PROVIDER,
    authType: "apikey",
    name: "agy-failopen-sibling",
    apiKey: "sk-agy-failopen-sibling",
    isActive: true,
    testStatus: "active",
  })) as { id: string };
  quotaPoolsDb.createPool({
    connectionId: primary.id,
    connectionIds: [primary.id, sibling.id],
    name: "failopen-pool",
    groupId: failGroup.id,
  });

  // Force the DB-side builder to throw while reading the sibling's cached
  // facts — the one step in buildQuotaCutoffScope that is not internally
  // guarded (`cachedWindowsForConnection`).
  quotaCache.setQuotaCache(sibling.id, FAMILY_PROVIDER, {
    gemini_weekly: { remainingPercentage: 1, resetAt: null, total: 1000, used: 990 },
  });
  const siblingEntry = quotaCache.getQuotaCache(sibling.id);
  assert.ok(siblingEntry, "sibling quota cache entry must exist");
  Object.defineProperty(siblingEntry!, "quotas", {
    configurable: true,
    get() {
      throw new Error("forced scope-builder failure");
    },
  });

  const groupModel = quotaModelName(FAIL_GROUP_NAME, FAMILY_PROVIDER, "gemini-3-pro");
  await assert.rejects(
    () => buildQuotaCutoffScope(FAMILY_PROVIDER, groupModel, primary.id),
    /forced scope-builder failure/
  );

  const settings = {
    quotaPreflight: {
      enabled: true,
      defaultThresholdPercent: 2,
      warnThresholdPercent: 20,
      providerWindowDefaults: {},
    },
  } as unknown as ResilienceSettingsArg;
  const resetWindowConfig = resolveResetWindowConfig(null);

  // Healthy raw windows → the gate proceeds instead of erroring out.
  registerQuotaFetcher(FAMILY_PROVIDER, async () =>
    quota({ "gemini-3-pro": { percentUsed: 0.1 }, gemini_weekly: { percentUsed: 0.2 } })
  );
  const healthy = await resolveQuotaExhaustionCutoffForTarget(
    FAMILY_PROVIDER,
    primary.id,
    settings,
    resetWindowConfig,
    groupModel,
    noopLog(),
    groupModel
  );
  assert.equal(healthy.blocked, false, "a scope failure must never block routing");

  // Exhausted raw windows → the raw comparison is still enforced (fail-open is
  // "ignore the aggregation layer", not "ignore the cutoff").
  const exhaustedPrimary = (await providersDb.createProviderConnection({
    provider: FAMILY_PROVIDER,
    authType: "apikey",
    name: "agy-failopen-exhausted",
    apiKey: "sk-agy-failopen-exhausted",
    isActive: true,
    testStatus: "active",
  })) as { id: string };
  quotaPoolsDb.createPool({
    connectionId: exhaustedPrimary.id,
    connectionIds: [exhaustedPrimary.id, sibling.id],
    name: "failopen-pool-exhausted",
    groupId: failGroup.id,
  });
  const exhaustedQuota = quota({
    "gemini-3-pro": { percentUsed: 1 },
    gemini_weekly: { percentUsed: 1 },
  });
  registerQuotaFetcher(FAMILY_PROVIDER, async () => exhaustedQuota);
  const blocked = await resolveQuotaExhaustionCutoffForTarget(
    FAMILY_PROVIDER,
    exhaustedPrimary.id,
    settings,
    resetWindowConfig,
    groupModel,
    noopLog(),
    groupModel
  );
  assert.equal(blocked.blocked, true);
  // Same verdict the scope-less evaluator gives for that quota.
  assert.equal(
    evaluateQuotaCutoff(exhaustedQuota, buildAutoQuotaThresholds(FAMILY_PROVIDER, {}, settings))
      .proceed,
    false
  );

  // Restore the cache entry so later tests see a normal object.
  Object.defineProperty(siblingEntry!, "quotas", {
    configurable: true,
    enumerable: true,
    writable: true,
    value: {},
  });
});

// ── 12. Real combo dispatch wiring (per-target model, not the combo name) ──

test("handleComboChat scopes the per-target cutoff by the resolved target model", async () => {
  // A named combo's identifier carries NO family information. The per-target
  // cutoff must therefore classify by `ResolvedComboTarget.modelStr` — the
  // model actually dispatched upstream. Classifying by `combo.name` leaves the
  // request unscoped, and BOTH families' windows get evaluated, so the
  // exhausted Gemini bucket below would also block the Claude target.
  const connection = (await providersDb.createProviderConnection({
    provider: FAMILY_PROVIDER,
    authType: "apikey",
    name: "agy-combo-wiring",
    apiKey: "sk-agy-combo-wiring",
    isActive: true,
    testStatus: "active",
  })) as { id: string };

  registerQuotaFetcher(FAMILY_PROVIDER, async () =>
    quota({
      "gemini-3-pro": { percentUsed: 0.1 },
      gemini_weekly: { percentUsed: 1 },
      "claude-sonnet-4-5": { percentUsed: 0.1 },
      claude_gpt_weekly: { percentUsed: 0.1 },
    })
  );

  const settings = {
    resilienceSettings: {
      quotaPreflight: {
        enabled: true,
        defaultThresholdPercent: 2,
        warnThresholdPercent: 20,
        providerWindowDefaults: {},
      },
    },
  };

  const dispatch = async (comboName: string, model: string) => {
    const dispatched: string[] = [];
    const response = await handleComboChat({
      body: { model: comboName, messages: [{ role: "user", content: "hi" }] },
      combo: {
        name: comboName,
        strategy: "priority",
        models: [{ kind: "model", model, connectionId: connection.id }],
      },
      handleSingleModel: async (_body: unknown, modelStr: string) => {
        dispatched.push(modelStr);
        return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
      log: { info() {}, warn() {}, debug() {}, error() {} },
      settings,
    } as never);
    return { status: response.status, dispatched };
  };

  const gemini = await dispatch("agy-named-combo-gemini", `${FAMILY_PROVIDER}/gemini-3-pro`);
  assert.deepEqual(
    gemini.dispatched,
    [],
    "the Gemini target must be skipped by its own exhausted family bucket"
  );
  assert.notEqual(gemini.status, 200);

  const claude = await dispatch("agy-named-combo-claude", `${FAMILY_PROVIDER}/claude-sonnet-4-5`);
  assert.deepEqual(
    claude.dispatched,
    [`${FAMILY_PROVIDER}/claude-sonnet-4-5`],
    "the Claude target must dispatch — the exhausted Gemini bucket is another family"
  );
  assert.equal(claude.status, 200);
});
