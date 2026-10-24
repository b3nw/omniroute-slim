/**
 * Shared abort reasons for combo target dispatch.
 *
 * `buildTargetTimeoutRunner` aborts a stalled target with `new Error(...)` as the
 * abort reason, and hedged targets are cancelled with a different one. Consumers
 * downstream (session-affinity eviction in src/sse/handlers/chat.ts) must be able
 * to tell those two apart from an ordinary client disconnect: only the per-model
 * TIMEOUT means "this account stalled", while a hedge cancellation means "a
 * sibling target won" and says nothing about the account's health.
 *
 * Kept as a dependency-free leaf so src/** can import it without pulling in the
 * combo dispatcher.
 */

/** Abort reason used when a combo target exceeds `comboTargetTimeoutMs`. */
export const COMBO_PER_MODEL_TIMEOUT_REASON = "combo-per-model-timeout";

/** Abort reason used when a hedged sibling target won the race. */
export const COMBO_HEDGE_CANCELLED_REASON = "hedge-cancelled";

function abortReasonMessage(signal: AbortSignal): string {
  const reason: unknown = signal.reason;
  if (typeof reason === "string") return reason;
  if (reason && typeof reason === "object" && typeof (reason as Error).message === "string") {
    return (reason as Error).message;
  }
  return "";
}

/**
 * True only when `signal` was aborted by the combo per-model timeout. A client
 * disconnect, a hedge cancellation, or a non-aborted signal all return false.
 */
export function isComboPerModelTimeoutAbort(signal: AbortSignal | null | undefined): boolean {
  if (!signal?.aborted) return false;
  return abortReasonMessage(signal) === COMBO_PER_MODEL_TIMEOUT_REASON;
}

/**
 * Per-target startup-timeout disarmers, keyed by the abort signal handed to the
 * target. `buildTargetTimeoutRunner` registers one on its timeout signal; every
 * place that wraps/merges that signal propagates it, so downstream code holding
 * only a derived signal can disarm the startup timer once the upstream response
 * has started (first byte for streaming, headers for non-streaming buffering).
 * Without this, a stream:false target is killed mid-generation because the
 * runner's timer wraps the whole buffered body read.
 */
const targetTimeoutDisarmers = new WeakMap<AbortSignal, () => void>();

export function registerComboTargetTimeoutDisarm(
  signal: AbortSignal | null | undefined,
  disarm: () => void
): void {
  if (!signal) return;
  targetTimeoutDisarmers.set(signal, disarm);
}

/** Make `targetSignal` able to disarm whatever any of `sourceSignals` could disarm. */
export function propagateComboTargetTimeoutDisarm(
  targetSignal: AbortSignal | null | undefined,
  ...sourceSignals: Array<AbortSignal | null | undefined>
): void {
  if (!targetSignal) return;
  const disarmFns: Array<() => void> = [];
  for (const src of sourceSignals) {
    const fn = src ? targetTimeoutDisarmers.get(src) : undefined;
    if (fn) disarmFns.push(fn);
  }
  if (disarmFns.length > 0) {
    targetTimeoutDisarmers.set(targetSignal, () => {
      for (const fn of disarmFns) fn();
    });
  }
}

/** Disarm the combo per-target startup timeout reachable from `signal` (one-shot, idempotent). */
export function disarmComboTargetTimeout(signal: AbortSignal | null | undefined): void {
  if (!signal) return;
  const disarm = targetTimeoutDisarmers.get(signal);
  if (disarm) {
    targetTimeoutDisarmers.delete(signal);
    disarm();
  }
}
