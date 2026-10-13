/**
 * Gemini CLI codeassist.google.com copy/paste auth flow & tier re-probe.
 *
 * Production bug: the OAuth modal sent gemini-cli to a loopback redirect
 * (http://127.0.0.1:<port>/callback), which fails with "connection refused" on
 * remote servers. Upstream google/gemini-cli uses Google's hosted copy/paste page
 * (https://codeassist.google.com/authcode) with the same built-in client.
 *
 * Contract pinned here:
 *   1. The authorize route resolves gemini-cli / gemini_cli (built-in client) to
 *      the codeassist redirect; custom clients and Antigravity are unchanged.
 *   2. The auth URL and token exchange both carry that redirect_uri.
 *   3. OAuthModal goes straight to the paste-code input for that redirect.
 *   4. reprobeGeminiCliTierForProject / applyGeminiCliTierReprobe pick up the
 *      real tier once a project ID is configured, and respect a manual tier.
 *   5. Token-refresh project discovery never overwrites a manually pinned tier.
 *
 * Run: node --import tsx/esm --test tests/unit/gemini-cli-codeassist-auth.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  clearGeminiCliProjectCache,
  discoverGeminiCliProjectAndTier,
  reprobeGeminiCliTierForProject,
} from "../../open-sse/services/geminiCliDiscovery.ts";
import {
  GEMINI_CLI_CODE_ASSIST_REDIRECT_URI,
  GEMINI_CLI_CONFIG,
} from "../../src/lib/oauth/constants/oauth.ts";
import { generateAuthData, resolveBrowserOAuthRedirectUri } from "../../src/lib/oauth/providers.ts";
import { geminiCli } from "../../src/lib/oauth/providers/gemini-cli.ts";
import { applyGeminiCliTierReprobe } from "../../src/lib/oauth/geminiCliTierReprobe.ts";
import { applyGeminiCliTier } from "../../src/app/(dashboard)/dashboard/providers/[id]/components/modals/geminiCliTier.ts";
import { resolvePublicCred } from "../../open-sse/utils/publicCreds.ts";
import { getAccessToken } from "../../open-sse/services/tokenRefresh.ts";

const CODE_ASSIST = "https://codeassist.google.com/authcode";
const LOOPBACK = "http://127.0.0.1:20128/callback";

const here = dirname(fileURLToPath(import.meta.url));
const readSrc = (rel: string) => readFileSync(resolve(here, "../../src", rel), "utf8");

const originalFetch = globalThis.fetch;

function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

test.beforeEach(() => {
  clearGeminiCliProjectCache();
});

test.afterEach(() => {
  globalThis.fetch = originalFetch;
});

// ---------------------------------------------------------------------------
// 1. Redirect resolution
// ---------------------------------------------------------------------------

test("codeassist redirect constant matches upstream gemini-cli", () => {
  assert.equal(GEMINI_CLI_CODE_ASSIST_REDIRECT_URI, CODE_ASSIST);
  assert.equal(GEMINI_CLI_CONFIG.redirectUri, CODE_ASSIST);
});

test("built-in Gemini CLI client is upstream's public Code Assist client", () => {
  assert.equal(
    GEMINI_CLI_CONFIG.clientId,
    resolvePublicCred("gemini_id"),
    "gemini-cli must keep using the embedded google/gemini-cli client"
  );
  assert.match(
    GEMINI_CLI_CONFIG.clientId,
    /^681255809395-[a-z0-9]+\.apps\.googleusercontent\.com$/
  );
});

for (const provider of ["gemini-cli", "gemini_cli"]) {
  test(`${provider}: built-in client resolves loopback to codeassist redirect`, () => {
    assert.equal(resolveBrowserOAuthRedirectUri(provider, LOOPBACK, {}), CODE_ASSIST);
    // Even when a public base URL is configured — the built-in client only
    // allows loopback / codeassist redirects, never the dashboard origin.
    assert.equal(
      resolveBrowserOAuthRedirectUri(provider, LOOPBACK, {
        NEXT_PUBLIC_BASE_URL: "https://omniroute.example.com",
      }),
      CODE_ASSIST
    );
  });

  test(`${provider}: custom client keeps the public-callback upgrade`, () => {
    assert.equal(
      resolveBrowserOAuthRedirectUri(provider, LOOPBACK, {
        NEXT_PUBLIC_BASE_URL: "https://omniroute.example.com",
        GEMINI_CLI_OAUTH_CLIENT_ID: "custom-id.apps.googleusercontent.com",
        GEMINI_CLI_OAUTH_CLIENT_SECRET: "custom-secret",
      }),
      "https://omniroute.example.com/callback"
    );
  });
}

test("antigravity / agy keep the loopback redirect", () => {
  assert.equal(resolveBrowserOAuthRedirectUri("antigravity", LOOPBACK, {}), LOOPBACK);
  assert.equal(resolveBrowserOAuthRedirectUri("agy", LOOPBACK, {}), LOOPBACK);
});

// ---------------------------------------------------------------------------
// 2. Auth URL + token exchange
// ---------------------------------------------------------------------------

test("generateAuthData builds a PKCE auth URL with the codeassist redirect", () => {
  const redirectUri = resolveBrowserOAuthRedirectUri("gemini-cli", LOOPBACK, {});
  const authData = generateAuthData("gemini-cli", redirectUri);

  assert.equal(authData.redirectUri, CODE_ASSIST);
  assert.ok(authData.codeVerifier, "PKCE verifier must be returned for the exchange step");
  const url = new URL(String(authData.authUrl));
  assert.equal(url.origin + url.pathname, "https://accounts.google.com/o/oauth2/v2/auth");
  assert.equal(url.searchParams.get("redirect_uri"), CODE_ASSIST);
  assert.equal(url.searchParams.get("client_id"), resolvePublicCred("gemini_id"));
  assert.equal(url.searchParams.get("response_type"), "code");
  assert.equal(url.searchParams.get("access_type"), "offline");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(url.searchParams.get("code_challenge"), authData.codeChallenge);
  assert.equal(url.searchParams.get("state"), authData.state);
});

test("exchange sends the pasted code with the codeassist redirect_uri", async () => {
  let body: URLSearchParams | null = null;
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    assert.equal(String(url), "https://oauth2.googleapis.com/token");
    body = new URLSearchParams(String(init?.body));
    return jsonRes({ access_token: "ya29.test", refresh_token: "1//rt", expires_in: 3599 });
  }) as typeof fetch;

  const tokens = await geminiCli.exchangeToken(
    GEMINI_CLI_CONFIG,
    "4/0AVtest-code",
    CODE_ASSIST,
    "verifier-123"
  );

  assert.equal(tokens.access_token, "ya29.test");
  assert.ok(body);
  assert.equal(body.get("code"), "4/0AVtest-code");
  assert.equal(body.get("redirect_uri"), CODE_ASSIST);
  assert.equal(body.get("code_verifier"), "verifier-123");
  assert.equal(body.get("grant_type"), "authorization_code");
  assert.equal(body.get("client_id"), resolvePublicCred("gemini_id"));
  assert.equal(body.get("client_secret"), resolvePublicCred("gemini_alt"));
});

// ---------------------------------------------------------------------------
// 3. OAuthModal: paste-code mode
// ---------------------------------------------------------------------------

test("OAuthModal forces manual paste-code input for the codeassist redirect", () => {
  const src = readSrc("shared/components/OAuthModal.tsx");
  assert.match(
    src,
    /GEMINI_CLI_CODE_ASSIST_REDIRECT_URI = "https:\/\/codeassist\.google\.com\/authcode"/
  );
  assert.match(
    src,
    /if \(isCodeAssistPasteRedirect\(effectiveRedirectUri\)\) \{\s*forceManual = true;/
  );
  // The redirect returned by the authorize route (not the loopback the modal
  // requested) is what the exchange step must send back.
  assert.match(src, /setAuthData\(\{ \.\.\.data, redirectUri: effectiveRedirectUri \}\)/);
  // Loopback/SSH-tunnel guidance is wrong for the hosted page — suppressed.
  assert.match(src, /isCodeAssistPaste=\{isCodeAssistPasteRedirect\(authData\?\.redirectUri\)\}/);
});

test("manual panel explains the codeassist copy/paste step", () => {
  const src = readSrc("shared/components/OAuthModalPanels.tsx");
  assert.match(src, /isCodeAssistPaste \? \(/);
  assert.match(src, /t\.rich\("codeAssistPasteNotice"/);
  const en = JSON.parse(readSrc("i18n/messages/en.json")).oauthModal;
  assert.equal(
    en.codeAssistPastePlaceholder,
    "4/0A... (authorization code from codeassist.google.com)"
  );
});

// ---------------------------------------------------------------------------
// 4. Tier re-probe
// ---------------------------------------------------------------------------

function loadCodeAssistFetch(calls: Array<{ url: string; body: any }>, response: unknown) {
  return (async (url: unknown, init?: RequestInit) => {
    const u = String(url);
    calls.push({ url: u, body: init?.body ? JSON.parse(String(init.body)) : null });
    if (u.includes(":loadCodeAssist")) return jsonRes(response);
    return jsonRes({ error: "unexpected" }, 500);
  }) as typeof fetch;
}

test("reprobeGeminiCliTierForProject sends the project and returns the paid tier", async () => {
  const calls: Array<{ url: string; body: any }> = [];
  const fetchImpl = loadCodeAssistFetch(calls, {
    cloudaicompanionProject: "my-proj",
    currentTier: { id: "standard-tier" },
  });

  const result = await reprobeGeminiCliTierForProject("tok", "  my-proj  ", { fetchImpl });

  assert.deepEqual(result, {
    projectId: "my-proj",
    tier: "standard-tier",
    tierCanonical: "PRO",
    tier_full: "PRO",
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.cloudaicompanionProject, "my-proj");
  assert.equal(calls[0].body.metadata.duetProject, "my-proj");
});

test("reprobe prefers paidTier and refreshes the discovery cache", async () => {
  const fetchImpl = loadCodeAssistFetch([], {
    cloudaicompanionProject: "my-proj",
    currentTier: { id: "free-tier" },
    paidTier: { id: "g1-ultra-tier" },
  });

  const result = await reprobeGeminiCliTierForProject("tok-cache", "my-proj", { fetchImpl });
  assert.equal(result?.tierCanonical, "ULTRA");
  assert.equal(result?.tier_full, "Google One AI ULTRA");

  // discoverGeminiCliProjectAndTier now serves the fresh tier from cache
  // without hitting the network again.
  const cached = await discoverGeminiCliProjectAndTier("tok-cache", {
    projectId: "my-proj",
    fetchImpl: (async () => {
      throw new Error("must not refetch");
    }) as typeof fetch,
  });
  assert.equal(cached.tierCanonical, "ULTRA");
});

test("reprobe returns null on failure or missing inputs", async () => {
  const failing = (async () => jsonRes({ error: "denied" }, 403)) as typeof fetch;
  assert.equal(
    await reprobeGeminiCliTierForProject("tok", "my-proj", { fetchImpl: failing }),
    null
  );
  assert.equal(await reprobeGeminiCliTierForProject("tok", "   ", { fetchImpl: failing }), null);
  assert.equal(await reprobeGeminiCliTierForProject("", "my-proj", { fetchImpl: failing }), null);
});

const PRO_RESULT = {
  projectId: "my-proj",
  tier: "standard-tier",
  tierCanonical: "PRO" as const,
  tier_full: "PRO",
};

function freeTierConnection(overrides: Record<string, unknown> = {}) {
  return {
    provider: "gemini-cli",
    accessToken: "ya29.live",
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    projectId: null,
    providerSpecificData: { tier: "free-tier", tierCanonical: "FREE", tier_full: "FREE" },
    ...overrides,
  };
}

test("save with a new project ID re-probes and updates the tier fields", async () => {
  const probed: Array<[string, string]> = [];
  const updateData: Record<string, any> = {
    projectId: "my-proj",
    providerSpecificData: {
      tier: "free-tier",
      tierCanonical: "FREE",
      tier_full: "FREE",
      projectId: "my-proj",
      isProjectIdManual: true,
      isTierManual: false,
    },
  };

  const changed = await applyGeminiCliTierReprobe({
    existing: freeTierConnection(),
    updateData,
    reprobe: async (token, projectId) => {
      probed.push([token, projectId]);
      return PRO_RESULT;
    },
  });

  assert.equal(changed, true);
  assert.deepEqual(probed, [["ya29.live", "my-proj"]]);
  assert.equal(updateData.providerSpecificData.tier, "standard-tier");
  assert.equal(updateData.providerSpecificData.tierCanonical, "PRO");
  assert.equal(updateData.providerSpecificData.tier_full, "PRO");
});

test("gemini_cli alias is re-probed too", async () => {
  const updateData: Record<string, any> = {
    projectId: "my-proj",
    providerSpecificData: { tierCanonical: "FREE", projectId: "my-proj" },
  };
  const changed = await applyGeminiCliTierReprobe({
    existing: freeTierConnection({ provider: "gemini_cli" }),
    updateData,
    reprobe: async () => PRO_RESULT,
  });
  assert.equal(changed, true);
  assert.equal(updateData.providerSpecificData.tierCanonical, "PRO");
});

test("a manually pinned tier is never overwritten by the re-probe", async () => {
  const updateData: Record<string, any> = {
    projectId: "my-proj",
    providerSpecificData: {
      tier: "enterprise-tier",
      tierCanonical: "ULTRA",
      tier_full: "ULTRA",
      isTierManual: true,
    },
  };
  const changed = await applyGeminiCliTierReprobe({
    existing: freeTierConnection(),
    updateData,
    reprobe: async () => {
      throw new Error("must not probe");
    },
  });
  assert.equal(changed, false);
  assert.equal(updateData.providerSpecificData.tierCanonical, "ULTRA");
});

test("applyGeminiCliTierReprobe re-probes and populates providerSpecificData on project-only updateData", async () => {
  const probed: string[] = [];
  const updateData: Record<string, any> = { projectId: "my-proj" };
  const changed = await applyGeminiCliTierReprobe({
    existing: freeTierConnection(),
    updateData,
    reprobe: async (_token, projectId) => {
      probed.push(projectId);
      return PRO_RESULT;
    },
  });

  assert.equal(changed, true);
  assert.deepEqual(probed, ["my-proj"]);
  assert.equal(updateData.providerSpecificData.tier, "standard-tier");
  assert.equal(updateData.providerSpecificData.tierCanonical, "PRO");
  assert.equal(updateData.providerSpecificData.tier_full, "PRO");

  // A failed probe on a project-only update still flags the retry.
  const failedUpdate: Record<string, any> = { projectId: "my-proj" };
  assert.equal(
    await applyGeminiCliTierReprobe({
      existing: freeTierConnection(),
      updateData: failedUpdate,
      reprobe: async () => null,
    }),
    false
  );
  assert.equal(failedUpdate.providerSpecificData.pendingTierReprobe, true);
  assert.equal(failedUpdate.providerSpecificData.tierCanonical, "FREE");
});

test("applyGeminiCliTierReprobe preserves manual tier and skips probe on project-only updateData when isTierManual is true", async () => {
  const updateData: Record<string, any> = { projectId: "new-proj" };
  const changed = await applyGeminiCliTierReprobe({
    existing: freeTierConnection({
      projectId: "old-proj",
      providerSpecificData: {
        tier: "enterprise-tier",
        tierCanonical: "ULTRA",
        tier_full: "ULTRA",
        isTierManual: true,
      },
    }),
    updateData,
    reprobe: async () => {
      throw new Error("must not probe");
    },
  });
  assert.equal(changed, false);
  assert.equal(updateData.providerSpecificData.tierCanonical, "ULTRA");
  assert.equal(updateData.providerSpecificData.isTierManual, true);
  assert.equal(updateData.providerSpecificData.pendingTierReprobe, undefined);
});

test("re-probe is skipped without a project, without a live token, or for other providers", async () => {
  const neverProbe = async () => {
    throw new Error("must not probe");
  };
  const psd = () => ({ providerSpecificData: { tierCanonical: "FREE" } });

  assert.equal(
    await applyGeminiCliTierReprobe({
      existing: freeTierConnection(),
      updateData: { projectId: null, ...psd() },
      reprobe: neverProbe,
    }),
    false
  );
  assert.equal(
    await applyGeminiCliTierReprobe({
      existing: freeTierConnection({ expiresAt: new Date(Date.now() - 1000).toISOString() }),
      updateData: { projectId: "my-proj", ...psd() },
      reprobe: neverProbe,
    }),
    false
  );
  assert.equal(
    await applyGeminiCliTierReprobe({
      existing: freeTierConnection({ accessToken: "" }),
      updateData: { projectId: "my-proj", ...psd() },
      reprobe: neverProbe,
    }),
    false
  );
  assert.equal(
    await applyGeminiCliTierReprobe({
      existing: freeTierConnection({ provider: "antigravity" }),
      updateData: { projectId: "my-proj", ...psd() },
      reprobe: neverProbe,
    }),
    false
  );
});

test("unchanged project with an already-paid discovered tier is not re-probed", async () => {
  const updateData: Record<string, any> = {
    projectId: "my-proj",
    providerSpecificData: { tierCanonical: "PRO", projectId: "my-proj", isTierManual: false },
  };
  const changed = await applyGeminiCliTierReprobe({
    existing: freeTierConnection({
      projectId: "my-proj",
      providerSpecificData: { tierCanonical: "PRO", projectId: "my-proj" },
    }),
    updateData,
    reprobe: async () => {
      throw new Error("must not probe");
    },
  });
  assert.equal(changed, false);
});

test("switching from a manual tier back to auto re-probes", async () => {
  const updateData: Record<string, any> = {
    projectId: "my-proj",
    providerSpecificData: { tierCanonical: "PRO", projectId: "my-proj", isTierManual: false },
  };
  const changed = await applyGeminiCliTierReprobe({
    existing: freeTierConnection({
      projectId: "my-proj",
      providerSpecificData: { tierCanonical: "PRO", projectId: "my-proj", isTierManual: true },
    }),
    updateData,
    reprobe: async () => ({ ...PRO_RESULT, tier: "g1-ultra-tier", tierCanonical: "ULTRA" }),
  });
  assert.equal(changed, true);
  assert.equal(updateData.providerSpecificData.tierCanonical, "ULTRA");
});

test("a failed re-probe keeps the stored tier and does not throw", async () => {
  const updateData: Record<string, any> = {
    projectId: "my-proj",
    providerSpecificData: { tier: "free-tier", tierCanonical: "FREE", tier_full: "FREE" },
  };
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    assert.equal(
      await applyGeminiCliTierReprobe({
        existing: freeTierConnection(),
        updateData,
        reprobe: async () => {
          throw new Error("network down");
        },
      }),
      false
    );
    assert.equal(
      await applyGeminiCliTierReprobe({
        existing: freeTierConnection(),
        updateData,
        reprobe: async () => null,
      }),
      false
    );
  } finally {
    console.warn = originalWarn;
  }
  assert.equal(updateData.providerSpecificData.tierCanonical, "FREE");
});

test("PUT /api/providers/[id] runs the re-probe before persisting", () => {
  const src = readSrc("app/api/providers/[id]/route.ts");
  const probeIdx = src.indexOf("await applyGeminiCliTierReprobe({");
  const persistIdx = src.indexOf("await updateProviderConnection(id, updateData);");
  assert.ok(probeIdx > 0, "route must call applyGeminiCliTierReprobe");
  assert.ok(probeIdx < persistIdx, "re-probe must run before the DB write");
});

test("applyGeminiCliTierReprobe sets pendingTierReprobe: true when switching to auto if probe fails or token expired", async () => {
  const pinnedPro = {
    projectId: "my-proj",
    providerSpecificData: {
      tier: "standard-tier",
      tierCanonical: "PRO",
      tier_full: "PRO",
      projectId: "my-proj",
      isTierManual: true,
    },
  };
  const autoUpdate = () => ({
    projectId: "my-proj",
    providerSpecificData: {
      tier: "standard-tier",
      tierCanonical: "PRO",
      tier_full: "PRO",
      projectId: "my-proj",
      isTierManual: false,
    } as Record<string, any>,
  });

  // Expired token: the probe never runs.
  const expired = autoUpdate();
  let probes = 0;
  assert.equal(
    await applyGeminiCliTierReprobe({
      existing: freeTierConnection({ ...pinnedPro, expiresAt: new Date(0).toISOString() }),
      updateData: expired,
      reprobe: async () => {
        probes++;
        return PRO_RESULT;
      },
    }),
    false
  );
  assert.equal(probes, 0);
  assert.equal(expired.providerSpecificData.pendingTierReprobe, true);
  assert.equal(expired.providerSpecificData.tierCanonical, "PRO");

  // Probe throws.
  const thrown = autoUpdate();
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    await applyGeminiCliTierReprobe({
      existing: freeTierConnection(pinnedPro),
      updateData: thrown,
      reprobe: async () => {
        throw new Error("network down");
      },
    });
  } finally {
    console.warn = originalWarn;
  }
  assert.equal(thrown.providerSpecificData.pendingTierReprobe, true);

  // Probe returns nothing.
  const empty = autoUpdate();
  await applyGeminiCliTierReprobe({
    existing: freeTierConnection(pinnedPro),
    updateData: empty,
    reprobe: async () => null,
  });
  assert.equal(empty.providerSpecificData.pendingTierReprobe, true);
});

test("applyGeminiCliTierReprobe sets pendingTierReprobe: true on project change if probe fails or token expired", async () => {
  const autoUpdate = () => ({
    projectId: "new-proj",
    providerSpecificData: {
      tier: "free-tier",
      tierCanonical: "FREE",
      tier_full: "FREE",
      projectId: "new-proj",
      isTierManual: false,
    } as Record<string, any>,
  });
  const previous = {
    projectId: "old-proj",
    providerSpecificData: { tierCanonical: "FREE", projectId: "old-proj", isTierManual: false },
  };

  // Expired token: the probe never runs.
  const expired = autoUpdate();
  let probes = 0;
  assert.equal(
    await applyGeminiCliTierReprobe({
      existing: freeTierConnection({ ...previous, expiresAt: new Date(0).toISOString() }),
      updateData: expired,
      reprobe: async () => {
        probes++;
        return PRO_RESULT;
      },
    }),
    false
  );
  assert.equal(probes, 0);
  assert.equal(expired.providerSpecificData.pendingTierReprobe, true);
  assert.equal(expired.providerSpecificData.tierCanonical, "FREE");

  // Probe throws.
  const thrown = autoUpdate();
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    await applyGeminiCliTierReprobe({
      existing: freeTierConnection(previous),
      updateData: thrown,
      reprobe: async () => {
        throw new Error("network down");
      },
    });
  } finally {
    console.warn = originalWarn;
  }
  assert.equal(thrown.providerSpecificData.pendingTierReprobe, true);

  // First project configured on a connection that had none; probe returns nothing.
  const first = autoUpdate();
  await applyGeminiCliTierReprobe({
    existing: freeTierConnection({
      projectId: null,
      providerSpecificData: { tierCanonical: "FREE" },
    }),
    updateData: first,
    reprobe: async () => null,
  });
  assert.equal(first.providerSpecificData.pendingTierReprobe, true);
});

test("applyGeminiCliTierReprobe retries and clears pendingTierReprobe when probe succeeds", async () => {
  // Later save: no project change, not a fresh auto switch, paid tier stored —
  // only the pending flag (from the stored row) triggers the probe.
  const stored = {
    tier: "standard-tier",
    tierCanonical: "PRO",
    tier_full: "PRO",
    projectId: "my-proj",
    isTierManual: false,
    pendingTierReprobe: true,
  };
  const updateData: Record<string, any> = {
    projectId: "my-proj",
    providerSpecificData: { ...stored },
  };
  const changed = await applyGeminiCliTierReprobe({
    existing: freeTierConnection({ projectId: "my-proj", providerSpecificData: stored }),
    updateData,
    reprobe: async () => ({ ...PRO_RESULT, tier: "g1-ultra-tier", tierCanonical: "ULTRA" }),
  });
  assert.equal(changed, true);
  assert.equal(updateData.providerSpecificData.tierCanonical, "ULTRA");
  assert.equal("pendingTierReprobe" in updateData.providerSpecificData, false);

  // A failed retry keeps the flag.
  const retry: Record<string, any> = {
    projectId: "my-proj",
    providerSpecificData: { ...stored },
  };
  await applyGeminiCliTierReprobe({
    existing: freeTierConnection({ projectId: "my-proj", providerSpecificData: stored }),
    updateData: retry,
    reprobe: async () => null,
  });
  assert.equal(retry.providerSpecificData.pendingTierReprobe, true);
});

test("pinning a tier manually clears a pending re-probe", () => {
  const target: Record<string, unknown> = { pendingTierReprobe: true, isTierManual: false };
  applyGeminiCliTier(target, "PRO");
  assert.equal(target.isTierManual, true);
  assert.equal("pendingTierReprobe" in target, false);
});

test("applyGeminiCliTierReprobe runs the probe through runProbe", async () => {
  const calls: string[] = [];
  const updateData: Record<string, any> = {
    projectId: "my-proj",
    providerSpecificData: { tier: "free-tier", tierCanonical: "FREE", tier_full: "FREE" },
  };
  const changed = await applyGeminiCliTierReprobe({
    existing: freeTierConnection(),
    updateData,
    runProbe: async (probe) => {
      calls.push("enter");
      const out = await probe();
      calls.push("exit");
      return out;
    },
    reprobe: async () => {
      calls.push("probe");
      return PRO_RESULT;
    },
  });
  assert.equal(changed, true);
  assert.deepEqual(calls, ["enter", "probe", "exit"]);
});

test("PUT /api/providers/[id] wraps applyGeminiCliTierReprobe in proxy context", () => {
  const src = readSrc("app/api/providers/[id]/route.ts");
  const start = src.indexOf("await applyGeminiCliTierReprobe({");
  const block = src.slice(start, src.indexOf("await updateProviderConnection(", start));
  assert.ok(start > 0, "route must call applyGeminiCliTierReprobe");
  assert.match(block, /runProbe:/);
  assert.match(block, /resolveProxyForConnection\(id,/);
  // The probe runs before the row is saved, so a proxy toggle in the same update
  // must be applied rather than the stale persisted value.
  assert.match(block, /proxyEnabledOverride: pendingProxyEnabled/);
  assert.match(block, /updateData\.proxyEnabled !== undefined/);
  assert.match(block, /runWithProxyContextOrDirect\(/);
  assert.match(
    src,
    /import \{ runWithProxyContextOrDirect \} from "@omniroute\/open-sse\/utils\/proxyFetch\.ts";/
  );
});

test("codeassist paste notice and placeholder are localized in all Tier 1 locales", () => {
  for (const locale of ["en", "de", "es", "fr", "ja", "pt-BR", "zh-CN"]) {
    const messages = JSON.parse(readSrc(`i18n/messages/${locale}.json`));
    const modal = messages.oauthModal;
    assert.ok(modal, `${locale}: oauthModal namespace missing`);
    assert.match(modal.codeAssistPasteNotice, /<code>codeassist\.google\.com<\/code>/, locale);
    assert.match(modal.codeAssistPastePlaceholder, /codeassist\.google\.com/, locale);
  }
  const panels = readSrc("shared/components/OAuthModalPanels.tsx");
  assert.match(panels, /t\.rich\("codeAssistPasteNotice"/);
  assert.match(panels, /t\("codeAssistPastePlaceholder"\)/);
  assert.doesNotMatch(panels, /After you approve access, Google shows/);
});

// ---------------------------------------------------------------------------
// 5. Token-refresh discovery respects a manually pinned tier
// ---------------------------------------------------------------------------

function refreshAndDiscoverFetch(accessToken: string) {
  return (async (url: unknown) => {
    const u = String(url);
    if (u.includes(":loadCodeAssist")) {
      return jsonRes({ cloudaicompanionProject: "disc-proj", currentTier: { id: "free-tier" } });
    }
    if (u.includes("oauth2.googleapis.com/token")) {
      return jsonRes({ access_token: accessToken, expires_in: 3599 });
    }
    return jsonRes({ error: "unexpected" }, 500);
  }) as typeof fetch;
}

test("token-refresh discovery keeps a manually pinned tier while recovering projectId", async () => {
  globalThis.fetch = refreshAndDiscoverFetch("ya29.refresh-manual");
  const result = await getAccessToken(
    "gemini-cli",
    {
      refreshToken: "1//rt-manual-tier",
      providerSpecificData: {
        tier: "standard-tier",
        tierCanonical: "PRO",
        tier_full: "PRO",
        isTierManual: true,
      },
    },
    null
  );

  assert.equal(result?.projectId, "disc-proj");
  assert.equal(result?.providerSpecificData?.projectId, "disc-proj");
  assert.equal(result?.providerSpecificData?.clientProfile, "cli");
  assert.equal(result?.providerSpecificData?.isTierManual, true);
  assert.equal(result?.providerSpecificData?.tier, "standard-tier");
  assert.equal(result?.providerSpecificData?.tierCanonical, "PRO");
  assert.equal(result?.providerSpecificData?.tier_full, "PRO");
});

test("token-refresh discovery updates tier fields when the tier is not pinned", async () => {
  globalThis.fetch = refreshAndDiscoverFetch("ya29.refresh-auto");
  const result = await getAccessToken(
    "gemini-cli",
    {
      refreshToken: "1//rt-auto-tier",
      providerSpecificData: {
        tier: "standard-tier",
        tierCanonical: "PRO",
        tier_full: "PRO",
        isTierManual: false,
      },
    },
    null
  );

  assert.equal(result?.projectId, "disc-proj");
  assert.equal(result?.providerSpecificData?.projectId, "disc-proj");
  assert.equal(result?.providerSpecificData?.tier, "free-tier");
  assert.equal(result?.providerSpecificData?.tierCanonical, "FREE");
  assert.equal(result?.providerSpecificData?.tier_full, "FREE");
});

test("token refresh resolves pendingTierReprobe when access token is refreshed", async () => {
  const seen: Array<{ url: string; body: string }> = [];
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    const u = String(url);
    seen.push({ url: u, body: typeof init?.body === "string" ? init.body : "" });
    if (u.includes(":loadCodeAssist")) {
      return jsonRes({
        cloudaicompanionProject: "my-proj",
        currentTier: { id: "standard-tier" },
      });
    }
    if (u.includes("oauth2.googleapis.com/token")) {
      return jsonRes({ access_token: "ya29.refresh-pending", expires_in: 3599 });
    }
    return jsonRes({ error: "unexpected" }, 500);
  }) as typeof fetch;

  const result = await getAccessToken(
    "gemini-cli",
    {
      refreshToken: "1//rt-pending-tier",
      projectId: "my-proj",
      providerSpecificData: {
        tier: "free-tier",
        tierCanonical: "FREE",
        tier_full: "FREE",
        projectId: "my-proj",
        isTierManual: false,
        pendingTierReprobe: true,
      },
    },
    null
  );

  const probe = seen.find((r) => r.url.includes(":loadCodeAssist"));
  assert.ok(probe, "refresh must re-probe the pending tier");
  assert.match(probe!.body, /my-proj/);
  assert.equal(result?.providerSpecificData?.tierCanonical, "PRO");
  assert.equal(result?.providerSpecificData?.tier, "standard-tier");
  assert.equal(result?.providerSpecificData?.pendingTierReprobe, undefined);
});

test("token refresh skips the tier re-probe when nothing is pending", async () => {
  const seen: string[] = [];
  globalThis.fetch = (async (url: unknown) => {
    const u = String(url);
    seen.push(u);
    if (u.includes("oauth2.googleapis.com/token")) {
      return jsonRes({ access_token: "ya29.refresh-no-pending", expires_in: 3599 });
    }
    return jsonRes({ error: "unexpected" }, 500);
  }) as typeof fetch;

  await getAccessToken(
    "gemini-cli",
    {
      refreshToken: "1//rt-no-pending",
      projectId: "my-proj",
      providerSpecificData: { tierCanonical: "PRO", projectId: "my-proj" },
    },
    null
  );
  assert.equal(seen.filter((u) => u.includes(":loadCodeAssist")).length, 0);
});

test("exchange sanitizes user-pasted code with quotes, whitespace, and loopback redirect", async () => {
  let capturedBody: URLSearchParams | null = null;
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    capturedBody = new URLSearchParams(init?.body as string);
    return jsonRes({
      access_token: "ya29.mock-sanitized",
      refresh_token: "1//mock-sanitized",
      expires_in: 3600,
    });
  }) as typeof fetch;

  await geminiCli.exchangeToken(
    GEMINI_CLI_CONFIG,
    '  "4/0AVMBsJi12345"  \n',
    "http://127.0.0.1:20138/callback",
    "  verifier123  \n"
  );

  assert.ok(capturedBody);
  assert.equal(capturedBody.get("code"), "4/0AVMBsJi12345");
  assert.equal(capturedBody.get("code_verifier"), "verifier123");
  assert.equal(capturedBody.get("redirect_uri"), CODE_ASSIST);
});

test("oauthExchangeSchema parses optional projectId during code exchange", async () => {
  const { oauthExchangeSchema } = await import("../../src/shared/validation/schemas/auth");
  const parsed = oauthExchangeSchema.parse({
    code: "4/0A-code",
    redirectUri: CODE_ASSIST,
    projectId: "  my-custom-project  ",
  });
  assert.equal(parsed.projectId, "my-custom-project");
  assert.equal(parsed.code, "4/0A-code");
});

test("postExchange with context.projectId populates project and discovers Pro tier", async () => {
  const seen: string[] = [];
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    const u = String(url);
    seen.push(u);
    if (u.includes("oauth2/v2/userinfo")) {
      return jsonRes({ email: "user@example.com" });
    }
    if (u.includes(":loadCodeAssist")) {
      return jsonRes({
        currentTier: { id: "standard-tier", name: "Google Code Assist (Standard)" },
        cloudaicompanionProject: "attached-project",
      });
    }
    return jsonRes({ error: "not found" }, 404);
  }) as typeof fetch;

  const result = await geminiCli.postExchange(
    { access_token: "ya29.with-project", expires_in: 3600 },
    { projectId: "attached-project" }
  );

  assert.equal(result.projectId, "attached-project");
  assert.equal(result.tierCanonical, "PRO");
  assert.equal(result.tier, "standard-tier");
  assert.equal(result.projectDiscoveryOutcome, undefined);
});
