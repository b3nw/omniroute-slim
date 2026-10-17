import { NextResponse } from "next/server";
export const dynamic = "force-dynamic";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import { getCallLogs } from "@/lib/usageDb";
import { getCompletedDetails, getPendingById } from "@/lib/usage/usageHistory";
import { callLogCorrelationKey } from "@/lib/usage/completedRequestDetails";
import { getProviderConnections } from "@/lib/db/providers";
import { getProviderNodes } from "@/models";
import { matchesSearch } from "@/shared/utils/turkishText";

type CallLogListRowsInput = {
  logs: any[];
  connections: any[];
  providerDisplayNames?: Map<string, string>;
  pendingDetails: Iterable<any>;
  completedDetails: Iterable<any>;
  now?: number;
};

function rowTimestampMs(row: any): number {
  const value = Date.parse(String(row?.timestamp || ""));
  return Number.isFinite(value) ? value : 0;
}

function rowPriority(row: any): number {
  if (row?.active) return 0;
  if (row?.completed) return 1;
  return 2;
}

/**
 * Applies the active filter predicates to a single merged call-log row.
 *
 * `getCallLogs()` already filters the persisted DB rows server-side, but the
 * in-memory entries (active/pending + recently-completed) are merged in by
 * `buildCallLogListRows()` and would otherwise bypass every filter except
 * `correlationId`. Running the same predicates over the merged rows closes that
 * gap. It is idempotent for DB rows (they already satisfy the predicate) while
 * correctly excluding in-memory rows that do not match.
 */
export function rowMatchesFilter(row: any, filter: Record<string, any>): boolean {
  if (!filter) return true;

  if (filter.status === "error") {
    if (!(Number(row?.status) >= 400 || Boolean(row?.error))) return false;
  } else if (filter.status === "ok") {
    if (!(Number(row?.status) >= 200 && Number(row?.status) < 300)) return false;
  } else if (
    typeof filter.status === "number" ||
    (typeof filter.status === "string" && !isNaN(Number(filter.status)))
  ) {
    if (Number(row?.status) !== Number(filter.status)) return false;
  }

  if (filter.model && !matchesSearch(row?.model || "", String(filter.model))) {
    return false;
  }
  if (filter.provider && !matchesSearch(row?.provider || "", String(filter.provider))) {
    return false;
  }
  if (filter.account && !matchesSearch(row?.account || "", String(filter.account))) {
    return false;
  }
  if (filter.apiKey && !matchesSearch(row?.apiKeyName || "", String(filter.apiKey))) {
    return false;
  }
  if (filter.combo && !matchesSearch(row?.comboName || "", String(filter.combo))) {
    return false;
  }
  if (
    filter.correlationId &&
    !matchesSearch(row?.correlationId || "", String(filter.correlationId))
  ) {
    return false;
  }
  if (filter.search) {
    const term = String(filter.search);
    const tokens = term.split(/\s+/).filter(Boolean);
    const positiveTokens = tokens.filter((t) => !t.startsWith("-") || t.length === 1);
    const negativeTokens = tokens
      .filter((t) => t.startsWith("-") && t.length > 1)
      .map((t) => t.substring(1));

    const haystack = [
      row?.model,
      row?.provider,
      row?.providerDisplay,
      row?.account,
      row?.apiKeyName,
      row?.comboName,
      row?.correlationId,
      row?.error,
      row?.path,
    ]
      .filter(Boolean)
      .join(" ");

    // Must match ALL positive tokens
    for (const pToken of positiveTokens) {
      if (!matchesSearch(haystack, pToken)) return false;
    }

    // Must NOT match ANY negative tokens
    for (const nToken of negativeTokens) {
      if (matchesSearch(haystack, nToken)) return false;
    }
  }

  return true;
}

