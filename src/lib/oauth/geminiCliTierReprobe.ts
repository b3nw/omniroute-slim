import {
  reprobeGeminiCliTierForProject,
  type GeminiCliDiscoveryResult,
} from "@omniroute/open-sse/services/geminiCliDiscovery.ts";

const GEMINI_CLI_PROVIDERS = new Set(["gemini-cli", "gemini_cli"]);
const DEFAULT_REPROBE_TIMEOUT_MS = 8_000;

type Reprobe = (
  accessToken: string,
  projectId: string,
  options?: { signal?: AbortSignal }
) => Promise<GeminiCliDiscoveryResult | null>;

/** Wraps the outbound probe, e.g. to bind the connection's upstream proxy context. */
type ProbeRunner = <T>(probe: () => Promise<T>) => Promise<T>;

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function isExpired(expiresAt: unknown, now: number): boolean {
  if (typeof expiresAt !== "string" && typeof expiresAt !== "number") return false;
  const ms = typeof expiresAt === "number" ? expiresAt : Date.parse(expiresAt);
  return Number.isFinite(ms) && ms <= now;
}

/**
 * Re-probe the Gemini CLI subscription tier when a connection is saved with a
 * GCP project ID (PUT /api/providers/[id]).
 *
 * Accounts authorized without a project are stored as `free-tier`; loadCodeAssist
 * only reports the real paid tier once it is called with the project. Runs when
 * the tier is not pinned manually AND the project changed, the user just switched
 * back to "auto", the stored tier is still FREE/unknown, or an earlier probe is
 * still pending.
 *
 * Best-effort: skipped without a live access token, bounded by a short timeout,
 * and a failed probe keeps the stored tier. Any probe that cannot be resolved
 * sets `pendingTierReprobe` so the next save or token refresh retries it. Mutates `updateData.providerSpecificData`
 * (seeded from the stored data on project-only updates).
 * Returns true when tier fields were updated.
 */
export async function applyGeminiCliTierReprobe(options: {
  existing: Record<string, unknown>;
  updateData: Record<string, unknown>;
  reprobe?: Reprobe;
  runProbe?: ProbeRunner;
  timeoutMs?: number;
  now?: number;
}): Promise<boolean> {
  const { existing, updateData } = options;
  if (!GEMINI_CLI_PROVIDERS.has(stringValue(existing.provider))) return false;

  const existingPsd =
    existing.providerSpecificData && typeof existing.providerSpecificData === "object"
      ? (existing.providerSpecificData as Record<string, unknown>)
      : {};

  // A project-only update (no providerSpecificData in the request) still needs a
  // re-probe: start from the stored data so the tier fields have somewhere to go.
  if (!updateData.providerSpecificData || typeof updateData.providerSpecificData !== "object") {
    updateData.providerSpecificData = { ...existingPsd };
  }
  const psd = updateData.providerSpecificData as Record<string, unknown>;
  if (psd.isTierManual === true) return false;

  const projectId =
    stringValue(updateData.projectId !== undefined ? updateData.projectId : existing.projectId) ||
    stringValue(psd.projectId);
  if (!projectId) return false;

  const previousProjectId = stringValue(existing.projectId) || stringValue(existingPsd.projectId);
  const projectChanged = projectId !== previousProjectId;
  const switchedToAuto = existingPsd.isTierManual === true;
  const tierUnknownOrFree = psd.tierCanonical !== "PRO" && psd.tierCanonical !== "ULTRA";
  const hasPendingProbe =
    existingPsd.pendingTierReprobe === true || psd.pendingTierReprobe === true;
  if (!projectChanged && !switchedToAuto && !tierUnknownOrFree && !hasPendingProbe) return false;

  const result = await probeTier(options, projectId);
  if (!result?.tier) {
    // Keep the stored tier, but flag the auto-managed tier for retry on the next
    // save or token refresh (project change, auto switch, or pending probe).
    psd.pendingTierReprobe = true;
    return false;
  }

  psd.tier = result.tier;
  psd.tierCanonical = result.tierCanonical;
  psd.tier_full = result.tier_full;
  delete psd.pendingTierReprobe;
  return true;
}

async function probeTier(
  options: Parameters<typeof applyGeminiCliTierReprobe>[0],
  projectId: string
): Promise<GeminiCliDiscoveryResult | null> {
  const { existing } = options;
  const accessToken = stringValue(existing.accessToken);
  if (!accessToken || isExpired(existing.expiresAt, options.now ?? Date.now())) return null;

  const reprobe = options.reprobe ?? reprobeGeminiCliTierForProject;
  const runProbe: ProbeRunner = options.runProbe ?? ((probe) => probe());
  try {
    return await runProbe(() =>
      reprobe(accessToken, projectId, {
        signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_REPROBE_TIMEOUT_MS),
      })
    );
  } catch (error) {
    console.warn("Gemini CLI tier re-probe failed:", error);
    return null;
  }
}
