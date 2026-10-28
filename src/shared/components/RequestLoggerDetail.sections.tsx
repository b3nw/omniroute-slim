"use client";

import { useState, useEffect, useRef } from "react";
import { useTranslations } from "next-intl";
import { ChatBubble } from "@/shared/components/conversation/ChatBubble";
import { buildRequestTurns, buildResponseTurns } from "@/shared/conversation/conversationNormalizer";
import type { ConversationResponsePayload, NormalizedTurn } from "@/shared/conversation/types";

// ─── Call log size-limit notices ────────────────────────────────────────────
// Mirrors the markers src/lib/usage/callLogArtifacts.ts writes in place of (or
// after a preview of) a payload that pushed its artifact over the size cap.
// Strings are matched exactly, never by substring, so ordinary payload text
// that merely mentions "omitted" is not mistaken for a notice.

const SIZE_LIMIT_OMITTED_MARKERS = new Set([
  "[omitted: call log artifact size limit exceeded]",
  "[stream chunks omitted: call log artifact size limit exceeded]",
]);
const SIZE_LIMIT_TRUNCATED_SUFFIX = " [truncated: call log artifact size limit exceeded]";
const SIZE_LIMIT_REASON = "call_log_artifact_size_limit_exceeded";

export type SizeLimitNotice =
  | { kind: "omitted" }
  | { kind: "truncated"; preview: string; keptBytes: number; originalBytes: number | null };

function utf8ByteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

function stripTruncatedSuffix(text: string): string {
  return text.endsWith(SIZE_LIMIT_TRUNCATED_SUFFIX)
    ? text.slice(0, -SIZE_LIMIT_TRUNCATED_SUFFIX.length)
    : text;
}

export function getSizeLimitNotice(payload: unknown): SizeLimitNotice | null {
  if (typeof payload === "string") {
    if (SIZE_LIMIT_OMITTED_MARKERS.has(payload)) return { kind: "omitted" };
    if (!payload.endsWith(SIZE_LIMIT_TRUNCATED_SUFFIX)) return null;
    const preview = stripTruncatedSuffix(payload);
    return { kind: "truncated", preview, keptBytes: utf8ByteLength(preview), originalBytes: null };
  }

  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const record = payload as Record<string, unknown>;
  if (record._omniroute_truncated === true && typeof record.preview === "string") {
    const preview = stripTruncatedSuffix(record.preview);
    return {
      kind: "truncated",
      preview,
      keptBytes: utf8ByteLength(preview),
      originalBytes: typeof record._originalBytes === "number" ? record._originalBytes : null,
    };
  }
  if (record._omniroute_truncated === true || record.reason === SIZE_LIMIT_REASON) {
    return { kind: "omitted" };
  }
  return null;
}

export function isSizeLimitOmission(payload: unknown): boolean {
  return getSizeLimitNotice(payload)?.kind === "omitted";
}

function formatKiB(bytes: number): string {
  return `${(bytes / 1024).toFixed(1)} KiB`;
}

export function SizeLimitNoticeBanner({ notice }: { notice: SizeLimitNotice }) {
  const t = useTranslations("requestLogger.detail.payload");

  let message: string;
  if (notice.kind === "omitted") {
    message = t("omitted");
  } else if (notice.originalBytes != null) {
    message = t("truncated", {
      kept: formatKiB(notice.keptBytes),
      total: formatKiB(notice.originalBytes),
    });
  } else {
    message = t("truncatedNoTotal", { kept: formatKiB(notice.keptBytes) });
  }

  return (
    <div className="p-4 rounded-xl bg-amber-500/10 border border-amber-500/30">
      <div className="text-[10px] text-amber-700 dark:text-amber-400 uppercase tracking-wider mb-1 font-bold">
        {t("sizeLimitTitle")}
      </div>
      <div className="text-sm text-amber-700 dark:text-amber-200">{message}</div>
    </div>
  );
}

// ─── Payload Code Block ─────────────────────────────────────────────────────

