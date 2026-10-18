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
 * Parse the Antigravity App (Hub) updater manifest.
 *
 * The Hub publishes an electron-builder `latest-<os>-<arch>.yml`, not JSON:
 *   version: 2.24.0
 *   files:
 *     - url: https://storage.googleapis.com/antigravity-public/...
 *   path: Antigravity.zip
 * The `files:` entries carry no version key, so matching the top-level `version:` line
 * is unambiguous.
 */
export function parseAntigravityAppManifest(payload: unknown): string | null {
  if (typeof payload !== "string") return null;
  const match = payload.match(/^version:\s*(\d+\.\d+\.\d+)\s*$/m);
  return normalizeVersion(match?.[1]);
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
      // The Antigravity App (a.k.a. Hub). This is the surface that still receives the
      // current model catalog; the legacy IDE feed stopped publishing at 2.0.0 while the
      // Hub is on 2.24.x, so the IDE feed must not drive the version we report.
      url: "https://antigravity-hub-auto-updater-974169037036.us-central1.run.app/manifest/latest-arm64-mac.yml",
      parse: parseAntigravityAppManifest,
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
    // Sources disagree on payload shape: most are JSON APIs, but the Antigravity App
    // publishes an electron-builder YAML manifest. Ask for both and parse from text.
    Accept: "application/json, text/yaml, text/plain, */*",
    "User-Agent": "OmniRoute-ClientVersionCheck/1.0",
  };
  if (cached) headers["If-None-Match"] = cached.etag;

  const response = await fetchImpl(source.url, {
    headers,
    signal: AbortSignal.timeout(CLIENT_VERSION_FETCH_TIMEOUT_MS),
  });

  if (response.status === 304 && cached) return cached.version;
  if (!response.ok) throw new Error(`${new URL(source.url).host} returned HTTP ${response.status}`);

  const body = await response.text();
  // Most sources are JSON; the Antigravity App publishes an electron-builder YAML
  // manifest. Try JSON and fall back to the raw text so every parser sees its shape.
  let payload: unknown = body;
  try {
    payload = JSON.parse(body);
  } catch {
    // not JSON — leave as raw text for YAML/plain-text parsers
  }
  const version = source.parse(payload);
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
