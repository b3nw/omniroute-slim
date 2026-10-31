import {
  classifyProviderSafetyError,
  isProviderSafetyStopsEnabled,
} from "../../utils/providerSafety.ts";
import { normalizeStreamFailurePayload } from "../../utils/streamErrorFormat.ts";
import {
  COMBO_HEDGE_CANCELLED_REASON,
  propagateComboTargetTimeoutDisarm,
} from "./comboAbortReasons.ts";
import { finishComboTrace } from "./decisionTrace.ts";
import type { HandleComboChatOptions } from "./types.ts";

type ComboInner = (options: HandleComboChatOptions) => Promise<Response>;

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : {};
}

/**
 * Read a JSON error body's code/type/message. Under PROVIDER_SAFETY_STOPS_TERMINAL a
 * Responses failure that only carries `response.error` is read too (#17049).
 */
function readJsonErrorFields(parsed: unknown): {
  errorCode: unknown;
  errorType: unknown;
  message: unknown;
} {
  const record = asRecord(parsed);
  const rootError = asRecord(record.error);
  const errorObj =
    Object.keys(rootError).length > 0 || !isProviderSafetyStopsEnabled()
      ? rootError
      : asRecord(asRecord(record.response).error);
  return {
    errorCode: errorObj.code,
    errorType: errorObj.type,
    message: errorObj.message ?? record.message,
  };
}

/** True when a 400/403 target response carries an explicit provider safety stop. */
async function isSafetyRejection(result: Response): Promise<boolean> {
  if (result.status !== 400 && result.status !== 403) return false;
  let parsed: unknown;
  try {
    parsed = await result.clone().json();
  } catch {
    // Non-JSON errors retain ordinary routing behavior.
    return false;
  }
  const error = readJsonErrorFields(parsed);
  return (
    classifyProviderSafetyError({
      code: error.errorCode,
      type: error.errorType,
      message: error.message,
      status: result.status,
    }) !== null
  );
}

// Lifecycle frames that precede the first substantive SSE event and carry no content.
const PRE_CONTENT_SSE_EVENTS = new Set([
  "response.created",
  "response.in_progress",
  "message_start",
  "ping",
]);
const MAX_SSE_SAFETY_PEEK_BYTES = 64 * 1024;

function isSseErrorFrame(parsed: JsonRecord, eventType: string): boolean {
  if (eventType === "response.failed" || eventType === "error") return true;
  if (parsed.error != null && typeof parsed.error === "object") return true;
  const response = asRecord(parsed.response);
  return response.status === "failed" && response.error != null;
}

// Delta keys that only describe the turn. Any other non-empty key (content, refusal, tool
// calls, or any reasoning variant: reasoning, reasoning_content, reasoning_details,
// reasoning_text, thinking, thought, ...) is substantive and ends the peek.
const NON_CONTENT_DELTA_KEYS = new Set(["role"]);

function isEmptyDeltaValue(value: unknown): boolean {
  if (value == null || value === "") return true;
  if (Array.isArray(value)) return value.length === 0;
  return typeof value === "object" && Object.keys(value).length === 0;
}

/**
 * True for a Chat Completions chunk whose choices only open the turn (e.g.
 * `delta: { role: "assistant" }`) without content, reasoning, tools or a finish reason.
 */
function isRoleOnlyDeltaFrame(parsed: JsonRecord): boolean {
  const choices = parsed.choices;
  if (!Array.isArray(choices)) return false;
  if (choices.length === 0) return true;
  return choices.every((choice) => {
    const record = asRecord(choice);
    if (record.finish_reason != null) return false;
    const delta = asRecord(record.delta);
    return Object.entries(delta).every(
      ([key, value]) => NON_CONTENT_DELTA_KEYS.has(key) || isEmptyDeltaValue(value)
    );
  });
}

/** Classify one parsed SSE frame: a safety stop, other content/error, or a pre-content frame. */
function classifySseFrame(parsed: JsonRecord, eventType: string): "safety" | "stop" | null {
  if (isSseErrorFrame(parsed, eventType)) {
    // normalizeStreamFailurePayload already maps a code-less legacy stop to its bounded label.
    const failure = normalizeStreamFailurePayload(parsed);
    const safety =
      failure &&
      classifyProviderSafetyError({
        status: failure.status,
        code: failure.code,
        type: failure.type,
        message: failure.message,
      });
    return safety ? "safety" : "stop";
  }
  if (PRE_CONTENT_SSE_EVENTS.has(eventType)) return null;
  return isRoleOnlyDeltaFrame(parsed) ? null : "stop";
}

/**
 * A 200 SSE target that fails with a safety stop before any content (e.g. `response.failed`
 * carrying content_policy_violation). Peeks a bounded pre-content prefix of a clone and, on a
 * safety stop, returns a replayable response holding the refusal; otherwise null.
 */
