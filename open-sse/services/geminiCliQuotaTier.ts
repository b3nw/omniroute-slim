export type GeminiCliQuotaTier = "pro" | "flash" | "flash_lite";

export const GEMINI_CLI_PROVIDERS = ["gemini-cli", "gemini_cli", "gcli"] as const;

/** Canonical grouped quota keys, in fixed display order. */
export const GEMINI_CLI_TIER_QUOTA_KEYS: Record<GeminiCliQuotaTier, string> = {
  pro: "gemini_cli_pro",
  flash: "gemini_cli_flash",
  flash_lite: "gemini_cli_flash_lite",
};

export const GEMINI_CLI_TIER_DISPLAY_NAMES: Record<GeminiCliQuotaTier, string> = {
  pro: "Gemini Pro Models",
  flash: "Gemini Flash Models",
  flash_lite: "Gemini Flash Lite Models",
};

/** Every quota key accepted as an alias of a tier's canonical key. */
export const GEMINI_CLI_TIER_QUOTA_ALIASES: Record<GeminiCliQuotaTier, string[]> = {
  pro: ["gemini_cli_pro", "gemini_pro", "pro"],
  flash: ["gemini_cli_flash", "gemini_flash", "flash"],
  flash_lite: [
    "gemini_cli_flash_lite",
    "gemini_flash_lite",
    "flash_lite",
    "gemini_cli_lite",
    "gemini_lite",
    "lite",
  ],
};

export function isGeminiCliProvider(provider: string | null | undefined): boolean {
  return (GEMINI_CLI_PROVIDERS as readonly string[]).includes(String(provider || "").toLowerCase());
}

/**
 * Classify a Gemini CLI model into the Cloud Code PA quota tier whose daily
 * request pool it shares. Lite is checked first because lite ids also contain
 * "-flash". Returns null for models outside the three shared pools.
 */
export function getGeminiCliQuotaTier(model: string | null | undefined): GeminiCliQuotaTier | null {
  const bare = String(model || "")
    .trim()
    .toLowerCase()
    .replace(/^.*\//, "");
  if (!bare) return null;
  // Tier tokens must be whole hyphen/underscore-delimited segments so ids such
  // as "gemini-prototype" or "gemini-flashcards" never classify by substring.
  if (/(?:^|[-_])(?:flash[-_])?lite(?:$|[-_.])/.test(bare)) return "flash_lite";
  if (/(?:^|[-_])pro(?:$|[-_.])/.test(bare)) return "pro";
  if (/(?:^|[-_])flash(?:$|[-_.])/.test(bare)) return "flash";
  return null;
}

/** Map a (canonical or alias) grouped quota key back to its tier. */
export function getGeminiCliTierForQuotaKey(quotaKey: string): GeminiCliQuotaTier | null {
  for (const tier of Object.keys(GEMINI_CLI_TIER_QUOTA_ALIASES) as GeminiCliQuotaTier[]) {
    if (GEMINI_CLI_TIER_QUOTA_ALIASES[tier].includes(quotaKey)) return tier;
  }
  return null;
}
