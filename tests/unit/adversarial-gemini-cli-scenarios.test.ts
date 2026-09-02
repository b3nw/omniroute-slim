import test from "node:test";
import assert from "node:assert/strict";

import {
  normalizeTierName,
  isFreeTier,
  getTierFullName,
  extractProjectId,
  tryLoadCodeAssist,
  tryOnboardUser,
  scanGcpProjectsForCodeAssist,
  listFirstActiveGcpProject,
  discoverGeminiCliProjectAndTier,
  getGeminiCliAuthHeaders,
  clearGeminiCliProjectCache,
} from "../../open-sse/services/geminiCliDiscovery.ts";

import {
  parseGeminiCliQuotaResponse,
  fetchGeminiCliUsage,
  type GeminiCliQuotaResponse,
} from "../../open-sse/services/usage/gemini-cli.ts";

import {
  resolvePublicCred,
  resolvePublicCredMulti,
  decodePublicCred,
  decodePublicCredBytes,
} from "../../open-sse/utils/publicCreds.ts";

import { GEMINI_CLI_CONFIG } from "../../src/lib/oauth/constants/oauth.ts";
import { geminiCli } from "../../src/lib/oauth/providers/gemini-cli.ts";
import {
  sanitizeGeminiCliError,
  parseGeminiCliResetDuration,
} from "../../open-sse/executors/geminiCli.ts";

// ============================================================================
// CHALLENGE SCENARIO 1: Free-Tier Accounts 412 Prevention
// ============================================================================

