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
  const bare = normalizeModelId(model).replace(/^(?:antigravity|agy)\//, "").replace(/^.*\//, "");

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
