import { getDbInstance } from "../db/core";
import type { PendingRequestDetail } from "./usageHistory";

const COMPLETED_DETAIL_TTL_MS = 120_000;
const MAX_COMPLETED_DETAILS = 256;
// Max distance between a persisted row's timestamp and a correlation-fallback candidate.
const CORRELATION_FALLBACK_WINDOW_MS = 5_000;

const completedDetails = new Map<string, PendingRequestDetail>();
const completedDetailAliases = new Map<string, string>();
const callLogByDetailId = new Map<string, string>();
const detailPairDelta = new Map<string, number>();
const completedDetailTimers = new Map<string, ReturnType<typeof setTimeout>>();

function deleteCompletedDetail(id: string) {
  completedDetails.delete(id);
  const existingTimer = completedDetailTimers.get(id);
  if (existingTimer) {
    clearTimeout(existingTimer);
    completedDetailTimers.delete(id);
  }
  const aliasedCallLogId = callLogByDetailId.get(id);
  if (aliasedCallLogId) {
    completedDetailAliases.delete(aliasedCallLogId);
    callLogByDetailId.delete(id);
  }
  detailPairDelta.delete(id);
}

function trimCompletedDetails() {
  while (completedDetails.size > MAX_COMPLETED_DETAILS) {
    const oldestId = completedDetails.keys().next().value;
    if (!oldestId) break;
    deleteCompletedDetail(oldestId);
  }
}

export function getCompletedDetails(): Map<string, PendingRequestDetail> {
  return completedDetails;
}

export function getEstablishedCallLogId(detailId: string): string | undefined {
  return callLogByDetailId.get(detailId);
}

export function getEstablishedPairDelta(detailId: string): number | undefined {
  return detailPairDelta.get(detailId);
}

export function linkCompletedDetailToCallLog(
  callLogId: string,
  detail: PendingRequestDetail | string,
  delta: number = 0
) {
  const detailId = typeof detail === "string" ? detail : detail?.id;
  if (!callLogId || !detailId) return;

  const previousOwner = callLogByDetailId.get(detailId);
  if (previousOwner && previousOwner !== callLogId) {
    completedDetailAliases.delete(previousOwner);
  }

  const previousDetailId = completedDetailAliases.get(callLogId);
  if (previousDetailId && previousDetailId !== detailId) {
    callLogByDetailId.delete(previousDetailId);
    detailPairDelta.delete(previousDetailId);
  }

  completedDetailAliases.set(callLogId, detailId);
  callLogByDetailId.set(detailId, callLogId);
  detailPairDelta.set(detailId, delta);
  while (completedDetailAliases.size > MAX_COMPLETED_DETAILS) {
    const oldest = completedDetailAliases.keys().next().value;
    if (!oldest) break;
    const oldestDetailId = completedDetailAliases.get(oldest);
    completedDetailAliases.delete(oldest);
    if (oldestDetailId && callLogByDetailId.get(oldestDetailId) === oldest) {
      callLogByDetailId.delete(oldestDetailId);
      detailPairDelta.delete(oldestDetailId);
    }
  }
}

export function storeCompletedDetail(detail: PendingRequestDetail) {
  completedDetails.set(detail.id, detail);
  trimCompletedDetails();
}

export function scheduleCompletedDetailCleanup(id: string) {
  const existingTimer = completedDetailTimers.get(id);
  if (existingTimer) clearTimeout(existingTimer);
  const timer = setTimeout(() => {
    deleteCompletedDetail(id);
  }, COMPLETED_DETAIL_TTL_MS);
  timer.unref?.();
  completedDetailTimers.set(id, timer);
}

/**
 * Identity shared by a persisted call-log row and the in-memory copy of the same
 * request. Deliberately excludes `connectionId`: the in-memory detail keeps the
 * starting account while the persisted row stores the post-rotation one. Returns
 * null without a correlationId so rows are never matched on a missing correlation.
 */
export function callLogCorrelationKey(row: {
  correlationId?: string | null;
  model?: string | null;
  provider?: string | null;
}): string | null {
  if (!row?.correlationId) return null;
  return `${row.correlationId}\u0000${row.model || ""}\u0000${row.provider || ""}`;
}

/**
 * Effective status of a completed detail: the recorded status, else 502 for an
 * error, else 200 when a response payload was captured, else null (unknown).
 */
export function resolveDetailStatus(detail: any): number | null {
  if (typeof detail?.status === "number") return detail.status;
  if (detail?.error || detail?.errorCode) return 502;
  return detail?.clientResponse || detail?.providerResponse ? 200 : null;
}

/**
 * Finds the in-memory completed detail backing a persisted call-log row. Matches on
 * the detail id, then on `callLogId` against the row id, then on `callLogId` against the
 * persisted correlationId (standard requests persist the attempt traceId there). Only
 * details without a `callLogId` fall through to the correlation key: a detail linked to
 * a different attempt is never borrowed (#14474). Retry attempts can share a
 * correlation key, so fallback candidates must have a matching status (when the persisted status is known; an unresolvable detail status is declined
 * rather than treated as a wildcard) and a request time close to the persisted timestamp
 * (when known); an ambiguous or empty match is declined rather than returning another
 * attempt's payloads.
 */
