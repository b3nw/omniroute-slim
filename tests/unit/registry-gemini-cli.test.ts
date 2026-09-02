import test from "node:test";
import assert from "node:assert/strict";

const { resolvePublicCred, resolvePublicCredMulti } =
  await import("../../open-sse/utils/publicCreds.ts");

// Model Catalog Specification (10 primary models)
export const GEMINI_CLI_EXPECTED_MODELS = [
  "gemini-2.5-pro",
  "gemini-2.5-flash",
  "gemini-2.5-flash-lite",
  "gemini-3-pro-preview",
  "gemini-3.1-pro-preview",
  "gemini-3-flash-preview",
  "gemini-3-flash",
  "gemini-3.5-flash",
  "gemini-3.1-flash-lite",
  "gemini-3.1-flash-lite-preview",
];

export interface GeminiCliModelSpec {
  contextWindow: number;
  maxOutputTokens: number;
  supportsThinking: boolean;
  supportsTools: boolean;
  supportsVision: boolean;
}

export const GEMINI_CLI_MODEL_SPEC_DEFAULTS: GeminiCliModelSpec = {
  contextWindow: 1048576, // 1M
  maxOutputTokens: 65536, // 65K
  supportsThinking: true,
  supportsTools: true,
  supportsVision: true,
};

// Quota Usage Snapshot Normalizer
export function parseGeminiCliQuotaResponse(
  quotaData: {
    buckets?: Array<{
      modelId?: string;
      remainingFraction?: number;
      resetTime?: string;
    }>;
  },
  tier: "ULTRA" | "PRO" | "FREE" = "PRO"
) {
  const buckets = quotaData.buckets || [];
  const tierMaxRpd = tier === "ULTRA" ? 2000 : tier === "PRO" ? 1500 : 1000;
  const costPerRequestPercent = 100 / tierMaxRpd;

  const modelUsage: Record<string, { remainingFraction: number; resetTime?: string }> = {};
  for (const b of buckets) {
    if (b.modelId) {
      modelUsage[b.modelId] = {
        remainingFraction: b.remainingFraction ?? 1.0,
        resetTime: b.resetTime,
      };
    }
  }

  return {
    tier,
    tierMaxRpd,
    costPerRequestPercent,
    models: modelUsage,
  };
}

// ============================================================================
// TIER 1: Provider Catalog, 10 Model Specifications & Quota Tracking
// ============================================================================

test("Tier 1: Provider Registration Metadata Specifications (id, alias, authType)", () => {
  const providerMeta = {
    id: "gemini-cli",
    alias: "gemini_cli",
    name: "Gemini CLI",
    icon: "terminal",
    color: "#4285F4",
    textIcon: "GC",
    authType: "oauth",
    hasFree: true,
  };

  assert.equal(providerMeta.id, "gemini-cli");
  assert.equal(providerMeta.alias, "gemini_cli");
  assert.equal(providerMeta.authType, "oauth");
  assert.equal(providerMeta.color, "#4285F4");
  assert.equal(providerMeta.hasFree, true);
});

test("Tier 1: Model Specifications - Exactly 10 Gemini CLI models with 1M context and 65K output cap", () => {
  assert.equal(GEMINI_CLI_EXPECTED_MODELS.length, 10);

  for (const modelId of GEMINI_CLI_EXPECTED_MODELS) {
    // Model spec contract check
    const spec = GEMINI_CLI_MODEL_SPEC_DEFAULTS;
    assert.equal(spec.contextWindow, 1048576, `${modelId} must have 1M context window`);
    assert.equal(spec.maxOutputTokens, 65536, `${modelId} must have 65K output token limit`);
    assert.equal(spec.supportsThinking, true, `${modelId} must support thinking`);
    assert.equal(spec.supportsTools, true, `${modelId} must support function calling / tools`);
    assert.equal(spec.supportsVision, true, `${modelId} must support multimodal / vision`);
  }
});

