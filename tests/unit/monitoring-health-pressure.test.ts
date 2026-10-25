/**
 * Health endpoint + heap-pressure deadlock regression.
 *
 * Production outage: the V8 heap crossed the 85% shed threshold, the admission
 * gates went `critical` and rejected 100% of chat traffic. With nothing
 * allocating, V8 never collected, so the process stayed latched in a 503
 * deadlock — while `/api/monitoring/health` kept answering 200 `"healthy"`
 * (status was hardcoded), so external probes never noticed.
 */

import test, { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omni-health-pressure-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const { buildHealthPayload, deriveHealthStatus } =
  await import("../../src/lib/monitoring/observability.ts");
const heapPressure = await import("../../open-sse/utils/heapPressure.ts");
const resourcePressure = await import("../../open-sse/utils/resourcePressure.ts");
const policy = await import("../../open-sse/utils/resourcePressurePolicy.ts");
const core = await import("../../src/lib/db/core.ts");
const route = await import("../../src/app/api/monitoring/health/route.ts");

test.after(() => {
  resourcePressure.reloadResourcePressureRuntime();
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

const MB = 1024 * 1024;

type HealthArgs = Parameters<typeof buildHealthPayload>[0];

function healthArgs(overrides: Partial<HealthArgs> = {}): HealthArgs {
  return {
    appVersion: "1.2.3",
    settings: { setupComplete: true },
    connections: [
      { provider: "openai", isActive: true },
      { provider: "anthropic", isActive: true },
      { provider: "gemini", isActive: false },
    ],
    circuitBreakers: [],
    rateLimitStatus: {},
    learnedLimits: {},
    lockouts: {},
    localProviders: {},
    inflightRequests: 0,
    quotaMonitorSummary: {
      active: 0,
      alerting: 0,
      exhausted: 0,
      errors: 0,
      statusCounts: { starting: 0, idle: 0, healthy: 0, warning: 0, exhausted: 0, error: 0 },
      byProvider: {},
    },
    quotaMonitorMonitors: [],
    activeSessions: [],
    ...overrides,
  } as HealthArgs;
}

function chatSnapshot(pressureSeverity: string) {
  return {
    activeHeavy: 0,
    activeHealthyHeadroom: 0,
    waiting: 0,
    queuedBytes: 0,
    shedTotal: 0,
    shedsByReason: {},
    lanes: [],
    inflightBytes: 0,
    maxInflightBytes: 1,
    budgetSource: "v8_heap",
    pressureSeverity,
    countCapEnabled: false,
  } as unknown as HealthArgs["chatAdmission"];
}

function signals(heapUsedMb: number, heapLimitMb: number, observedAtMs = 0) {
  return {
    observedAtMs,
    v8: { heapUsedBytes: heapUsedMb * MB, heapLimitBytes: heapLimitMb * MB },
    process: {
      rssBytes: 0,
      externalBytes: 0,
      arrayBuffersBytes: 0,
      availableBytes: null,
      constrainedBytes: null,
    },
    cgroup: { currentBytes: null, maxBytes: null, highBytes: null, fileBytes: null, events: null },
    psi: null,
  };
}

describe("buildHealthPayload status", () => {
  it("is healthy with no pressure and closed breakers", () => {
    assert.equal(buildHealthPayload(healthArgs()).status, "healthy");
  });

  it("is unhealthy when chatAdmission pressure is critical", () => {
    const payload = buildHealthPayload(healthArgs({ chatAdmission: chatSnapshot("critical") }));
    assert.equal(payload.status, "unhealthy");
  });

  it("is degraded when chatAdmission pressure is high", () => {
    const payload = buildHealthPayload(healthArgs({ chatAdmission: chatSnapshot("high") }));
    assert.equal(payload.status, "degraded");
  });

  it("follows adaptiveAdmission resourceSeverity", () => {
    assert.equal(
      deriveHealthStatus({
        adaptivePressure: "critical",
        activeProviders: new Set(),
        providerBreakers: [],
      }),
      "unhealthy"
    );
    assert.equal(
      deriveHealthStatus({
        adaptivePressure: "high",
        activeProviders: new Set(),
        providerBreakers: [],
      }),
      "degraded"
    );
  });

  it("is unhealthy when every active provider breaker is OPEN", () => {
    const payload = buildHealthPayload(
      healthArgs({
        circuitBreakers: [
          { name: "openai", state: "OPEN" },
          { name: "anthropic", state: "OPEN" },
        ],
      })
    );
    assert.equal(payload.status, "unhealthy");
  });

  it("is degraded when only some active provider breakers are OPEN or DEGRADED", () => {
    for (const state of ["OPEN", "DEGRADED"]) {
      const payload = buildHealthPayload(
        healthArgs({
          circuitBreakers: [
            { name: "openai", state },
            { name: "anthropic", state: "CLOSED" },
          ],
        })
      );
      assert.equal(payload.status, "degraded", `state=${state}`);
    }
  });

  it("ignores breakers for inactive, unconfigured, or test providers", () => {
    const payload = buildHealthPayload(
      healthArgs({
        circuitBreakers: [
          { name: "gemini", state: "OPEN" },
          { name: "openai:conn-1", state: "OPEN" },
          { name: "test-openai", state: "OPEN" },
        ],
      })
    );
    assert.equal(payload.status, "healthy");
  });

  it("does not report unhealthy for an install with no active providers", () => {
    const payload = buildHealthPayload(healthArgs({ connections: [] }));
    assert.equal(payload.status, "healthy");
  });
});

describe("GET /api/monitoring/health HTTP status", () => {
  it("returns 503 (anonymous + liveness view) when admission pressure is critical", async () => {
    // Latch the shared runtime into critical via the immediate heap guard, with
    // GC disabled and refresh suppressed so the state can't recover mid-test.
    const runtime = resourcePressure.reloadResourcePressureRuntime({
      heapThresholdMb: 100,
      immediateHeapUsedMb: () => 500,
      emergencyGc: () => false,
      schedule: () => {},
    });
    assert.ok(runtime.check(), "guard should trip");
    assert.equal(resourcePressure.getResourcePressureObservation().state.severity, "critical");

    const res = await route.GET(new Request("http://localhost/api/monitoring/health") as never);
    assert.equal(res.status, 503);
    const body = (await res.json()) as Record<string, unknown>;
    assert.equal(body.status, "unhealthy");
    for (const key of Object.keys(body)) {
      assert.ok(["status", "setupComplete"].includes(key), `public view leaked ${key}`);
    }

    // Cached payload (1s TTL) keeps the same verdict and HTTP code.
    const cached = await route.GET(new Request("http://localhost/api/monitoring/health") as never);
    assert.equal(cached.status, 503);
  });

  it("returns 200 once pressure clears", async () => {
    resourcePressure.reloadResourcePressureRuntime({
      heapThresholdMb: 10_000,
      immediateHeapUsedMb: () => 1,
      schedule: () => {},
    });
    await new Promise((resolve) => setTimeout(resolve, 1_100)); // expire payload cache
    const res = await route.GET(new Request("http://localhost/api/monitoring/health") as never);
    assert.equal(res.status, 200);
    assert.notEqual(((await res.json()) as { status: string }).status, "unhealthy");
  });
});

describe("tryEmergencyGc", () => {
  it("runs a real GC and is debounced", () => {
    heapPressure.resetEmergencyGcStateForTests();
    const before = process.memoryUsage().heapUsed;
    assert.equal(heapPressure.tryEmergencyGc(1_000_000), true, "GC must be resolvable");
    const after = process.memoryUsage().heapUsed;
    assert.ok(Number.isFinite(after) && after > 0);
    assert.ok(after <= before * 1.5, "re-measured heap is sane after GC");
    assert.equal(heapPressure.tryEmergencyGc(1_000_001), false, "debounced inside window");
    assert.equal(
      heapPressure.tryEmergencyGc(1_000_000 + heapPressure.EMERGENCY_GC_MIN_INTERVAL_MS),
      true,
      "allowed again after the window"
    );
  });
});

describe("checkHeapPressureGuard emergency GC", () => {
  it("proceeds when the heap drops under threshold after GC", () => {
    let gcCalls = 0;
    const guard = heapPressure.checkHeapPressureGuard(500, 400, {
      emergencyGc: () => {
        gcCalls += 1;
        return true;
      },
      remeasureHeapUsedMb: () => 300,
    });
    assert.equal(guard, null);
    assert.equal(gcCalls, 1);
  });

  it("still sheds with 503 when the heap stays above threshold after GC", () => {
    const guard = heapPressure.checkHeapPressureGuard(500, 400, {
      emergencyGc: () => true,
      remeasureHeapUsedMb: () => 450,
    });
    assert.equal(guard?.status, 503);
  });

  it("does not attempt GC below threshold or without a re-measure hook", () => {
    let gcCalls = 0;
    const gc = () => {
      gcCalls += 1;
      return true;
    };
    assert.equal(heapPressure.checkHeapPressureGuard(100, 400, { emergencyGc: gc }), null);
    assert.equal(heapPressure.checkHeapPressureGuard(500, 400, { emergencyGc: gc })?.status, 503);
    assert.equal(gcCalls, 0);
  });

  it("re-checks the live heap through the resource-pressure runtime", () => {
    let heapMb = 500;
    const runtime = resourcePressure.createResourcePressureRuntime({
      heapThresholdMb: 400,
      immediateHeapUsedMb: () => heapMb,
      emergencyGc: () => {
        heapMb = 250;
        return true;
      },
      schedule: () => {},
    });
    assert.equal(runtime.check(), null, "GC freed enough heap to admit the request");
    assert.notEqual(runtime.getObservation().state.severity, "critical");
    runtime.dispose();
  });
});

describe("resource-pressure runtime deadlock prevention", () => {
  it("getObservation schedules a refresh so a latched critical state can recover", async () => {
    let heapMb = 950;
    const pending: Array<() => void> = [];
    const runtime = resourcePressure.createResourcePressureRuntime({
      heapThresholdMb: null,
      thresholds: { sustainedSamplesCritical: 1, sustainedSamplesRecovery: 1 },
      emergencyGc: () => false,
      sample: async () => signals(heapMb, 1000, heapMb),
      schedule: (refresh) => pending.push(refresh),
      staleAfterMs: 0,
    });
    const drain = async () => {
      pending.splice(0).forEach((refresh) => refresh());
      await runtime.whenRefreshSettled();
    };

    // Admission (chatBodyAdmission) only ever READS the observation; chatCore's
    // check() is never reached once everything is shed at the front door.
    runtime.getObservation();
    await drain();
    assert.equal(runtime.getObservation().state.severity, "critical");

    heapMb = 500;
    await drain();
    assert.equal(runtime.getObservation().state.severity, "normal");
    runtime.dispose();
  });

  it("forces a GC when a refresh observes critical heap pressure", async () => {
    let gcCalls = 0;
    const pending: Array<() => void> = [];
    const runtime = resourcePressure.createResourcePressureRuntime({
      heapThresholdMb: null,
      thresholds: { sustainedSamplesCritical: 1 },
      emergencyGc: () => {
        gcCalls += 1;
        return true;
      },
      sample: async () => signals(950, 1000, 1),
      schedule: (refresh) => pending.push(refresh),
      staleAfterMs: 0,
    });
    runtime.getObservation();
    pending.splice(0).forEach((refresh) => refresh());
    await runtime.whenRefreshSettled();
    assert.equal(runtime.getObservation().state.severity, "critical");
    assert.equal(gcCalls, 1);
    runtime.dispose();
  });
});

describe("hysteresis recovery (isHeapRecovered)", () => {
  const thresholds = policy.resolveResourcePressureThresholds({ heapAbsoluteThresholdMb: 850 });

  it("recovers on the ratio bound without also requiring the compounded absolute bound", () => {
    // 700/1000 = 0.70 <= 0.75 recovers, even though 700 > 850*0.75 (637.5).
    assert.equal(policy.isHeapRecovered(signals(700, 1000), thresholds), true);
  });

  it("recovers on the absolute bound alone", () => {
    // Ratio 600/700 = 0.857 > 0.75, but 600 <= 637.5.
    assert.equal(policy.isHeapRecovered(signals(600, 700), thresholds), true);
  });

  it("does not recover when both bounds are exceeded", () => {
    assert.equal(policy.isHeapRecovered(signals(800, 1000), thresholds), false);
  });

  it("tracker returns to normal once the heap is under the recovery ratio", () => {
    const tracker = policy.createResourcePressureTracker({
      heapAbsoluteThresholdMb: 850,
      sustainedSamplesCritical: 1,
      sustainedSamplesRecovery: 2,
    });
    assert.equal(tracker.observe(signals(950, 1000, 1)).severity, "critical");
    assert.equal(tracker.observe(signals(700, 1000, 2)).severity, "critical");
    assert.equal(tracker.observe(signals(700, 1000, 3)).severity, "normal");
  });
});
