import { getActiveClientVersion } from "@/lib/client-versions/registry";

const ANTIGRAVITY_APP_RELEASE_URL =
  "https://antigravity-hub-auto-updater-974169037036.us-central1.run.app/manifest/latest-arm64-mac.yml";
const ANTIGRAVITY_CLI_RELEASE_URL =
  "https://api.github.com/repos/google-antigravity/antigravity-cli/releases/latest";

export const ANTIGRAVITY_VERSION_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
export const ANTIGRAVITY_VERSION_FETCH_TIMEOUT_MS = 5_000;
// Floor used only when the Hub manifest cannot be read. The Hub feed is authoritative;
// keep this at or above the version upstream currently requires for current models.
export const ANTIGRAVITY_APP_FALLBACK_VERSION = "2.24.0";
export const ANTIGRAVITY_CLI_FALLBACK_VERSION = "1.1.5";

type VersionCache = {
  fetchedAt: number;
  version: string;
};

type ProductVersionState = {
  cache: VersionCache | null;
  inFlight: Promise<string> | null;
};

type FetchLike = typeof fetch;
type VersionParser = (payload: unknown) => string | null;

const appState: ProductVersionState = { cache: null, inFlight: null };
const cliState: ProductVersionState = { cache: null, inFlight: null };

function normalizeVersion(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().replace(/^v/i, "");
  const match = trimmed.match(/^(\d+\.\d+\.\d+)\b/);
  return match ? match[1] : null;
}

function compareSemver(a: string, b: string): number {
  const aParts = a.split(".").map((part) => Number.parseInt(part, 10) || 0);
  const bParts = b.split(".").map((part) => Number.parseInt(part, 10) || 0);
  for (let i = 0; i < 3; i += 1) {
    if (aParts[i] !== bParts[i]) return aParts[i] - bParts[i];
  }
  return 0;
}

function pickNewestVersion(...versions: unknown[]): string | null {
  return versions
    .map((version) => normalizeVersion(version))
    .filter((version): version is string => !!version)
    .reduce<string | null>(
      (best, version) => (!best || compareSemver(version, best) > 0 ? version : best),
      null
    );
}

async function fetchPayloadWithTimeout(fetchImpl: FetchLike, url: string): Promise<unknown> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), ANTIGRAVITY_VERSION_FETCH_TIMEOUT_MS);

  try {
    const response = await fetchImpl(url, {
      // Feeds differ: the Hub publishes a YAML updater manifest, the CLI feed is JSON.
      headers: {
        Accept: "application/json, text/yaml, text/plain, */*",
        "User-Agent": "OmniRoute-AntigravityVersion/1.0",
      },
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`Version source ${url} returned ${response.status}`);
    }

    return await response.text();
  } finally {
    clearTimeout(timeoutId);
  }
}

function parseAppReleaseManifest(payload: unknown): string | null {
  // The Hub serves an electron-builder `latest-*.yml` manifest, not JSON:
  //   version: 2.24.0
  //   files:
  //     - url: https://storage.googleapis.com/antigravity-public/...
  //   path: Antigravity.zip
  //   sha512: ...
  // Only the top-level `version:` line carries the App release version; the `files:`
  // block has no version key, so a plain line parse is sufficient and dependency-free.
  if (typeof payload !== "string") return null;
  const match = payload.match(/^version:\s*(\d+\.\d+\.\d+)\s*$/m);
  return match ? match[1] : null;
}

function parseCliRelease(payload: unknown): string | null {
  // The CLI feed is GitHub's JSON API; `fetchPayloadWithTimeout` returns raw text so the
  // YAML App manifest can share the same fetch path.
  let parsed: unknown = payload;
  if (typeof payload === "string") {
    try {
      parsed = JSON.parse(payload);
    } catch {
      return null;
    }
  }
  if (!parsed || typeof parsed !== "object") return null;
  const release = parsed as { name?: unknown; tag_name?: unknown };
  return normalizeVersion(release.tag_name ?? release.name);
}

