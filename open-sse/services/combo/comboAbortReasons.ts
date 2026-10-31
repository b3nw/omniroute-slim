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

/**
 * Per-target selected-connection records, keyed by abort signal. A combo target's
 * resolved `connectionId` is not necessarily the one dispatched (session-affinity
 * pins can swap it, #5903), so `buildTargetTimeoutRunner` tracks a mutable holder on
 * its timeout signal and the chat dispatch path records the connection it actually
 * used. Derived/merged signals share the SAME holder objects (propagated alongside
 * the disarmers below), so a record made on a derived signal is visible when the
 * runner reads its original signal and attributes a synthetic 504 to the
 * connection that really stalled.
 */
type SelectedConnectionHolder = { connectionId?: string };
const selectedConnectionHolders = new WeakMap<AbortSignal, SelectedConnectionHolder[]>();

/** Start tracking the dispatched connection for `signal` (resets any prior record). */
export function trackComboTargetSelectedConnection(signal: AbortSignal | null | undefined): void {
  if (!signal) return;
  selectedConnectionHolders.set(signal, [{}]);
}

/** Record the connection actually selected for dispatch on (a signal derived from) a target signal. */
export function recordComboTargetSelectedConnection(
  signal: AbortSignal | null | undefined,
  connectionId: string | null | undefined
): void {
  if (!signal || typeof connectionId !== "string" || connectionId.length === 0) return;
  const holders = selectedConnectionHolders.get(signal);
  if (!holders) return;
  for (const holder of holders) holder.connectionId = connectionId;
}

/** The connection last recorded as dispatched for `signal`, if any. */
export function getComboTargetSelectedConnection(
  signal: AbortSignal | null | undefined
): string | undefined {
  if (!signal) return undefined;
  return selectedConnectionHolders.get(signal)?.find((holder) => holder.connectionId)?.connectionId;
}

/**
 * Make `targetSignal` able to disarm whatever any of `sourceSignals` could disarm, and
 * share their selected-connection holders (see trackComboTargetSelectedConnection).
 */
export function propagateComboTargetTimeoutDisarm(
  targetSignal: AbortSignal | null | undefined,
  ...sourceSignals: Array<AbortSignal | null | undefined>
): void {
  if (!targetSignal) return;
  const disarmFns: Array<() => void> = [];
  const holders = new Set<SelectedConnectionHolder>();
  for (const src of sourceSignals) {
    const fn = src ? targetTimeoutDisarmers.get(src) : undefined;
    if (fn) disarmFns.push(fn);
    for (const holder of (src && selectedConnectionHolders.get(src)) || []) holders.add(holder);
  }
  if (holders.size > 0) selectedConnectionHolders.set(targetSignal, [...holders]);
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
