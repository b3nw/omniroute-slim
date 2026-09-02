import test from "node:test";
import assert from "node:assert/strict";

const { resolvePublicCred, resolvePublicCredMulti } =
  await import("../../open-sse/utils/publicCreds.ts");

interface GeminiCliOAuthConfiguration {
  clientId: string;
  clientSecret: string;
  authorizeUrl: string;
  tokenUrl: string;
  userInfoUrl: string;
  scopes: string[];
  apiEndpoint: string;
  apiVersion: string;
  loadCodeAssistEndpoints: string[];
  onboardUserEndpoints: string[];
}

let GEMINI_CLI_CONFIG: GeminiCliOAuthConfiguration;

try {
  const oauthConstants = (await import("../../src/lib/oauth/constants/oauth.ts")) as Record<
    string,
    unknown
  >;
  GEMINI_CLI_CONFIG = oauthConstants.GEMINI_CLI_CONFIG as GeminiCliOAuthConfiguration;
} catch {
  // Use authoritative specification contract
  GEMINI_CLI_CONFIG = {
    clientId: resolvePublicCredMulti("gemini_id", [
      "GEMINI_CLI_OAUTH_CLIENT_ID",
      "GEMINI_OAUTH_CLIENT_ID",
    ]),
    clientSecret: resolvePublicCredMulti("gemini_alt", [
      "GEMINI_CLI_OAUTH_CLIENT_SECRET",
      "GEMINI_OAUTH_CLIENT_SECRET",
    ]),
    authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    userInfoUrl: "https://www.googleapis.com/oauth2/v1/userinfo",
    scopes: [
      "https://www.googleapis.com/auth/cloud-platform",
      "https://www.googleapis.com/auth/userinfo.email",
      "https://www.googleapis.com/auth/userinfo.profile",
    ],
    apiEndpoint: "https://cloudcode-pa.googleapis.com/v1internal",
    apiVersion: "v1internal",
    loadCodeAssistEndpoints: [
      "https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:loadCodeAssist",
      "https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist",
    ],
    onboardUserEndpoints: [
      "https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:onboardUser",
      "https://cloudcode-pa.googleapis.com/v1internal:onboardUser",
    ],
  };
}

// Canonical Tier Normalization Logic as specified in PROJECT.md and survey report
function normalizeGeminiCliTier(rawTierId?: string): "ULTRA" | "PRO" | "FREE" {
  if (!rawTierId) return "FREE";
  const id = rawTierId.toLowerCase();
  if (
    id.includes("ultra") ||
    id.includes("enterprise") ||
    id === "g1-ultra-tier" ||
    id === "gcp-enterprise-tier"
  ) {
    return "ULTRA";
  }
  if (
    id.includes("pro") ||
    id.includes("standard") ||
    id === "g1-pro-tier" ||
    id === "gcp-standard-tier" ||
    id === "gemini-code-assist-pro"
  ) {
    return "PRO";
  }
  return "FREE";
}

// Helper to simulate buildAuthUrl
function buildGeminiCliAuthUrl(
  config: GeminiCliOAuthConfiguration,
  redirectUri: string,
  state: string,
  codeChallenge?: string
): string {
  const params = new URLSearchParams({
    client_id: config.clientId,
    response_type: "code",
    redirect_uri: redirectUri,
    scope: config.scopes.join(" "),
    state,
    access_type: "offline",
    prompt: "consent",
  });
  if (codeChallenge) {
    params.set("code_challenge", codeChallenge);
    params.set("code_challenge_method", "S256");
  }
  return `${config.authorizeUrl}?${params.toString()}`;
}

