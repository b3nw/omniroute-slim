/**
 * Gemini CLI project and tier discovery — loadCodeAssist, onboardUser, and GCP scanning.
 *
 * Connects to Google's Cloud Code Assist API (cloudaicompanion.googleapis.com / cloudcode-pa.googleapis.com)
 * using the official Gemini CLI request fingerprint to discover the user's GCP project and subscription tier.
 */

export type CanonicalTier = "ULTRA" | "PRO" | "FREE";

export type GeminiCliDiscoveryResult = {
  projectId: string;
  tier: string;
  tierCanonical: CanonicalTier;
  tier_full: string;
  userEmail?: string;
};

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export const LOAD_CODE_ASSIST_ENDPOINTS = [
  "https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:loadCodeAssist",
  "https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist",
] as const;

export const ONBOARD_USER_ENDPOINTS = [
  "https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:onboardUser",
  "https://cloudcode-pa.googleapis.com/v1internal:onboardUser",
] as const;

const SERVICE_USAGE_API = "https://serviceusage.googleapis.com/v1";
const CRM_PROJECTS_URL = "https://cloudresourcemanager.googleapis.com/v1/projects";

const DEFAULT_UA_VERSION = "0.31.0";
const DEFAULT_NODE_CLIENT_VERSION = "10.6.1";
const DEFAULT_GL_NODE_VERSION = "22.17.1";
const DEFAULT_PLATFORM_ARCH = "win32; x64";
const DEFAULT_ACCEPT_ENCODING = "gzip, deflate, br";

export function getGeminiCliAuthHeaders(accessToken: string): Record<string, string> {
  const uaVersion = process.env.GEMINI_CLI_UA_VERSION || DEFAULT_UA_VERSION;
  const nodeClientVersion =
    process.env.GEMINI_CLI_NODE_CLIENT_VERSION || DEFAULT_NODE_CLIENT_VERSION;
  const glNodeVersion = process.env.GEMINI_CLI_GL_NODE_VERSION || DEFAULT_GL_NODE_VERSION;
  const platformArch = process.env.GEMINI_CLI_PLATFORM_ARCH || DEFAULT_PLATFORM_ARCH;
  const acceptEncoding = process.env.GEMINI_CLI_ACCEPT_ENCODING || DEFAULT_ACCEPT_ENCODING;

  return {
    Authorization: `Bearer ${accessToken}`,
    "Content-Type": "application/json",
    "User-Agent": `GeminiCLI/${uaVersion} (${platformArch}) google-api-nodejs-client/${nodeClientVersion}`,
    "X-Goog-Api-Client": `gl-node/${glNodeVersion}`,
    Accept: "*/*",
    "Accept-Encoding": acceptEncoding,
    Connection: "close",
  };
}

/**
 * Normalizes a raw tier identifier to canonical form ("ULTRA" | "PRO" | "FREE").
 */
export function normalizeTierName(tierId?: string | null): CanonicalTier {
  if (!tierId) return "FREE";
  const id = tierId.toLowerCase().trim();

  // ULTRA tiers
  if (
    id === "g1-ultra-tier" ||
    id === "gcp-enterprise-tier" ||
    id === "enterprise-tier" ||
    id === "ultra-tier" ||
    id === "gemini-code-assist-ultra" ||
    id === "ultra"
  ) {
    return "ULTRA";
  }

  // PRO tiers
  if (
    id === "g1-pro-tier" ||
    id === "gcp-standard-tier" ||
    id === "gemini-code-assist-pro" ||
    id === "standard-tier" ||
    id === "pro-tier" ||
    id === "pro"
  ) {
    return "PRO";
  }

  // FREE tiers
  return "FREE";
}

/**
 * Checks if a tier is considered a free tier.
 */
export function isFreeTier(tierId?: string | null): boolean {
  return normalizeTierName(tierId) === "FREE";
}

/**
 * Returns full descriptive display name for a tier.
 */
export function getTierFullName(tierId?: string | null): string {
  if (!tierId) return "FREE";
  const map: Record<string, string> = {
    "g1-ultra-tier": "Google One AI ULTRA",
    "gcp-enterprise-tier": "Code Assist Enterprise",
    "enterprise-tier": "ULTRA",
    "ultra-tier": "ULTRA",
    "gemini-code-assist-ultra": "Code Assist ULTRA",
    "g1-pro-tier": "Google One AI PRO",
    "gcp-standard-tier": "Code Assist Standard",
    "gemini-code-assist-pro": "Code Assist PRO",
    "standard-tier": "PRO",
    "pro-tier": "PRO",
    "g1-free-tier": "FREE",
    "gcp-free-tier": "FREE",
    "free-tier": "FREE",
    "legacy-tier": "FREE",
    "gemini-code-assist-free": "FREE",
  };
  return map[tierId] || normalizeTierName(tierId);
}

