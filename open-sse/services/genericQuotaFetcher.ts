/**
 * genericQuotaFetcher.ts — Generic preflight quota fetcher
 *
 * Wraps the existing per-provider usage fetchers in `usage.ts` so that any
 * provider with a `getUsageForProvider` implementation gets per-window
 * preflight enforcement automatically. This is the bridge between the
 * dashboard's "Provider Limits" data (which already supports ~16 providers)
 * and the quotaPreflight system (which previously only had Codex).
 *
 * For providers that ship their own custom QuotaFetcher (Codex, CROF,
 * DeepSeek, Bailian Coding Plan, etc.) the registrar skips them — their
 * bespoke fetchers stay in charge.
 *
 * Each provider's first successful response also populates the static
 * `registerQuotaWindows` registry so other callers (UI window catalog,
 * tests) can discover which windows that provider exposes.
 */

import { getUsageForProvider, USAGE_FETCHER_PROVIDERS } from "./usage.ts";
import {
  getQuotaFetcher,
  registerQuotaFetcher,
  registerQuotaWindows,
  type QuotaFetcher,
  type QuotaInfo,
} from "./quotaPreflight.ts";
import { getAntigravityQuotaFamily, getQuotaFetchScope } from "./antigravityQuotaFamily.ts";
import { boundedMap } from "../../src/lib/quota/boundedMap.ts";

type UsageFetcher = (connection: Parameters<typeof getUsageForProvider>[0]) => Promise<unknown>;

let usageFetcherOverride: UsageFetcher | null = null;

// 60s — matches Codex's TTL. Long enough to avoid hammering upstream usage
// endpoints on every routing decision, short enough that a near-exhausted
// account is skipped within one minute of crossing its threshold.
const CACHE_TTL_MS = 60_000;

// One entry per (provider, connection[, Antigravity family]); 4096 keeps very
// large pools from evicting.
const cache = boundedMap<QuotaInfo>("quota-fetcher-cache", 4096, "ttl", CACHE_TTL_MS);

function connectionKey(provider: string, connectionId: string): string {
  return `${provider}::${connectionId}`;
}

// #12637 — Antigravity Gemini and Claude families have independent quota
// buckets, so their converted QuotaInfo is cached per family; every other
// provider keeps one entry per connection (scope `*`).
function cacheKey(provider: string, connectionId: string, requestedModel?: string | null): string {
  return `${connectionKey(provider, connectionId)}::${getQuotaFetchScope(provider, requestedModel)}`;
}

// Auto-cleanup stale entries — same shape as codexQuotaFetcher.
const _cacheCleanup = setInterval(() => {
  // ttl reads purge expired entries.
  for (const key of cache.keys()) cache.get(key);
}, 5 * 60_000);
if (typeof _cacheCleanup === "object" && "unref" in _cacheCleanup) {
  (_cacheCleanup as { unref?: () => void }).unref?.();
}

function toNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = parseFloat(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

/**
 * Compute percentUsed (0-1) for a single quota entry. Prefers the explicit
 * remainingPercentage / used / total fields surfaced by per-provider
 * fetchers (see `usage.ts`). Returns null when the entry is unlimited or
 * doesn't expose enough data to compute a percent — preflight ignores
 * those windows.
 */
function percentUsedForQuota(entry: unknown): number | null {
  if (!entry || typeof entry !== "object") return null;
  const q = entry as Record<string, unknown>;
  if (q.unlimited === true) return null;
  // Upstream explicitly told us it did not report this window's fraction
  // (e.g. Antigravity per-model quota with no usage data yet). Treat as
  // unknown rather than defaulting remainingPercentage:0 into "100% used" —
  // otherwise one unreported model falsely exhausts the whole connection.
  if (q.fractionReported === false) return null;

  const remainingPercentage = toNumber(q.remainingPercentage);
  if (remainingPercentage !== null) {
    // remainingPercentage is 0-100 in the usage.ts contract.
    const used = (100 - Math.max(0, Math.min(100, remainingPercentage))) / 100;
    return used;
  }

  const used = toNumber(q.used);
  const total = toNumber(q.total);
  if (used !== null && total !== null && total > 0) {
    return Math.max(0, Math.min(1, used / total));
  }

  return null;
}

function resetAtForQuota(entry: unknown): string | null {
  if (!entry || typeof entry !== "object") return null;
  const q = entry as Record<string, unknown>;
  return typeof q.resetAt === "string" ? q.resetAt : null;
}

interface ConnectionInputs {
  id?: string;
  provider?: string;
  accessToken?: string;
  apiKey?: string;
  providerSpecificData?: Record<string, unknown>;
  projectId?: string;
  email?: string;
}

/**
 * Reshape a raw `getUsageForProvider` response into the preflight `QuotaInfo`
 * contract. Returns `null` if there are no measurable windows (all unlimited
 * / shape-unknown / missing). Exported for unit testing — the production path
 * is `fetchGenericQuota`, which adds caching + the upstream call.
 */
type UsageToQuotaContext = {
  requestedModel?: string | null;
  provider?: string | null;
};

export function convertUsageToQuotaInfo(
  usage: unknown,
  context: UsageToQuotaContext = {}
): QuotaInfo | null {
  if (!usage || typeof usage !== "object") return null;
  const usageRecord = usage as Record<string, unknown>;
  if (
    typeof usageRecord.message === "string" &&
    (!usageRecord.quotas || typeof usageRecord.quotas !== "object")
  ) {
    // Provider explicitly told us it couldn't fetch (auth expired, etc.).
    // Fail open — let the request proceed and surface the failure through
    // its normal error path.
    return null;
  }

  const quotasObj = usageRecord.quotas;
  if (!quotasObj || typeof quotasObj !== "object" || Array.isArray(quotasObj)) {
    return null;
  }

  const windows: Record<string, { percentUsed: number; resetAt: string | null }> = {};
  for (const [name, entry] of Object.entries(quotasObj as Record<string, unknown>)) {
    const percentUsed = percentUsedForQuota(entry);
    if (percentUsed === null) continue;
    windows[name] = { percentUsed, resetAt: resetAtForQuota(entry) };
  }

  if (Object.keys(windows).length === 0) return null;

  // #12637 — a Gemini request must not see an exhausted Claude family bucket
  // (and vice versa); only the requested family's windows are evaluated.
  const requestedFamily = requestedAntigravityFamily(context);
  const providerScopedWindows =
    requestedFamily === "gemini" || requestedFamily === "claude"
      ? Object.fromEntries(
          Object.entries(windows).filter(([key]) => {
            if (key.endsWith("_weekly")) {
              return antigravityWeeklyWindowMatchesFamily(key, requestedFamily);
            }
            return getAntigravityQuotaFamily(key) === requestedFamily;
          })
        )
      : windows;
  if (Object.keys(providerScopedWindows).length === 0) return null;

  const normalized = normalizeQuotaWindows(providerScopedWindows, context);
  const scopedEntries = Object.values(providerScopedWindows);
  const percentUsed = scopedEntries.reduce(
    (worst, entry) => Math.max(worst, entry.percentUsed),
    0
  );
  const resetAt =
    scopedEntries.reduce<{ percentUsed: number; resetAt: string | null } | null>(
      (worst, entry) => (!worst || entry.percentUsed > worst.percentUsed ? entry : worst),
      null
    )?.resetAt ?? null;

  return {
    used: 0,
    total: 0,
    percentUsed,
    resetAt,
    windows: providerScopedWindows,
    ...normalized,
    limitReached: percentUsed >= 1 - 1e-9,
  };
}

function isAntigravityProvider(provider: string | null | undefined): boolean {
  return provider === "antigravity" || provider === "agy";
}

function requestedAntigravityFamily(context: UsageToQuotaContext) {
  return isAntigravityProvider(context.provider) && context.requestedModel
    ? getAntigravityQuotaFamily(context.requestedModel)
    : null;
}

function antigravityWeeklyWindowMatchesFamily(key: string, family: "gemini" | "claude"): boolean {
  if (!key.endsWith("_weekly")) return false;
  return family === "gemini" ? key === "gemini_weekly" : key === "claude_gpt_weekly";
}

/**
 * Map provider-native window keys to canonical structural windows so that
 * reset-aware / reset-window scoring works without knowing every provider's
 * naming convention.
 *
 *   - Claude: "session (5h)" → window5h, "weekly (7d)" → window7d
 *   - Antigravity: requested-family model quota → window5h; matching family weekly quota → window7d
 */
function normalizeQuotaWindows(
  windows: Record<string, { percentUsed: number; resetAt: string | null }>,
  context: UsageToQuotaContext
): Record<string, { percentUsed: number; resetAt: string | null }> {
  const normalized: Record<string, { percentUsed: number; resetAt: string | null }> = {};
  const requestedFamily = requestedAntigravityFamily(context);

  // Claude-style explicit time windows.
  if (windows["session (5h)"] && !normalized.window5h) {
    normalized.window5h = windows["session (5h)"];
  }
  if (windows["weekly (7d)"] && !normalized.window7d) {
    normalized.window7d = windows["weekly (7d)"];
  }

  // Antigravity-style per-model windows: pick worst only inside requested family.
  const modelWindows = Object.entries(windows).filter(
    ([key]) =>
      key !== "credits" &&
      !key.endsWith("_weekly") &&
      !key.startsWith("window") &&
      !key.includes("(5h)") &&
      !key.includes("(7d)") &&
      (requestedFamily === null ||
        requestedFamily === "other" ||
        getAntigravityQuotaFamily(key) === requestedFamily)
  );
  if (modelWindows.length > 0 && !normalized.window5h) {
    const worst = modelWindows.reduce((a, b) => (a[1].percentUsed > b[1].percentUsed ? a : b));
    normalized.window5h = worst[1];
  }

  // Antigravity-style weekly buckets: pick worst only inside requested family.
  const weeklyWindows = Object.entries(windows).filter(([key]) => {
    const hasFamilyScope = requestedFamily === "gemini" || requestedFamily === "claude";
    return (
      key.endsWith("_weekly") &&
      (!hasFamilyScope || antigravityWeeklyWindowMatchesFamily(key, requestedFamily))
    );
  });
  if (weeklyWindows.length > 0 && !normalized.window7d) {
    const worst = weeklyWindows.reduce((a, b) => (a[1].percentUsed > b[1].percentUsed ? a : b));
    normalized.window7d = worst[1];
  }

  return normalized;
}

/**
 * Fetch quota for a connection by delegating to the appropriate
 * provider-specific usage fetcher and reshaping its output into the
 * preflight `QuotaInfo` contract (with a `windows` map for per-window
 * threshold evaluation).
 */
export const fetchGenericQuota: QuotaFetcher = async (connectionId, connection) => {
  if (!connection) return null;
  const conn = connection as ConnectionInputs;
  const provider = typeof conn.provider === "string" ? conn.provider : null;
  if (!provider) return null;

  const requestedModel =
    typeof connection.requestedModel === "string" ? connection.requestedModel : undefined;
  const key = cacheKey(provider, connectionId, requestedModel);
  const cached = cache.get(key);
  if (cached !== undefined) return cached;

  let usage: unknown;
  try {
    const fetchUsage = usageFetcherOverride ?? getUsageForProvider;
    usage = await fetchUsage(conn as Parameters<typeof getUsageForProvider>[0]);
  } catch {
    return null;
  }

  const quota = convertUsageToQuotaInfo(usage, { provider, requestedModel });
  if (!quota) return null;

  // Refresh the static window catalog from the unscoped usage payload so a
  // family-scoped request cannot hide sibling-family dashboard controls.
  const unscopedQuota = convertUsageToQuotaInfo(usage, { provider });
  registerQuotaWindows(provider, Object.keys(unscopedQuota?.windows || quota.windows || {}));

  cache.set(key, quota);
  return quota;
};

/**
 * Force-invalidate the cache for a connection — call after the connection
 * receives an upstream 429 / quota-reset event so the next preflight gets
 * fresh data instead of a 60s stale window.
 */
export function invalidateGenericQuotaCache(provider: string, connectionId: string): void {
  const prefix = `${connectionKey(provider, connectionId)}::`;
  for (const key of cache.keys()) {
    if (key.startsWith(prefix)) cache.delete(key);
  }
}

/**
 * Register the generic fetcher for every provider that has a usage
 * implementation. Providers with bespoke fetchers (Codex, CROF, DeepSeek,
 * Bailian Coding Plan) MUST be registered before this runs so the defensive
 * `getQuotaFetcher` check below preserves them — see `src/sse/handlers/chat.ts`
 * for the registration order. Idempotent: re-running this is a no-op.
 */
export function registerGenericQuotaFetchers(): void {
  for (const provider of USAGE_FETCHER_PROVIDERS) {
    if (getQuotaFetcher(provider)) continue; // bespoke fetcher already registered — leave it alone
    registerQuotaFetcher(provider, fetchGenericQuota);
  }
}

export const __testing = {
  setUsageFetcher(fetcher: UsageFetcher): void {
    usageFetcherOverride = fetcher;
  },
  resetUsageFetcher(): void {
    usageFetcherOverride = null;
  },
  clearCache(): void {
    cache.clear();
  },
};
