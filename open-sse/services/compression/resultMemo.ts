import crypto from "node:crypto";
import type { CompressionConfig, CompressionMode, CompressionResult } from "./types.ts";
import { jsonSha256 } from "../../utils/jsonHash.ts";
import { registerMemoryPressureEvictor } from "../../utils/heapPressure.ts";

export const MEMO_CAP = 5_000;
/** Entries larger than this (serialized UTF-8 bytes) are never memoized. */
export const MAX_MEMO_ENTRY_BYTES = 8 * 1024 * 1024;
/** Total serialized bytes retained across all memo entries. */
export const MAX_MEMO_TOTAL_BYTES = 64 * 1024 * 1024;
/** Memo entries expire after this long so idle processes release cached bodies. */
export const MEMO_TTL_MS = 10 * 60 * 1000;
const MEMO_SWEEP_INTERVAL_MS = 60_000;

interface MemoEntry {
  value: CompressionResult;
  bytes: number;
  expiresAt: number;
}

// ── Windowed hit/miss ring buffer for time-bucketed stats ──────────────
// Records each lookup outcome with a ms timestamp. getMemoStats scans the
// ring to compute 1m/5m/15m/1h windows (like load average) so operators see
// the *current* hit rate during a traffic spike, not a diluted all-time
// average. Bounded memory: RING_CAP * ~9 bytes ≈ 90 KB, fixed-size array.
const RING_CAP = 10_000;

interface MemoState {
  memoMap: Map<string, MemoEntry>;
  totalBytes: number;
  lookupCountForTests: number;
  memoHits: number;
  memoMisses: number;
  ring: Array<{ ts: number; hit: boolean } | undefined>;
  ringHead: number; // index of the NEXT write slot (wraps)
  ringCount: number; // entries written so far (clamped to RING_CAP)
  sweepTimer: ReturnType<typeof setInterval> | null;
}

// Anchored on globalThis so every Next.js route chunk shares one memo store.
const STATE_KEY = Symbol.for("omniroute.compression.resultMemo");
const state: MemoState = ((globalThis as Record<symbol, unknown>)[STATE_KEY] ??= {
  memoMap: new Map<string, MemoEntry>(),
  totalBytes: 0,
  lookupCountForTests: 0,
  memoHits: 0,
  memoMisses: 0,
  ring: new Array(RING_CAP),
  ringHead: 0,
  ringCount: 0,
  sweepTimer: null,
} satisfies MemoState) as MemoState;
const memoMap = state.memoMap;
const ring = state.ring;

function recordLookup(hit: boolean): void {
  ring[state.ringHead] = { ts: Date.now(), hit };
  state.ringHead = (state.ringHead + 1) % RING_CAP;
  if (state.ringCount < RING_CAP) state.ringCount++;
}

function deleteMemoEntry(key: string): void {
  const existing = memoMap.get(key);
  if (!existing) return;
  state.totalBytes -= existing.bytes;
  memoMap.delete(key);
}

function sweepExpiredMemo(now: number = Date.now()): void {
  for (const [key, entry] of memoMap) {
    if (now >= entry.expiresAt) deleteMemoEntry(key);
  }
  if (memoMap.size === 0) stopMemoSweep();
}

function stopMemoSweep(): void {
  if (state.sweepTimer) {
    clearInterval(state.sweepTimer);
    state.sweepTimer = null;
  }
}

function ensureMemoSweep(): void {
  if (state.sweepTimer || memoMap.size === 0) return;
  state.sweepTimer = setInterval(() => sweepExpiredMemo(), MEMO_SWEEP_INTERVAL_MS);
  state.sweepTimer.unref?.();
}

/** Cache-only clear for memory pressure: keeps lifetime counters and the stats ring. */
function evictMemoCache(): void {
  memoMap.clear();
  state.totalBytes = 0;
  stopMemoSweep();
}

registerMemoryPressureEvictor("compression.resultMemo", evictMemoCache);

