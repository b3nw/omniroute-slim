import { GEMINI_CLI_CODE_ASSIST_REDIRECT_URI, GEMINI_CLI_CONFIG } from "../constants/oauth";
import {
  discoverGeminiCliProjectAndTier,
  type GeminiCliDiscoveryResult,
} from "@omniroute/open-sse/services/geminiCliDiscovery.ts";

const POSTEXCHANGE_TIMEOUT_MS = 8_000;

type GeminiCliOAuthConfig = typeof GEMINI_CLI_CONFIG;

type GeminiCliTokenPayload = {
  access_token: string;
  expires_in?: number;
  refresh_token?: string;
  scope?: string;
};

/**
 * Why no Code Assist projectId was discovered at connect time (mirrors Antigravity, #11284).
 * - "requires_manual_project": discovery completed but found no project with
 *   cloudaicompanion.googleapis.com enabled — the user must configure one (BYOP).
 * - "discovery_failed": discovery timed out or was aborted before it could conclude.
 */
type GeminiCliProjectDiscoveryOutcome = "requires_manual_project" | "discovery_failed";

type GeminiCliPostExchange = {
  projectId: string;
  tier: string;
  tierCanonical: "ULTRA" | "PRO" | "FREE";
  tier_full: string;
  userInfo: { email?: string; name?: string; picture?: string };
  projectDiscoveryOutcome?: GeminiCliProjectDiscoveryOutcome;
};

function buildGeminiCliAuthUrl(
  config: GeminiCliOAuthConfig,
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

async function exchangeGeminiCliToken(
  config: GeminiCliOAuthConfig,
  code: string,
  redirectUri: string,
  codeVerifier?: string
): Promise<GeminiCliTokenPayload> {
  const trimmedCode = (code || "").trim().replace(/^["']|["']$/g, "");
  const trimmedVerifier = (codeVerifier || "").trim();
  const cleanRedirect = (redirectUri || "").trim();
  // Ensure we never pass loopback redirect to Google when exchanging for Gemini CLI built-in client
  const effectiveRedirectUri =
    !cleanRedirect || cleanRedirect.includes("127.0.0.1") || cleanRedirect.includes("localhost")
      ? config.redirectUri || GEMINI_CLI_CODE_ASSIST_REDIRECT_URI
      : cleanRedirect;

  const bodyParams: Record<string, string> = {
    grant_type: "authorization_code",
    client_id: config.clientId,
    code: trimmedCode,
    redirect_uri: effectiveRedirectUri,
  };
  if (config.clientSecret) bodyParams.client_secret = config.clientSecret;
  if (trimmedVerifier) bodyParams.code_verifier = trimmedVerifier;

  const response = await fetch(config.tokenUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
      "User-Agent": "GeminiCLI/0.31.0",
    },
    body: new URLSearchParams(bodyParams),
  });
  if (!response.ok) {
    throw new Error(`Token exchange failed: ${await response.text()}`);
  }
  return (await response.json()) as GeminiCliTokenPayload;
}

async function postExchangeGeminiCli(
  config: GeminiCliOAuthConfig,
  tokens: GeminiCliTokenPayload,
  context?: { projectId?: string }
): Promise<GeminiCliPostExchange> {
  const userInfoResponse = await fetch(`${config.userInfoUrl}?alt=json`, {
    headers: { Authorization: `Bearer ${tokens.access_token}` },
    signal: AbortSignal.timeout(8_000),
  }).catch(() => null);

  const userInfo = userInfoResponse?.ok
    ? ((await userInfoResponse.json()) as { email?: string; name?: string; picture?: string })
    : {};

  const configuredProjectId = (context?.projectId || "").trim();
  let discovery: GeminiCliDiscoveryResult | null = null;
  let discoveryAborted = false;
  try {
    discovery = await discoverGeminiCliProjectAndTier(tokens.access_token, {
      signal: AbortSignal.timeout(POSTEXCHANGE_TIMEOUT_MS),
      projectId: configuredProjectId || undefined,
    });
  } catch (error) {
    const name = error instanceof Error ? error.name : "";
    discoveryAborted = name === "TimeoutError" || name === "AbortError";
    console.warn("Failed Gemini CLI post-auth discovery:", error);
  }

  const projectId = discovery?.projectId || configuredProjectId;
  return {
    projectId,
    tier: discovery?.tier || "free-tier",
    tierCanonical: discovery?.tierCanonical || "FREE",
    tier_full: discovery?.tier_full || "FREE",
    userInfo,
    ...(projectId
      ? {}
      : {
          projectDiscoveryOutcome: discoveryAborted
            ? ("discovery_failed" as const)
            : ("requires_manual_project" as const),
        }),
  };
}

function mapGeminiCliTokens(tokens: GeminiCliTokenPayload, extra?: GeminiCliPostExchange) {
  return {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    expiresIn: tokens.expires_in,
    scope: tokens.scope,
    email: extra?.userInfo?.email,
    displayName: extra?.userInfo?.email,
    projectId: extra?.projectId,
    // Lets the OAuth route save the connection as degraded (BYOP warning)
    // instead of a false "active" row with no usable project.
    projectDiscoveryOutcome: extra?.projectDiscoveryOutcome,
    providerSpecificData: {
      clientProfile: "cli",
      projectId: extra?.projectId,
      tier: extra?.tier,
      tierCanonical: extra?.tierCanonical,
      tier_full: extra?.tier_full,
    },
  };
}

export function createGeminiCliOAuthProvider(config: GeminiCliOAuthConfig = GEMINI_CLI_CONFIG) {
  return {
    config,
    flowType: "authorization_code_pkce" as const,
    supportsBrowserPkce: true,
    buildAuthUrl: (
      runtimeConfig: GeminiCliOAuthConfig,
      redirectUri: string,
      state: string,
      codeChallenge?: string
    ) => buildGeminiCliAuthUrl(runtimeConfig, redirectUri, state, codeChallenge),
    exchangeToken: (
      runtimeConfig: GeminiCliOAuthConfig,
      code: string,
      redirectUri: string,
      codeVerifier?: string
    ) => exchangeGeminiCliToken(runtimeConfig, code, redirectUri, codeVerifier),
    exchangeCodeForTokens: (
      runtimeConfig: GeminiCliOAuthConfig,
      code: string,
      redirectUri: string,
      codeVerifier?: string
    ) => exchangeGeminiCliToken(runtimeConfig, code, redirectUri, codeVerifier),
    postExchange: (tokens: GeminiCliTokenPayload, context?: { projectId?: string }) =>
      postExchangeGeminiCli(config, tokens, context),
    mapTokens: (tokens: GeminiCliTokenPayload, extra?: GeminiCliPostExchange) =>
      mapGeminiCliTokens(tokens, extra),
  };
}

export const geminiCli = createGeminiCliOAuthProvider(GEMINI_CLI_CONFIG);

export default geminiCli;