export function buildCallLogListRows({
  logs,
  connections,
  providerDisplayNames = new Map<string, string>(),
  pendingDetails,
  completedDetails,
  now = Date.now(),
}: CallLogListRowsInput): any[] {
  const connectionNames = new Map(
    connections.map((connection: any) => [
      connection.id,
      connection.displayName || connection.name || connection.email || connection.id,
    ])
  );
  const getProviderDisplay = (providerId: unknown): string | null => {
    if (typeof providerId !== "string" || providerId.length === 0) return null;
    return providerDisplayNames.get(providerId) || null;
  };

  // Include active (in-flight) requests from the pending-by-id map
  // so they appear in the logs grid alongside persisted entries.
  const activeEntries: any[] = [];

  for (const detail of pendingDetails) {
    activeEntries.push({
      id: detail.id,
      timestamp: new Date(detail.startedAt).toISOString(),
      method: "",
      path: detail.clientEndpoint || "",
      status: 0,
      model: detail.model,
      requestedModel: null,
      provider: detail.provider,
      providerDisplay: getProviderDisplay(detail.provider),
      account: connectionNames.get(detail.connectionId || "") || detail.connectionId || "unknown",
      connectionId: detail.connectionId,
      duration: Math.max(0, now - detail.startedAt),
      timeToFirstTokenMs: null,
      tokens: { in: 0, out: 0 },
      cacheSource: null,
      sourceFormat: null,
      targetFormat: null,
      apiKeyId: null,
      apiKeyName: null,
      comboName: null,
      error: null,
      correlationId: detail.correlationId || null,
      active: true,
    });
  }

  const pendingIds = new Set(activeEntries.map((entry) => entry.id));
  // Persisted rows were originally keyed on the chatCore trace id (#13481) and later
  // decoupled to random UUIDs (#14474), so in-memory copies are matched via `callLogId`,
  // falling through to the correlation key when `detail.callLogId` matches no persisted row.
  // Persisted statuses are pooled per correlation key so that retry attempts sharing a
  // correlationId are each paired 1-to-1 with a persisted row of a compatible status,
  // without dropping unwritten in-memory attempts. Exact matches reserve their persisted
  // row first, so an unwritten attempt ordered before an exactly linked one cannot consume
  // that row and hide itself. Status pairing matters because the persisted query may be
  // status-filtered (e.g. `status=ok` returns only the 200 of a 429 → 200 retry).
  const remainingCorrelationStatuses = new Map<string, (number | null)[]>();
  const logsById = new Map<string, any>();
  for (const log of logs) {
    if (log.id) logsById.set(log.id, log);
    const key = callLogCorrelationKey(log);
    if (!key) continue;
    const statuses = remainingCorrelationStatuses.get(key) || [];
    statuses.push(typeof log.status === "number" ? log.status : null);
    remainingCorrelationStatuses.set(key, statuses);
  }
  // Removes one persisted status compatible with `status` (an unknown status on either
  // side is compatible with anything, exact matches preferred) and reports success.
  const takeCorrelationStatus = (key: string, status: unknown) => {
    const statuses = remainingCorrelationStatuses.get(key);
    if (!statuses?.length) return false;
    let index = 0;
    if (typeof status === "number") {
      index = statuses.indexOf(status);
      if (index < 0) index = statuses.indexOf(null);
      if (index < 0) return false;
    }
    statuses.splice(index, 1);
    return true;
  };
  const exactPersistedMatch = (detail: any) =>
    logsById.get(detail.id) || (detail.callLogId ? logsById.get(detail.callLogId) : undefined);
  // Materialize once: callers pass single-use iterators (e.g. `Map.values()`).
  const completedList = Array.from(completedDetails);
  const reservedLogs = new Set<any>();
  for (const detail of completedList) {
    const log = exactPersistedMatch(detail);
    if (!log || reservedLogs.has(log)) continue;
    reservedLogs.add(log);
    // Reserve this row's own pooled status, not merely a compatible one.
    const statuses = remainingCorrelationStatuses.get(callLogCorrelationKey(log) || "");
    const index = statuses?.indexOf(typeof log.status === "number" ? log.status : null) ?? -1;
    if (index >= 0) statuses!.splice(index, 1);
  }
  const completedEntries: any[] = [];
  for (const detail of completedList) {
    if (exactPersistedMatch(detail) || pendingIds.has(detail.id)) continue;
    const key = callLogCorrelationKey(detail);
    if (key && takeCorrelationStatus(key, detail.status)) continue;
    const completedAt = typeof detail.completedAt === "number" ? detail.completedAt : null;
    const duration =
      typeof detail.durationMs === "number" && Number.isFinite(detail.durationMs)
        ? detail.durationMs
        : Math.max(0, (completedAt ?? now) - detail.startedAt);
    completedEntries.push({
      id: detail.id,
      timestamp: new Date(detail.startedAt).toISOString(),
      method: "",
      path: detail.clientEndpoint || "",
      status: typeof detail.status === "number" ? detail.status : detail.error ? 502 : 200,
      model: detail.model,
      requestedModel: null,
      provider: detail.provider,
      providerDisplay: getProviderDisplay(detail.provider),
      account: connectionNames.get(detail.connectionId || "") || detail.connectionId || "unknown",
      connectionId: detail.connectionId,
      duration,
      timeToFirstTokenMs: null,
      tokens: { in: 0, out: 0 },
      cacheSource: null,
      sourceFormat: null,
      targetFormat: null,
      apiKeyId: null,
      apiKeyName: null,
      comboName: null,
      error: detail.error || null,
      correlationId: detail.correlationId || null,
      active: false,
      completed: true,
      completedAt: completedAt ? new Date(completedAt).toISOString() : null,
      detailState: "in-memory",
    });
  }

  return [...activeEntries, ...completedEntries, ...logs].sort((a, b) => {
    // Active requests always on top
    const pa = rowPriority(a);
    const pb = rowPriority(b);
    if (pa !== pb) return pa - pb;
    // Within same priority, newest first
    return rowTimestampMs(b) - rowTimestampMs(a);
  });
}

