import v8 from "node:v8";
import vm from "node:vm";

/**
 * Compute the V8 heap-pressure shed threshold (MB).
 *
 * The chat pipeline rejects new requests with a 503 once `heapUsed` exceeds this
 * value, to avoid hard "JavaScript heap out of memory" crashes under concurrent
 * large-context load. The threshold is derived from the process's *actual* V8
 * heap ceiling (`heap_size_limit`, which reflects `--max-old-space-size` when set,
 * otherwise Node's RAM-derived default) so it auto-adapts across 1 GB / 2 GB /
 * large VPS instead of using a fixed number.
 *
 * A fixed default was the bug: 200 MB sat *below* the app's ~260 MB working set,
 * so the guard rejected every request once the heap warmed up (the v3.8.8
 * "resource pressure" outage). We shed at 85% of the ceiling — leaving headroom
 * for in-flight requests + GC — with a floor that always clears the runtime
 * baseline so a small/undersized heap never rejects all traffic.
 *
 * @param heapSizeLimitMb  `v8.getHeapStatistics().heap_size_limit` expressed in MB
 * @param override         `HEAP_PRESSURE_THRESHOLD_MB` env value — wins when it
 *                         parses to a positive number; invalid/unset → auto-calibrate
 */
export function computeHeapPressureThresholdMb(
  heapSizeLimitMb: number,
  override?: string | number | null
): number {
  const explicit = Number(override);
  if (Number.isFinite(explicit) && explicit > 0) return Math.floor(explicit);
  // Shed at 85% of the heap ceiling, but never below a floor that clears the
  // runtime's own ~260 MB baseline (+ margin) so an undersized heap degrades to
  // "guard never fires" rather than "guard rejects everything".
  const SHED_RATIO = 0.85;
  const FLOOR_MB = 400;
  return Math.max(Math.round(heapSizeLimitMb * SHED_RATIO), FLOOR_MB);
}

/**
 * Heap-pressure threshold (MB) resolved once at module load from the live V8 heap
 * ceiling. Read by `open-sse/handlers/chatCore.ts`'s memory-pressure guard.
 */
export const HEAP_PRESSURE_THRESHOLD_MB = computeHeapPressureThresholdMb(
  v8.getHeapStatistics().heap_size_limit / (1024 * 1024),
  process.env.HEAP_PRESSURE_THRESHOLD_MB
);

const HEAP_PRESSURE_MESSAGE =
  "Service temporarily unavailable due to resource pressure. Retry shortly.";

export type HeapPressureGuardResult = {
  success: false;
  status: 503;
  error: string;
  response: Response;
};

const MB = 1024 * 1024;
export const EMERGENCY_GC_MIN_INTERVAL_MS = 5_000;

type GcFunction = () => void;

let resolvedGc: GcFunction | null | undefined;
let lastEmergencyGcAtMs = Number.NEGATIVE_INFINITY;

function resolveGc(): GcFunction | null {
  const exposed = (globalThis as { gc?: unknown }).gc;
  if (typeof exposed === "function") return exposed as GcFunction;
  if (resolvedGc !== undefined) return resolvedGc;
  // Without --expose-gc, enable the flag at runtime and pull `gc` out of a fresh
  // context (contexts created after the flag flip get the global). Resolved once.
  try {
    v8.setFlagsFromString("--expose_gc");
    const gc = vm.runInNewContext("gc");
    resolvedGc = typeof gc === "function" ? (gc as GcFunction) : null;
  } catch {
    resolvedGc = null;
  }
  return resolvedGc;
}

/**
 * Force a full V8 GC, debounced to at most once per `EMERGENCY_GC_MIN_INTERVAL_MS`.
 *
 * Breaks the shed deadlock: once the pressure guard rejects 100% of requests the
 * process stops allocating, so V8's allocation-driven GC never runs and the heap
 * never drops back under the threshold. Returns true only when a GC actually ran.
 */
export function tryEmergencyGc(nowMs: number = Date.now()): boolean {
  if (nowMs - lastEmergencyGcAtMs < EMERGENCY_GC_MIN_INTERVAL_MS) return false;
  lastEmergencyGcAtMs = nowMs;
  const gc = resolveGc();
  if (!gc) return false;
  try {
    gc();
    return true;
  } catch {
    return false;
  }
}

/** Test-only: clear the debounce window so successive tests can force a GC. */
export function resetEmergencyGcStateForTests(): void {
  lastEmergencyGcAtMs = Number.NEGATIVE_INFINITY;
}

export type HeapPressureGuardOptions = {
  /**
   * Re-reads live heap usage (MB) after an emergency GC. When omitted the guard is
   * a pure threshold comparison on `heapUsedMb` (no GC is attempted).
   */
  remeasureHeapUsedMb?: () => number;
  /** Injectable GC trigger; defaults to the debounced `tryEmergencyGc`. */
  emergencyGc?: () => boolean;
};

export function defaultHeapUsedMb(): number {
  return process.memoryUsage().heapUsed / MB;
}

/**
 * Memory-pressure shed guard for the chat pipeline (extracted from chatCore's handleChatCore).
 * Returns a ready-to-return 503 result when live heap usage exceeds the shed threshold, else null
 * to proceed. When `remeasureHeapUsedMb` is supplied, an over-threshold reading first triggers an
 * emergency GC and a re-measure; the request proceeds if the heap is back under the threshold.
 * The heap figure is logged for INTERNAL telemetry only and is NEVER placed in the
 * client-facing response (Hard Rule #12).
 */
export function checkHeapPressureGuard(
  heapUsedMb: number,
  thresholdMb: number = HEAP_PRESSURE_THRESHOLD_MB,
  options: HeapPressureGuardOptions = {}
): HeapPressureGuardResult | null {
  if (heapUsedMb <= thresholdMb) return null;
  let currentMb = heapUsedMb;
  if (options.remeasureHeapUsedMb) {
    const ranGc = (options.emergencyGc ?? tryEmergencyGc)();
    if (ranGc) {
      let afterMb = currentMb;
      try {
        afterMb = options.remeasureHeapUsedMb();
      } catch {
        afterMb = currentMb;
      }
      if (afterMb <= thresholdMb) {
        console.warn(
          `[chatCore] heap pressure recovered after emergency GC: ${Math.round(heapUsedMb)}MB -> ${Math.round(afterMb)}MB (threshold ${thresholdMb}MB); proceeding`
        );
        return null;
      }
      currentMb = afterMb;
    }
  }
  console.warn(
    `[chatCore] heap pressure guard tripped: ${Math.round(currentMb)}MB > ${thresholdMb}MB; returning 503`
  );
  return {
    success: false,
    status: 503,
    error: HEAP_PRESSURE_MESSAGE,
    response: new Response(
      JSON.stringify({
        error: { message: HEAP_PRESSURE_MESSAGE, type: "server_error", code: "heap_pressure" },
      }),
      { status: 503, headers: { "Content-Type": "application/json", "Retry-After": "5" } }
    ),
  };
}