/**
 * Extracts cloudaicompanionProject ID from API response safely (handles string or object).
 */
export function extractProjectId(data: Record<string, unknown>): string {
  const project = data.cloudaicompanionProject;
  if (typeof project === "string") return project.trim();
  if (project && typeof project === "object" && !Array.isArray(project)) {
    const id = (project as Record<string, unknown>).id;
    if (typeof id === "string") return id.trim();
  }
  return "";
}

/**
 * Attempts fetch across ordered endpoints until first successful response.
 */
async function fetchFirstOk(
  endpoints: readonly string[],
  init: RequestInit,
  timeoutMs: number,
  fetchImpl: FetchLike = fetch,
  signal?: AbortSignal
): Promise<Response> {
  let lastError: unknown = null;
  for (const url of endpoints) {
    if (signal?.aborted) throw signal.reason;
    try {
      const timeoutSignal = AbortSignal.timeout(timeoutMs);
      const combinedSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
      const response = await fetchImpl(url, { ...init, signal: combinedSignal });
      if (response.ok) return response;
      lastError = new Error(
        `${url} returned HTTP ${response.status}: ${await response.text().catch(() => "")}`
      );
    } catch (err) {
      if (signal?.aborted || (err instanceof Error && err.name === "AbortError" && !signal)) {
        // continue to next endpoint on timeout
      }
      lastError = err;
    }
  }
  throw lastError || new Error("No endpoints succeeded");
}

type LoadCodeAssistResult = {
  projectId: string;
  tierId: string;
  rawResponse?: Record<string, unknown>;
};

/**
 * Calls loadCodeAssist to probe user session and subscription tiers.
 * For free accounts, cloudaicompanionProject is omitted to prevent HTTP 412.
 */
export async function tryLoadCodeAssist(
  accessToken: string,
  configuredProjectId?: string,
  fetchImpl: FetchLike = fetch,
  signal?: AbortSignal
): Promise<LoadCodeAssistResult | null> {
  const headers = getGeminiCliAuthHeaders(accessToken);
  const metadata: Record<string, unknown> = {
    ideType: "IDE_UNSPECIFIED",
    platform: "PLATFORM_UNSPECIFIED",
    pluginType: "GEMINI",
  };
  if (configuredProjectId) {
    metadata.duetProject = configuredProjectId;
  }

  const body: Record<string, unknown> = { metadata };
  if (configuredProjectId) {
    body.cloudaicompanionProject = configuredProjectId;
  }

  try {
    const response = await fetchFirstOk(
      LOAD_CODE_ASSIST_ENDPOINTS,
      {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      },
      15_000,
      fetchImpl,
      signal
    );

    const data = (await response.json()) as Record<string, unknown>;
    const projectId = extractProjectId(data);

    // Tier detection hierarchy: paidTier.id > currentTier.id > allowedTiers[isDefault] > allowedTiers[0] > "free-tier"
    const paidTier = data.paidTier as Record<string, unknown> | undefined;
    const currentTier = data.currentTier as Record<string, unknown> | undefined;
    const allowedTiers = (data.allowedTiers as Array<Record<string, unknown>>) || [];

    let tierId = "free-tier";
    if (typeof paidTier?.id === "string" && paidTier.id) {
      tierId = paidTier.id;
    } else if (typeof currentTier?.id === "string" && currentTier.id) {
      tierId = currentTier.id;
    } else {
      const defaultTier = allowedTiers.find((t) => t.isDefault === true);
      if (typeof defaultTier?.id === "string" && defaultTier.id) {
        tierId = defaultTier.id;
      } else if (
        allowedTiers.length > 0 &&
        typeof allowedTiers[0]?.id === "string" &&
        allowedTiers[0].id
      ) {
        tierId = allowedTiers[0].id;
      }
    }

    return { projectId, tierId, rawResponse: data };
  } catch {
    return null;
  }
}

/**
 * Scans active GCP projects and checks for cloudaicompanion.googleapis.com service enablement.
 */
