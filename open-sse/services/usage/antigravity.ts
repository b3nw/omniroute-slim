/**
 * usage/antigravity.ts — Antigravity (Gemini Code Assist) usage fetcher + quota helpers.
 *
 * Extracted from services/usage.ts (god-file decomposition): the full Antigravity family —
 * local-usage fallback, code-assist tier/plan mapping, credit-balance probing, the user-quota
 * + available-models fetchers (with their module-level caches), and getAntigravityUsage. The
 * 4 data caches + their proactive TTL-purge setInterval move here as a self-contained unit
 * (previously the purge timer lived in usage.ts; that timer was
 * split so each module owns its own caches + cleanup). usage.ts imports getAntigravityUsage
 * (dispatcher) + getAntigravityPlanLabel/mapCodeAssist* (__testing). Behavior-preserving move.
 */

import { PROVIDERS } from "../../config/constants.ts";
import {
  ANTIGRAVITY_BOOTSTRAP_BASE_URLS,
  ANTIGRAVITY_RUNTIME_BASE_URLS,
  getAntigravityFetchAvailableModelsUrls,
} from "../../config/antigravityUpstream.ts";
import {
  isDiscoverableAntigravityModelId,
  toClientAntigravityQuotaModelId,
} from "../../config/antigravityModelAliases.ts";
import { isUserCallableAgyModelId } from "../../config/agyModels.ts";
import { getDbInstance } from "@/lib/db/core";
import {
  applyAntigravityClientProfileHeaders,
  getAntigravityClientProfile,
  type AntigravityClientProfile,
} from "../antigravityClientProfile.ts";
import {
  getAntigravityContentHeaders,
  getAntigravityLoadCodeAssistMetadata,
} from "../antigravityHeaders.ts";
import {
  getAntigravityRemainingCredits,
  updateAntigravityRemainingCredits,
} from "../../executors/antigravity.ts";
import { getCreditsMode } from "../antigravityCredits.ts";
import { generateAntigravityRequestId, getAntigravitySessionId } from "../antigravityIdentity.ts";
import {
  extractCodeAssistOnboardTierId,
  extractCodeAssistSubscriptionTier,
} from "../codeAssistSubscription.ts";
import { toRecord, toNumber, getFieldValue } from "./scalars.ts";
import { type UsageQuota, parseResetTime } from "./quota.ts";
import { fetchAndParseAntigravityWeeklyQuotas } from "./antigravityWeeklyQuota.ts";
import { getAntigravityQuotaFamily } from "../antigravityQuotaFamily.ts";

type JsonRecord = Record<string, unknown>;
type SubscriptionCacheEntry = {
  data: unknown;
  fetchedAt: number;
};

const ANTIGRAVITY_CONFIG = {
  loadProjectApiUrl: `${ANTIGRAVITY_BOOTSTRAP_BASE_URLS[0]}/v1internal:loadCodeAssist`,
  tokenUrl: "https://oauth2.googleapis.com/token",
  get clientId() {
    return PROVIDERS.antigravity.clientId;
  },
  get clientSecret() {
    return PROVIDERS.antigravity.clientSecret;
  },
};

const _antigravitySubCache = new Map<string, SubscriptionCacheEntry>();
const ANTIGRAVITY_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const ANTIGRAVITY_MODELS_CACHE_TTL_MS = 60 * 1000;
const ANTIGRAVITY_CREDIT_PROBE_TTL_MS = 5 * 60 * 1000;
const _antigravityUserQuotaCache = new Map<string, { data: unknown; fetchedAt: number }>();
const _antigravityUserQuotaInflight = new Map<string, Promise<unknown>>();
const _antigravityCreditProbeCache = new Map<string, { data: number | null; fetchedAt: number }>();
const _antigravityCreditProbeInflight = new Map<string, Promise<number | null>>();

// ── Proactive TTL purging for the Antigravity module-level caches ──────────
// Split out of the shared usage.ts cleanup timer (god-file decomposition): this
// leaf owns its data caches, so it owns their purge too. The inflight Maps
// self-clean when their Promise settles, so they are NOT swept here.
const _antigravityCacheCleanupTimer = setInterval(
  () => {
    const now = Date.now();
    for (const [key, entry] of _antigravitySubCache) {
      if (now - entry.fetchedAt > ANTIGRAVITY_CACHE_TTL_MS) _antigravitySubCache.delete(key);
    }
    for (const [key, entry] of _antigravityUserQuotaCache) {
      if (now - entry.fetchedAt > ANTIGRAVITY_MODELS_CACHE_TTL_MS)
        _antigravityUserQuotaCache.delete(key);
    }
    for (const [key, entry] of _antigravityCreditProbeCache) {
      if (now - entry.fetchedAt > ANTIGRAVITY_CREDIT_PROBE_TTL_MS)
        _antigravityCreditProbeCache.delete(key);
    }
  },
  5 * 60 * 1000
); // every 5 minutes
_antigravityCacheCleanupTimer.unref?.(); // Don't prevent process exit