async function peekSseSafetyRejection(result: Response): Promise<Response | null> {
  if (result.status !== 200) return null;
  if (!(result.headers.get("content-type") || "").includes("text/event-stream")) return null;
  let peek: Response;
  try {
    peek = result.clone();
  } catch {
    return null;
  }
  if (!peek.body) return null;
  const reader = peek.body.getReader();
  const decoder = new TextDecoder("utf-8");
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  let pending = "";
  let eventType = "";
  let verdict: "safety" | "stop" | null = null;
  let done = false;
  try {
    while (verdict === null && !done && bytes < MAX_SSE_SAFETY_PEEK_BYTES) {
      const next = await reader.read();
      done = next.done;
      if (next.value) {
        chunks.push(next.value);
        bytes += next.value.byteLength;
      }
      pending += done ? decoder.decode() + "\n" : decoder.decode(next.value, { stream: true });
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith("event:")) {
          eventType = trimmed.slice(6).trim();
          continue;
        }
        if (!trimmed.startsWith("data:")) {
          if (!trimmed) eventType = "";
          continue;
        }
        const data = trimmed.slice(5).trim();
        if (!data) continue;
        if (data === "[DONE]") {
          verdict = "stop";
          break;
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(data);
        } catch {
          verdict = "stop";
          break;
        }
        const record = asRecord(parsed);
        verdict = classifySseFrame(
          record,
          (typeof record.type === "string" ? record.type : "") || eventType
        );
        eventType = "";
        if (verdict !== null) break;
      }
    }
  } catch {
    verdict = "stop";
  }
  if (verdict !== "safety") {
    // Cancelling one tee branch leaves the strategy's branch streaming.
    reader.cancel().catch(() => {});
    return null;
  }
  // Replay the peeked refusal prefix, then forward whatever remains of the clone.
  let index = 0;
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (index < chunks.length) {
        controller.enqueue(chunks[index++]);
        return;
      }
      try {
        if (done) {
          controller.close();
          return;
        }
        const next = await reader.read();
        if (next.done) controller.close();
        else controller.enqueue(next.value);
      } catch {
        controller.close();
      }
    },
    cancel() {
      reader.cancel().catch(() => {});
    },
  });
  return new Response(body, {
    status: result.status,
    statusText: result.statusText,
    headers: result.headers,
  });
}

/**
 * PROVIDER_SAFETY_STOPS_TERMINAL (#17049): run one combo invocation with a safety latch.
 * The latch sits before strategy code sees a target response, so neither retries nor
 * intentional sibling cancellation can replace a refusal. State is local to this invocation.
 */
export async function runComboWithSafetyLatch(
  options: HandleComboChatOptions,
  invocationId: string,
  inner: ComboInner
): Promise<Response> {
  const terminalController = new AbortController();
  const signal = options.signal
    ? AbortSignal.any([options.signal, terminalController.signal])
    : terminalController.signal;
  let safetyResponse: Response | null = null;
  const handleSingleModel: HandleComboChatOptions["handleSingleModel"] = async (
    body,
    model,
    target
  ) => {
    if (safetyResponse) return safetyResponse.clone();
    signal.throwIfAborted();
    const modelAbortSignal = target?.modelAbortSignal
      ? AbortSignal.any([signal, target.modelAbortSignal])
      : signal;
    // Keep the per-target startup-timeout disarm and selected-connection attribution
    // reachable from the derived signal the target actually receives.
    if (target?.modelAbortSignal) {
      propagateComboTargetTimeoutDisarm(modelAbortSignal, target.modelAbortSignal);
    }
    const result = await options.handleSingleModel(body, model, { ...target, modelAbortSignal });
    if (!safetyResponse && (await isSafetyRejection(result)) && !safetyResponse) {
      safetyResponse = result.clone();
      terminalController.abort(new Error(COMBO_HEDGE_CANCELLED_REASON));
      return result;
    }
    // Pre-content SSE refusals arrive as 200 streams; latch them before strategy code can
    // treat them as an ordinary quality failure and fall back to another target.
    const sseSafety = safetyResponse ? null : await peekSseSafetyRejection(result);
    if (sseSafety && !safetyResponse) {
      safetyResponse = sseSafety;
      terminalController.abort(new Error(COMBO_HEDGE_CANCELLED_REASON));
    }
    return result;
  };
  let response: Response;
  try {
    response = await inner({ ...options, invocationId, handleSingleModel, signal });
  } catch (error) {
    if (!safetyResponse) throw error;
    response = safetyResponse;
  }
  if (safetyResponse) {
    response = safetyResponse;
    finishComboTrace(invocationId, { status: response.status, errorClass: "safety_rejection" });
  }
  return response;
}