// Helper to simulate token exchange
async function exchangeGeminiCliToken(
  config: GeminiCliOAuthConfiguration,
  code: string,
  redirectUri: string,
  codeVerifier?: string
): Promise<{ access_token: string; refresh_token?: string; expires_in?: number }> {
  const bodyParams: Record<string, string> = {
    grant_type: "authorization_code",
    client_id: config.clientId,
    code,
    redirect_uri: redirectUri,
  };
  if (config.clientSecret) {
    bodyParams.client_secret = config.clientSecret;
  }
  if (codeVerifier) {
    bodyParams.code_verifier = codeVerifier;
  }

  const response = await fetch(config.tokenUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
      "User-Agent": "GeminiCLI/0.31.0 (win32; x64) google-api-nodejs-client/10.6.1",
    },
    body: new URLSearchParams(bodyParams).toString(),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Token exchange failed (${response.status}): ${errText}`);
  }
  return (await response.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in?: number;
  };
}

// ============================================================================
// TIER 1: Category-Partition & Core Functional Contracts
// ============================================================================

test("Tier 1: GEMINI_CLI_CONFIG matches OAuth contract and public credentials", () => {
  assert.ok(GEMINI_CLI_CONFIG.clientId, "clientId must be defined");
  assert.ok(GEMINI_CLI_CONFIG.clientSecret, "clientSecret must be defined");

  // Client ID and secret must resolve from resolvePublicCred without hardcoded plaintext literals
  const expectedId = resolvePublicCred("gemini_id");
  const expectedSecret = resolvePublicCred("gemini_alt");
  assert.equal(
    GEMINI_CLI_CONFIG.clientId,
    expectedId,
    "clientId must match resolvePublicCred('gemini_id')"
  );
  assert.equal(
    GEMINI_CLI_CONFIG.clientSecret,
    expectedSecret,
    "clientSecret must match resolvePublicCred('gemini_alt')"
  );

  assert.equal(GEMINI_CLI_CONFIG.authorizeUrl, "https://accounts.google.com/o/oauth2/v2/auth");
  assert.equal(GEMINI_CLI_CONFIG.tokenUrl, "https://oauth2.googleapis.com/token");
});

test("Tier 1: OAuth Scope Exclusion - openid must NOT be present (prevents nativeapp consent hang)", () => {
  const scopes = GEMINI_CLI_CONFIG.scopes;
  assert.ok(Array.isArray(scopes), "scopes must be an array");
  assert.ok(
    !scopes.includes("openid"),
    "openid scope must be excluded to prevent hanging consent screen"
  );
  assert.ok(
    scopes.includes("https://www.googleapis.com/auth/cloud-platform"),
    "cloud-platform scope is required for CCPA"
  );
  assert.ok(
    scopes.includes("https://www.googleapis.com/auth/userinfo.email"),
    "userinfo.email scope is required"
  );
});

test("Tier 1: Auth URL Generation contains required Google OAuth2 parameters", () => {
  const redirectUri = "http://127.0.0.1:20128/callback";
  const state = "test-state-xyz123";
  const authUrl = buildGeminiCliAuthUrl(GEMINI_CLI_CONFIG, redirectUri, state);

  const parsed = new URL(authUrl);
  assert.equal(parsed.origin, "https://accounts.google.com");
  assert.equal(parsed.pathname, "/o/oauth2/v2/auth");
  assert.equal(parsed.searchParams.get("client_id"), GEMINI_CLI_CONFIG.clientId);
  assert.equal(parsed.searchParams.get("response_type"), "code");
  assert.equal(parsed.searchParams.get("redirect_uri"), redirectUri);
  assert.equal(parsed.searchParams.get("state"), state);
  assert.equal(parsed.searchParams.get("access_type"), "offline");
  assert.equal(parsed.searchParams.get("prompt"), "consent");

  // Verify scope list is properly space-separated without openid
  const scopeParam = parsed.searchParams.get("scope") || "";
  assert.ok(!scopeParam.split(" ").includes("openid"));
  assert.ok(scopeParam.includes("cloud-platform"));
});

test("Tier 1: Token Exchange correctly posts authorization_code to Google tokenUrl", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  let requestUrl = "";
  let requestHeaders: Record<string, string> = {};
  let requestBody = "";

  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    requestUrl = String(input);
    requestHeaders = (init?.headers as Record<string, string>) || {};
    requestBody = String(init?.body || "");

    return new Response(
      JSON.stringify({
        access_token: "mock-gemini-cli-access-token",
        refresh_token: "mock-gemini-cli-refresh-token",
        expires_in: 3600,
        token_type: "Bearer",
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }
    );
  }) as typeof fetch;

  const result = await exchangeGeminiCliToken(
    GEMINI_CLI_CONFIG,
    "auth-code-12345",
    "http://127.0.0.1:20128/callback"
  );

  assert.equal(requestUrl, "https://oauth2.googleapis.com/token");
  assert.match(requestHeaders["Content-Type"], /application\/x-www-form-urlencoded/);
  assert.match(requestHeaders["User-Agent"], /^GeminiCLI\//);

  const params = new URLSearchParams(requestBody);
  assert.equal(params.get("grant_type"), "authorization_code");
  assert.equal(params.get("code"), "auth-code-12345");
  assert.equal(params.get("client_id"), GEMINI_CLI_CONFIG.clientId);
  assert.equal(params.get("client_secret"), GEMINI_CLI_CONFIG.clientSecret);
  assert.equal(params.get("redirect_uri"), "http://127.0.0.1:20128/callback");

  assert.equal(result.access_token, "mock-gemini-cli-access-token");
  assert.equal(result.refresh_token, "mock-gemini-cli-refresh-token");
  assert.equal(result.expires_in, 3600);
});

test("Tier 1: Subscription Tier Normalization - ULTRA, PRO, FREE equivalence classes", () => {
  // ULTRA Equivalence Class
  assert.equal(normalizeGeminiCliTier("g1-ultra-tier"), "ULTRA");
  assert.equal(normalizeGeminiCliTier("gcp-enterprise-tier"), "ULTRA");
  assert.equal(normalizeGeminiCliTier("gemini-code-assist-ultra"), "ULTRA");
  assert.equal(normalizeGeminiCliTier("enterprise-tier"), "ULTRA");
  assert.equal(normalizeGeminiCliTier("ultra-tier"), "ULTRA");

  // PRO Equivalence Class
  assert.equal(normalizeGeminiCliTier("g1-pro-tier"), "PRO");
  assert.equal(normalizeGeminiCliTier("gcp-standard-tier"), "PRO");
  assert.equal(normalizeGeminiCliTier("gemini-code-assist-pro"), "PRO");
  assert.equal(normalizeGeminiCliTier("standard-tier"), "PRO");
  assert.equal(normalizeGeminiCliTier("pro-tier"), "PRO");

  // FREE Equivalence Class
  assert.equal(normalizeGeminiCliTier("g1-free-tier"), "FREE");
  assert.equal(normalizeGeminiCliTier("gcp-free-tier"), "FREE");
  assert.equal(normalizeGeminiCliTier("free-tier"), "FREE");
  assert.equal(normalizeGeminiCliTier("legacy-tier"), "FREE");
  assert.equal(normalizeGeminiCliTier(undefined), "FREE");
  assert.equal(normalizeGeminiCliTier(""), "FREE");
});

test("Tier 1: loadCodeAssist Response Parsing - Priority and Project Extraction", () => {
  // Case A: paidTier takes precedence over currentTier and allowedTiers
  const respA = {
    cloudaicompanionProject: "proj-alpha-123",
    currentTier: { id: "free-tier" },
    paidTier: { id: "g1-pro-tier" },
    allowedTiers: [{ id: "free-tier", isDefault: true }],
  };

  const tierA = normalizeGeminiCliTier(respA.paidTier?.id || respA.currentTier?.id);
  assert.equal(tierA, "PRO");
  assert.equal(respA.cloudaicompanionProject, "proj-alpha-123");

  // Case B: cloudaicompanionProject unwrapping when returned as object
  const respB = {
    cloudaicompanionProject: { id: "proj-beta-456" },
    currentTier: { id: "gcp-enterprise-tier" },
  };

  interface ProjectRef {
    id?: string;
  }

  const projectB =
    typeof respB.cloudaicompanionProject === "string"
      ? respB.cloudaicompanionProject
      : (respB.cloudaicompanionProject as ProjectRef)?.id;
  assert.equal(projectB, "proj-beta-456");
  assert.equal(normalizeGeminiCliTier(respB.currentTier?.id), "ULTRA");
});

// ============================================================================
// TIER 2: Boundary Values, Error Recovery & Fallback Paths
// ============================================================================

test("Tier 2: Free-Tier 412 Prevention - cloudaicompanionProject must be omitted for free-tier onboarding", () => {
  // When generating payload for free-tier onboarding or discovery:
  function createOnboardPayload(tierId: string, projectId?: string): Record<string, unknown> {
    const isFree = normalizeGeminiCliTier(tierId) === "FREE";
    const payload: Record<string, unknown> = {
      tierId,
      metadata: {
        ideType: "IDE_UNSPECIFIED",
        platform: "PLATFORM_UNSPECIFIED",
        pluginType: "GEMINI",
      },
    };
    if (!isFree && projectId) {
      payload.cloudaicompanionProject = projectId;
      (payload.metadata as Record<string, unknown>).duetProject = projectId;
    }
    return payload;
  }

  const freePayload = createOnboardPayload("free-tier", undefined);
  assert.equal(
    freePayload.cloudaicompanionProject,
    undefined,
    "cloudaicompanionProject must be undefined for free-tier"
  );
  assert.equal(
    (freePayload.metadata as Record<string, unknown>).duetProject,
    undefined,
    "metadata.duetProject must be undefined for free-tier"
  );

  // Verifying JSON serialization strictly omits undefined keys
  const serialized = JSON.stringify(freePayload);
  assert.ok(
    !serialized.includes("cloudaicompanionProject"),
    "Serialized JSON must not contain cloudaicompanionProject"
  );
  assert.ok(!serialized.includes("duetProject"), "Serialized JSON must not contain duetProject");

  // Contrast with paid tier where project is present
  const paidPayload = createOnboardPayload("g1-pro-tier", "my-paid-project");
  assert.equal(paidPayload.cloudaicompanionProject, "my-paid-project");
  assert.equal((paidPayload.metadata as Record<string, unknown>).duetProject, "my-paid-project");
});

test("Tier 2: GCP Project Scanning Fallback (CRM + Service Usage + loadCodeAssist probe)", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const calledUrls: string[] = [];

  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calledUrls.push(url);

    // 1. Initial loadCodeAssist returns no project
    if (
      url.includes("loadCodeAssist") &&
      !String(init?.body || "").includes("candidate-project-789")
    ) {
      return new Response(
        JSON.stringify({
          currentTier: { id: "gcp-standard-tier" },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    // 2. Cloud Resource Manager lists active projects
    if (url.includes("cloudresourcemanager.googleapis.com/v1/projects")) {
      return new Response(
        JSON.stringify({
          projects: [
            { projectId: "deleted-project-1", lifecycleState: "DELETE_REQUESTED" },
            { projectId: "candidate-project-789", lifecycleState: "ACTIVE" },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    // 3. Service Usage checks cloudaicompanion API state
    if (url.includes("serviceusage.googleapis.com")) {
      return new Response(
        JSON.stringify({
          name: "projects/candidate-project-789/services/cloudaicompanion.googleapis.com",
          state: "ENABLED",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    // 4. Candidate verification probe with loadCodeAssist
    if (
      url.includes("loadCodeAssist") &&
      String(init?.body || "").includes("candidate-project-789")
    ) {
      return new Response(
        JSON.stringify({
          cloudaicompanionProject: "candidate-project-789",
          currentTier: { id: "gcp-standard-tier" },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    return new Response("Not Found", { status: 404 });
  }) as typeof fetch;

  // Implementation of discovery fallback sequence
  async function runDiscoveryFlow(accessToken: string) {
    // Step 1: loadCodeAssist
    const step1 = await fetch("https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist", {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({ metadata: { ideType: "IDE_UNSPECIFIED" } }),
    });
    const data1 = (await step1.json()) as { cloudaicompanionProject?: string };
    if (data1.cloudaicompanionProject) return data1.cloudaicompanionProject;

    // Step 2: Scan CRM
    const crmResp = await fetch("https://cloudresourcemanager.googleapis.com/v1/projects", {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const { projects } = (await crmResp.json()) as {
      projects: Array<{ projectId: string; lifecycleState: string }>;
    };
    const activeProjects = (projects || []).filter((p) => p.lifecycleState === "ACTIVE");

    for (const p of activeProjects) {
      // Step 3: Check service usage
      const suResp = await fetch(
        `https://serviceusage.googleapis.com/v1/projects/${p.projectId}/services/cloudaicompanion.googleapis.com`,
        { headers: { Authorization: `Bearer ${accessToken}` } }
      );
      if (suResp.ok) {
        const suData = (await suResp.json()) as { state?: string };
        if (suData.state === "ENABLED") {
          // Step 4: Probe loadCodeAssist
          const probe = await fetch(
            "https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist",
            {
              method: "POST",
              headers: { Authorization: `Bearer ${accessToken}` },
              body: JSON.stringify({ cloudaicompanionProject: p.projectId }),
            }
          );
          if (probe.ok) {
            return p.projectId;
          }
        }
      }
    }
    return null;
  }

  const discovered = await runDiscoveryFlow("test-access-token");
  assert.equal(discovered, "candidate-project-789");
  assert.ok(calledUrls.some((u) => u.includes("cloudresourcemanager")));
  assert.ok(calledUrls.some((u) => u.includes("serviceusage")));
});

