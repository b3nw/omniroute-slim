/**
 * First-byte deadline + fresh-connection retry for gemini-cli upstream calls.
 *
 * Google Cloud Code Assist (cloudcode-pa) occasionally holds a request before
 * emitting anything for 100s+, while an identical request on a fresh connection
 * answers in ~2s. Each attempt is bounded by a deadline that covers response
 * headers PLUS the first real SSE `data:` event (comments, blank lines and
 * ping/keepalive frames do not count). On deadline the attempt is aborted, its
 * body reader cancelled to release the socket, and the byte-identical request is
 * retried on a fresh no-keep-alive dispatcher when the egress is plain direct
 * undici (proxied / relayed / TLS-fingerprinted egress retries through the same
 * path). Nothing is ever retried once a byte has been handed downstream: the
 * bytes read ahead are replayed in front of the remaining stream.
 */
import { HTTP_STATUS } from "../config/constants.ts";
import { getFreshDirectRetryDispatcher } from "../utils/proxyFetch.ts";
import { prependBufferedChunks } from "../utils/streamReadiness.ts";
import { getGeminiCliFirstByteConfig } from "@/shared/utils/runtimeTimeouts";

export const GEMINI_CLI_FIRST_BYTE_TIMEOUT_CODE = "GEMINI_CLI_FIRST_BYTE_TIMEOUT";
const ATTEMPT_DEADLINE_CODE = "GEMINI_CLI_FIRST_BYTE_ATTEMPT_DEADLINE";
// Retries get a slightly longer window: a fresh connection pays a TLS handshake.
const RETRY_DEADLINE_MULTIPLIER = 1.5;

export type GeminiCliDispatcherKind = "pooled" | "fresh";
export type GeminiCliAttemptOutcome = "ok" | "first_byte_timeout" | "error";

export type GeminiCliAttemptTiming = {
  attempt: number;
  dispatcher: GeminiCliDispatcherKind;
  /** Per-attempt deadline in ms (null when the deadline is disabled). */
  deadlineMs: number | null;
  /** fetch start → response headers. */
  upstreamHeadersMs: number | null;
  /** fetch start → first non-empty, non-comment, non-ping SSE `data:` event. */
  upstreamFirstDataMs: number | null;
  status: number | null;
  outcome: GeminiCliAttemptOutcome;
};

export class GeminiCliFirstByteTimeoutError extends Error {
  code = GEMINI_CLI_FIRST_BYTE_TIMEOUT_CODE;
  status = HTTP_STATUS.GATEWAY_TIMEOUT;
  attempts: GeminiCliAttemptTiming[];

  constructor(attempts: GeminiCliAttemptTiming[], elapsedMs: number) {
    super(
      `Gemini CLI upstream produced no first data event after ${attempts.length} attempt(s) in ${elapsedMs}ms`
    );
    // TimeoutError + 504 → chatCore tags errorType "upstream_timeout" (self-inflicted,
    // no connection cooldown) and the code is request-scoped for combo failover.
    this.name = "TimeoutError";
    this.attempts = attempts;
  }
}

export function isGeminiCliFirstByteTimeout(err: unknown): boolean {
  return (
    !!err &&
    typeof err === "object" &&
    (err as { code?: unknown }).code === GEMINI_CLI_FIRST_BYTE_TIMEOUT_CODE
  );
}

type FetchInit = RequestInit & { dispatcher?: unknown };
type FetchLike = (url: string, init: FetchInit) => Promise<Response>;

export type FirstByteDeadlineOptions = {
  url: string;
  /** method/headers/body. The body must be a pre-serialized string so every attempt is byte-identical. */
  init: Omit<RequestInit, "signal"> & { body: string };
  signal?: AbortSignal | null;
  timeoutMs?: number;
  maxAttempts?: number;
  totalBudgetMs?: number;
  /** Defaults to the (patched) global fetch, resolved at call time. */
  fetchImpl?: FetchLike;
  /** Returns a fresh dispatcher for retries, or null to retry through the default path. */
  getFreshDispatcher?: (url: string) => unknown | null;
  now?: () => number;
  onAttempt?: (timing: GeminiCliAttemptTiming) => void;
};

