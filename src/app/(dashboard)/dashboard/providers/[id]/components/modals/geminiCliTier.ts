/**
 * Gemini CLI subscription tier selector helpers.
 *
 * An account authorized before a GCP project was configured is stored as
 * `free-tier`. The connection modal lets the user either keep the discovered
 * tier ("auto" — re-probed server-side via loadCodeAssist once a project is set)
 * or pin one manually. A pinned tier is flagged `isTierManual` so discovery and
 * the save-time re-probe leave it alone.
 *
 * Pure helpers so the UI mapping can be unit-tested without a DOM.
 */

export const GEMINI_CLI_TIER_PROVIDERS: ReadonlySet<string> = new Set(["gemini-cli", "gemini_cli"]);

/** Dropdown value: "auto" keeps the discovered tier; the rest pin a canonical tier. */
export type GeminiCliTierSetting = "auto" | "FREE" | "PRO" | "ULTRA";

export const GEMINI_CLI_TIER_OPTIONS: ReadonlyArray<{
  value: GeminiCliTierSetting;
  labelKey: string;
}> = [
  { value: "auto", labelKey: "geminiCliTierAuto" },
  { value: "FREE", labelKey: "geminiCliTierFree" },
  { value: "PRO", labelKey: "geminiCliTierPro" },
  { value: "ULTRA", labelKey: "geminiCliTierUltra" },
];

// Raw Code Assist tier ids whose normalizeTierName()/getTierFullName() round-trip
// to the selected canonical tier (see open-sse/services/geminiCliDiscovery.ts).
const MANUAL_TIER_FIELDS: Record<
  Exclude<GeminiCliTierSetting, "auto">,
  { tier: string; tier_full: string }
> = {
  FREE: { tier: "free-tier", tier_full: "FREE" },
  PRO: { tier: "standard-tier", tier_full: "PRO" },
  ULTRA: { tier: "enterprise-tier", tier_full: "ULTRA" },
};

export function isGeminiCliTierProvider(provider?: string | null): boolean {
  return !!provider && GEMINI_CLI_TIER_PROVIDERS.has(provider);
}

/** Map stored providerSpecificData to the dropdown value. */
export function readGeminiCliTierSetting(psd: unknown): GeminiCliTierSetting {
  if (!psd || typeof psd !== "object") return "auto";
  const record = psd as Record<string, unknown>;
  if (record.isTierManual !== true) return "auto";
  const canonical = record.tierCanonical;
  return canonical === "FREE" || canonical === "PRO" || canonical === "ULTRA" ? canonical : "auto";
}

/**
 * Apply the selected tier onto a providerSpecificData target.
 *
 * A manual tier writes `tier`, `tierCanonical` and `tier_full`. "auto" only
 * clears the manual flag and keeps the stored (discovered) tier fields — the
 * PUT route re-probes them when a project ID is configured. Pinning a tier drops
 * any pending re-probe.
 */
export function applyGeminiCliTier(
  target: Record<string, unknown>,
  setting: GeminiCliTierSetting
): void {
  if (setting === "auto") {
    target.isTierManual = false;
    return;
  }
  const fields = MANUAL_TIER_FIELDS[setting];
  if (!fields) return;
  target.tier = fields.tier;
  target.tierCanonical = setting;
  target.tier_full = fields.tier_full;
  target.isTierManual = true;
  delete target.pendingTierReprobe;
}
