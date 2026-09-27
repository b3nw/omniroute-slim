import {
  GEMINI_CLI_TIER_QUOTA_KEYS,
  getGeminiCliTierForQuotaKey,
  isGeminiCliProvider,
} from "@omniroute/open-sse/services/geminiCliQuotaTier.ts";

type JsonRecord = Record<string, unknown>;

export function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isAntigravitySummaryQuotaKey(quotaKey: string): boolean {
  return /^(?:gemini|claude|claude_gpt|gpt)_(?:weekly|5h|session)$/.test(quotaKey);
}

/** Gemini CLI tier-grouped quota keys (`gemini_cli_pro`, `gemini_flash`, `lite`, ...). */
export function isGeminiCliSummaryQuotaKey(quotaKey: string): boolean {
  return /^(?:gemini_cli_|gemini_)?(?:pro|flash|flash_lite|lite)$/.test(quotaKey);
}

export function isUsageQuotaKeyAllowed(provider: string, quotaKey: string): boolean {
  if (quotaKey === "credits" || quotaKey === "models") return true;
  if (provider === "antigravity" || provider === "agy") {
    return isAntigravitySummaryQuotaKey(quotaKey);
  }
  if (isGeminiCliProvider(provider)) {
    return isGeminiCliSummaryQuotaKey(quotaKey);
  }
  return true;
}

export function normalizeUsageQuotaKey(provider: string, quotaKey: string): string | null {
  if (quotaKey === "credits" || quotaKey === "models") return quotaKey;
  if (provider === "antigravity" || provider === "agy") {
    return isAntigravitySummaryQuotaKey(quotaKey) ? quotaKey : null;
  }
  if (isGeminiCliProvider(provider)) {
    // Legacy per-model keys (e.g. "gemini-2.5-pro") duplicate the shared tier pool;
    // tier aliases ("pro", "gemini_pro") collapse onto the canonical key so each
    // tier renders exactly one card.
    if (!isGeminiCliSummaryQuotaKey(quotaKey)) return null;
    const tier = getGeminiCliTierForQuotaKey(quotaKey);
    return tier ? GEMINI_CLI_TIER_QUOTA_KEYS[tier] : quotaKey;
  }
  return isUsageQuotaKeyAllowed(provider, quotaKey) ? quotaKey : null;
}

export function normalizeUsageQuotasForProvider(
  provider: string,
  quotas: JsonRecord | null | undefined
): JsonRecord | null {
  if (!isRecord(quotas)) return quotas ?? null;

  const normalized: JsonRecord = {};
  let changed = false;

  for (const [quotaKey, quota] of Object.entries(quotas)) {
    const normalizedKey = normalizeUsageQuotaKey(provider, quotaKey);
    if (!normalizedKey) {
      changed = true;
      continue;
    }
    // Mark before the rank check: a lower-ranked alias skipped below must still
    // force the normalized (deduplicated) object to be returned.
    if (normalizedKey !== quotaKey) changed = true;

    const existing = normalized[normalizedKey];
    if (existing && isRecord(existing) && isRecord(quota)) {
      const existingSource = String(existing.quotaSource ?? "");
      const nextSource = String(quota.quotaSource ?? "");
      const sourceRank: Record<string, number> = {
        fetchAvailableModels: 0,
        localUsageHistory: 1,
        retrieveUserQuota: 2,
      };
      if ((sourceRank[existingSource] ?? 0) > (sourceRank[nextSource] ?? 0)) {
        continue;
      }
    }

    normalized[normalizedKey] = quota as JsonRecord;
  }

  return changed ? normalized : quotas;
}

export function sanitizeUsageQuotasForProvider(provider: string, usage: JsonRecord): JsonRecord {
  if (provider !== "antigravity" && provider !== "agy" && !isGeminiCliProvider(provider)) {
    return usage;
  }
  if (!isRecord(usage.quotas)) return usage;

  const sanitizedQuotas = normalizeUsageQuotasForProvider(provider, usage.quotas);
  return sanitizedQuotas === usage.quotas ? usage : { ...usage, quotas: sanitizedQuotas };
}
