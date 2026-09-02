import { GEMINI_CLI_CONFIG } from "../constants/oauth";
import {
  discoverGeminiCliProjectAndTier,
  type GeminiCliDiscoveryResult,
} from "@omniroute/open-sse/services/geminiCliDiscovery.ts";

const POSTEXCHANGE_TIMEOUT_MS = 25_000;

type GeminiCliOAuthConfig = typeof GEMINI_CLI_CONFIG;

type GeminiCliTokenPayload = {
  access_token: string;
  expires_in?: number;
  refresh_token?: string;
  scope?: string;
};

type GeminiCliPostExchange = {
  projectId: string;
  tier: string;
  tierCanonical: "ULTRA" | "PRO" | "FREE";
  tier_full: string;
  userInfo: { email?: string; name?: string; picture?: string };
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
  const bodyParams: Record<string, string> = {
    grant_type: "authorization_code",
    client_id: config.clientId,
    code,
    redirect_uri: redirectUri,
  };
  if (config.clientSecret) bodyParams.client_secret = config.clientSecret;
  if (codeVerifier) bodyParams.code_verifier = codeVerifier;

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
  tokens: GeminiCliTokenPayload
): Promise<GeminiCliPostExchange> {
  const userInfoResponse = await fetch(`${config.userInfoUrl}?alt=json`, {
    headers: { Authorization: `Bearer ${tokens.access_token}` },
    signal: AbortSignal.timeout(8_000),
  }).catch(() => null);

  const userInfo = userInfoResponse?.ok
    ? ((await userInfoResponse.json()) as { email?: string; name?: string; picture?: string })
    : {};

  let discovery: GeminiCliDiscoveryResult | null = null;
  try {
    discovery = await discoverGeminiCliProjectAndTier(tokens.access_token, {
      signal: AbortSignal.timeout(POSTEXCHANGE_TIMEOUT_MS),
    });
  } catch (error) {
    console.warn("Failed Gemini CLI post-auth discovery:", error);
  }

  return {
    projectId: discovery?.projectId || "",
    tier: discovery?.tier || "free-tier",
    tierCanonical: discovery?.tierCanonical || "FREE",
    tier_full: discovery?.tier_full || "FREE",
    userInfo,
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
    postExchange: (tokens: GeminiCliTokenPayload) => postExchangeGeminiCli(config, tokens),
    mapTokens: (tokens: GeminiCliTokenPayload, extra?: GeminiCliPostExchange) =>
      mapGeminiCliTokens(tokens, extra),
  };
}

export const geminiCli = createGeminiCliOAuthProvider(GEMINI_CLI_CONFIG);

export default geminiCli;