interface AntigravityUsageOptions {
  forceRefresh?: boolean;
}

// `toClientAntigravityQuotaModelId` was an inline if-ladder here; it is now the single
// source of truth in open-sse/config/antigravityModelAliases.ts (imported above), shared
// with the provider-limits cache sanitizer. (#3821-review LEDGER-5)

function buildAntigravityUsageCacheKey(
  accessToken: string,
  projectId: string | null | undefined,
  clientProfile: AntigravityClientProfile
): string {
  return `${accessToken.substring(0, 16)}:${projectId || "default"}:${clientProfile}`;
}

async function fetchAntigravityUserQuotaCached(
  accessToken: string,
  projectId?: string | null,
  clientProfile: AntigravityClientProfile = "ide",
  options: AntigravityUsageOptions = {}
): Promise<unknown | null> {
  if (!accessToken || !projectId) return null;

  const cacheKey = buildAntigravityUsageCacheKey(accessToken, projectId, clientProfile);
  const cached = _antigravityUserQuotaCache.get(cacheKey);
  if (
    !options.forceRefresh &&
    cached &&
    Date.now() - cached.fetchedAt < ANTIGRAVITY_MODELS_CACHE_TTL_MS
  ) {
    return cached.data;
  }

  const inflight = _antigravityUserQuotaInflight.get(cacheKey);
  if (inflight) return inflight;

  const promise = (async () => {
    try {
      for (const baseUrl of ANTIGRAVITY_RUNTIME_BASE_URLS) {
        const response = await fetch(`${baseUrl}/v1internal:retrieveUserQuota`, {
          method: "POST",
          headers: getAntigravityContentHeaders(clientProfile, accessToken),
          body: JSON.stringify({ project: projectId }),
          signal: AbortSignal.timeout(10000),
        });

        if (!response.ok) continue;

        const data = await response.json();
        _antigravityUserQuotaCache.set(cacheKey, { data, fetchedAt: Date.now() });
        return data;
      }
      return null;
    } catch {
      return null;
    }
  })().finally(() => {
    _antigravityUserQuotaInflight.delete(cacheKey);
  });

  _antigravityUserQuotaInflight.set(cacheKey, promise);
  return promise;
}

function extractCodeAssistTierId(subscription: JsonRecord): string {
  const tierId = extractCodeAssistOnboardTierId(subscription);
  if (tierId === "legacy-tier") return "";
  const upper = tierId.toUpperCase();
  return mapCodeAssistTierIdToLabel(upper) ? upper : "";
}

export function mapCodeAssistTierIdToLabel(tierId: string): string | null {
  const upper = tierId.toUpperCase();
  if (upper.includes("ULTRA")) return "Ultra";
  if (
    upper.includes("PRO") ||
    upper.includes("PREMIUM") ||
    upper.includes("GOOGLE_ONE") ||
    upper.includes("ONE_AI")
  )
    return "Pro";
  if (upper.includes("ENTERPRISE")) return "Enterprise";
  if (upper.includes("BUSINESS") || upper.includes("STANDARD")) return "Business";
  if (upper.includes("PLUS")) return "Plus";
  if (upper.includes("LITE") || upper.includes("LIGHT")) return "Lite";
  if (upper.includes("FREE") || upper.includes("INDIVIDUAL") || upper.includes("LEGACY"))
    return "Free";
  return null;
}

export function mapSubscriptionTierStringToPlanLabel(tierText: string): string | null {
  const upper = tierText.toUpperCase();
  if (upper.includes("ULTRA")) return "Ultra";
  if (upper.includes("PRO") || upper.includes("PREMIUM") || upper.includes("GOOGLE ONE"))
    return "Pro";
  if (upper.includes("ENTERPRISE")) return "Enterprise";
  if (upper.includes("STANDARD") || upper.includes("BUSINESS")) return "Business";
  if (upper.includes("PLUS")) return "Plus";
  if (upper.includes("LITE")) return "Lite";
  if (upper.includes("INDIVIDUAL") || upper.includes("FREE")) return "Free";
  // Strip a trailing "(RESTRICTED)" marker. Match the fixed literal anywhere then
  // trim, instead of /\s*\(RESTRICTED\)\s*$/ whose overlapping \s* runs backtrack
  // polynomially on whitespace-heavy upstream input (js/polynomial-redos).
  const normalizedId = upper.replace(/\(RESTRICTED\)/i, "").trim();
  if (normalizedId) {
    const mapped = mapCodeAssistTierIdToLabel(normalizedId);
    if (mapped) return mapped;
  }
  return null;
}