// `payload` is the raw value behind `json`; when given, a size-limit omission
// replaces the code block with a notice and a truncated preview is labelled.
export function PayloadSection({
  title,
  json,
  onCopy,
  payload = undefined,
  collapsible = true,
  defaultOpen = true,
}) {
  const t = useTranslations("requestLogger.detail");
  const [copied, setCopied] = useState(false);
  const [open, setOpen] = useState(defaultOpen);
  const sizeLimitNotice = payload === undefined ? null : getSizeLimitNotice(payload);

  const handleCopy = async () => {
    const success = await onCopy();
    if (success !== false) {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-3">
          <h3 className="text-[11px] text-text-muted uppercase tracking-wider font-bold">
            {title}
          </h3>
          {collapsible && (
            <button
              onClick={() => setOpen((v) => !v)}
              className="p-1 rounded hover:bg-bg-subtle text-text-muted hover:text-text-primary transition-colors"
              aria-label={open ? t("collapse", { title }) : t("expand", { title })}
            >
              <span className="material-symbols-outlined text-[16px]">
                {open ? "expand_less" : "expand_more"}
              </span>
            </button>
          )}
        </div>
        <button
          onClick={handleCopy}
          className="flex items-center gap-1 px-2 py-1 text-xs text-text-muted hover:text-text-primary transition-colors"
          aria-label={t("copyTitle", { title })}
        >
          <span className="material-symbols-outlined text-[14px]">
            {copied ? "check" : "content_copy"}
          </span>
          {copied ? t("copied") : t("copy")}
        </button>
      </div>
      {open && sizeLimitNotice && (
        <div className={sizeLimitNotice.kind === "truncated" ? "mb-2" : undefined}>
          <SizeLimitNoticeBanner notice={sizeLimitNotice} />
        </div>
      )}
      {open && sizeLimitNotice?.kind !== "omitted" && (
        <pre className="p-4 rounded-xl bg-black/5 dark:bg-black/30 border border-border overflow-x-auto text-xs font-mono text-text-main max-h-150 overflow-y-auto leading-relaxed whitespace-pre-wrap break-words">
          {json}
        </pre>
      )}
    </div>
  );
}

// ─── Conversation context section ───────────────────────────────────────────
// Renders THIS request's own context (its request body's messages/input, plus
// its response) — a plain single-request normalization, same shape as the
// conversation viewer, no cross-request reconstruction. While
// the request is still generating (detail.active === true) the response side
// shows the partial text captured so far, refreshed on a short poll scoped to
// just this section.
const CONVERSATION_ACTIVE_POLL_INTERVAL_MS = 1200;

function asInterceptedResponseBody(responseBody: unknown): ConversationResponsePayload {
  return {
    responseHeaders: {},
    responseBody: responseBody != null ? JSON.stringify(responseBody) : null,
  };
}

export function ConversationContextSection({ log, detail }) {
  const [open, setOpen] = useState(true);
  const [liveDetail, setLiveDetail] = useState(detail);
  const [liveRefresh, setLiveRefresh] = useState(() => {
    try {
      const v = localStorage.getItem("pref:conversationContext:liveRefresh");
      return v == null ? true : v === "1";
    } catch {
      return true;
    }
  });
  const turnsBoxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setLiveDetail(detail);
  }, [detail]);

  // Same live-poll pattern as the SSE Events section (StreamSection below),
  // but gated on liveRefresh too: an active request keeps generating either
  // way, this toggle only controls whether THIS panel keeps fetching/
  // redrawing while the user reads it.
  useEffect(() => {
    if (!liveDetail?.active || !liveRefresh) return;
    let cancelled = false;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;

    const tick = () => {
      if (cancelled) return;
      if (document.visibilityState !== "visible") {
        timeoutId = setTimeout(tick, CONVERSATION_ACTIVE_POLL_INTERVAL_MS);
        return;
      }
      fetch(`/api/logs/${log.id}`, { cache: "no-store" })
        .then((res) => (res.ok ? res.json() : null))
        .then((data) => {
          if (cancelled || !data) return;
          setLiveDetail(data);
          if (data.active) timeoutId = setTimeout(tick, CONVERSATION_ACTIVE_POLL_INTERVAL_MS);
        })
        .catch(() => {
          timeoutId = setTimeout(tick, CONVERSATION_ACTIVE_POLL_INTERVAL_MS);
        });
    };

    timeoutId = setTimeout(tick, CONVERSATION_ACTIVE_POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      if (timeoutId) clearTimeout(timeoutId);
    };
  }, [liveDetail?.active, liveRefresh, log.id]);

  const toggleLiveRefresh = () => {
    const next = !liveRefresh;
    setLiveRefresh(next);
    try {
      localStorage.setItem("pref:conversationContext:liveRefresh", next ? "1" : "0");
    } catch {}
  };

  const scrollToBottom = () => {
    const el = turnsBoxRef.current;
    if (!el) return;
    requestAnimationFrame(() => {
      try {
        el.scrollTop = el.scrollHeight;
      } catch {}
    });
  };

  const requestBody =
    liveDetail?.requestBody ?? liveDetail?.pipelinePayloads?.clientRequest ?? null;
  const requestTurns = buildRequestTurns(requestBody) ?? [];

  const responseBody = liveDetail?.responseBody ?? null;
  const responseTurns: NormalizedTurn[] =
    responseBody != null
      ? buildResponseTurns(asInterceptedResponseBody(responseBody))
      : liveDetail?.partialAssistantText
        ? [
            {
              role: "assistant",
              blocks: [{ type: "text", text: liveDetail.partialAssistantText }],
            },
          ]
        : [];

  const allTurns: NormalizedTurn[] = [...requestTurns, ...responseTurns];

  // Follow new content as it streams in — same idea as StreamSection's
  // autoscroll effect, tied to the same liveRefresh toggle.
  useEffect(() => {
    if (!liveRefresh || !open) return;
    scrollToBottom();
  }, [allTurns.length, liveDetail?.partialAssistantText, liveRefresh, open]);

  if (allTurns.length === 0) return null;

  return (
    <div>
      <div className="flex items-center justify-between gap-3 mb-2">
        <div className="flex items-center gap-3">
          <h3 className="text-[11px] text-text-muted uppercase tracking-wider font-bold">
            Conversation Context
          </h3>
          <button
            onClick={() => setOpen((v) => !v)}
            className="p-1 rounded hover:bg-bg-subtle text-text-muted hover:text-text-primary transition-colors"
            aria-label={open ? "Collapse Conversation Context" : "Expand Conversation Context"}
          >
            <span className="material-symbols-outlined text-[16px]">
              {open ? "expand_less" : "expand_more"}
            </span>
          </button>
        </div>
        {open && (
          <div className="flex items-center gap-1">
            {liveDetail?.active && (
              <button
                onClick={toggleLiveRefresh}
                title={liveRefresh ? "Live refresh: on" : "Live refresh: off"}
                className={`p-1 rounded hover:bg-bg-subtle text-text-muted hover:text-text-primary transition-colors ${liveRefresh ? "text-primary" : ""}`}
                aria-pressed={liveRefresh}
              >
                <span className="material-symbols-outlined text-[18px]">
                  {liveRefresh ? "sync" : "sync_disabled"}
                </span>
              </button>
            )}
            <button
              onClick={scrollToBottom}
              title="Go to bottom"
              className="p-1 rounded hover:bg-bg-subtle text-text-muted hover:text-text-primary transition-colors"
              aria-label="Go to bottom"
            >
              <span className="material-symbols-outlined text-[18px]">vertical_align_bottom</span>
            </button>
          </div>
        )}
      </div>
      {open && (
        <div
          ref={turnsBoxRef}
          className="rounded-xl bg-black/5 dark:bg-black/30 border border-border max-h-150 overflow-y-auto p-3 space-y-2"
        >
          {allTurns.map((turn, i) => (
            <ChatBubble key={i} turn={turn} />
          ))}
        </div>
      )}
    </div>
  );
}
