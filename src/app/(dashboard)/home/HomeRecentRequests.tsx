"use client";

import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Card } from "@/shared/components";
import ProviderIcon from "@/shared/components/ProviderIcon";
import { AI_PROVIDERS } from "@/shared/constants/providers";
import { PROVIDER_COLORS } from "@/shared/constants/colors";
import { getProviderDisplayLabel } from "@/shared/utils/providerDisplayLabel";
import { fmtCompact } from "@/shared/utils/formatting";

/**
 * Home-page "Recent Requests" panel — the live request feed that sits beside the
 * Provider Topology graph (parity with 9Router's Usage view).
 *
 * ## Data source
 * Fed by POLLING `GET /api/usage/call-logs?limit=N` every ~3s, NOT by the live
 * WebSocket. The WS is used elsewhere for the in-flight beam (it emits
 * `request.started` and, since the stuck-latch fix, `request.completed`/`request.failed`),
 * but its payload carries no tokens/latency/status and no persisted history — so it
 * can't back a "recent requests" table on its own. The call-logs endpoint merges the
 * in-memory active/completed entries with persisted rows and returns them newest-first
 * (active on top), which is exactly this feed.
 *
 * The poll is gated by `enabled` (the same `showProviderTopologyOnHome` flag that
 * gates the topology section) AND page visibility, so a backgrounded tab pauses.
 */

const POLL_INTERVAL_MS = 3000;
// Rows shown after client-side filtering of connection-test rows.
const RECENT_LIMIT = 20;
// Fetch a wider window than we display so filtering out connection-test rows
// (a burst of "Test connection" clicks) can't starve the feed below RECENT_LIMIT.
const FETCH_LIMIT = 60;

export type CallLogRow = {
  id?: string;
  timestamp?: string;
  status?: number;
  model?: string;
  provider?: string;
  providerDisplay?: string | null;
  path?: string;
  sourceFormat?: string | null;
  targetFormat?: string | null;
  tokens?: {
    in?: number;
    out?: number;
    cacheRead?: number;
    cacheWrite?: number;
    reasoning?: number;
    compressed?: number;
  };
  error?: string | null;
  active?: boolean;
  completed?: boolean;
};

/**
 * Connection tests write real `call_logs` rows (provider "Test connection" button →
 * `/api/providers/[id]/test`) with fixed markers: model `connection-test`, path
 * `/api/providers/test`, sourceFormat/targetFormat `test`. Those are health probes,
 * not user traffic, so they must not clutter the Recent Requests feed (matching how
 * 9Router keeps its Usage list to real calls). Drop any row carrying a test marker.
 */
export function isConnectionTestRow(row: CallLogRow): boolean {
  return (
    row.model === "connection-test" ||
    row.sourceFormat === "test" ||
    row.targetFormat === "test" ||
    row.path === "/api/providers/test"
  );
}

export type RequestState = "active" | "error" | "ok";

export function requestState(row: CallLogRow): RequestState {
  if (row.active || row.status === 0) return "active";
  if (row.error || (typeof row.status === "number" && row.status >= 400)) return "error";
  return "ok";
}

export function formatCachePercentage(
  tokensIn?: number | null,
  cacheRead?: number | null
): number {
  if (typeof cacheRead !== "number" || !Number.isFinite(cacheRead) || cacheRead <= 0) return 0;
  if (typeof tokensIn !== "number" || !Number.isFinite(tokensIn) || tokensIn <= 0) return 100;
  return Math.min(100, Math.max(1, Math.round((cacheRead / tokensIn) * 100)));
}

export function resolveProviderName(row: CallLogRow): string {
  if (row.providerDisplay && row.providerDisplay.trim()) {
    return row.providerDisplay.trim();
  }
  const provider = row.provider?.trim();
  if (!provider) return "—";

  const compatLabel = getProviderDisplayLabel(provider);
  if (compatLabel) return compatLabel;

  const config = (AI_PROVIDERS as Record<string, { name?: string }>)[provider];
  if (config?.name) return config.name;

  const colorConfig = (PROVIDER_COLORS as Record<string, { label?: string }>)[provider];
  if (colorConfig?.label) return colorConfig.label;

  return provider;
}

export function timeAgo(timestamp: string | undefined, nowMs: number): string {
  if (!timestamp) return "";
  const then = Date.parse(timestamp);
  if (!Number.isFinite(then)) return "";
  const diff = Math.max(0, Math.floor((nowMs - then) / 1000));
  if (diff < 60) return `${diff}s`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
  return `${Math.floor(diff / 86400)}d`;
}

const STATE_DOT: Record<RequestState, string> = {
  active: "bg-primary animate-pulse",
  error: "bg-red-500",
  ok: "bg-green-500",
};