export async function scanGcpProjectsForCodeAssist(
  accessToken: string,
  fetchImpl: FetchLike = fetch,
  signal?: AbortSignal
): Promise<{ projectId: string; tierId?: string } | null> {
  const headers = getGeminiCliAuthHeaders(accessToken);
  try {
    const timeoutSignal = AbortSignal.timeout(20_000);
    const combinedSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;

    const res = await fetchImpl(CRM_PROJECTS_URL, {
      method: "GET",
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: combinedSignal,
    });
    if (!res.ok) return null;

    const data = (await res.json()) as {
      projects?: Array<{ projectId: string; lifecycleState: string }>;
    };
    const activeProjects = (data.projects || []).filter((p) => p.lifecycleState === "ACTIVE");
    if (activeProjects.length === 0) return null;

    const candidateProjects: string[] = [];
    for (const p of activeProjects) {
      try {
        const svcUrl = `${SERVICE_USAGE_API}/projects/${p.projectId}/services/cloudaicompanion.googleapis.com`;
        const svcRes = await fetchImpl(svcUrl, {
          method: "GET",
          headers: { Authorization: `Bearer ${accessToken}` },
          signal: AbortSignal.timeout(10_000),
        });
        if (svcRes.ok) {
          const svcData = (await svcRes.json()) as { state?: string };
          if (svcData.state === "ENABLED") {
            candidateProjects.push(p.projectId);
          }
        }
      } catch {
        // continue checking next project
      }
    }

    if (candidateProjects.length === 0) return null;

    // Test candidate projects against loadCodeAssist
    for (const candidateId of candidateProjects) {
      try {
        const testReq = {
          cloudaicompanionProject: candidateId,
          metadata: {
            ideType: "IDE_UNSPECIFIED",
            platform: "PLATFORM_UNSPECIFIED",
            pluginType: "GEMINI",
            duetProject: candidateId,
          },
        };
        const probeRes = await fetchFirstOk(
          LOAD_CODE_ASSIST_ENDPOINTS,
          {
            method: "POST",
            headers,
            body: JSON.stringify(testReq),
          },
          15_000,
          fetchImpl,
          signal
        );

        if (probeRes.ok) {
          const probeData = (await probeRes.json()) as Record<string, unknown>;
          const paidTier = probeData.paidTier as Record<string, unknown> | undefined;
          const currentTier = probeData.currentTier as Record<string, unknown> | undefined;
          const tierId =
            (typeof paidTier?.id === "string" && paidTier.id) ||
            (typeof currentTier?.id === "string" && currentTier.id) ||
            "free-tier";
          return { projectId: candidateId, tierId };
        }
      } catch {
        // continue testing other candidates
      }
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * Triggers onboardUser and polls LRO if necessary.
 * For free tiers, cloudaicompanionProject MUST be omitted to avoid HTTP 412 Precondition Failed.
 */
export async function tryOnboardUser(
  accessToken: string,
  tierId: string = "free-tier",
  onboardProjectId?: string,
  fetchImpl: FetchLike = fetch,
  signal?: AbortSignal
): Promise<{ projectId?: string; tierId?: string } | null> {
  const headers = getGeminiCliAuthHeaders(accessToken);
  const isFree = isFreeTier(tierId);
  const effectiveProjectId = isFree ? undefined : onboardProjectId;

  const metadata: Record<string, unknown> = {
    ideType: "IDE_UNSPECIFIED",
    platform: "PLATFORM_UNSPECIFIED",
    pluginType: "GEMINI",
  };
  if (effectiveProjectId) {
    metadata.duetProject = effectiveProjectId;
  }

  const requestBody: Record<string, unknown> = {
    tierId,
    metadata,
  };
  if (effectiveProjectId) {
    requestBody.cloudaicompanionProject = effectiveProjectId;
  }

  const MAX_POLL_RETRIES = 15; // 15 polls * 2s = 30s
  const POLL_INTERVAL_MS = 2000;

  for (let attempt = 0; attempt < MAX_POLL_RETRIES; attempt++) {
    if (signal?.aborted) throw signal.reason;
    try {
      const response = await fetchFirstOk(
        ONBOARD_USER_ENDPOINTS,
        {
          method: "POST",
          headers,
          body: JSON.stringify(requestBody),
        },
        15_000,
        fetchImpl,
        signal
      );

      const data = (await response.json()) as Record<string, unknown>;
      if (data.done === true) {
        const resp = data.response as Record<string, unknown> | undefined;
        if (resp) {
          const extractedProject = extractProjectId(resp);
          const currentTier = resp.currentTier as Record<string, unknown> | undefined;
          const resTierId = typeof currentTier?.id === "string" ? currentTier.id : tierId;
          return { projectId: extractedProject || effectiveProjectId, tierId: resTierId };
        }
        return { projectId: effectiveProjectId, tierId };
      }
    } catch (err) {
      if (signal?.aborted) throw signal.reason;
      // Transient error, wait and retry
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  return null;
}

/**
 * Fallback: queries Resource Manager API and selects first active GCP project.
 */
export async function listFirstActiveGcpProject(
  accessToken: string,
  fetchImpl: FetchLike = fetch,
  signal?: AbortSignal
): Promise<string | null> {
  try {
    const timeoutSignal = AbortSignal.timeout(15_000);
    const combinedSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
    const res = await fetchImpl(CRM_PROJECTS_URL, {
      method: "GET",
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: combinedSignal,
    });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      projects?: Array<{ projectId: string; lifecycleState: string }>;
    };
    const active = (data.projects || []).find((p) => p.lifecycleState === "ACTIVE");
    return active ? active.projectId : null;
  } catch {
    return null;
  }
}

// In-memory memoization cache for discovered projects/tiers per access token
const discoveryCache = new Map<string, GeminiCliDiscoveryResult>();

export function clearGeminiCliProjectCache(): void {
  discoveryCache.clear();
}

export function getGeminiCliProjectFromCache(
  accessToken: string
): GeminiCliDiscoveryResult | undefined {
  return discoveryCache.get(accessToken);
}

/**
 * Main discovery orchestrator: discovers GCP Project ID and subscription tier.
 */
export async function discoverGeminiCliProjectAndTier(
  accessToken: string,
  options?: {
    projectId?: string;
    fetchImpl?: FetchLike;
    signal?: AbortSignal;
  }
): Promise<GeminiCliDiscoveryResult> {
  const fetchImpl = options?.fetchImpl || fetch;
  const signal = options?.signal;
  const configuredProjectId = options?.projectId || process.env.GEMINI_CLI_PROJECT_ID;

  const cached = discoveryCache.get(accessToken);
  if (cached && (!configuredProjectId || cached.projectId === configuredProjectId)) {
    return cached;
  }

  // 1. Try loadCodeAssist
  const lcaResult = await tryLoadCodeAssist(accessToken, configuredProjectId, fetchImpl, signal);

  let discoveredProjectId = lcaResult?.projectId || "";
  let rawTierId = lcaResult?.tierId || "free-tier";

  // 2. If loadCodeAssist returned configured project or server project
  if (!discoveredProjectId && configuredProjectId) {
    discoveredProjectId = configuredProjectId;
  }

  // 3. If tier is present but no project returned, scan GCP projects
  if (!discoveredProjectId && lcaResult) {
    const scanned = await scanGcpProjectsForCodeAssist(accessToken, fetchImpl, signal);
    if (scanned?.projectId) {
      discoveredProjectId = scanned.projectId;
      if (scanned.tierId) rawTierId = scanned.tierId;
    }
  }

  // 4. If still no project, attempt onboardUser
  if (!discoveredProjectId) {
    const onboarded = await tryOnboardUser(
      accessToken,
      rawTierId,
      configuredProjectId,
      fetchImpl,
      signal
    );
    if (onboarded?.projectId) {
      discoveredProjectId = onboarded.projectId;
      if (onboarded.tierId) rawTierId = onboarded.tierId;
    } else {
      // Retry loadCodeAssist once after onboarding
      const retryLca = await tryLoadCodeAssist(accessToken, configuredProjectId, fetchImpl, signal);
      if (retryLca?.projectId) {
        discoveredProjectId = retryLca.projectId;
        if (retryLca.tierId) rawTierId = retryLca.tierId;
      }
    }
  }

  // 5. Last-resort fallback: first active GCP project from Cloud Resource Manager
  if (!discoveredProjectId) {
    const activeProject = await listFirstActiveGcpProject(accessToken, fetchImpl, signal);
    if (activeProject) {
      discoveredProjectId = activeProject;
    }
  }

  if (!discoveredProjectId) {
    throw new Error(
      "Could not auto-discover Gemini CLI project ID. Please configure a GCP project ID via GEMINI_CLI_PROJECT_ID or provider settings."
    );
  }

  const tierCanonical = normalizeTierName(rawTierId);
  const tier_full = getTierFullName(rawTierId);

  const result: GeminiCliDiscoveryResult = {
    projectId: discoveredProjectId,
    tier: rawTierId,
    tierCanonical,
    tier_full,
  };

  discoveryCache.set(accessToken, result);
  return result;
}

/**
 * Parity helper for ensureAntigravityProjectAssigned.
 */
export async function ensureGeminiCliProjectAssigned(
  accessToken: string,
  fetchImpl: FetchLike = fetch,
  signal?: AbortSignal
): Promise<string> {
  const result = await discoverGeminiCliProjectAndTier(accessToken, { fetchImpl, signal });
  return result.projectId;
}