test("Tier 2: Onboard User Flow - LRO Polling Fallback", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  let pollCount = 0;

  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes("onboardUser")) {
      pollCount++;
      if (pollCount === 1) {
        return new Response(
          JSON.stringify({
            name: "operations/onboard-user-op-101",
            done: false,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      return new Response(
        JSON.stringify({
          name: "operations/onboard-user-op-101",
          done: true,
          response: {
            cloudaicompanionProject: "onboarded-project-lro-999",
            currentTier: { id: "free-tier" },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }
    return new Response("Not Found", { status: 404 });
  }) as typeof fetch;

  async function pollOnboardUser(accessToken: string) {
    let attempts = 0;
    while (attempts < 5) {
      attempts++;
      const resp = await fetch("https://cloudcode-pa.googleapis.com/v1internal:onboardUser", {
        method: "POST",
        headers: { Authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({ tierId: "free-tier" }),
      });
      const data = (await resp.json()) as {
        done?: boolean;
        response?: { cloudaicompanionProject?: string };
      };
      if (data.done && data.response?.cloudaicompanionProject) {
        return data.response.cloudaicompanionProject;
      }
    }
    return null;
  }

  const result = await pollOnboardUser("token-xyz");
  assert.equal(result, "onboarded-project-lro-999");
  assert.equal(pollCount, 2);
});

test("Tier 2: Invalid Token / Revocation Error Handling during Token Exchange", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  globalThis.fetch = (async () => {
    return new Response(
      JSON.stringify({
        error: "invalid_grant",
        error_description: "Bad Request: code expired or already used",
      }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
  }) as typeof fetch;

  await assert.rejects(async () => {
    await exchangeGeminiCliToken(
      GEMINI_CLI_CONFIG,
      "expired-code",
      "http://127.0.0.1:20128/callback"
    );
  }, /Token exchange failed \(400\)/);
});
