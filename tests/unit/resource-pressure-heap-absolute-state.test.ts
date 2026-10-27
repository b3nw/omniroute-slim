import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createResourcePressureRuntime } from "../../open-sse/utils/resourcePressure.ts";
import type { ResourceSignals } from "../../open-sse/utils/resourcePressurePolicy.ts";

const MiB = 1024 ** 2;

// Heap limit 1000 MiB; heapThresholdMb (85%) = 850 MiB; critical ratio = 92%.
// 860 MiB sits in the 85%-92% band where the bug used to flip critical -> high.
function signals(observedAtMs: number, heapUsedMb: number): ResourceSignals {
  return {
    observedAtMs,
    v8: { heapUsedBytes: heapUsedMb * MiB, heapLimitBytes: 1_000 * MiB },
    process: {
      rssBytes: 200 * MiB,
      externalBytes: 10 * MiB,
      arrayBuffersBytes: MiB,
      availableBytes: null,
      constrainedBytes: null,
    },
    cgroup: { currentBytes: null, maxBytes: null, highBytes: null, fileBytes: null, events: null },
    psi: null,
  };
}

describe("resource pressure heap absolute threshold", () => {
  it("stays critical (v8_heap_absolute) after refresh when heap is between 85% and 92%", async () => {
    let gcCalls = 0;
    const runtime = createResourcePressureRuntime({
      heapThresholdMb: 850,
      immediateHeapUsedMb: () => 860,
      emergencyGc: () => {
        gcCalls += 1;
        return true;
      },
      sample: async () => signals(1, 860),
    });

    const guard = runtime.check();
    assert.ok(guard, "immediate heap guard must shed the request");
    assert.equal(guard.status, 503);

    await runtime.whenRefreshSettled();
    await Promise.resolve();

    const { state } = runtime.getObservation();
    assert.equal(state.severity, "critical", "refresh must not downgrade critical to high");
    assert.equal(state.reason, "v8_heap_absolute");
    assert.ok(gcCalls >= 1, "emergency GC must run under heap pressure");
    runtime.dispose();
  });

  it("runs emergency GC when refresh classifies high v8_heap_ratio pressure", async () => {
    let gcCalls = 0;
    const runtime = createResourcePressureRuntime({
      heapThresholdMb: null,
      immediateHeapUsedMb: () => 0,
      emergencyGc: () => {
        gcCalls += 1;
        return true;
      },
      sample: async () => signals(1, 860),
      thresholds: { sustainedSamplesHigh: 1, heapAbsoluteThresholdMb: null },
    });

    runtime.check();
    await runtime.whenRefreshSettled();
    await Promise.resolve();

    const { state } = runtime.getObservation();
    assert.equal(state.severity, "high");
    assert.equal(state.reason, "v8_heap_ratio");
    assert.ok(gcCalls >= 1, "high heap pressure must proactively trigger emergency GC");
    runtime.dispose();
  });
});
