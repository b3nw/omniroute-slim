import {
  checkHeapPressureGuard,
  HEAP_PRESSURE_THRESHOLD_MB,
  tryEmergencyGc,
} from "./heapPressure.ts";
import { buildErrorBody } from "./error.ts";
import {
  createResourcePressureTracker,
  resolveResourcePressureThresholds,
  type PressureReason,
  type ResourcePressureState,
  type ResourcePressureThresholds,
  type ResourceSignals,
} from "./resourcePressurePolicy.ts";
import {
  sampleResourceSignals,
  type SampleResourceSignalsDeps,
} from "./resourcePressureSampler.ts";

const MB = 1024 * 1024;
const RETRY_AFTER_SECONDS = "5";
const PRESSURE_MESSAGE = "Service temporarily unavailable due to resource pressure. Retry shortly.";

export type ResourcePressureGuardResult = {
  success: false;
  status: 503;
  error: string;
  response: Response;
};

export type ResourcePressureObservation = {
  signals: ResourceSignals | null;
  state: ResourcePressureState;
};

export type ResourcePressureRuntimeOptions = {
  thresholds?: Partial<ResourcePressureThresholds>;
  heapThresholdMb?: number | null;
  immediateHeapUsedMb?: () => number;
  /** Debounced forced-GC hook used to break the shed deadlock; injectable for tests. */
  emergencyGc?: () => boolean;
  sample?: () => Promise<ResourceSignals>;
  nowMs?: () => number;
  schedule?: (refresh: () => void) => void;
  staleAfterMs?: number;
  maxStaleMs?: number;
  retryAfterMs?: number;
  samplerDeps?: SampleResourceSignalsDeps;
};

export type ResourcePressureRuntime = {
  check: () => ResourcePressureGuardResult | null;
  getObservation: () => ResourcePressureObservation;
  whenRefreshSettled: () => Promise<void>;
  dispose: () => void;
};

function emptyState(): ResourcePressureState {
  return {
    severity: "normal",
    reason: "none",
    elevatedStreak: 0,
    recoveryStreak: 0,
    lastTransitionAtMs: 0,
    observedAtMs: 0,
  };
}

function requireDuration(name: string, value: number): number {
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < 0 || value > 3_600_000) {
    throw new RangeError(`${name} must be an integer between 0 and 3600000`);
  }
  return value;
}

function buildCriticalGuard(reason: PressureReason): ResourcePressureGuardResult {
  console.warn(
    `[resourcePressure] critical pressure guard tripped (reason=${reason}); returning 503`
  );
  return {
    success: false,
    status: 503,
    error: PRESSURE_MESSAGE,
    response: new Response(
      JSON.stringify(
        buildErrorBody(503, PRESSURE_MESSAGE, undefined, {
          type: "server_error",
          code: "resource_pressure",
        })
      ),
      {
        status: 503,
        headers: { "Content-Type": "application/json", "Retry-After": RETRY_AFTER_SECONDS },
      }
    ),
  };
}

function immediateHeapGuard(
  heapUsedMb: number,
  thresholdMb: number | null,
  remeasureHeapUsedMb: () => number,
  emergencyGc: () => boolean
): ResourcePressureGuardResult | null {
  if (thresholdMb == null) return null;
  const guard = checkHeapPressureGuard(heapUsedMb, thresholdMb, {
    remeasureHeapUsedMb,
    emergencyGc,
  });
  if (!guard) return null;
  return buildCriticalGuard("v8_heap_absolute");
}

