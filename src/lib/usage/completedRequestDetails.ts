import { getDbInstance } from "../db/core";
import type { PendingRequestDetail } from "./usageHistory";

const COMPLETED_DETAIL_TTL_MS = 120_000;
const MAX_COMPLETED_DETAILS = 256;

const completedDetails = new Map<string, PendingRequestDetail>();
const completedDetailTimers = new Map<string, ReturnType<typeof setTimeout>>();

function deleteCompletedDetail(id: string) {
  completedDetails.delete(id);
  const existingTimer = completedDetailTimers.get(id);
  if (existingTimer) {
    clearTimeout(existingTimer);
    completedDetailTimers.delete(id);
  }
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

export function storeCompletedDetail(detail: PendingRequestDetail) {
  completedDetails.set(detail.id, detail);
  trimCompletedDetails();
}

export function scheduleCompletedDetailCleanup(id: string) {
  const existingTimer = completedDetailTimers.get(id);
  if (existingTimer) clearTimeout(existingTimer);
  const timer = setTimeout(() => {
    completedDetails.delete(id);
    completedDetailTimers.delete(id);
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
 * Finds the in-memory completed detail backing a persisted call-log row. Matches on
 * the detail id, then on `callLogId` (persisted rows are keyed on the chatCore trace
 * id), then on the correlation key — the last only for details without a
 * `callLogId`, since one that has a different callLogId belongs to another attempt.
 */
export function findCompletedDetailForCallLog(
  id: string,
  persisted?: {
    correlationId?: string | null;
    model?: string | null;
    provider?: string | null;
  } | null
): PendingRequestDetail | undefined {
  const direct = completedDetails.get(id);
  if (direct) return direct;
  const key = persisted ? callLogCorrelationKey(persisted) : null;
  let correlated: PendingRequestDetail | undefined;
  for (const detail of completedDetails.values()) {
    if (detail.callLogId === id) return detail;
    if (key && !correlated && !detail.callLogId && callLogCorrelationKey(detail) === key) {
      correlated = detail;
    }
  }
  return correlated;
}

export function clearCompletedDetails() {
  for (const timer of completedDetailTimers.values()) clearTimeout(timer);
  completedDetailTimers.clear();
  completedDetails.clear();
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