export async function GET(request: Request) {
  try {
    const authError = await requireManagementAuth(request);
    if (authError) return authError;

    const { searchParams } = new URL(request.url);

    const filter: Record<string, any> = {};
    if (searchParams.get("status")) filter.status = searchParams.get("status");
    if (searchParams.get("model")) filter.model = searchParams.get("model");
    if (searchParams.get("provider")) filter.provider = searchParams.get("provider");
    if (searchParams.get("account")) filter.account = searchParams.get("account");
    if (searchParams.get("apiKey")) filter.apiKey = searchParams.get("apiKey");
    if (searchParams.get("combo")) filter.combo = searchParams.get("combo");
    if (searchParams.get("search")) filter.search = searchParams.get("search");
    if (searchParams.get("correlationId")) filter.correlationId = searchParams.get("correlationId");
    if (searchParams.get("limit")) filter.limit = parseInt(searchParams.get("limit"));
    if (searchParams.get("offset")) filter.offset = parseInt(searchParams.get("offset"));
    // Home Recent Requests feed sets excludeTests=1 so connection-test probe rows
    // are dropped at the SQL layer (before LIMIT), not client-side after slicing.
    if (searchParams.get("excludeTests") === "1") filter.excludeTests = true;

    const [logs, connections, providerNodes] = await Promise.all([
      getCallLogs(filter),
      getProviderConnections(),
      getProviderNodes(),
    ]);
    const providerDisplayNames = new Map<string, string>(
      (Array.isArray(providerNodes) ? providerNodes : []).flatMap((node: any) => {
        if (typeof node?.id !== "string" || node.id.length === 0) return [];
        const label =
          (typeof node?.name === "string" && node.name.trim().length > 0
            ? node.name.trim()
            : typeof node?.prefix === "string" && node.prefix.trim().length > 0
              ? node.prefix.trim()
              : "") || null;
        return label ? [[node.id, label] as const] : [];
      })
    );

    const rows = buildCallLogListRows({
      logs,
      connections,
      providerDisplayNames,
      pendingDetails: getPendingById().values(),
      completedDetails: getCompletedDetails().values(),
    });

    const filtered = rows.filter((r: any) => rowMatchesFilter(r, filter));
    return NextResponse.json(filtered);
  } catch (error) {
    console.error("[API ERROR] /api/usage/call-logs failed:", error);
    return NextResponse.json({ error: "Failed to fetch call logs" }, { status: 500 });
  }
}
