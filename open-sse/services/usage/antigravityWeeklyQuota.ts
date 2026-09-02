/**
 * usage/antigravityWeeklyQuota.ts — Antigravity weekly-quota fetcher + parser (#4017).
 *
 * Antigravity enforces both a 5-hour window (already surfaced per-model by
 * `getAntigravityUsage()` via `retrieveUserQuota`) and a separate weekly window.
 * The weekly window is NOT part of the per-model `retrieveUserQuota` response —
 * it lives in a distinct upstream RPC, `v1internal:retrieveUserQuotaSummary`,
 * which groups models into families ("Gemini Models", "Claude and GPT models")
 * and reports one bucket per family per window (5h + weekly), keyed by a
 * `bucketId`/`displayName` pair rather than by individual modelId. There is no
 * dedicated window-type field on the bucket — the window is inferred from the
 * bucketId/displayName text (matches the reverse-engineered shape documented by
 * third-party Antigravity clients, since Google does not publish this API).
 *
 * This module is a small, self-contained leaf so `usage/antigravity.ts` stays a
 * thin caller: fetch (cached, best-effort) + pure parse, mirroring the existing
 * `fetchAntigravityUserQuotaCached` pattern.
 */

import { ANTIGRAVITY_RUNTIME_BASE_URLS } from "../../config/antigravityUpstream.ts";
import { toRecord, toNumber } from "./scalars.ts";
import { type UsageQuota, parseResetTime } from "./quota.ts";
import { getAntigravityContentHeaders } from "../antigravityHeaders.ts";
import type { AntigravityClientProfile } from "../antigravityClientProfile.ts";

type JsonRecord = Record<string, unknown>;

interface AntigravityWeeklyQuotaOptions {
  forceRefresh?: boolean;
}

const WEEKLY_QUOTA_CACHE_TTL_MS = 60 * 1000;
const _weeklyQuotaCache = new Map<string, { data: unknown; fetchedAt: number }>();
const _weeklyQuotaInflight = new Map<string, Promise<unknown>>();

// Self-contained purge timer — this leaf owns its own cache, so it owns the cleanup too
// (same pattern as usage/antigravity.ts's module-level caches).
const _weeklyQuotaCacheCleanupTimer = setInterval(
  () => {
    const now = Date.now();
    for (const [key, entry] of _weeklyQuotaCache) {
      if (now - entry.fetchedAt > WEEKLY_QUOTA_CACHE_TTL_MS) _weeklyQuotaCache.delete(key);
    }
  },
  5 * 60 * 1000
);
_weeklyQuotaCacheCleanupTimer.unref?.();

function buildCacheKey(
  accessToken: string,
  projectId: string | null | undefined,
  clientProfile: AntigravityClientProfile
): string {
  return `${accessToken.substring(0, 16)}:${projectId || "default"}:${clientProfile}`;
}

/**
 * Fetch the weekly-quota-bearing `retrieveUserQuotaSummary` response (cached, best-effort).
 * Returns `null` on any failure — callers must treat this as optional data, never a hard
 * dependency, since the RPC is undocumented and may not be available for every account/tier.
 */
export async function fetchAntigravityUserQuotaSummaryCached(
  accessToken: string,
  projectId?: string | null,
  clientProfile: AntigravityClientProfile = "ide",
  options: AntigravityWeeklyQuotaOptions = {}
): Promise<unknown | null> {
  if (!accessToken || !projectId) return null;

  const cacheKey = buildCacheKey(accessToken, projectId, clientProfile);
  const cached = _weeklyQuotaCache.get(cacheKey);
  if (
    !options.forceRefresh &&
    cached &&
    Date.now() - cached.fetchedAt < WEEKLY_QUOTA_CACHE_TTL_MS
  ) {
    return cached.data;
  }

  const inflight = _weeklyQuotaInflight.get(cacheKey);
  if (inflight !== undefined) return inflight;

  const promise = (async () => {
    try {
      for (const baseUrl of ANTIGRAVITY_RUNTIME_BASE_URLS) {
        const response = await fetch(
          `${baseUrl}/v1internal:retrieveUserQuotaSummary`,
          {
            method: "POST",
            headers: getAntigravityContentHeaders(clientProfile, accessToken),
            body: JSON.stringify({ project: projectId }),
            signal: AbortSignal.timeout(10000),
          }
        );

        if (!response.ok) continue;

        const data = await response.json();
        _weeklyQuotaCache.set(cacheKey, { data, fetchedAt: Date.now() });
        return data;
      }
      return null;
    } catch {
      return null;
    }
  })().finally(() => {
    _weeklyQuotaInflight.delete(cacheKey);
  });

  _weeklyQuotaInflight.set(cacheKey, promise);
  return promise;
}

