/**
 * #11284 — Antigravity OAuth connect-time DEGRADE marking for accounts without
 * a Cloud Code projectId. Shared helper used by the OAuth route's `exchange`,
 * `poll-callback`, and the shared persistOAuthConnection path.
 *
 * Maintainer direction on #11284: do NOT reject the connect — SAVE the
 * connection but mark it degraded, so the refresh token stays stored and the
 * request-time bootstrap can self-heal it (persistDiscoveredAntigravityProjectId
 * flips the row back to active). Confirmed-BYOP accounts get disabled by
 * markAntigravityMissingCloudCodeProject() on the first dispatch instead.
 */

export type AntigravityDegradedProjectState = {
  /** Persist with this status instead of "active". */
  testStatus: "degraded";
  errorCode: string;
  lastErrorType: string;
  lastError: string;
  /** Non-fatal warning surfaced in the connect response for the dashboard. */
  warning: string;
};

/** Providers whose Cloud Code projectId is expected at connect time. */
const PROJECT_EXPECTED_PROVIDERS = new Set(["antigravity", "agy", "gemini-cli", "gemini_cli"]);
const GEMINI_CLI_PROVIDERS = new Set(["gemini-cli", "gemini_cli"]);

const BYOP_WARNING =
  "Connected, but Google did not assign a Cloud Code project to this account (BYOP). " +
  "Create a GCP Project at console.cloud.google.com and complete Gemini Code Assist onboarding; " +
  "the account is marked degraded until then and cannot serve requests.";

const GEMINI_CLI_BYOP_WARNING =
  "Connected, but no Google Cloud project with Gemini Code Assist " +
  "(cloudaicompanion.googleapis.com) enabled was found for this account (BYOP). " +
  "Enable the API in a GCP project at console.cloud.google.com, then set its Google Cloud " +
  "Project ID in this connection's settings; the account is marked degraded until then.";

const DISCOVERY_FAILED_WARNING =
  "Connected, but the Google Cloud Code projectId could not be discovered during login " +
  "(loadCodeAssist/onboardUser failed). The account is marked degraded; discovery retries " +
  "automatically on the first request.";

/**
 * #11284: when projectId discovery failed at connect time, return the degrade
 * fields to persist (testStatus:"degraded" + typed error markers) instead of
 * silently saving a false "active". Returns null for healthy payloads.
 */
export function antigravityDegradedProjectState(
  provider: string,
  tokenData: Record<string, unknown> | null | undefined
): AntigravityDegradedProjectState | null {
  if (!PROJECT_EXPECTED_PROVIDERS.has(provider)) return null;
  const outcome = tokenData?.projectDiscoveryOutcome;
  if (!outcome) return null;
  console.warn(
    `[oauth] ${provider}: marking connection degraded — no Cloud Code projectId (${String(outcome)}) (#11284)`
  );
  const byopWarning = GEMINI_CLI_PROVIDERS.has(provider) ? GEMINI_CLI_BYOP_WARNING : BYOP_WARNING;
  const warning = outcome === "requires_manual_project" ? byopWarning : DISCOVERY_FAILED_WARNING;
  return {
    testStatus: "degraded",
    errorCode: "missing_project_id",
    lastErrorType: "oauth_missing_project_id",
    lastError: warning,
    warning,
  };
}