async function resolveProductVersion(
  state: ProductVersionState,
  fallbackVersion: string,
  sourceUrl: string,
  parsePayload: VersionParser,
  fetchImpl: FetchLike
): Promise<string> {
  const now = Date.now();
  if (state.cache && now - state.cache.fetchedAt < ANTIGRAVITY_VERSION_CACHE_TTL_MS) {
    return pickNewestVersion(state.cache.version, fallbackVersion) ?? fallbackVersion;
  }

  if (state.inFlight) {
    return state.inFlight;
  }

  state.inFlight = (async () => {
    let resolved: string | null = null;
    try {
      resolved = parsePayload(await fetchPayloadWithTimeout(fetchImpl, sourceUrl));
    } catch {
      resolved = null;
    }

    const version =
      pickNewestVersion(resolved, state.cache?.version, fallbackVersion) ?? fallbackVersion;

    if (resolved) {
      state.cache = {
        fetchedAt: Date.now(),
        version,
      };
    }
    return version;
  })();

  try {
    return await state.inFlight;
  } finally {
    state.inFlight = null;
  }
}

function seedVersionCache(state: ProductVersionState, version: string, fetchedAt: number): void {
  const normalized = normalizeVersion(version);
  if (!normalized) {
    throw new TypeError(`Invalid Antigravity version: ${version}`);
  }
  state.cache = { fetchedAt, version: normalized };
}

/**
 * Resolve the Antigravity **App** (Hub) version from its electron-builder updater
 * manifest. The App replaced the Antigravity IDE as the surface that receives current
 * model access, so this is what the default identity reports.
 */
export function resolveAntigravityAppVersion(fetchImpl: FetchLike = fetch): Promise<string> {
  const dynamic = getActiveClientVersion("antigravity");
  if (dynamic) return Promise.resolve(dynamic);
  return resolveProductVersion(
    appState,
    ANTIGRAVITY_APP_FALLBACK_VERSION,
    ANTIGRAVITY_APP_RELEASE_URL,
    parseAppReleaseManifest,
    fetchImpl
  );
}

export function resolveAntigravityCliVersion(fetchImpl: FetchLike = fetch): Promise<string> {
  const dynamic = getActiveClientVersion("antigravity-cli");
  if (dynamic) return Promise.resolve(dynamic);
  return resolveProductVersion(
    cliState,
    ANTIGRAVITY_CLI_FALLBACK_VERSION,
    ANTIGRAVITY_CLI_RELEASE_URL,
    parseCliRelease,
    fetchImpl
  );
}

export function getCachedAntigravityAppVersion(): string {
  return (
    getActiveClientVersion("antigravity") ??
    appState.cache?.version ??
    ANTIGRAVITY_APP_FALLBACK_VERSION
  );
}

export function getCachedAntigravityCliVersion(): string {
  return (
    getActiveClientVersion("antigravity-cli") ??
    cliState.cache?.version ??
    ANTIGRAVITY_CLI_FALLBACK_VERSION
  );
}

export function seedAntigravityAppVersionCache(version: string, fetchedAt = Date.now()): void {
  seedVersionCache(appState, version, fetchedAt);
}

export function seedAntigravityCliVersionCache(version: string, fetchedAt = Date.now()): void {
  seedVersionCache(cliState, version, fetchedAt);
}

export function clearAntigravityVersionCaches(): void {
  appState.cache = null;
  appState.inFlight = null;
  cliState.cache = null;
  cliState.inFlight = null;
}

/**
 * @deprecated The Antigravity IDE is retired as the default identity; it now reports the
 * App (Hub) version. Use `resolveAntigravityAppVersion` / `getCachedAntigravityAppVersion`.
 * These aliases exist so existing call sites and persisted settings keep resolving.
 */
export const resolveAntigravityIdeVersion = resolveAntigravityAppVersion;
/** @deprecated See `resolveAntigravityIdeVersion`. */
export const getCachedAntigravityIdeVersion = getCachedAntigravityAppVersion;
/** @deprecated See `resolveAntigravityIdeVersion`. */
export const seedAntigravityIdeVersionCache = seedAntigravityAppVersionCache;
/** @deprecated See `resolveAntigravityIdeVersion`. */
export const ANTIGRAVITY_IDE_FALLBACK_VERSION = ANTIGRAVITY_APP_FALLBACK_VERSION;
