/**
 * usage/gemini-cli.ts — Gemini CLI quota usage fetcher and parser.
 *
 * Interacts with Google Cloud Code Partner API (CCPA) v1internal:retrieveUserQuota
 * to extract model quotas, remaining fractions, and calculate per-tier cost percentages.
 */

import { parseResetTime, type UsageQuota } from "./quota.ts";
import {
  getGeminiCliAuthHeaders,
  normalizeTierName,
  discoverGeminiCliProjectAndTier,
  type CanonicalTier,
} from "../geminiCliDiscovery.ts";

export interface GeminiCliBucket {
  modelId?: string;
  model_id?: string;
  remainingFraction?: number;
  remaining_fraction?: number;
  resetTime?: string;
  reset_time?: string;
  remainingAmount?: string;
  tokenType?: string;
}

export interface GeminiCliQuotaResponse {
  buckets?: GeminiCliBucket[];
}

export interface UsageSnapshot {
  tier: CanonicalTier;
  tierMaxRpd: number;
  costPerRequestPercent: number;
  models: Record<string, { remainingFraction: number; resetTime?: string }>;
  quotas: Record<string, UsageQuota>;
  plan?: string;
  projectId?: string;
  fetchedAt?: number;
}

const GEMINI_CLI_QUOTA_ENDPOINTS = [
  "https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota",
  "https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:retrieveUserQuota",
] as const;

const _geminiCliQuotaCache = new Map<string, { data: UsageSnapshot; fetchedAt: number }>();
const _geminiCliQuotaInflight = new Map<string, Promise<UsageSnapshot>>();
const GEMINI_CLI_QUOTA_CACHE_TTL_MS = 60 * 1000; // 1 minute

/**
 * Normalizes a :retrieveUserQuota API response into a structured UsageSnapshot.
 */
export function parseGeminiCliQuotaResponse(
  quotaData: GeminiCliQuotaResponse,
  tier: CanonicalTier = "PRO"
): UsageSnapshot {
  const buckets = quotaData.buckets || [];
  const tierMaxRpd = tier === "ULTRA" ? 2000 : tier === "PRO" ? 1500 : 1000;
  const costPerRequestPercent = 100 / tierMaxRpd;

  const modelUsage: Record<string, { remainingFraction: number; resetTime?: string }> = {};
  const quotas: Record<string, UsageQuota> = {};

  for (const b of buckets) {
    const modelId = b.modelId || b.model_id;
    if (modelId) {
      const rawRemaining = b.remainingFraction ?? b.remaining_fraction;
      const remainingFraction =
        rawRemaining !== undefined ? Math.max(0, Math.min(1, rawRemaining)) : 1.0;
      const resetTime = b.resetTime || b.reset_time;
      const resetAt = parseResetTime(resetTime);

      modelUsage[modelId] = {
        remainingFraction,
        resetTime,
      };

      const total = tierMaxRpd;
      const remaining = Math.round(total * remainingFraction);
      const used = Math.max(0, total - remaining);

      quotas[modelId] = {
        used,
        total,
        remaining,
        remainingPercentage: remainingFraction * 100,
        resetAt,
        unlimited: false,
        fractionReported: rawRemaining !== undefined,
        quotaSource: "retrieveUserQuota",
      };
    }
  }

  return {
    tier,
    tierMaxRpd,
    costPerRequestPercent,
    models: modelUsage,
    quotas,
    plan: tier === "ULTRA" ? "Ultra" : tier === "PRO" ? "Pro" : "Free",
  };
}

/**
 * Fetches real-time quota usage from Cloud Code PA :retrieveUserQuota API for Gemini CLI connections.
 */
