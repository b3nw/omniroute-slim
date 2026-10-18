import type { AntigravityClientProfile } from "@/shared/constants/antigravityClientProfile";
import {
  getCachedAntigravityAppVersion,
  getCachedAntigravityCliVersion,
} from "./antigravityVersion.ts";

export const ANTIGRAVITY_NODE_API_CLIENT = "google-api-nodejs-client/10.3.0";
export const ANTIGRAVITY_NODE_X_GOOG_API_CLIENT = "gl-node/22.21.1";

// Antigravity presents the native macOS desktop client fingerprint: the upstream
// backend expects the Mac build, so the OS/arch token is pinned to darwin/arm64
// regardless of the host OmniRoute happens to run on (#8098).
const ANTIGRAVITY_OS_TYPE = "darwin";
const ANTIGRAVITY_ARCH = "arm64";

function withOptionalBearerAuth(
  headers: Record<string, string>,
  accessToken?: string | null
): Record<string, string> {
  if (accessToken) {
    headers.Authorization = `Bearer ${accessToken}`;
  }
  return headers;
}

/**
 * Antigravity App (a.k.a. Hub) identity — `antigravity/hub/<v> <os>/<arch>`.
 *
 * This is the surface that currently receives the full model catalog
 * (`gemini-4-argon-*`, `gemini-3.8-flash-*`). The legacy `antigravity/ide/<v>` form is
 * served a reduced catalog and is rejected for those families, so `app` is the default.
 * CLIProxyAPI derives the same string for its Hub family.
 */
export function antigravityAppUserAgent(version = getCachedAntigravityAppVersion()): string {
  return `antigravity/hub/${version} ${ANTIGRAVITY_OS_TYPE}/${ANTIGRAVITY_ARCH}`;
}

/**
 * Antigravity App control-plane identity: the Hub UA plus the node client suffix.
 *
 * CLIProxyAPI makes the same split for the Hub family — the short form is used for
 * generate/stream/model-list, the node-suffixed form for control-plane calls such as
 * onboardUser.
 */
export function antigravityAppNodeUserAgent(version = getCachedAntigravityAppVersion()): string {
  return `${antigravityAppUserAgent(version)} ${ANTIGRAVITY_NODE_API_CLIENT}`;
}

export function antigravityCliUserAgent(
  version = getCachedAntigravityCliVersion(),
  authMethod = "consumer"
): string {
  return `antigravity/cli/${version} (aidev_client; os_type=${ANTIGRAVITY_OS_TYPE}; arch=${ANTIGRAVITY_ARCH}; auth_method=${authMethod})`;
}

/** The short runtime User-Agent for a client profile — used for content/generate calls. */
export function getAntigravityRuntimeUserAgent(profile: AntigravityClientProfile): string {
  return profile === "cli" ? antigravityCliUserAgent() : antigravityAppUserAgent();
}

/**
 * Control-plane (OAuth/onboarding) User-Agent for a client profile. The App carries the
 * node client suffix here. There is no IDE branch: `ide` is not an
 * AntigravityClientProfile, and legacy persisted values are coerced to `app` on read.
 */
export function getAntigravityOAuthUserAgent(profile: AntigravityClientProfile): string {
  return profile === "cli" ? antigravityCliUserAgent() : antigravityAppNodeUserAgent();
}

export function getAntigravityContentHeaders(
  profile: AntigravityClientProfile,
  accessToken?: string | null
): Record<string, string> {
  return withOptionalBearerAuth(
    {
      "Content-Type": "application/json",
      "User-Agent": getAntigravityRuntimeUserAgent(profile),
    },
    accessToken
  );
}

/** App control-plane headers (OAuth post-exchange / onboarding) — Hub UA + Node client. */
export function getAntigravityAppNodeHeaders(accessToken?: string | null): Record<string, string> {
  return withOptionalBearerAuth(
    {
      "Content-Type": "application/json",
      "User-Agent": antigravityAppNodeUserAgent(),
      "X-Goog-Api-Client": ANTIGRAVITY_NODE_X_GOOG_API_CLIENT,
    },
    accessToken
  );
}

/** Native loadCodeAssist body metadata captured from both official clients. */
export function getAntigravityLoadCodeAssistMetadata(): Record<string, string> {
  return {
    ideType: "ANTIGRAVITY",
  };
}