export type FirstByteDeadlineResult = {
  response: Response;
  attempts: GeminiCliAttemptTiming[];
};

/** Incremental SSE scanner: true once a real `data:` event has been seen. */
export function createSseFirstDataScanner(): (chunk: Uint8Array) => boolean {
  const decoder = new TextDecoder();
  let pending = "";
  let eventName = "";
  let found = false;
  const isKeepaliveEvent = () => /^(ping|keep-?alive|heartbeat)$/i.test(eventName);

  return (chunk) => {
    if (found) return true;
    pending += decoder.decode(chunk, { stream: true });
    const lines = pending.split(/\r?\n/);
    pending = lines.pop() ?? "";
    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line) {
        eventName = "";
        continue;
      }
      if (line.startsWith(":")) continue;
      if (line.startsWith("event:")) {
        eventName = line.slice(6).trim();
        continue;
      }
      if (line.startsWith("data:") && line.slice(5).trim() && !isKeepaliveEvent()) {
        found = true;
        return true;
      }
    }
    return false;
  };
}

function mergeAbortSignals(
  primary: AbortSignal | null | undefined,
  secondary: AbortSignal
): AbortSignal {
  if (!primary) return secondary;
  if (primary.aborted) return primary;
  const controller = new AbortController();
  const onPrimaryAbort = () => controller.abort(primary.reason);
  const onSecondaryAbort = () => controller.abort(secondary.reason);
  const cleanup = () => {
    primary.removeEventListener("abort", onPrimaryAbort);
    secondary.removeEventListener("abort", onSecondaryAbort);
  };
  primary.addEventListener("abort", onPrimaryAbort, { once: true });
  secondary.addEventListener("abort", onSecondaryAbort, { once: true });
  controller.signal.addEventListener("abort", cleanup, { once: true });
  return controller.signal;
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("This operation was aborted", "AbortError");
}

/** Settles with `promise`, or rejects as soon as `signal` aborts (even if `promise` ignores it). */
function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    promise.catch(() => {});
    return Promise.reject(abortReason(signal));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortReason(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      }
    );
  });
}

function createAttemptDeadlineReason(deadlineMs: number): Error {
  const err = new Error(`Gemini CLI first-byte deadline (${deadlineMs}ms) exceeded`) as Error & {
    code: string;
  };
  err.name = "TimeoutError";
  err.code = ATTEMPT_DEADLINE_CODE;
  return err;
}