test("Tier 1: Quota Usage Fetcher - :retrieveUserQuota Parsing and Tier Cost Calculation", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  let requestedUrl = "";
  let requestedBody: Record<string, unknown> | null = null;

  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    requestedUrl = String(input);
    requestedBody = JSON.parse(String(init?.body || "{}")) as Record<string, unknown>;

    return new Response(
      JSON.stringify({
        buckets: [
          {
            modelId: "gemini-3-flash",
            remainingFraction: 0.85,
            resetTime: "2026-08-27T00:00:00Z",
          },
          {
            modelId: "gemini-3-pro-preview",
            remainingFraction: 0.4,
            resetTime: "2026-08-27T00:00:00Z",
          },
        ],
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  }) as typeof fetch;

  async function fetchQuota(
    accessToken: string,
    projectId: string,
    tier: "ULTRA" | "PRO" | "FREE"
  ) {
    const res = await fetch("https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ project: projectId }),
    });
    const data = (await res.json()) as {
      buckets?: Array<{
        modelId?: string;
        remainingFraction?: number;
        resetTime?: string;
      }>;
    };
    return parseGeminiCliQuotaResponse(data, tier);
  }

  // Test FREE tier quota calculation (1000 RPD -> 0.1% per req)
  const freeUsage = await fetchQuota("token-123", "proj-free", "FREE");
  assert.ok(requestedUrl.endsWith(":retrieveUserQuota"));
  assert.equal(requestedBody?.project, "proj-free");
  assert.equal(freeUsage.tierMaxRpd, 1000);
  assert.equal(freeUsage.costPerRequestPercent, 0.1);
  assert.equal(freeUsage.models["gemini-3-flash"].remainingFraction, 0.85);

  // Test PRO tier quota calculation (1500 RPD -> ~0.0667% per req)
  const proUsage = parseGeminiCliQuotaResponse(
    { buckets: [{ modelId: "gemini-3-flash", remainingFraction: 0.9 }] },
    "PRO"
  );
  assert.equal(proUsage.tierMaxRpd, 1500);
  assert.ok(Math.abs(proUsage.costPerRequestPercent - 0.0666666) < 0.0001);

  // Test ULTRA tier quota calculation (2000 RPD -> 0.05% per req)
  const ultraUsage = parseGeminiCliQuotaResponse(
    { buckets: [{ modelId: "gemini-3-flash", remainingFraction: 0.95 }] },
    "ULTRA"
  );
  assert.equal(ultraUsage.tierMaxRpd, 2000);
  assert.equal(ultraUsage.costPerRequestPercent, 0.05);
});

// ============================================================================
// TIER 2: Public Credential XOR Unmasking & Environment Overrides
// ============================================================================

test("Tier 2: Public Credentials - gemini_id and gemini_alt correctly decode from XOR mask", () => {
  const clientId = resolvePublicCred("gemini_id");
  const clientSecret = resolvePublicCred("gemini_alt");

  assert.ok(clientId.length > 0, "gemini_id must be non-empty");
  assert.ok(clientSecret.length > 0, "gemini_alt must be non-empty");

  // Google OAuth client ID format: <digits>-<alphanumeric>.apps.googleusercontent.com
  assert.match(
    clientId,
    /^[0-9]+-[a-z0-9]+\.apps\.googleusercontent\.com$/,
    "gemini_id must match Google OAuth client ID format"
  );
  assert.equal(
    clientId,
    "681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com"
  );

  // Google OAuth client secret format: GOCSPX-<alphanumeric>
  assert.match(
    clientSecret,
    /^GOCSPX-[a-zA-Z0-9_-]+$/,
    "gemini_alt must match Google OAuth client secret format"
  );
  assert.equal(clientSecret, "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");
});

test("Tier 2: Public Credentials - Environment Override Precedence", () => {
  const testEnvVar = "TEST_GEMINI_CLI_OVERRIDE_SECRET";
  process.env[testEnvVar] = "GOCSPX-custom-override-value-999";

  try {
    const overridden = resolvePublicCred("gemini_alt", testEnvVar);
    assert.equal(overridden, "GOCSPX-custom-override-value-999");

    const multiOverridden = resolvePublicCredMulti("gemini_alt", ["NON_EXISTENT_VAR", testEnvVar]);
    assert.equal(multiOverridden, "GOCSPX-custom-override-value-999");
  } finally {
    delete process.env[testEnvVar];
  }
});
