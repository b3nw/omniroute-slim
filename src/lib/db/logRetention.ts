/**
 * Log retention — automatic cleanup of the runtime log tables.
 *
 * Split APP/CALL retention windows (APP_LOG_RETENTION_DAYS /
 * CALL_LOG_RETENTION_DAYS) plus row-count ceilings, so usage_history,
 * call_logs, proxy_logs, request_detail_logs and mcp_tool_audit cannot grow
 * without bound.
 *
 * @module lib/db/logRetention
 */

import { getDbInstance } from "./core";
import {
  getAppLogRetentionDays,
  getCallLogRetentionDays,
  getAppLogRetentionDaysOverride,
  getCallLogRetentionDaysOverride,
  getCallLogsTableMaxRows,
  getProxyLogsTableMaxRows,
} from "../logEnv";
import { getUserDatabaseSettings } from "./databaseSettings";

function getDb() {
  try {
    return getDbInstance();
  } catch {
    return null;
  }
}

/** Get the configured retention periods. */
export function getRetentionDays() {
  return {
    app: getAppLogRetentionDays(),
    call: getCallLogRetentionDays(),
  };
}

/**
 * Clean up logs using split APP/CALL retention windows.
 * Called periodically (startup + the scheduled maintenance tick).
 */
export async function cleanupExpiredLogs() {
  const db = getDb();
  const appRetentionDays = getAppLogRetentionDays();
  const callRetentionDays = getCallLogRetentionDays();
  const callLogsMaxRows = getCallLogsTableMaxRows();
  const proxyLogsMaxRows = getProxyLogsTableMaxRows();

  if (!db) {
    return {
      deletedUsage: 0,
      deletedCallLogs: 0,
      deletedProxyLogs: 0,
      deletedRequestDetailLogs: 0,
      deletedMcpAuditLogs: 0,
      trimmedCallLogs: 0,
      trimmedProxyLogs: 0,
      appRetentionDays,
      callRetentionDays,
      callLogsMaxRows,
      proxyLogsMaxRows,
    };
  }

  // #4354: retention precedence is explicit env override > dashboard DB setting > 7-day
  // default. Previously this path always used the env default (7d), silently overriding a
  // configured dashboard "Data Retention" (e.g. 90d) on every startup and trimming
  // usage_history before the dashboard-based runAutoCleanup() could run. We now honor the
  // dashboard retention per table when the operator did not set the env var, while still
  // letting an explicit env var win (and falling back to env for non-DB deployments).
  const callOverride = getCallLogRetentionDaysOverride();
  const appOverride = getAppLogRetentionDaysOverride();
  let dbRetention: { usageHistory: number; callLogs: number; mcpAudit: number } | null = null;
  try {
    const r = getUserDatabaseSettings().retention;
    dbRetention = { usageHistory: r.usageHistory, callLogs: r.callLogs, mcpAudit: r.mcpAudit };
  } catch {
    /* settings table unavailable (e.g. very early startup) — keep env fallback */
  }
  const usageHistoryRetentionDays = callOverride ?? dbRetention?.usageHistory ?? callRetentionDays;
  const callLogRetentionDays = callOverride ?? dbRetention?.callLogs ?? callRetentionDays;
  const mcpAuditRetentionDays = appOverride ?? dbRetention?.mcpAudit ?? appRetentionDays;

  const day = 24 * 60 * 60 * 1000;
  const usageCutoff = new Date(Date.now() - usageHistoryRetentionDays * day).toISOString();
  const callCutoff = new Date(Date.now() - callLogRetentionDays * day).toISOString();
  const mcpCutoff = new Date(Date.now() - mcpAuditRetentionDays * day).toISOString();

  let deletedUsage = 0;
  let deletedCallLogs = 0;
  let deletedProxyLogs = 0;
  let deletedRequestDetailLogs = 0;
  let deletedMcpAuditLogs = 0;
  let trimmedCallLogs = 0;
  let trimmedProxyLogs = 0;

  try {
    const r1 = db.prepare("DELETE FROM usage_history WHERE timestamp < ?").run(usageCutoff);
    deletedUsage = r1.changes;
  } catch {
    /* table may not exist */
  }

  try {
    const { deleteCallLogsBefore } = await import("../usage/callLogs");
    const r2 = deleteCallLogsBefore(callCutoff);
    deletedCallLogs = r2.deletedRows;
  } catch {
    /* table may not exist */
  }

  try {
    const r3 = db.prepare("DELETE FROM proxy_logs WHERE timestamp < ?").run(callCutoff);
    deletedProxyLogs = r3.changes;
  } catch {
    /* table may not exist */
  }

  try {
    const r4 = db.prepare("DELETE FROM request_detail_logs WHERE timestamp < ?").run(callCutoff);
    deletedRequestDetailLogs = r4.changes;
  } catch {
    /* legacy table may not exist */
  }

  try {
    const r5 = db.prepare("DELETE FROM mcp_tool_audit WHERE created_at < ?").run(mcpCutoff);
    deletedMcpAuditLogs = r5.changes;
  } catch {
    /* table may not exist */
  }

  // Enforce row count limits to prevent unbounded DB growth (batched to avoid long locks)
  const BATCH_SIZE = 5000;
  if (callLogsMaxRows > 0) {
    try {
      const { trimCallLogsToMaxRows } = await import("../usage/callLogs");
      const trimmed = trimCallLogsToMaxRows(callLogsMaxRows);
      trimmedCallLogs = trimmed.deletedRows;
    } catch {
      /* best effort */
    }
  }

  if (proxyLogsMaxRows > 0) {
    try {
      const currentProxyCount = db.prepare("SELECT COUNT(*) as cnt FROM proxy_logs").get() as {
        cnt: number;
      };
      while (currentProxyCount.cnt > proxyLogsMaxRows) {
        const toDelete = Math.min(currentProxyCount.cnt - proxyLogsMaxRows, BATCH_SIZE);
        const trimmed = db
          .prepare(
            `DELETE FROM proxy_logs WHERE id IN (
              SELECT id FROM proxy_logs ORDER BY timestamp ASC LIMIT ?
            )`
          )
          .run(toDelete);
        trimmedProxyLogs += trimmed.changes;
        currentProxyCount.cnt -= trimmed.changes;
        if (trimmed.changes === 0) break;
      }
    } catch {
      /* best effort */
    }
  }

  return {
    deletedUsage,
    deletedCallLogs,
    deletedProxyLogs,
    deletedRequestDetailLogs,
    deletedMcpAuditLogs,
    trimmedCallLogs,
    trimmedProxyLogs,
    appRetentionDays,
    callRetentionDays,
    callLogsMaxRows,
    proxyLogsMaxRows,
  };
}