export function findCompletedDetailForCallLog(
  id: string,
  persisted?: {
    correlationId?: string | null;
    model?: string | null;
    provider?: string | null;
    status?: number | null;
    timestamp?: string | number | null;
  } | null
): PendingRequestDetail | undefined {
  const direct = completedDetails.get(id);
  if (direct) return direct;
  const aliasedId = completedDetailAliases.get(id);
  if (aliasedId) {
    const aliased = completedDetails.get(aliasedId);
    if (aliased && callLogByDetailId.get(aliasedId) === id) {
      return aliased;
    }
    completedDetailAliases.delete(id);
    if (callLogByDetailId.get(aliasedId) === id) {
      callLogByDetailId.delete(aliasedId);
      detailPairDelta.delete(aliasedId);
    }
  }
  const key = persisted ? callLogCorrelationKey(persisted) : null;
  const rawTime = persisted?.timestamp;
  const persistedTime =
    typeof rawTime === "number"
      ? rawTime
      : typeof rawTime === "string" && rawTime
        ? Date.parse(rawTime)
        : NaN;
  const candidates: PendingRequestDetail[] = [];
  const traceMatches: PendingRequestDetail[] = [];
  for (const detail of completedDetails.values()) {
    if (detail.callLogId === id) return detail;

    // If this detail is already owned by another persisted row, do not borrow it.
    const establishedOwner = callLogByDetailId.get(detail.id);
    if (establishedOwner && establishedOwner !== id) continue;

    const detailStatus = resolveDetailStatus(detail);
    const detailTime =
      typeof detail.completedAt === "number" ? detail.completedAt : detail.startedAt;
    const statusCompatible =
      typeof persisted?.status !== "number" || detailStatus === persisted.status;
    const timeCompatible =
      !Number.isFinite(persistedTime) ||
      Math.abs(detailTime - persistedTime) <= CORRELATION_FALLBACK_WINDOW_MS;

    if (persisted?.correlationId && detail.callLogId === persisted.correlationId) {
      if (statusCompatible && timeCompatible) {
        traceMatches.push(detail);
      }
      continue;
    }
    // A detail carrying a differing callLogId belongs to another attempt; a shared
    // correlation key, status, and time window cannot establish attempt identity.
    if (detail.callLogId) continue;
    if (key && callLogCorrelationKey(detail) === key && statusCompatible && timeCompatible) {
      candidates.push(detail);
    }
  }
  if (traceMatches.length === 1) return traceMatches[0];
  if (traceMatches.length > 1) return undefined;
  return candidates.length === 1 ? candidates[0] : undefined;
}

export function clearCompletedDetails() {
  for (const timer of completedDetailTimers.values()) clearTimeout(timer);
  completedDetailTimers.clear();
  completedDetails.clear();
  completedDetailAliases.clear();
  callLogByDetailId.clear();
  detailPairDelta.clear();
}

export function maybeEnrichCompletedDetail(updated: PendingRequestDetail, connectionId: string) {
  void (async () => {
    try {
      const missingProvider =
        updated.providerResponse === undefined || updated.providerResponse === null;
      const missingClient = updated.clientResponse === undefined || updated.clientResponse === null;
      if (!missingProvider && !missingClient) return;

      const db = getDbInstance();
      const sinceIso = new Date(Date.now() - 30_000).toISOString();
      const rows = db
        .prepare(
          `SELECT artifact_relpath FROM call_logs WHERE connection_id = ? AND model = ? AND timestamp >= ? ORDER BY timestamp DESC LIMIT 5`
        )
        .all(connectionId, updated.model, sinceIso) as Array<{ artifact_relpath: string | null }>;
      for (const row of rows) {
        if (!row.artifact_relpath) continue;
        const { readCallArtifact } = await import("./callLogArtifacts");
        const art = readCallArtifact(row.artifact_relpath);
        if (art.state !== "ready" || !art.artifact) continue;
        const pipeline = art.artifact.pipeline as
          { providerResponse?: unknown; clientResponse?: unknown } | undefined;
        if (missingProvider && pipeline?.providerResponse) {
          updated.providerResponse = pipeline.providerResponse;
        }
        if (missingClient && pipeline?.clientResponse) {
          updated.clientResponse = pipeline.clientResponse;
        }
        if (
          (missingProvider && art.artifact.responseBody) ||
          (missingClient && art.artifact.responseBody)
        ) {
          if (missingProvider) updated.providerResponse = art.artifact.responseBody;
          if (missingClient) updated.clientResponse = art.artifact.responseBody;
        }
        if (updated.providerResponse || updated.clientResponse) {
          if (completedDetails.has(updated.id)) storeCompletedDetail(updated);
          break;
        }
      }
    } catch (e) {
      try {
        console.warn(
          "[usageHistory] failed to enrich completed detail from artifacts:",
          e && (e.message || e)
        );
      } catch {}
    }
  })();
}
