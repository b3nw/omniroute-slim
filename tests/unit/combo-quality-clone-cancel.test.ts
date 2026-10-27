import test from "node:test";
import assert from "node:assert/strict";

const { validateResponseQuality } = await import("../../open-sse/services/combo.ts");
const { releaseQualityClone } = await import("../../open-sse/services/combo/validateQuality.ts");

const silentLog = { warn: () => {} };
const encoder = new TextEncoder();

test("releaseQualityClone propagates cancel through the replay stream to the upstream body", async () => {
  let upstreamCancelled = false;
  const upstream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(
        encoder.encode(
          'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}\n\n'
        )
      );
    },
    // Keep the upstream open like a live SSE stream would be.
    pull() {
      return new Promise<void>(() => {});
    },
    cancel() {
      upstreamCancelled = true;
    },
  });

  // Separate Response objects so releaseQualityClone does not short-circuit on clone === original.
  const clone = new Response(upstream, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
  const original = new Response("unused", { status: 200 });

  const quality = await validateResponseQuality(clone, true, silentLog);
  assert.equal(quality.valid, true, "content_block_delta should be accepted as content");
  assert.ok(quality.clonedResponse, "valid stream must return a replay response");
  assert.equal(upstreamCancelled, false, "nothing cancelled before release");

  releaseQualityClone(clone, original, quality);
  // Cancellation is fire-and-forget; let the cancel microtasks drain.
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(upstreamCancelled, true, "cancel must reach the upstream reader (no leak)");
});