export default function HomeRecentRequests({ enabled = true }: { enabled?: boolean }) {
  const t = useTranslations("home");
  const [rows, setRows] = useState<CallLogRow[]>([]);
  const [loaded, setLoaded] = useState(false);
  // A ticking clock so the relative "When" column updates without re-fetching.
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    if (!enabled) return;
    const id = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(id);
  }, [enabled]);

  const load = useCallback(async (signal: AbortSignal) => {
    try {
      const res = await fetch(`/api/usage/call-logs?limit=${FETCH_LIMIT}&excludeTests=1`, {
        cache: "no-store",
        signal,
      });
      if (!res.ok) return;
      const data = await res.json();
      if (signal.aborted) return;
      const filtered = Array.isArray(data)
        ? (data as CallLogRow[]).filter((row) => !isConnectionTestRow(row)).slice(0, RECENT_LIMIT)
        : [];
      setRows(filtered);
      setLoaded(true);
    } catch (error) {
      const isAbort = error instanceof DOMException && error.name === "AbortError";
      if (!isAbort) console.error("Failed to load recent requests:", error);
    }
  }, []);

  useEffect(() => {
    if (!enabled) return;

    let cancelled = false;
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    let controller: AbortController | null = null;

    const tick = async () => {
      // Pause polling while the tab is backgrounded; resume on next tick.
      if (document.visibilityState === "visible") {
        const currentController = new AbortController();
        controller = currentController;
        await load(currentController.signal);
        if (controller === currentController) controller = null;
      }
      if (!cancelled) timeoutId = setTimeout(tick, POLL_INTERVAL_MS);
    };

    tick();
    return () => {
      cancelled = true;
      if (timeoutId) clearTimeout(timeoutId);
      controller?.abort();
    };
  }, [enabled, load]);

  return (
    <Card padding="sm" className="flex min-w-0 flex-col overflow-hidden h-[300px] sm:h-[420px]">
      <div className="pb-2 mb-1 border-b border-border shrink-0">
        <span className="text-xs font-semibold uppercase tracking-wide text-text-muted">
          {t("recentRequests")}
        </span>
      </div>

      {loaded && rows.length === 0 ? (
        <div className="flex-1 flex items-center justify-center text-sm text-text-muted">
          {t("recentRequestsEmpty")}
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto -mx-1 px-1">
          <table className="w-full min-w-0 border-collapse text-xs">
            <thead className="sticky top-0 z-10 bg-surface">
              <tr className="border-b border-border text-text-muted">
                <th className="w-4 py-1.5 pl-1 pr-2" />
                <th className="py-1.5 text-left font-semibold">{t("recentRequestsProvider")}</th>
                <th className="py-1.5 text-left font-semibold">{t("recentRequestsModel")}</th>
                <th className="py-1.5 text-right font-semibold whitespace-nowrap">
                  {t("recentRequestsTokens")}
                </th>
                <th className="py-1.5 text-right font-semibold">{t("recentRequestsWhen")}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/50">
              {rows.map((row, i) => {
                const state = requestState(row);
                const providerName = resolveProviderName(row);
                const hasCache =
                  typeof row.tokens?.cacheRead === "number" && row.tokens.cacheRead > 0;
                const cachePct = hasCache
                  ? formatCachePercentage(row.tokens?.in, row.tokens?.cacheRead)
                  : 0;

                return (
                  <tr key={row.id || i} className="hover:bg-bg-subtle transition-colors">
                    <td className="py-1.5 pl-1 pr-2">
                      <span className={`block size-1.5 rounded-full shrink-0 ${STATE_DOT[state]}`} />
                    </td>
                    <td
                      className="py-1.5 truncate max-w-[80px] sm:max-w-[110px]"
                      title={providerName}
                    >
                      <div className="flex items-center gap-1.5 min-w-0">
                        {row.provider && (
                          <span className="size-3.5 rounded shrink-0 inline-flex items-center justify-center">
                            <ProviderIcon providerId={row.provider} size={14} type="color" />
                          </span>
                        )}
                        <span className="truncate font-medium text-text-main">
                          {providerName}
                        </span>
                      </div>
                    </td>
                    <td
                      className="py-1.5 font-mono truncate max-w-[90px] sm:max-w-[130px]"
                      title={row.model || ""}
                    >
                      {row.model || "—"}
                    </td>
                    <td className="py-1.5 text-right whitespace-nowrap">
                      <span className="text-primary">{fmtCompact(row.tokens?.in)}↑</span>{" "}
                      {hasCache && (
                        <>
                          <span
                            className="text-sky-600 dark:text-sky-400 font-medium"
                            title={
                              row.tokens?.cacheRead
                                ? `${fmtCompact(row.tokens.cacheRead)} cached (${cachePct}%)`
                                : `${cachePct}% cached`
                            }
                          >
                            {cachePct}%
                          </span>{" "}
                        </>
                      )}
                      <span className="text-green-500">{fmtCompact(row.tokens?.out)}↓</span>
                    </td>
                    <td className="py-1.5 text-right whitespace-nowrap text-text-muted">
                      {state === "active" ? (
                        <span className="text-primary">•••</span>
                      ) : (
                        timeAgo(row.timestamp, nowMs)
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}