function replayResponse(
  response: Response,
  chunks: Uint8Array[],
  reader: ReadableStreamDefaultReader<Uint8Array>
): Response {
  const headers = new Headers(response.headers);
  // The body has already been decoded by fetch; these no longer describe it.
  headers.delete("content-encoding");
  headers.delete("content-length");
  return new Response(prependBufferedChunks(chunks, reader), {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/**
 * Fetch a gemini-cli SSE endpoint with a per-attempt first-byte deadline and
 * fresh-connection retries. Non-2xx responses are returned untouched (no retry),
 * caller aborts propagate immediately, and exhaustion throws
 * {@link GeminiCliFirstByteTimeoutError}. With timeoutMs <= 0 this is a single
 * plain fetch, identical to the pre-deadline behavior.
 */
export async function fetchWithFirstByteDeadline(
  options: FirstByteDeadlineOptions
): Promise<FirstByteDeadlineResult> {
  const config = getGeminiCliFirstByteConfig();
  const timeoutMs = options.timeoutMs ?? config.timeoutMs;
  const maxAttempts = Math.max(1, Math.floor(options.maxAttempts ?? config.maxAttempts));
  const totalBudgetMs = options.totalBudgetMs ?? config.totalBudgetMs;
  const fetchImpl: FetchLike =
    options.fetchImpl ?? ((url, init) => globalThis.fetch(url, init as RequestInit));
  const getFreshDispatcher = options.getFreshDispatcher ?? getFreshDirectRetryDispatcher;
  const now = options.now ?? Date.now;
  const callerSignal = options.signal ?? null;
  const attempts: GeminiCliAttemptTiming[] = [];
  const record = (timing: GeminiCliAttemptTiming) => {
    attempts.push(timing);
    options.onAttempt?.(timing);
  };

  if (!timeoutMs || timeoutMs <= 0) {
    const timing: GeminiCliAttemptTiming = {
      attempt: 1,
      dispatcher: "pooled",
      deadlineMs: null,
      upstreamHeadersMs: null,
      upstreamFirstDataMs: null,
      status: null,
      outcome: "error",
    };
    const t0 = now();
    try {
      const response = await fetchImpl(options.url, {
        ...options.init,
        signal: callerSignal || undefined,
      });
      timing.upstreamHeadersMs = now() - t0;
      timing.status = response.status;
      timing.outcome = response.ok ? "ok" : "error";
      record(timing);
      return { response, attempts };
    } catch (err) {
      record(timing);
      throw err;
    }
  }

  const start = now();
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (callerSignal?.aborted) throw abortReason(callerSignal);
    const remainingMs = totalBudgetMs - (now() - start);
    if (attempt > 1 && remainingMs <= 0) break;
    const baseDeadlineMs =
      attempt === 1 ? timeoutMs : Math.floor(timeoutMs * RETRY_DEADLINE_MULTIPLIER);
    const deadlineMs = Math.max(1, Math.min(baseDeadlineMs, remainingMs));
    const dispatcher = attempt > 1 ? getFreshDispatcher(options.url) : null;

    const timing: GeminiCliAttemptTiming = {
      attempt,
      dispatcher: dispatcher ? "fresh" : "pooled",
      deadlineMs,
      upstreamHeadersMs: null,
      upstreamFirstDataMs: null,
      status: null,
      outcome: "error",
    };

    const attemptController = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      attemptController.abort(createAttemptDeadlineReason(deadlineMs));
    }, deadlineMs);
    // Intentionally NOT unref'd: this timer is always cleared on every exit path,
    // and an unref'd deadline could let the event loop drain while an attempt is
    // still pending (the deadline must fire to abort a hung upstream).
    const attemptSignal = mergeAbortSignals(callerSignal, attemptController.signal);

    // Casts keep TS from narrowing these to `null` inside the catch block.
    let response = null as Response | null;
    let reader = null as ReadableStreamDefaultReader<Uint8Array> | null;
    const t0 = now();
    try {
      const fetchPromise = fetchImpl(options.url, {
        ...options.init,
        signal: attemptSignal,
        ...(dispatcher ? { dispatcher } : {}),
      });
      // If the deadline/abort wins the race, release whatever the fetch eventually yields.
      fetchPromise.then(
        (late) => {
          if (attemptSignal.aborted) void late.body?.cancel().catch(() => {});
        },
        () => {}
      );
      response = await raceAbort(fetchPromise, attemptSignal);
      timing.upstreamHeadersMs = now() - t0;
      timing.status = response.status;

      if (!response.ok || !response.body) {
        clearTimeout(timer);
        timing.outcome = response.ok ? "ok" : "error";
        record(timing);
        return { response, attempts };
      }

      reader = response.body.getReader();
      const sawFirstData = createSseFirstDataScanner();
      const chunks: Uint8Array[] = [];
      while (true) {
        const { done, value } = await raceAbort(reader.read(), attemptSignal);
        if (done) break; // EOF before any data event: hand back what we have.
        if (!value || value.byteLength === 0) continue;
        chunks.push(value);
        if (sawFirstData(value)) {
          timing.upstreamFirstDataMs = now() - t0;
          break;
        }
      }
      clearTimeout(timer);
      timing.outcome = "ok";
      record(timing);
      return { response: replayResponse(response, chunks, reader), attempts };
    } catch (err) {
      clearTimeout(timer);
      if (reader) {
        void reader.cancel(err).catch(() => {});
      } else if (response?.body && !response.bodyUsed) {
        void response.body.cancel(err).catch(() => {});
      }
      if (callerSignal?.aborted) {
        record(timing);
        throw err;
      }
      if (timedOut) {
        timing.outcome = "first_byte_timeout";
        record(timing);
        continue;
      }
      record(timing);
      throw err;
    }
  }

  throw new GeminiCliFirstByteTimeoutError(attempts, now() - start);
}
