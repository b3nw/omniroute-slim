/**
 * Process-wide CCR store state, anchored on globalThis so every Next.js standalone route
 * chunk (each bundling its own copy of `ccr/index.ts`) shares a single content store,
 * byte accounting, and sweep timer. Also owns the idle expiry sweep and the
 * memory-pressure evictor so `ccr/index.ts` stays within its frozen size budget.
 */
import { registerMemoryPressureEvictor } from "../../../../utils/heapPressure.ts";

/** Upper bound on per-principal lifecycle counter records (FIFO-evicted). */
export const MAX_CCR_LIFECYCLE_PRINCIPALS = 1_000;
/** Interval of the self-stopping expiry sweep while the store is non-empty. */
export const CCR_SWEEP_INTERVAL_MS = 5 * 60_000;

interface CcrStoredEntry {
  principalId: string;
  bytes: number;
}

export interface CcrStoreState<E extends CcrStoredEntry, L> {
  ccrStore: Map<string, E>;
  retrievalCounts: Map<string, number>;
  principalBytesMap: Map<string, number>;
  lifecycleByPrincipal: Map<string, L>;
  globalBytes: number;
  sweepTimer: ReturnType<typeof setInterval> | null;
  purgeExpired: (now: number) => void;
  removeCapacity: (key: string) => void;
}

const STATE_KEY = Symbol.for("omniroute.compression.ccrStore");

/**
 * Returns the shared CCR state, creating it on first use. `purgeExpired` / `removeEntry`
 * are the calling chunk's own helpers; every chunk's copies operate on this same state,
 * so whichever was bound last is equally valid for the sweep and the pressure evictor.
 */
export function getCcrStoreState<E extends CcrStoredEntry, L>(
  purgeExpired: (now: number) => void,
  removeEntry: (key: string, reason?: "expired" | "capacity") => boolean
): CcrStoreState<E, L> {
  const g = globalThis as Record<symbol, unknown>;
  let state = g[STATE_KEY] as CcrStoreState<E, L> | undefined;
  if (!state) {
    state = {
      ccrStore: new Map(),
      retrievalCounts: new Map(),
      principalBytesMap: new Map(),
      lifecycleByPrincipal: new Map(),
      globalBytes: 0,
      sweepTimer: null,
      purgeExpired,
      removeCapacity: (key) => void removeEntry(key, "capacity"),
    };
    g[STATE_KEY] = state;
  } else {
    state.purgeExpired = purgeExpired;
    state.removeCapacity = (key) => void removeEntry(key, "capacity");
  }
  const shared = state;
  registerMemoryPressureEvictor("compression.ccr", () => evictCcrUnderPressure(shared));
  return state;
}

export function stopCcrSweep(state: CcrStoreState<CcrStoredEntry, unknown>): void {
  if (state.sweepTimer) {
    clearInterval(state.sweepTimer);
    state.sweepTimer = null;
  }
}

function ensureCcrSweep(state: CcrStoreState<CcrStoredEntry, unknown>): void {
  if (state.sweepTimer || state.ccrStore.size === 0) return;
  state.sweepTimer = setInterval(() => {
    state.purgeExpired(Date.now());
    if (state.ccrStore.size === 0) stopCcrSweep(state);
  }, CCR_SWEEP_INTERVAL_MS);
  state.sweepTimer.unref?.();
}

/** Insert an admitted entry, update byte accounting, and arm the idle expiry sweep. */
export function addCcrEntry<E extends CcrStoredEntry>(
  state: CcrStoreState<E, unknown>,
  key: string,
  entry: E
): void {
  state.ccrStore.set(key, entry);
  state.globalBytes += entry.bytes;
  const owner = entry.principalId;
  state.principalBytesMap.set(owner, (state.principalBytesMap.get(owner) ?? 0) + entry.bytes);
  ensureCcrSweep(state);
}

/** Insert lifecycle counters for a new principal, FIFO-evicting the oldest past the cap. */
export function setCcrLifecycle<L>(
  state: CcrStoreState<CcrStoredEntry, L>,
  principalId: string,
  counters: L
): void {
  const map = state.lifecycleByPrincipal;
  if (!map.has(principalId) && map.size >= MAX_CCR_LIFECYCLE_PRINCIPALS) {
    const oldest = map.keys().next().value;
    if (oldest !== undefined) map.delete(oldest);
  }
  map.set(principalId, counters);
}

/** Clear all in-memory CCR state and stop the sweep (durable tier handled by caller). */
export function clearCcrState(state: CcrStoreState<CcrStoredEntry, unknown>): void {
  state.ccrStore.clear();
  state.retrievalCounts.clear();
  state.principalBytesMap.clear();
  state.globalBytes = 0;
  state.lifecycleByPrincipal.clear();
  stopCcrSweep(state);
}

/**
 * Emergency-GC evictor: drop expired blocks, then the oldest half of what remains.
 * Capacity-evicted blocks stay in the durable tier, so retrieval still works.
 */
function evictCcrUnderPressure(state: CcrStoreState<CcrStoredEntry, unknown>): void {
  state.purgeExpired(Date.now());
  const toEvict = Math.ceil(state.ccrStore.size / 2);
  if (toEvict > 0) {
    const keys = Array.from(state.ccrStore.keys()).slice(0, toEvict);
    for (const key of keys) state.removeCapacity(key);
  }
  if (state.ccrStore.size === 0) stopCcrSweep(state);
}