export function mapCodeAssistSubscriptionToPlanLabel(subscriptionInfo: unknown): string {
  const subscription = toRecord(subscriptionInfo);
  if (Object.keys(subscription).length === 0) return "Free";

  const subscriptionTier = extractCodeAssistSubscriptionTier(subscriptionInfo);
  if (subscriptionTier) {
    const mapped = mapSubscriptionTierStringToPlanLabel(subscriptionTier);
    if (mapped) return mapped;
    if (subscriptionTier.toLowerCase() !== "free") {
      return subscriptionTier.charAt(0).toUpperCase() + subscriptionTier.slice(1).toLowerCase();
    }
  }

  const currentTier = toRecord(subscription.currentTier);
  const tierName = String(
    getFieldValue(currentTier, "name", "displayName") ||
      subscription.subscriptionType ||
      subscription.tier ||
      ""
  );
  const mappedName = tierName ? mapSubscriptionTierStringToPlanLabel(tierName) : null;
  if (mappedName) return mappedName;

  const tierId = extractCodeAssistTierId(subscription);
  if (tierId) {
    const mapped = mapCodeAssistTierIdToLabel(tierId);
    if (mapped) return mapped;
  }
  if (currentTier.upgradeSubscriptionType) return "Free";
  if (tierName) return tierName.charAt(0).toUpperCase() + tierName.slice(1).toLowerCase();
  return "Free";
}

const KNOWN_ANTIGRAVITY_PLAN_LABELS = new Set([
  "Ultra",
  "Pro",
  "Enterprise",
  "Business",
  "Plus",
  "Lite",
]);

/**
 * Map raw loadCodeAssist tier data to short display labels (Antigravity Manager parity).
 */
export function getAntigravityPlanLabel(subscriptionInfo: unknown, fallbackInfo?: unknown): string {
  const livePlan = mapCodeAssistSubscriptionToPlanLabel(subscriptionInfo);
  const fallbackPlan = mapCodeAssistSubscriptionToPlanLabel(fallbackInfo);

  if (KNOWN_ANTIGRAVITY_PLAN_LABELS.has(livePlan)) return livePlan;
  if (KNOWN_ANTIGRAVITY_PLAN_LABELS.has(fallbackPlan)) return fallbackPlan;
  if (livePlan !== "Free") return livePlan;
  return fallbackPlan !== "Free" ? fallbackPlan : livePlan;
}

/**
 * Proactive credit balance probe for Antigravity.
 *
 * Fires a minimal streamGenerateContent request with GOOGLE_ONE_AI credits enabled
 * and maxOutputTokens=1 to extract the `remainingCredits` field from the SSE stream.
 * This uses ~1 credit but lets us show the balance on the dashboard without waiting
 * for a real user request.
 *
 * Returns the credit balance, or null if the probe failed.
 */
async function probeAntigravityCreditBalance(
  accessToken: string,
  accountId: string,
  projectId?: string | null,
  options: AntigravityUsageOptions = {},
  providerSpecificData: JsonRecord = {}
): Promise<number | null> {
  if (!accessToken) return null;

  const clientProfile = getAntigravityClientProfile({ providerSpecificData });
  const cacheKey = buildAntigravityUsageCacheKey(
    accessToken,
    projectId || accountId,
    clientProfile
  );
  const cached = _antigravityCreditProbeCache.get(cacheKey);
  if (
    !options.forceRefresh &&
    cached &&
    Date.now() - cached.fetchedAt < ANTIGRAVITY_CREDIT_PROBE_TTL_MS
  ) {
    return cached.data;
  }

  const inflight = _antigravityCreditProbeInflight.get(cacheKey);
  if (inflight) return inflight;

  const promise = probeAntigravityCreditBalanceUncached(
    accessToken,
    accountId,
    projectId,
    providerSpecificData
  )
    .then(
      (data) => {
        _antigravityCreditProbeCache.set(cacheKey, { data, fetchedAt: Date.now() });
        return data;
      },
      (error) => {
        _antigravityCreditProbeCache.set(cacheKey, { data: null, fetchedAt: Date.now() });
        throw error;
      }
    )
    .finally(() => {
      _antigravityCreditProbeInflight.delete(cacheKey);
    });

  _antigravityCreditProbeInflight.set(cacheKey, promise);
  return promise;
}