/** Compute hits/misses/hitRate for lookups within the last `windowMs`. */
function windowStats(windowMs: number): { hits: number; misses: number; hitRate: number } {
  const cutoff = Date.now() - windowMs;
  let hits = 0;
  let misses = 0;
  // Walk newest→oldest. The ring is time-ordered (oldest at head), so once
  // an entry is older than the cutoff every earlier one is too — early break.
  for (let k = 0; k < state.ringCount; k++) {
    const idx = (state.ringHead - 1 - k + RING_CAP) % RING_CAP;
    const e = ring[idx];
    if (!e) break;
    if (e.ts < cutoff) break;
    if (e.hit) hits++;
    else misses++;
  }
  const total = hits + misses;
  return {
    hits,
    misses,
    hitRate: total > 0 ? Math.round((hits / total) * 10000) / 100 : 0,
  };
}

// Opt-IN whitelist (NOT opt-out): cache only engines proven pure + STATELESS across
// requests. Excluded on purpose: `ccr` and `session-dedup` write to the cross-request
// CCR store (`ccr/index.ts` ccrStore; session-dedup imports storeBlock), so their output
// depends on prior state → not safe to memoize; `ultra`/`aggressive`/`llmlingua` are
// model-backed/non-deterministic. Any NEW engine is excluded until explicitly vetted.
// "omniglyph" is intentionally excluded too (P2 registry-consistency pass): it renders
// context as an image via a model-backed pipeline, so it is not yet proven deterministic
// across requests — conservative default (never-wrong) until explicitly vetted.
const DETERMINISTIC_ENGINES = new Set(["lite", "caveman", "rtk"]);

/** Top-level modes safe to cache (whitelist — any unknown/new mode defaults to false).
 * "omniglyph" intentionally omitted — see comment on DETERMINISTIC_ENGINES above. */
const DETERMINISTIC_MODES = new Set<CompressionMode>(["lite", "standard", "rtk"]);

export function isDeterministicMode(mode: CompressionMode, config?: CompressionConfig): boolean {
  if (mode === "stacked") {
    const pipeline = config?.stackedPipeline;
    if (!pipeline || pipeline.length === 0) return false;
    return pipeline.every((step) => DETERMINISTIC_ENGINES.has(step.engine));
  }
  return DETERMINISTIC_MODES.has(mode);
}

function sha256hex(text: string): string {
  return crypto.createHash("sha256").update(text).digest("hex");
}

export function makeMemoKey(
  body: Record<string, unknown>,
  mode: CompressionMode,
  config: CompressionConfig,
  principalId?: string,
  model?: string,
  supportsVision?: boolean | null
): string {
  // Uses streaming jsonSha256 instead of sha256hex(JSON.stringify(body))
  // to avoid allocating multi-MB string transients on large agent payloads (#7847).
  const bodyHash = jsonSha256(body);

  // #8137: Only include model + supportsVision in the cache key when the compression
  // result actually depends on them. The `lite` engine strips data:image URLs only when
  // vision is unsupported (replaceImageUrls / modelSupportsVision), so the same (body,
  // config) yields a DIFFERENT result per target — omitting them would return a wrong
  // (image-stripped or image-kept) cached body across vision/non-vision targets.
  //
  // For all other deterministic engines (caveman, rtk), the output is model-independent.
  // Including model in the key defeats memoization across combo retries — the body is
  // identical but the model changes each attempt, producing a fresh cache miss every time
  // and re-running the full compression pipeline 5-8x per request.
  const isVisionDependent = usesVisionDependentEngine(mode, config);

  return sha256hex(
    JSON.stringify({
      bodyHash,
      mode,
      config,
      principalId: principalId ?? null,
      model: isVisionDependent ? (model ?? null) : null,
      supportsVision: isVisionDependent ? (supportsVision ?? null) : null,
    })
  );
}

/**
 * Whether the compression pipeline for this mode/config includes the `lite` engine,
 * whose output depends on the target's vision support (image-URL stripping).
 * Only `lite` itself, `standard` (lite → caveman), and `stacked` pipelines containing
 * a `lite` step are vision-dependent.
 */
