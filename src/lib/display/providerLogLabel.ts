/**
 * Server-side provider label resolution for console / runtime log lines and
 * log-oriented API responses.
 *
 * Requests that target a custom compatible provider node carry the internal
 * `provider_nodes.id` (e.g. `openai-compatible-chat-<uuid>`) as their provider.
 * Log emitters used to print that id verbatim (often upper-cased), so this
 * module maps it to the node's configured `name` / `prefix` instead.
 *
 * Built-in providers never touch the DB: anything that does not start with
 * `openai-compatible-` / `anthropic-compatible-` is returned as-is. When no
 * node matches (or the DB is unavailable), the raw id is returned unchanged.
 *
 * The id → label map is cached for a short TTL and is dropped whenever
 * `invalidateDbCache("nodes")` runs (provider node create/update/delete).
 *
 * @module lib/display/providerLogLabel
 */

import { getDbInstance } from "@/lib/db/core";
import { getProviderNodesCacheVersion } from "@/lib/db/readCache";

const NODE_LABEL_TTL_MS = 30_000;
const COMPATIBLE_PREFIX_RE = /^(openai|anthropic)-compatible-/i;

interface NodeLabelCache {
  labels: Map<string, string>;
  expiresAt: number;
  version: number;
}

let nodeLabelCache: NodeLabelCache | null = null;

/** Drop the cached provider node label map (next lookup re-reads SQLite). */
export function invalidateProviderLogLabelCache(): void {
  nodeLabelCache = null;
}

function loadNodeLabels(): Map<string, string> {
  const version = getProviderNodesCacheVersion();
  const now = Date.now();
  if (nodeLabelCache && nodeLabelCache.version === version && nodeLabelCache.expiresAt > now) {
    return nodeLabelCache.labels;
  }

  const labels = new Map<string, string>();
  try {
    const rows = getDbInstance()
      .prepare("SELECT id, name, prefix FROM provider_nodes")
      .all() as Array<{ id?: unknown; name?: unknown; prefix?: unknown }>;
    for (const row of rows) {
      const name = typeof row.name === "string" ? row.name.trim() : "";
      const prefix = typeof row.prefix === "string" ? row.prefix.trim() : "";
      const label = name || prefix;
      if (!label) continue;
      // id first so an exact id match is never shadowed by another node's prefix.
      if (prefix && !labels.has(prefix.toLowerCase())) labels.set(prefix.toLowerCase(), label);
      if (typeof row.id === "string" && row.id) labels.set(row.id.toLowerCase(), label);
    }
  } catch {
    // DB not initialized / table missing (e.g. unit tests) — fall back to raw ids.
  }

  nodeLabelCache = { labels, expiresAt: now + NODE_LABEL_TTL_MS, version };
  return labels;
}

/**
 * Resolve a provider id to a human-facing label for logs.
 * Compatible node ids resolve to the node's name/prefix; everything else is
 * returned unchanged. Empty / non-string input returns `fallback`.
 */
export function resolveProviderLogLabel(
  provider: string | null | undefined,
  fallback = ""
): string {
  if (!provider || typeof provider !== "string" || !provider.trim()) return fallback;
  if (!COMPATIBLE_PREFIX_RE.test(provider)) return provider;
  return loadNodeLabels().get(provider.toLowerCase()) || provider;
}

/** Upper-cased variant of {@link resolveProviderLogLabel} for `PROVIDER | ...` log lines. */
export function formatProviderUpperLabel(
  provider: string | null | undefined,
  fallback = "UNKNOWN"
): string {
  if (!provider || typeof provider !== "string" || !provider.trim()) return fallback;
  return resolveProviderLogLabel(provider, fallback).toUpperCase();
}

/**
 * Resolve the provider prefix of a `provider/model` target string for logs
 * (e.g. `openai-compatible-chat-<uuid>/gemma` → `inferx/gemma`). Splits on the
 * first `/` only; strings without a `/` resolve as a bare provider id.
 */
export function formatModelTargetLogLabel(
  modelStr: string | null | undefined,
  fallback = ""
): string {
  if (!modelStr || typeof modelStr !== "string" || !modelStr.trim()) return fallback;
  const slash = modelStr.indexOf("/");
  if (slash <= 0) return resolveProviderLogLabel(modelStr, fallback);
  return `${resolveProviderLogLabel(modelStr.slice(0, slash))}${modelStr.slice(slash)}`;
}