async function probeAntigravityCreditBalanceUncached(
  accessToken: string,
  accountId: string,
  projectId?: string | null,
  providerSpecificData: JsonRecord = {}
): Promise<number | null> {
  try {
    if (!projectId) return null;

    // Try all base URLs (some accounts only work with specific endpoints)
    for (const baseUrl of ANTIGRAVITY_RUNTIME_BASE_URLS) {
      const url = `${baseUrl}/v1internal:streamGenerateContent?alt=sse`;

      const sessionId = getAntigravitySessionId({ connectionId: accountId, projectId });
      const body = {
        project: projectId,
        model: "gemini-2-flash",
        userAgent: "antigravity",
        requestType: "agent",
        requestId: generateAntigravityRequestId(),
        enabledCreditTypes: ["GOOGLE_ONE_AI"],
        request: {
          model: "gemini-2-flash",
          contents: [{ role: "user", parts: [{ text: "hi" }] }],
          generationConfig: { maxOutputTokens: 1 },
          sessionId,
        },
      };

      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
        Accept: "text/event-stream",
      };
      applyAntigravityClientProfileHeaders(
        headers,
        { connectionId: accountId, projectId, providerSpecificData },
        body
      );

      try {
        const res = await fetch(url, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(10_000),
        });

        if (!res.ok) continue;

        // Read the full SSE response and scan for remainingCredits
        const rawSSE = await res.text();
        const lines = rawSSE.split("\n");

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("data:")) continue;
          const payload = trimmed.slice(5).trim();
          if (payload === "[DONE]") break;
          try {
            const parsed = JSON.parse(payload);
            if (Array.isArray(parsed?.remainingCredits)) {
              const googleCredit = parsed.remainingCredits.find(
                (c: { creditType?: string }) => c?.creditType === "GOOGLE_ONE_AI"
              );
              if (googleCredit) {
                const balance = parseInt(googleCredit.creditAmount, 10);
                if (!isNaN(balance)) {
                  updateAntigravityRemainingCredits(accountId, balance);
                  return balance;
                }
              }
            }
          } catch {
            // Skip malformed SSE lines
          }
        }
      } catch {
        // Individual endpoint failure; try next
      }
    }

    return null;
  } catch {
    // Probe is best-effort — don't let it break the usage fetch
    return null;
  }
}

/**
 * Antigravity Usage - Fetch quota from Google Cloud Code API.
 * fetchAvailableModels is catalog/eligibility data and may keep reporting full buckets
 * after real usage. retrieveUserQuota is the consumption signal for Gemini-family
 * buckets, so prefer it when present and fall back to fetchAvailableModels only for
 * models that have no retrieveUserQuota entry (for example Claude/GPT OSS buckets).
 */