function usesVisionDependentEngine(mode: CompressionMode, config?: CompressionConfig): boolean {
  if (mode === "lite") return true;
  if (mode === "standard") return true; // standard = lite → caveman pipeline
  if (mode === "stacked") {
    const pipeline = config?.stackedPipeline;
    if (!pipeline || pipeline.length === 0) return false;
    return pipeline.some((step) => step.engine === "lite");
  }
  return false;
}

function boundedSet(key: string, value: CompressionResult, bytes: number, now: number): void {
  deleteMemoEntry(key);
  sweepExpiredMemo(now);
  while (
    memoMap.size > 0 &&
    (memoMap.size >= MEMO_CAP || state.totalBytes + bytes > MAX_MEMO_TOTAL_BYTES)
  ) {
    const firstKey = memoMap.keys().next().value;
    if (firstKey === undefined) break;
    deleteMemoEntry(firstKey);
  }
  memoMap.set(key, { value, bytes, expiresAt: now + MEMO_TTL_MS });
  state.totalBytes += bytes;
  ensureMemoSweep();
}

export function memoLookup(key: string): CompressionResult | null {
  state.lookupCountForTests++;
  let entry = memoMap.get(key);
  if (entry && Date.now() >= entry.expiresAt) {
    deleteMemoEntry(key);
    entry = undefined;
  }
  const hit = entry?.value;
  if (!hit) {
    state.memoMisses++;
    recordLookup(false);
    return null;
  }
  state.memoHits++;
  recordLookup(true);
  // Return a clone so downstream mutation cannot corrupt the cached value.
  const cloned = JSON.parse(JSON.stringify(hit)) as CompressionResult;
  if (cloned.stats) {
    cloned.stats.memoHit = true;
  }
  return cloned;
}

export function memoStore(key: string, result: CompressionResult): CompressionResult {
  // Clone on STORE (memoLookup also clones on read) so the caller's live object — which
  // an async engine may still hold a sub-ref to — cannot later corrupt the cached entry.
  // Returns the stored clone so callers that need a fresh instance (the common
  // `memoStore(key, result); return memoLookup(key)!` idiom) can avoid a redundant
  // second multi-MB deep clone of the body on the way out.
  const serialized = JSON.stringify(result);
  const stored = JSON.parse(serialized) as CompressionResult;
  const entryBytes = Buffer.byteLength(serialized, "utf8");
  // Oversized results are returned uncached so a single huge body cannot pin the heap.
  if (entryBytes > MAX_MEMO_ENTRY_BYTES) return stored;
  boundedSet(key, stored, entryBytes, Date.now());
  return stored;
}

/** Observability stats for the in-process result memo store.
 * `windows` gives time-bucketed hit/miss/rate (1m/5m/15m/1h) so operators
 * see the *current* behavior during a spike, not the diluted lifetime rate.
 * `hits`/`misses`/`hitRate` remain the lifetime cumulative counters. */
export function getMemoStats(): {
  size: number;
  capacity: number;
  hits: number;
  misses: number;
  hitRate: number;
  windows: {
    "1m": { hits: number; misses: number; hitRate: number };
    "5m": { hits: number; misses: number; hitRate: number };
    "15m": { hits: number; misses: number; hitRate: number };
    "1h": { hits: number; misses: number; hitRate: number };
  };
} {
  const total = state.memoHits + state.memoMisses;
  return {
    size: memoMap.size,
    capacity: MEMO_CAP,
    hits: state.memoHits,
    misses: state.memoMisses,
    hitRate: total > 0 ? Math.round((state.memoHits / total) * 10000) / 100 : 0,
    windows: {
      "1m": windowStats(60_000),
      "5m": windowStats(5 * 60_000),
      "15m": windowStats(15 * 60_000),
      "1h": windowStats(60 * 60_000),
    },
  };
}

/** For tests only — clears the in-process memo store and resets counters. */
export function clearMemoStore(): void {
  evictMemoCache();
  state.lookupCountForTests = 0;
  state.memoHits = 0;
  state.memoMisses = 0;
  for (let i = 0; i < RING_CAP; i++) ring[i] = undefined;
  state.ringHead = 0;
  state.ringCount = 0;
}
export const resultMemoForTests = {
  get lookupCount(): number {
    return state.lookupCountForTests;
  },
};
