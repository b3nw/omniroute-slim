/**
 * Provider display-name resolution for the usage analytics `byProvider`
 * breakdown (`src/app/api/usage/analytics/route.ts`).
 *
 * Raw `usage_history.provider` values are internal provider ids (e.g. a
 * dynamic compatible-provider uuid-suffixed id). This module maps those ids
 * to the friendly `name`/`prefix` configured on the matching `provider_nodes`
 * row, falling back to the raw id when no node matches, so analytics rows
 * show a readable label instead of an internal id.
 *
 * @module lib/usage/providerDisplayNames
 */
import { getProviderNodes } from "@/models";
import { getProviderById } from "@/shared/constants/providers";

function toStringValue(value: unknown, fallback = ""): string {
  return typeof value === "string" && value.trim().length > 0 ? value : fallback;
}

function roundCost(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

/**
 * Resolves a raw provider id to its display name: configured node name/prefix
 * first (case-insensitive id match), then the static catalog for built-ins
 * (e.g. codex → "OpenAI Codex") the nodes table doesn't know about, and the
 * raw id as the last resort.
 */
export function resolveProviderDisplayName(
  provider: unknown,
  providerDisplayNames: Map<string, string>
): string {
  const rawProvider = toStringValue(provider, "unknown");
  return (
    providerDisplayNames.get(rawProvider.toLowerCase()) ||
    getProviderById(rawProvider)?.name ||
    rawProvider
  );
}

/** Builds a lower-cased `provider_nodes.id` → display name (name, prefix, id) map. */
export async function buildProviderDisplayMap(): Promise<Map<string, string>> {
  const displayNames = new Map<string, string>();
  const providerNodes = (await getProviderNodes()) as Array<{
    id?: unknown;
    name?: unknown;
    prefix?: unknown;
  }>;

  for (const node of providerNodes) {
    const id = toStringValue(node.id);
    if (!id) continue;

    const displayName = toStringValue(node.name) || toStringValue(node.prefix) || id;
    displayNames.set(id.toLowerCase(), displayName);
  }

  return displayNames;
}

export interface ByProviderRow {
  provider: string;
  requests: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  avgLatencyMs: number;
  successRatePct: number | string;
  cost: number;
}

/**
 * Builds the `byProvider` analytics rows, resolving each row's raw provider
 * id to its configured display name.
 */
export async function buildByProviderRows(
  providerRows: Array<Record<string, unknown>>,
  providerCostByProvider: Map<string, number>
): Promise<ByProviderRow[]> {
  const providerDisplayNames = await buildProviderDisplayMap();
  return providerRows.map((row) => ({
    provider: resolveProviderDisplayName(row.provider, providerDisplayNames),
    requests: Number(row.requests),
    promptTokens: Number(row.promptTokens),
    completionTokens: Number(row.completionTokens),
    totalTokens: Number(row.totalTokens),
    avgLatencyMs: Math.round(Number(row.avgLatencyMs)),
    successRatePct:
      Number(row.requests) > 0
        ? Number((Number(row.successfulRequests) / Number(row.requests)) * 100).toFixed(2)
        : 0,
    cost: roundCost(providerCostByProvider.get(toStringValue(row.provider)) || 0),
  }));
}

export interface ProviderDailyDisplayRow {
  date: string;
  provider: string;
  requests: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

/**
 * Resolves the per-day provider rows of `/api/usage/requests-by-provider-date`
 * to display names, merging rows whose raw ids map to the same display name on
 * the same date (e.g. a node id logged under two casings).
 */
export async function buildProviderDailyDisplayRows(
  rows: ProviderDailyDisplayRow[]
): Promise<ProviderDailyDisplayRow[]> {
  const providerDisplayNames = await buildProviderDisplayMap();
  const merged = new Map<string, ProviderDailyDisplayRow>();

  for (const row of rows) {
    const provider = resolveProviderDisplayName(row.provider, providerDisplayNames);
    const key = `${row.date}::${provider}`;
    const existing = merged.get(key);
    if (existing) {
      existing.requests += Number(row.requests) || 0;
      existing.promptTokens += Number(row.promptTokens) || 0;
      existing.completionTokens += Number(row.completionTokens) || 0;
      existing.totalTokens += Number(row.totalTokens) || 0;
    } else {
      merged.set(key, {
        date: row.date,
        provider,
        requests: Number(row.requests) || 0,
        promptTokens: Number(row.promptTokens) || 0,
        completionTokens: Number(row.completionTokens) || 0,
        totalTokens: Number(row.totalTokens) || 0,
      });
    }
  }

  return [...merged.values()].sort((a, b) =>
    a.date === b.date ? b.requests - a.requests : a.date < b.date ? 1 : -1
  );
}