export async function getAntigravityUsage(
  provider: "antigravity" | "agy",
  accessToken?: string,
  providerSpecificData?: JsonRecord,
  connectionProjectId?: string,
  connectionId?: string,
  options: AntigravityUsageOptions = {}
) {
  if (!accessToken) {
    return { plan: "Free", message: "Antigravity access token not available." };
  }

  let subscriptionInfo: unknown = null;
  try {
    const clientProfile = getAntigravityClientProfile({ providerSpecificData });
    subscriptionInfo = await getAntigravitySubscriptionInfoCached(
      accessToken,
      providerSpecificData,
      options
    );
    const savedProjectId =
      typeof providerSpecificData?.projectId === "string" && providerSpecificData.projectId.trim()
        ? providerSpecificData.projectId.trim()
        : null;
    const subscriptionProject = toRecord(subscriptionInfo).cloudaicompanionProject;
    const projectId =
      savedProjectId ||
      connectionProjectId ||
      (typeof subscriptionProject === "string"
        ? subscriptionProject
        : typeof toRecord(subscriptionProject).id === "string"
          ? (toRecord(subscriptionProject).id as string)
          : null);

    // Derive accountId for credit balance cache.
    // Must match executor key: credentials.connectionId
    const accountId: string = connectionId || "unknown";

    // Read cached credit balance (hydrated from DB on first access)
    let creditBalance = getAntigravityRemainingCredits(accountId);

    // Only an explicit refresh in always mode may proactively spend credits to discover
    // the balance. Automatic/scheduled refreshes must use the cached balance (if any)
    // rather than adding credit-bearing inference calls after normal user requests.
    const creditsMode = getCreditsMode();
    if (options.forceRefresh === true && creditsMode === "always") {
      creditBalance = await probeAntigravityCreditBalance(
        accessToken,
        accountId,
        projectId,
        options,
        providerSpecificData || {}
      );
    }

    let quotas = await fetchAndParseAntigravityWeeklyQuotas(
      accessToken,
      projectId,
      clientProfile,
      options
    );

    // Fallback: If retrieveUserQuotaSummary yielded no groups, check retrieveUserQuota for 5h family quotas
    if (Object.keys(quotas).length === 0) {
      const userQuotaData = await fetchAntigravityUserQuotaCached(
        accessToken,
        projectId,
        clientProfile,
        options
      );
      const userQuotaObj = toRecord(userQuotaData);
      if (Array.isArray(userQuotaObj.buckets) && userQuotaObj.buckets.length > 0) {
        for (const bucketEntry of userQuotaObj.buckets) {
          const bucket = toRecord(bucketEntry);
          const rawFraction = toNumber(bucket.remainingFraction, -1);
          if (rawFraction < 0) continue;
          const modelId = typeof bucket.modelId === "string" ? bucket.modelId : "";
          const family = getAntigravityQuotaFamily(modelId);
          const key = family === "claude" ? "claude_gpt_5h" : "gemini_5h";
          if (quotas[key]) continue;
          const remainingFraction = Math.max(0, Math.min(1, rawFraction));
          const resetAt = parseResetTime(bucket.resetTime);
          const total = 1000;
          const remaining = Math.round(total * remainingFraction);
          quotas[key] = {
            used: Math.max(0, total - remaining),
            total,
            resetAt,
            remainingPercentage: remainingFraction * 100,
            unlimited: false,
            fractionReported: true,
            quotaSource: "retrieveUserQuota",
            displayName: family === "claude" ? "Claude and GPT models (5h)" : "Gemini Models (5h)",
          };
        }
      }
    }

    return {
      plan: getAntigravityPlanLabel(subscriptionInfo, providerSpecificData),
      quotas: {
        ...quotas,
        ...(creditBalance !== null && {
          credits: {
            used: 0,
            total: 0,
            remaining: creditBalance,
            unlimited: false,
            resetAt: null,
          },
        }),
      },
      subscriptionInfo,
    };
  } catch (error) {
    return {
      plan: getAntigravityPlanLabel(subscriptionInfo, providerSpecificData),
      subscriptionInfo,
      message: `Antigravity error: ${(error as Error).message}`,
    };
  }
}

/**
 * Get Antigravity subscription info (cached, 5 min TTL)
 * Prevents duplicate loadCodeAssist calls within the same quota cycle.
 */
async function getAntigravitySubscriptionInfoCached(
  accessToken: string,
  providerSpecificData?: JsonRecord,
  options: AntigravityUsageOptions = {}
): Promise<unknown> {
  const profile = getAntigravityClientProfile({ providerSpecificData });
  const cacheKey = `${accessToken.substring(0, 16)}:${profile}`;

  if (options.forceRefresh) {
    _antigravitySubCache.delete(cacheKey);
  } else {
    const cached = _antigravitySubCache.get(cacheKey);
    if (cached && Date.now() - cached.fetchedAt < ANTIGRAVITY_CACHE_TTL_MS) {
      return cached.data;
    }
  }

  const data = await getAntigravitySubscriptionInfo(accessToken, providerSpecificData);
  if (data != null) {
    _antigravitySubCache.set(cacheKey, { data, fetchedAt: Date.now() });
  }
  return data;
}

/**
 * Get Antigravity subscription info using correct Antigravity headers.
 * Must match the headers used in providers.js postExchange (not CLI headers).
 */
async function getAntigravitySubscriptionInfo(
  accessToken: string,
  providerSpecificData?: JsonRecord
): Promise<unknown | null> {
  try {
    const profile = getAntigravityClientProfile({ providerSpecificData });
    const response = await fetch(ANTIGRAVITY_CONFIG.loadProjectApiUrl, {
      method: "POST",
      headers: getAntigravityContentHeaders(profile, accessToken),
      body: JSON.stringify({ metadata: getAntigravityLoadCodeAssistMetadata() }),
    });

    if (!response.ok) return null;

    return await response.json();
  } catch {
    return null;
  }
}
