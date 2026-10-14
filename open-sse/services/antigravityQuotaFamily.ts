export type AntigravityQuotaFamily = "gemini" | "claude" | "other";

function normalizeModelId(model: string | null | undefined): string {
  return String(model || "")
    .trim()
    .toLowerCase();
}

/**
 * Classify Antigravity models by the quota bucket Google Cloud Code/Antigravity
 * appears to enforce. This is intentionally conservative:
 * - gemini-* / google/gemini-* variants share the Gemini family quota.
 * - claude-* and legacy cloud-* aliases are treated as the Claude/Cloud family.
 * - unknown models remain exact-model scoped for compatibility.
 */
export function getAntigravityQuotaFamily(
  model: string | null | undefined
): AntigravityQuotaFamily {
  const bare = normalizeModelId(model)
    .replace(/^(?:antigravity|agy)\//, "")
    .replace(/^.*\//, "");

  if (
    bare.startsWith("gemini-") ||
    bare.startsWith("gemini_") ||
    bare.includes("/gemini-") ||
    bare.includes("gemini")
  ) {
    return "gemini";
  }
  if (
    bare.startsWith("claude-") ||
    bare.startsWith("cloud-") ||
    bare.startsWith("gpt-") ||
    bare.includes("/claude-") ||
    bare.includes("/cloud-") ||
    bare.includes("/gpt-") ||
    bare.includes("claude") ||
    bare.includes("anthropic") ||
    bare.includes("claude_gpt")
  ) {
    return "claude";
  }
  return "other";
}

export function getQuotaScopedModelForProvider(
  provider: string | null | undefined,
  model: string | null | undefined
): string | null {
  if (!model) return null;
  if (provider !== "antigravity" && provider !== "agy") return model;
  const family = getAntigravityQuotaFamily(model);
  return family === "other" ? model : `family:${family}`;
}

export function getQuotaScopeLabelForProvider(
  provider: string | null | undefined,
  model: string | null | undefined
): string {
  if (provider !== "antigravity" && provider !== "agy") return "model";
  return getAntigravityQuotaFamily(model) === "other" ? "model" : "family";
}

export function getQuotaFetchScope(
  provider: string | null | undefined,
  model: string | null | undefined
): string {
  if (provider !== "antigravity" && provider !== "agy") return "*";
  return getQuotaScopedModelForProvider(provider, model) ?? "*";
}

export function isAntigravityQuotaProvider(provider: string | null | undefined): boolean {
  return provider === "antigravity" || provider === "agy";
}

export function quotaWindowNamesForScope(
  names: string[],
  scope?: { provider?: string | null; requestedModel?: string | null }
): string[] {
  if (!scope?.requestedModel || !isAntigravityQuotaProvider(scope.provider)) return names;
  const scoped = selectAntigravityQuotaWindowNames(names, scope.requestedModel);
  if (scoped.length > 0) return scoped;
  // A family-scoped request whose family reports no window must not be judged by the
  // other family's buckets (Claude weekly must not ride along on a Gemini request).
  return getAntigravityQuotaFamily(scope.requestedModel) === "other" ? names : scoped;
}

/** Min remaining % across scoped windows, or 100 when an Antigravity family scope matched none. */
export function remainingPercentFromQuotaWindows(
  rawWindows: Record<string, unknown>,
  scope?: { provider?: string | null; requestedModel?: string | null }
): number | null {
  const names = Object.keys(rawWindows);
  const namesToScan = quotaWindowNamesForScope(names, scope);
  let minRemaining: number | null = null;
  for (const name of namesToScan) {
    const windowInfo = rawWindows[name];
    if (!windowInfo || typeof windowInfo !== "object") continue;
    const percentUsed = Number((windowInfo as Record<string, unknown>).percentUsed);
    if (!Number.isFinite(percentUsed)) continue;
    const remaining = Math.max(0, Math.min(100, (1 - percentUsed) * 100));
    minRemaining = minRemaining === null ? remaining : Math.min(minRemaining, remaining);
  }
  if (minRemaining !== null) return minRemaining;
  if (scope?.requestedModel && namesToScan !== names) return 100;
  return null;
}

/**
 * Windows that belong to the requested Antigravity family. Claude weekly must
 * not ride along on a Gemini request (and the reverse). Shared by the quota
 * cache predicates and combo quota ranking.
 */
export function selectAntigravityQuotaWindowNames(
  quotaNames: string[],
  requestedModel: string | null | undefined
): string[] {
  if (!requestedModel) return quotaNames;
  const requestedFamily = getAntigravityQuotaFamily(requestedModel);
  const cleanRequestedModel = requestedModel.replace(/^(antigravity|agy)\//, "");
  const bareModel = cleanRequestedModel.includes("/")
    ? cleanRequestedModel.slice(cleanRequestedModel.lastIndexOf("/") + 1)
    : cleanRequestedModel;

  if (requestedFamily === "other") {
    return quotaNames.filter((windowName) => {
      const bare = windowName.replace(/^(antigravity|agy)\//, "");
      return bare === bareModel || bare === cleanRequestedModel;
    });
  }

  const familyAggregates =
    requestedFamily === "gemini"
      ? ["gemini_5h", "gemini_weekly"]
      : ["claude_gpt_5h", "claude_gpt_weekly", "claude_5h", "claude_weekly"];

  const exactWindows = quotaNames.filter((windowName) => {
    const bare = windowName.replace(/^(antigravity|agy)\//, "");
    return bare === bareModel;
  });
  const aggregateWindows = familyAggregates.filter((key) => quotaNames.includes(key));
  const scoped = [...exactWindows, ...aggregateWindows];
  if (scoped.length > 0) return scoped;

  // For Claude family, all models share the single aggregate quota pool if mapped under Claude model names.
  // For Gemini family, individual models have separate buckets and MUST NOT fall back to unrelated sibling models.
  if (requestedFamily === "claude") {
    return quotaNames.filter((windowName) => getAntigravityQuotaFamily(windowName) === "claude");
  }

  return [];
}
