/**
 * Upstream "latest version" lookups for `automatic` mode. Only ever invoked for
 * products whose mode is `automatic` (or by an explicit "Check Now"), so the
 * default `off` configuration makes zero network calls.
 */
import { isSafeClientVersion, type ClientVersionTarget } from "./registry";

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export const CLIENT_VERSION_FETCH_TIMEOUT_MS = 5_000;

type VersionSource = {
  url: string;
  parse: (payload: unknown) => string | null;
};

function toRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function normalizeVersion(value: unknown, stripPrefix?: RegExp): string | null {
  if (typeof value !== "string") return null;
  let version = value.trim();
  if (stripPrefix) version = version.replace(stripPrefix, "");
  version = version.replace(/^v(?=\d)/i, "");
  return isSafeClientVersion(version) ? version : null;
}

function compareSemver(a: string, b: string): number {
  const aParts = a.split(/[.-]/).map((part) => Number.parseInt(part, 10) || 0);
  const bParts = b.split(/[.-]/).map((part) => Number.parseInt(part, 10) || 0);
  for (let i = 0; i < 3; i += 1) {
    if ((aParts[i] ?? 0) !== (bParts[i] ?? 0)) return (aParts[i] ?? 0) - (bParts[i] ?? 0);
  }
  return 0;
}

/** `/-/package/<pkg>/dist-tags` returns the tags object directly; accept the full packument shape too. */
export function parseNpmDistTags(payload: unknown): string | null {
  const record = toRecord(payload);
  if (!record) return null;
  const tags = toRecord(record["dist-tags"]) ?? record;
  return normalizeVersion(tags.latest);
}

export function parseGithubRelease(payload: unknown, stripPrefix?: RegExp): string | null {
  const record = toRecord(payload);
  if (!record) return null;
  return normalizeVersion(record.tag_name ?? record.name, stripPrefix);
}

export function parseAntigravityReleaseFeed(payload: unknown): string | null {
  if (!Array.isArray(payload)) return null;
  return payload
    .map((entry) => normalizeVersion(toRecord(entry)?.version))
    .filter((version): version is string => !!version && /^\d+\.\d+\.\d+/.test(version))
    .reduce<string | null>(
      (best, version) => (!best || compareSemver(version, best) > 0 ? version : best),
      null
    );
}

/**
 * Antigravity IDE (2.x) and CLI (1.x) are versioned independently, so each has
 * its own source list — never fall back from one feed to the other.
 */
export const CLIENT_VERSION_SOURCES: Record<ClientVersionTarget, VersionSource[]> = {
  "claude-code": [
    {
      url: "https://registry.npmjs.org/-/package/@anthropic-ai%2Fclaude-code/dist-tags",
      parse: parseNpmDistTags,
    },
  ],
  codex: [
    {
      url: "https://registry.npmjs.org/-/package/@openai%2Fcodex/dist-tags",
      parse: parseNpmDistTags,
    },
    {
      url: "https://api.github.com/repos/openai/codex/releases/latest",
      parse: (payload) => parseGithubRelease(payload, /^rust-v/i),
    },
  ],
  antigravity: [
    {
      url: "https://antigravity-auto-updater-974169037036.us-central1.run.app/releases",
      parse: parseAntigravityReleaseFeed,
    },
  ],
  "antigravity-cli": [
    {
      url: "https://api.github.com/repos/google-antigravity/antigravity-cli/releases/latest",
      parse: (payload) => parseGithubRelease(payload),
    },
  ],
  "gemini-cli": [
    {
      url: "https://registry.npmjs.org/-/package/@google%2Fgemini-cli/dist-tags",
      parse: parseNpmDistTags,
    },
    {
      url: "https://api.github.com/repos/google-gemini/gemini-cli/releases/latest",
      parse: (payload) => parseGithubRelease(payload),
    },
  ],
};

// ETag cache: url → last validator + the version it resolved to.
const etagCache = new Map<string, { etag: string; version: string }>();

export function clearClientVersionEtagCache(): void {
  etagCache.clear();
}

async function fetchSourceVersion(fetchImpl: FetchLike, source: VersionSource): Promise<string> {
  const cached = etagCache.get(source.url);
  const headers: Record<string, string> = {
    Accept: "application/json",
    "User-Agent": "OmniRoute-ClientVersionCheck/1.0",
  };
  if (cached) headers["If-None-Match"] = cached.etag;

  const response = await fetchImpl(source.url, {
    headers,
    signal: AbortSignal.timeout(CLIENT_VERSION_FETCH_TIMEOUT_MS),
  });

  if (response.status === 304 && cached) return cached.version;
  if (!response.ok) throw new Error(`${new URL(source.url).host} returned HTTP ${response.status}`);

  const version = source.parse(await response.json());
  if (!version) throw new Error(`${new URL(source.url).host} returned no usable version`);

  const etag = response.headers.get("etag");
  if (etag) etagCache.set(source.url, { etag, version });
  return version;
}

/** Try each source in order; throws with the last error when every source fails. */
export async function fetchLatestClientVersion(
  product: ClientVersionTarget,
  fetchImpl: FetchLike = fetch
): Promise<string> {
  let lastError: unknown = null;
  for (const source of CLIENT_VERSION_SOURCES[product]) {
    try {
      return await fetchSourceVersion(fetchImpl, source);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error("No version source succeeded");
}