export async function fetchGeminiCliUsage(
  connectionOrToken?:
    | string
    | {
        accessToken?: string;
        projectId?: string;
        tier?: string;
        providerSpecificData?: Record<string, unknown>;
        id?: string;
      },
  optionsOrProviderSpecificData?: { forceRefresh?: boolean } | Record<string, unknown>,
  connectionProjectId?: string,
  connectionId?: string,
  options?: { forceRefresh?: boolean }
): Promise<UsageSnapshot | { message: string }> {
  let accessToken: string | undefined;
  let projectId: string | undefined;
  let rawTier: string | undefined;
  let forceRefresh = false;

  if (typeof connectionOrToken === "string") {
    accessToken = connectionOrToken;
    if (
      optionsOrProviderSpecificData &&
      typeof optionsOrProviderSpecificData === "object" &&
      !("forceRefresh" in optionsOrProviderSpecificData)
    ) {
      const psd = optionsOrProviderSpecificData as Record<string, unknown>;
      projectId = (psd.projectId as string) || connectionProjectId;
      rawTier = (psd.tier as string) || (psd.tierCanonical as string);
    } else {
      projectId = connectionProjectId;
      if (optionsOrProviderSpecificData && "forceRefresh" in optionsOrProviderSpecificData) {
        forceRefresh = optionsOrProviderSpecificData.forceRefresh === true;
      }
    }
    if (options?.forceRefresh) {
      forceRefresh = true;
    }
  } else if (connectionOrToken && typeof connectionOrToken === "object") {
    accessToken = connectionOrToken.accessToken;
    projectId =
      connectionOrToken.projectId || (connectionOrToken.providerSpecificData?.projectId as string);
    rawTier =
      connectionOrToken.tier ||
      (connectionOrToken.providerSpecificData?.tier as string) ||
      (connectionOrToken.providerSpecificData?.tierCanonical as string);
    if (optionsOrProviderSpecificData && "forceRefresh" in optionsOrProviderSpecificData) {
      forceRefresh = optionsOrProviderSpecificData.forceRefresh === true;
    }
  }

  if (!accessToken) {
    return { message: "Gemini CLI access token not available." };
  }

  let canonicalTier: CanonicalTier = normalizeTierName(rawTier);

  let effectiveProjectId = projectId || process.env.GEMINI_CLI_PROJECT_ID;
  if (!effectiveProjectId) {
    try {
      const discovery = await discoverGeminiCliProjectAndTier(accessToken);
      effectiveProjectId = discovery.projectId;
      if (!rawTier) {
        canonicalTier = discovery.tierCanonical;
      }
    } catch {
      // Fall through to try retrieveUserQuota with empty project payload
    }
  }

  const cacheKey = `${accessToken.slice(0, 16)}:${effectiveProjectId || "default"}:${canonicalTier}`;
  if (!forceRefresh) {
    const cached = _geminiCliQuotaCache.get(cacheKey);
    if (cached && Date.now() - cached.fetchedAt < GEMINI_CLI_QUOTA_CACHE_TTL_MS) {
      return cached.data;
    }
  }

  const inflight = _geminiCliQuotaInflight.get(cacheKey);
  if (inflight) return inflight;

  const promise = (async (): Promise<UsageSnapshot> => {
    let response: Response | null = null;
    let lastError: Error | null = null;

    const headers = getGeminiCliAuthHeaders(accessToken!);
    const body = JSON.stringify(effectiveProjectId ? { project: effectiveProjectId } : {});

    for (const endpoint of GEMINI_CLI_QUOTA_ENDPOINTS) {
      try {
        response = await fetch(endpoint, {
          method: "POST",
          headers,
          body,
          signal: AbortSignal.timeout(10000),
        });

        if (response.ok) break;
      } catch (err) {
        lastError = err as Error;
      }
    }

    if (!response || !response.ok) {
      const status = response ? `HTTP ${response.status}` : lastError?.message || "Unknown error";
      throw new Error(`Failed to fetch Gemini CLI user quota: ${status}`);
    }

    const data = (await response.json()) as GeminiCliQuotaResponse;
    const snapshot = parseGeminiCliQuotaResponse(data, canonicalTier);
    snapshot.projectId = effectiveProjectId;
    snapshot.fetchedAt = Date.now();

    _geminiCliQuotaCache.set(cacheKey, { data: snapshot, fetchedAt: Date.now() });
    return snapshot;
  })().finally(() => {
    _geminiCliQuotaInflight.delete(cacheKey);
  });

  _geminiCliQuotaInflight.set(cacheKey, promise);

  try {
    return await promise;
  } catch (error) {
    return { message: (error as Error).message };
  }
}

export const getGeminiCliUsage = fetchGeminiCliUsage;