test("Scenario 1: Free-Tier Accounts - cloudaicompanionProject and duetProject are strictly omitted in loadCodeAssist and onboardUser", async (t) => {
  clearGeminiCliProjectCache();

  // Test 1A: tryLoadCodeAssist without configured project
  const capturedRequests: Array<{ url: string; body: Record<string, unknown> }> = [];
  const mockFetch = (async (url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body || "{}")) as Record<string, unknown>;
    capturedRequests.push({ url, body });
    return new Response(
      JSON.stringify({
        currentTier: { id: "free-tier" },
        allowedTiers: [{ id: "free-tier", isDefault: true }],
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  }) as typeof fetch;

  const lcaResult = await tryLoadCodeAssist("mock-token-free", undefined, mockFetch);
  assert.ok(lcaResult);
  assert.equal(lcaResult.projectId, "");
  assert.equal(lcaResult.tierId, "free-tier");

  assert.equal(capturedRequests.length, 1);
  const lcaBody = capturedRequests[0].body;
  assert.equal(
    lcaBody.cloudaicompanionProject,
    undefined,
    "cloudaicompanionProject must not be sent"
  );
  const lcaMetadata = lcaBody.metadata as Record<string, unknown>;
  assert.ok(lcaMetadata);
  assert.equal(lcaMetadata.duetProject, undefined, "metadata.duetProject must not be sent");

  const lcaRawJson = JSON.stringify(lcaBody);
  assert.ok(
    !lcaRawJson.includes("cloudaicompanionProject"),
    "JSON string must not contain cloudaicompanionProject"
  );
  assert.ok(!lcaRawJson.includes("duetProject"), "JSON string must not contain duetProject");

  // Test 1B: tryOnboardUser with free tier (even if onboardProjectId was inadvertently supplied)
  capturedRequests.length = 0;
  const mockOnboardFetch = (async (url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body || "{}")) as Record<string, unknown>;
    capturedRequests.push({ url, body });
    return new Response(
      JSON.stringify({
        name: "operations/onboard-free-1",
        done: true,
        response: {
          cloudaicompanionProject: "free-proj-auto-assigned",
          currentTier: { id: "free-tier" },
        },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  }) as typeof fetch;

  const onboardResult = await tryOnboardUser(
    "mock-token-free",
    "free-tier",
    "should-be-omitted-for-free",
    mockOnboardFetch
  );
  assert.ok(onboardResult);
  assert.equal(onboardResult.projectId, "free-proj-auto-assigned");
  assert.equal(onboardResult.tierId, "free-tier");

  assert.equal(capturedRequests.length, 1);
  const onboardBody = capturedRequests[0].body;
  assert.equal(
    onboardBody.cloudaicompanionProject,
    undefined,
    "Free tier onboarding must omit cloudaicompanionProject"
  );
  const onboardMetadata = onboardBody.metadata as Record<string, unknown>;
  assert.equal(
    onboardMetadata.duetProject,
    undefined,
    "Free tier onboarding must omit metadata.duetProject"
  );

  const onboardRawJson = JSON.stringify(onboardBody);
  assert.ok(!onboardRawJson.includes("cloudaicompanionProject"));
  assert.ok(!onboardRawJson.includes("duetProject"));

  // Test 1C: Contrast with Paid tier (PRO) where project MUST be included
  capturedRequests.length = 0;
  const mockPaidOnboardFetch = (async (url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body || "{}")) as Record<string, unknown>;
    capturedRequests.push({ url, body });
    return new Response(
      JSON.stringify({
        name: "operations/onboard-paid-1",
        done: true,
        response: {
          cloudaicompanionProject: "my-paid-project",
          currentTier: { id: "g1-pro-tier" },
        },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  }) as typeof fetch;

  await tryOnboardUser("mock-token-paid", "g1-pro-tier", "my-paid-project", mockPaidOnboardFetch);
  assert.equal(capturedRequests.length, 1);
  const paidBody = capturedRequests[0].body;
  assert.equal(
    paidBody.cloudaicompanionProject,
    "my-paid-project",
    "Paid tier must include cloudaicompanionProject"
  );
  const paidMetadata = paidBody.metadata as Record<string, unknown>;
  assert.equal(
    paidMetadata.duetProject,
    "my-paid-project",
    "Paid tier must include metadata.duetProject"
  );
});

// ============================================================================
// CHALLENGE SCENARIO 2: Project Discovery Fallbacks
// ============================================================================

test("Scenario 2: Project Discovery Fallbacks - Empty loadCodeAssist -> CRM active projects -> Service Usage verification", async () => {
  clearGeminiCliProjectCache();

  const auditLog: string[] = [];

  const mockDiscoveryFetch = (async (url: string, init?: RequestInit) => {
    const urlStr = String(url);
    const bodyStr = String(init?.body || "");

    // 1. Initial loadCodeAssist: returns session with no project ID
    if (urlStr.includes(":loadCodeAssist") && !bodyStr.includes("crm-valid-project-99")) {
      auditLog.push("loadCodeAssist:initial_no_project");
      return new Response(
        JSON.stringify({
          currentTier: { id: "free-tier" },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    // 2. Cloud Resource Manager: returns active + inactive projects
    if (urlStr.includes("cloudresourcemanager.googleapis.com/v1/projects")) {
      auditLog.push("crm:list_projects");
      return new Response(
        JSON.stringify({
          projects: [
            { projectId: "deleted-project-1", lifecycleState: "DELETE_REQUESTED" },
            { projectId: "disabled-service-project", lifecycleState: "ACTIVE" },
            { projectId: "crm-valid-project-99", lifecycleState: "ACTIVE" },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    // 3. Service Usage: disabled-service-project has DISABLED service
    if (
      urlStr.includes("projects/disabled-service-project/services/cloudaicompanion.googleapis.com")
    ) {
      auditLog.push("serviceusage:disabled_service_project");
      return new Response(JSON.stringify({ state: "DISABLED" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    // 4. Service Usage: crm-valid-project-99 has ENABLED service
    if (urlStr.includes("projects/crm-valid-project-99/services/cloudaicompanion.googleapis.com")) {
      auditLog.push("serviceusage:crm_valid_project_99");
      return new Response(JSON.stringify({ state: "ENABLED" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    // 5. Verification probe with loadCodeAssist for crm-valid-project-99
    if (urlStr.includes(":loadCodeAssist") && bodyStr.includes("crm-valid-project-99")) {
      auditLog.push("loadCodeAssist:candidate_verified");
      return new Response(
        JSON.stringify({
          cloudaicompanionProject: "crm-valid-project-99",
          paidTier: { id: "g1-pro-tier" },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    return new Response("Not Found", { status: 404 });
  }) as typeof fetch;

  const result = await discoverGeminiCliProjectAndTier("test-token-crm-fallback", {
    fetchImpl: mockDiscoveryFetch,
  });

  assert.equal(result.projectId, "crm-valid-project-99");
  assert.equal(result.tier, "g1-pro-tier");
  assert.equal(result.tierCanonical, "PRO");
  assert.equal(result.tier_full, "Google One AI PRO");

  assert.ok(auditLog.includes("loadCodeAssist:initial_no_project"));
  assert.ok(auditLog.includes("crm:list_projects"));
  assert.ok(auditLog.includes("serviceusage:disabled_service_project"));
  assert.ok(auditLog.includes("serviceusage:crm_valid_project_99"));
  assert.ok(auditLog.includes("loadCodeAssist:candidate_verified"));
});

test("Scenario 2: Project Discovery Fallbacks - Disabled service usage falls through to tryOnboardUser", async () => {
  clearGeminiCliProjectCache();

  const auditLog: string[] = [];

  const mockDiscoveryFetch = (async (url: string, init?: RequestInit) => {
    const urlStr = String(url);

    if (urlStr.includes(":loadCodeAssist")) {
      auditLog.push("loadCodeAssist");
      return new Response(JSON.stringify({ currentTier: { id: "free-tier" } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (urlStr.includes("cloudresourcemanager.googleapis.com/v1/projects")) {
      auditLog.push("crm");
      return new Response(
        JSON.stringify({
          projects: [{ projectId: "all-disabled-proj", lifecycleState: "ACTIVE" }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    if (urlStr.includes("services/cloudaicompanion.googleapis.com")) {
      auditLog.push("serviceusage_disabled");
      return new Response(JSON.stringify({ state: "DISABLED" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (urlStr.includes(":onboardUser")) {
      auditLog.push("onboardUser");
      return new Response(
        JSON.stringify({
          name: "operations/op-123",
          done: true,
          response: {
            cloudaicompanionProject: "onboarded-project-fallback-777",
            currentTier: { id: "free-tier" },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    return new Response("Not Found", { status: 404 });
  }) as typeof fetch;

  const result = await discoverGeminiCliProjectAndTier("test-token-onboard-fallback", {
    fetchImpl: mockDiscoveryFetch,
  });

  assert.equal(result.projectId, "onboarded-project-fallback-777");
  assert.equal(result.tierCanonical, "FREE");
  assert.ok(auditLog.includes("loadCodeAssist"));
  assert.ok(auditLog.includes("crm"));
  assert.ok(auditLog.includes("serviceusage_disabled"));
  assert.ok(auditLog.includes("onboardUser"));
});

// ============================================================================
// CHALLENGE SCENARIO 3: Tier Normalization & Priority Hierarchy
// ============================================================================

test("Scenario 3: Tier Normalization - Priority Hierarchy paidTier.id > currentTier.id > allowedTiers[isDefault] > allowedTiers[0] > free-tier", async () => {
  // Test 3A: paidTier overrides currentTier
  const mockFetchPaidWins = (async () => {
    return new Response(
      JSON.stringify({
        cloudaicompanionProject: "proj-1",
        paidTier: { id: "g1-pro-tier" },
        currentTier: { id: "g1-ultra-tier" },
        allowedTiers: [{ id: "free-tier", isDefault: true }],
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  }) as typeof fetch;

  const resA = await tryLoadCodeAssist("token-1", undefined, mockFetchPaidWins);
  assert.equal(resA?.tierId, "g1-pro-tier");
  assert.equal(normalizeTierName(resA?.tierId), "PRO");

  // Test 3B: currentTier wins when paidTier is missing
  const mockFetchCurrentWins = (async () => {
    return new Response(
      JSON.stringify({
        cloudaicompanionProject: "proj-2",
        currentTier: { id: "gcp-enterprise-tier" },
        allowedTiers: [{ id: "free-tier", isDefault: true }],
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  }) as typeof fetch;

  const resB = await tryLoadCodeAssist("token-2", undefined, mockFetchCurrentWins);
  assert.equal(resB?.tierId, "gcp-enterprise-tier");
  assert.equal(normalizeTierName(resB?.tierId), "ULTRA");

  // Test 3C: allowedTiers[isDefault] wins when paidTier and currentTier are missing
  const mockFetchDefaultAllowedWins = (async () => {
    return new Response(
      JSON.stringify({
        cloudaicompanionProject: "proj-3",
        allowedTiers: [
          { id: "free-tier", isDefault: false },
          { id: "g1-ultra-tier", isDefault: true },
        ],
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  }) as typeof fetch;

  const resC = await tryLoadCodeAssist("token-3", undefined, mockFetchDefaultAllowedWins);
  assert.equal(resC?.tierId, "g1-ultra-tier");
  assert.equal(normalizeTierName(resC?.tierId), "ULTRA");

  // Test 3D: allowedTiers[0] wins when isDefault is missing
  const mockFetchFirstAllowedWins = (async () => {
    return new Response(
      JSON.stringify({
        cloudaicompanionProject: "proj-4",
        allowedTiers: [{ id: "gemini-code-assist-pro" }, { id: "free-tier" }],
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  }) as typeof fetch;

  const resD = await tryLoadCodeAssist("token-4", undefined, mockFetchFirstAllowedWins);
  assert.equal(resD?.tierId, "gemini-code-assist-pro");
  assert.equal(normalizeTierName(resD?.tierId), "PRO");

  // Test 3E: Complete fallback to free-tier
  const mockFetchEmptyFallback = (async () => {
    return new Response(JSON.stringify({}), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;

  const resE = await tryLoadCodeAssist("token-5", undefined, mockFetchEmptyFallback);
  assert.equal(resE?.tierId, "free-tier");
  assert.equal(normalizeTierName(resE?.tierId), "FREE");
});

test("Scenario 3: Tier Normalization - Canonical Tier Mapping Matrix & Graceful Defaults", () => {
  // ULTRA Matrix
  const ultraTiers = [
    "g1-ultra-tier",
    "gcp-enterprise-tier",
    "enterprise-tier",
    "ultra-tier",
    "gemini-code-assist-ultra",
    "ultra",
    "G1-ULTRA-TIER",
    "  ultra-tier  ",
  ];
  for (const t of ultraTiers) {
    assert.equal(normalizeTierName(t), "ULTRA", `Expected ${t} -> ULTRA`);
    assert.equal(isFreeTier(t), false);
  }

  // PRO Matrix
  const proTiers = [
    "g1-pro-tier",
    "gcp-standard-tier",
    "gemini-code-assist-pro",
    "standard-tier",
    "pro-tier",
    "pro",
    "G1-PRO-TIER",
    "  pro-tier  ",
  ];
  for (const t of proTiers) {
    assert.equal(normalizeTierName(t), "PRO", `Expected ${t} -> PRO`);
    assert.equal(isFreeTier(t), false);
  }

  // FREE Matrix
  const freeTiers = [
    "g1-free-tier",
    "gcp-free-tier",
    "free-tier",
    "legacy-tier",
    "gemini-code-assist-free",
    "free",
    null,
    undefined,
    "",
    "   ",
  ];
  for (const t of freeTiers) {
    assert.equal(normalizeTierName(t), "FREE", `Expected ${t} -> FREE`);
    assert.equal(isFreeTier(t), true);
  }

  // Unclassified / Unknown Tiers -> MUST default to FREE
  const unclassifiedTiers = [
    "unknown-custom-tier",
    "experimental-tier-2026",
    "beta-trial-x",
    "random_garbage_string",
  ];
  for (const t of unclassifiedTiers) {
    assert.equal(normalizeTierName(t), "FREE", `Unclassified ${t} must default to FREE`);
    assert.equal(isFreeTier(t), true);
    assert.equal(getTierFullName(t), "FREE");
  }

  // Full name mapping checks
  assert.equal(getTierFullName("g1-ultra-tier"), "Google One AI ULTRA");
  assert.equal(getTierFullName("g1-pro-tier"), "Google One AI PRO");
  assert.equal(getTierFullName("gcp-enterprise-tier"), "Code Assist Enterprise");
  assert.equal(getTierFullName("gcp-standard-tier"), "Code Assist Standard");
  assert.equal(getTierFullName("free-tier"), "FREE");
});

// ============================================================================
// CHALLENGE SCENARIO 4: Quota Cost Calculations & Corrupted Payload Resilience
// ============================================================================

test("Scenario 4: Quota Cost Calculations - Tier Max RPD and Cost per Request Percent ($100 / RPD)", () => {
  // ULTRA Tier: 2000 RPD -> 100 / 2000 = 0.05%
  const ultraSnap = parseGeminiCliQuotaResponse({}, "ULTRA");
  assert.equal(ultraSnap.tier, "ULTRA");
  assert.equal(ultraSnap.tierMaxRpd, 2000);
  assert.equal(ultraSnap.costPerRequestPercent, 0.05);

  // PRO Tier: 1500 RPD -> 100 / 1500 = 0.06666666666666667%
  const proSnap = parseGeminiCliQuotaResponse({}, "PRO");
  assert.equal(proSnap.tier, "PRO");
  assert.equal(proSnap.tierMaxRpd, 1500);
  assert.ok(Math.abs(proSnap.costPerRequestPercent - 100 / 1500) < 1e-9);

  // FREE Tier: 1000 RPD -> 100 / 1000 = 0.1%
  const freeSnap = parseGeminiCliQuotaResponse({}, "FREE");
  assert.equal(freeSnap.tier, "FREE");
  assert.equal(freeSnap.tierMaxRpd, 1000);
  assert.equal(freeSnap.costPerRequestPercent, 0.1);
});

test("Scenario 4: Quota Payload Parsing - Valid, Fractional, and Snake_Case Buckets", () => {
  const payload: GeminiCliQuotaResponse = {
    buckets: [
      {
        modelId: "gemini-3-flash",
        remainingFraction: 0.75,
        resetTime: "2026-08-27T12:00:00Z",
      },
      {
        model_id: "gemini-2.5-pro",
        remaining_fraction: 0.5,
        reset_time: "2026-08-27T18:00:00Z",
      },
    ],
  };

  const snap = parseGeminiCliQuotaResponse(payload, "PRO");
  assert.equal(snap.models["gemini-3-flash"].remainingFraction, 0.75);
  assert.equal(snap.models["gemini-2.5-pro"].remainingFraction, 0.5);

  // Check quota structure for PRO (1500 total)
  const qFlash = snap.quotas["gemini-3-flash"];
  assert.equal(qFlash.total, 1500);
  assert.equal(qFlash.remaining, 1125); // 1500 * 0.75
  assert.equal(qFlash.used, 375); // 1500 - 1125
  assert.equal(qFlash.remainingPercentage, 75);
  assert.equal(qFlash.fractionReported, true);

  const qPro = snap.quotas["gemini-2.5-pro"];
  assert.equal(qPro.total, 1500);
  assert.equal(qPro.remaining, 750); // 1500 * 0.5
  assert.equal(qPro.used, 750);
  assert.equal(qPro.remainingPercentage, 50);
});

test("Scenario 4: Quota Payload Parsing - Adversarially Corrupted & Boundary Payloads", () => {
  // Case A: Negative remaining fraction -> clamped to 0
  const negPayload: GeminiCliQuotaResponse = {
    buckets: [{ modelId: "gemini-3-flash", remainingFraction: -0.25 }],
  };
  const snapA = parseGeminiCliQuotaResponse(negPayload, "FREE");
  assert.equal(snapA.models["gemini-3-flash"].remainingFraction, 0);
  assert.equal(snapA.quotas["gemini-3-flash"].remaining, 0);
  assert.equal(snapA.quotas["gemini-3-flash"].used, 1000);
  assert.equal(snapA.quotas["gemini-3-flash"].remainingPercentage, 0);

  // Case B: Overflow remaining fraction (> 1.0) -> clamped to 1.0
  const overflowPayload: GeminiCliQuotaResponse = {
    buckets: [{ modelId: "gemini-3-flash", remainingFraction: 1.85 }],
  };
  const snapB = parseGeminiCliQuotaResponse(overflowPayload, "ULTRA");
  assert.equal(snapB.models["gemini-3-flash"].remainingFraction, 1.0);
  assert.equal(snapB.quotas["gemini-3-flash"].remaining, 2000);
  assert.equal(snapB.quotas["gemini-3-flash"].used, 0);
  assert.equal(snapB.quotas["gemini-3-flash"].remainingPercentage, 100);

  // Case C: Missing remainingFraction -> defaults to 1.0
  const missingFracPayload: GeminiCliQuotaResponse = {
    buckets: [{ modelId: "gemini-3-flash" }],
  };
  const snapC = parseGeminiCliQuotaResponse(missingFracPayload, "PRO");
  assert.equal(snapC.models["gemini-3-flash"].remainingFraction, 1.0);
  assert.equal(snapC.quotas["gemini-3-flash"].fractionReported, false);

  // Case D: Empty / malformed buckets (missing modelId or empty bucket objects)
  const malformedPayload: GeminiCliQuotaResponse = {
    buckets: [
      {} as unknown as Record<string, unknown>,
      { remainingFraction: 0.5 },
      { modelId: "" },
    ],
  };
  const snapD = parseGeminiCliQuotaResponse(malformedPayload, "PRO");
  assert.deepEqual(snapD.models, {});
  assert.deepEqual(snapD.quotas, {});

  // Case E: Reset Duration parsing under compound and embedded strings
  assert.equal(parseGeminiCliResetDuration("2s"), 2000);
  assert.equal(parseGeminiCliResetDuration("156h14m36.73s"), 562476730);
  assert.equal(parseGeminiCliResetDuration("quota will reset after 42m10s"), 2530000);
  assert.equal(parseGeminiCliResetDuration("quota will reset after 156h14m36.73s"), 562476730);
  assert.equal(parseGeminiCliResetDuration(null), null);
  assert.equal(parseGeminiCliResetDuration(""), null);
});

// ============================================================================
// CHALLENGE SCENARIO 5: Public Credentials & Error Sanitization
// ============================================================================

test("Scenario 5: Public Credentials Validation - Zero Plaintext Client IDs or Secrets Leaked", () => {
  // Verify GEMINI_CLI_CONFIG uses resolvePublicCred without hardcoded plaintexts
  assert.ok(GEMINI_CLI_CONFIG.clientId);
  assert.ok(GEMINI_CLI_CONFIG.clientSecret);

  // Verify decoded values match Google OAuth format patterns
  assert.match(
    GEMINI_CLI_CONFIG.clientId,
    /^[0-9]+-[a-z0-9]+\.apps\.googleusercontent\.com$/,
    "clientId must conform to Google OAuth Client ID pattern"
  );
  assert.match(
    GEMINI_CLI_CONFIG.clientSecret,
    /^GOCSPX-[a-zA-Z0-9_-]+$/,
    "clientSecret must conform to Google OAuth Client Secret pattern"
  );

  // Verify XOR unmasking mechanism
  const decodedId = resolvePublicCred("gemini_id");
  const decodedSecret = resolvePublicCred("gemini_alt");
  assert.equal(GEMINI_CLI_CONFIG.clientId, decodedId);
  assert.equal(GEMINI_CLI_CONFIG.clientSecret, decodedSecret);

  // Error Sanitizer Security Verification (CWE-209 / ERROR_SANITIZATION.md)
  const rawLeakError = `Error: 400 Bad Request at /home/b3nw/projects/OmniRoute/src/secret_handler.ts:42:15
    Authorization: Bearer ya29.a0AfH6SMDxyz123456789
    Client Secret: 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
    File: C:\\Users\\Administrator\\AppData\\Local\\Temp\\debug.log`;

  const sanitized = sanitizeGeminiCliError(rawLeakError);
  // Must be single line (drops stack trace)
  assert.ok(!sanitized.includes("\n"), "Must drop multiline stack traces");
  // Must replace file paths
  assert.ok(!sanitized.includes("/home/b3nw"), "Must strip POSIX file path");
  assert.ok(!sanitized.includes("C:\\Users"), "Must strip Windows file path");
  // Must redact bearer tokens & secrets
  assert.ok(!sanitized.includes("ya29.a0AfH6SMDxyz123456789"), "Must redact OAuth token");
  assert.ok(!sanitized.includes("GOCSPX-4uHgMPm"), "Must redact OAuth client secret");
});

test("Scenario 5: OAuth Provider Registration & Factory Validation", () => {
  assert.ok(geminiCli);
  assert.equal(geminiCli.flowType, "authorization_code_pkce");
  assert.equal(geminiCli.supportsBrowserPkce, true);
  assert.equal(typeof geminiCli.buildAuthUrl, "function");
  assert.equal(typeof geminiCli.exchangeToken, "function");
  assert.equal(typeof geminiCli.mapTokens, "function");

  const mapped = geminiCli.mapTokens(
    { access_token: "tok-1", refresh_token: "ref-1", expires_in: 3600, scope: "cloud-platform" },
    {
      projectId: "proj-map-test",
      tier: "g1-ultra-tier",
      tierCanonical: "ULTRA",
      tier_full: "Google One AI ULTRA",
      userInfo: { email: "user@example.com" },
    }
  );

  assert.equal(mapped.accessToken, "tok-1");
  assert.equal(mapped.refreshToken, "ref-1");
  assert.equal(mapped.email, "user@example.com");
  assert.equal(mapped.projectId, "proj-map-test");
  assert.equal(mapped.providerSpecificData.clientProfile, "cli");
  assert.equal(mapped.providerSpecificData.tierCanonical, "ULTRA");
  assert.equal(mapped.providerSpecificData.tier_full, "Google One AI ULTRA");
});
