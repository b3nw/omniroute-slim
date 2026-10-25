import assert from "node:assert/strict";
import { setImmediate as nextTurn } from "node:timers/promises";

assert.ok(process.env.DATA_DIR, "worker requires isolated DATA_DIR before imports");
assert.equal(typeof global.gc, "function", "worker requires --expose-gc");
const { createStreamController } = await import("../../../open-sse/utils/streamHandler.ts");

type Payload = { body: string; image: string };
function makeController(payload: Payload, keepDrain: boolean) {
  const calls = { disconnect: 0, error: 0, drain: 0 };
  const controller = createStreamController({
    allowCompletedToolHandoffGrace: keepDrain,
    clientDisconnectGracePeriodMs: keepDrain ? 1000 : 0,
    onDisconnect: () => { assert.ok(payload.body.length); calls.disconnect++; },
    onError: () => { assert.ok(payload.image.length); calls.error++; return true; },
  });
  controller.registerCompletedToolHandoffDrain(() => { assert.ok(payload.body.length); calls.drain++; });
  return { controller, calls };
}

function prepare(mode: string) {
  const payload = { body: "x".repeat(2_000_000), image: "y".repeat(500_000) };
  const ref = new WeakRef(payload);
  const { controller, calls } = makeController(payload, mode === "handoff");
  if (mode === "complete") controller.handleComplete();
  else if (mode === "disconnect") controller.handleDisconnect();
  else if (mode === "error") controller.handleError(new Error("fixture error"));
  else if (mode === "abort") controller.abort();
  else if (mode === "handoff") {
    controller.markCompletedToolHandoffSeen();
    controller.handleDisconnect("completed_tool_handoff");
  }
  return { mode, controller, calls, ref };
}

const probes = ["active", "complete", "disconnect", "error", "abort", "handoff"].map(prepare);
for (let i = 0; i < 12; i++) { await nextTurn(); global.gc!(); }
console.log("RETENTION_RESULT=" + JSON.stringify(probes.map(({ mode, controller, calls, ref }) => ({
  mode, retained: ref.deref() !== undefined, draining: controller.shouldDeferCompletedToolHandoff(), calls,
}))));