const WEEKLY_KEYWORD = /\b(?:week(?:ly)?|7\s*d(?:ay)?s?|_7d)\b/i;
const FIVE_HOUR_KEYWORD = /\b(?:5\s*h(?:our)?s?|session|hourly|_5h)\b/i;

function classifyBucketWindow(bucket: JsonRecord): "5h" | "weekly" | null {
  const text = `${String(bucket.bucketId || "")} ${String(bucket.displayName || "")}`;
  if (WEEKLY_KEYWORD.test(text)) return "weekly";
  if (FIVE_HOUR_KEYWORD.test(text)) return "5h";
  return null;
}

/** Turns a group displayName (e.g. "Gemini Models", "Claude and GPT models") and window type into a quota key. */
function slugifyGroupKey(displayName: string, windowType: "5h" | "weekly"): string | null {
  const cleaned = String(displayName || "")
    .toLowerCase()
    .replace(/\bmodels?\b/g, "")
    .replace(/\band\b/g, " ")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return cleaned ? `${cleaned}_${windowType}` : null;
}

/**
 * Parse the raw `retrieveUserQuotaSummary` response into `UsageQuota` entries,
 * capturing both 5-hour (`*_5h`) and weekly (`*_weekly`) windows per model family group.
 * Tolerant of the two response envelopes third-party Antigravity clients have observed
 * (`groups[]` at the top level, or nested under `quotaSummary.groups[]`).
 */
export function parseAntigravitySummaryQuotas(summaryData: unknown): Record<string, UsageQuota> {
  const quotas: Record<string, UsageQuota> = {};
  for (const groupValue of extractSummaryGroups(summaryData)) {
    const group = toRecord(groupValue);
    const buckets = Array.isArray(group.buckets) ? group.buckets : [];
    for (const b of buckets) {
      if (!b || typeof b !== "object") continue;
      const bucket = toRecord(b);
      if (bucket.disabled === true) continue;

      const windowType = classifyBucketWindow(bucket);
      if (!windowType) continue;

      const key = slugifyGroupKey(String(group.displayName || ""), windowType);
      if (!key) continue;

      const rawFraction = toNumber(bucket.remainingFraction, -1);
      if (rawFraction < 0) continue;

      const remainingFraction = Math.max(0, Math.min(1, rawFraction));
      const resetAt = parseResetTime(bucket.resetTime);
      const isUnlimited = !resetAt && remainingFraction >= 1;
      const QUOTA_NORMALIZED_BASE = 1000;
      const total = QUOTA_NORMALIZED_BASE;
      const remaining = Math.round(total * remainingFraction);
      const groupDisplayName = String(group.displayName || "").trim();
      const windowLabel = windowType === "5h" ? "5h" : "Weekly";
      const displayName = groupDisplayName ? `${groupDisplayName} (${windowLabel})` : undefined;

      quotas[key] = {
        used: isUnlimited ? 0 : Math.max(0, total - remaining),
        total: isUnlimited ? 0 : total,
        resetAt,
        remainingPercentage: isUnlimited ? 100 : remainingFraction * 100,
        unlimited: isUnlimited,
        fractionReported: true,
        quotaSource: "retrieveUserQuota",
        displayName,
      };
    }
  }
  return quotas;
}

/** Backward-compatible alias that parses all summary quota windows. */
export const parseAntigravityWeeklyQuotas = parseAntigravitySummaryQuotas;

/** Extracts `groups[]` from either observed response envelope (top-level or nested). */
function extractSummaryGroups(summaryData: unknown): unknown[] {
  const root = toRecord(summaryData);
  if (Array.isArray(root.groups)) return root.groups;
  const nested = toRecord(root.quotaSummary).groups;
  return Array.isArray(nested) ? nested : [];
}

/** Fetch + parse in one call — the only entry point `usage/antigravity.ts` needs. */
export async function fetchAndParseAntigravityWeeklyQuotas(
  accessToken: string,
  projectId: string | undefined | null,
  clientProfile: AntigravityClientProfile = "ide",
  options: AntigravityWeeklyQuotaOptions = {}
): Promise<Record<string, UsageQuota>> {
  const data = await fetchAntigravityUserQuotaSummaryCached(
    accessToken,
    projectId,
    clientProfile,
    options
  );
  return parseAntigravitySummaryQuotas(data);
}