export function createResourcePressureRuntime(
  options: ResourcePressureRuntimeOptions = {}
): ResourcePressureRuntime {
  const heapThresholdMb =
    options.heapThresholdMb === undefined ? HEAP_PRESSURE_THRESHOLD_MB : options.heapThresholdMb;
  if (heapThresholdMb !== null && (!Number.isFinite(heapThresholdMb) || heapThresholdMb <= 0)) {
    throw new RangeError("heapThresholdMb must be positive and finite or null");
  }
  const thresholds = resolveResourcePressureThresholds({
    ...options.thresholds,
    heapAbsoluteThresholdMb:
      options.thresholds?.heapAbsoluteThresholdMb === undefined
        ? null
        : options.thresholds.heapAbsoluteThresholdMb,
  });
  const staleAfterMs = requireDuration("staleAfterMs", options.staleAfterMs ?? 1_000);
  const maxStaleMs = requireDuration("maxStaleMs", options.maxStaleMs ?? 30_000);
  const retryAfterMs = requireDuration("retryAfterMs", options.retryAfterMs ?? 1_000);
  if (maxStaleMs < staleAfterMs) {
    throw new RangeError("maxStaleMs must be greater than or equal to staleAfterMs");
  }

  const nowMs = options.nowMs ?? Date.now;
  const immediateHeapUsedMb =
    options.immediateHeapUsedMb ?? (() => process.memoryUsage().heapUsed / MB);
  const emergencyGc = options.emergencyGc ?? (() => tryEmergencyGc());
  const sample = options.sample ?? (() => sampleResourceSignals(options.samplerDeps));
  const schedule =
    options.schedule ??
    ((refresh) => {
      const handle = setImmediate(refresh);
      handle.unref();
    });
  const tracker = createResourcePressureTracker(thresholds);

  let lastSignals: ResourceSignals | null = null;
  let state = emptyState();
  let lastRefreshAtMs = Number.NEGATIVE_INFINITY;
  let nextRefreshAtMs = Number.NEGATIVE_INFINITY;
  let scheduled = false;
  let inFlight: Promise<void> | null = null;
  let disposed = false;

  const refresh = (): void => {
    if (disposed || inFlight) return;
    scheduled = false;
    inFlight = Promise.resolve()
      .then(sample)
      .then((signals) => {
        if (disposed) return;
        const settledAtMs = nowMs();
        lastSignals = signals;
        state = tracker.observe(signals);
        // While shedding on heap pressure nothing allocates, so V8 never collects
        // on its own; force a (debounced) GC so the next sample can recover.
        if (
          state.severity === "critical" &&
          (state.reason === "v8_heap_ratio" || state.reason === "v8_heap_absolute")
        ) {
          emergencyGc();
        }
        lastRefreshAtMs = settledAtMs;
        nextRefreshAtMs = settledAtMs + staleAfterMs;
      })
      .catch(() => {
        if (!disposed) nextRefreshAtMs = nowMs() + retryAfterMs;
      })
      .finally(() => {
        inFlight = null;
      });
  };

  const scheduleRefresh = (): void => {
    if (disposed || scheduled || inFlight) return;
    scheduled = true;
    schedule(refresh);
  };

  return {
    check() {
      let heapUsedMb = 0;
      try {
        heapUsedMb = immediateHeapUsedMb();
      } catch {
        heapUsedMb = 0;
      }
      const immediate = immediateHeapGuard(
        heapUsedMb,
        heapThresholdMb,
        immediateHeapUsedMb,
        emergencyGc
      );
      const now = nowMs();
      if (now >= nextRefreshAtMs) scheduleRefresh();
      if (immediate) {
        state = {
          severity: "critical",
          reason: "v8_heap_absolute",
          elevatedStreak: 0,
          recoveryStreak: 0,
          lastTransitionAtMs: now,
          observedAtMs: now,
        };
        return immediate;
      }
      const cacheAge = lastSignals ? Math.max(0, now - lastRefreshAtMs) : Number.POSITIVE_INFINITY;
      return cacheAge <= maxStaleMs && state.severity === "critical"
        ? buildCriticalGuard(state.reason)
        : null;
    },
    getObservation: () => {
      // The front-door admission gate (chatBodyAdmission) reads this cached state
      // and sheds BEFORE chatCore ever calls check(). Refresh here too, or a
      // critical state latched by check() is never re-sampled once every request
      // is shed at admission — a permanent 503 even after the heap recovers.
      if (nowMs() >= nextRefreshAtMs) scheduleRefresh();
      return { signals: lastSignals, state };
    },
    whenRefreshSettled: async () => {
      if (scheduled) await new Promise<void>((resolve) => setImmediate(resolve));
      if (inFlight) await inFlight;
    },
    dispose() {
      disposed = true;
      scheduled = false;
    },
  };
}

let defaultRuntime = createResourcePressureRuntime();

export function checkResourcePressureGuard(): ResourcePressureGuardResult | null {
  return defaultRuntime.check();
}

export function getResourcePressureObservation(): ResourcePressureObservation {
  return defaultRuntime.getObservation();
}

/** Replaces and disposes the process singleton when configuration is reloaded. */
export function reloadResourcePressureRuntime(
  options: ResourcePressureRuntimeOptions = {}
): ResourcePressureRuntime {
  defaultRuntime.dispose();
  defaultRuntime = createResourcePressureRuntime(options);
  return defaultRuntime;
}

export type {
  PressureReason,
  PressureSeverity,
  ResourceMetricBytes,
  ResourcePressureState,
  ResourcePressureThresholds,
  ResourcePressureTracker,
  ResourceSignals,
} from "./resourcePressurePolicy.ts";
export {
  classifyAdaptiveResourcePressure as classifyResourcePressure,
  createResourcePressureTracker,
  resolveResourcePressureThresholds,
} from "./resourcePressurePolicy.ts";
export {
  sampleResourceSignals,
  sanitizeMemoryBytes,
  type ResourcePressureFs,
  type SampleResourceSignalsDeps,
} from "./resourcePressureSampler.ts";
