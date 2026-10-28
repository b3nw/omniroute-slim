/**
 * Build identity baked into the image at build time.
 *
 * The Dockerfile maps the `OMNIROUTE_GIT_SHA` / `OMNIROUTE_GIT_REF` / `OMNIROUTE_TIER` /
 * `OMNIROUTE_UPSTREAM_BASE` / `OMNIROUTE_BUILD_SEQ` / `BUILD_DATE` build args onto the
 * runtime env vars read here (and onto matching OCI labels), so a running instance can
 * describe which commit, tier and upstream alignment it was built from without being a
 * git checkout. Surfaced as `build` on `GET /api/system/version`.
 *
 * Pure and dependency-free so it is unit-testable with an injected env.
 */

export const DEFAULT_UPSTREAM_BASE = "3.8.51";

export interface BuildInfo {
  sha: string;
  ref: string;
  tier: string;
  upstreamBase: string;
  seq: number;
  builtAt: string;
}

function envString(value: string | undefined, fallback: string): string {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed || fallback;
}

function envSeq(value: string | undefined): number {
  const parsed = Number(value || 0);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

export function getBuildInfo(env: NodeJS.ProcessEnv = process.env): BuildInfo {
  return {
    sha: envString(env.OMNIROUTE_BUILD_SHA, "unknown"),
    ref: envString(env.OMNIROUTE_BUILD_REF, "unknown"),
    tier: envString(env.OMNIROUTE_BUILD_TIER, "unknown"),
    upstreamBase: envString(env.OMNIROUTE_UPSTREAM_BASE, DEFAULT_UPSTREAM_BASE),
    seq: envSeq(env.OMNIROUTE_BUILD_SEQ),
    builtAt: envString(env.OMNIROUTE_BUILD_DATE, "unknown"),
  };
}
