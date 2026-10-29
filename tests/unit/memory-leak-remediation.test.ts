import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-memory-leak-remediation-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const { summarizeEmbeddingsPayloadForLog } = await import("../../open-sse/handlers/embeddings.ts");
const artifactWriter = await import("../../src/lib/usage/callLogArtifactWriter.ts");
const { releaseQualityClone } = await import("../../open-sse/services/combo/validateQuality.ts");

after(async () => {
  await artifactWriter.closeCallLogArtifactWriter(0);
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

// ---------------------------------------------------------------------------
// (a) Embeddings log summarization
// ---------------------------------------------------------------------------
describe("memory-leak: summarizeEmbeddingsPayloadForLog", () => {
  it("replaces float arrays and long base64 strings with summaries without mutating input", () => {
    const floats = Array.from({ length: 3072 }, (_, i) => i / 3072);
    const base64 = "A".repeat(200);
    const payload = {
      object: "list",
      model: "openai/text-embedding-3-large",
      usage: { prompt_tokens: 3, total_tokens: 3 },
      data: [
        { object: "embedding", index: 0, embedding: floats },
        { object: "embedding", index: 1, embedding: base64 },
        { object: "embedding", index: 2, embedding: [[1, 2], [3]] },
        { object: "embedding", index: 3, embedding: "short" },
      ],
    };
    const before = structuredClone(payload);

    const summary = summarizeEmbeddingsPayloadForLog(payload) as typeof payload & {
      data: Array<Record<string, unknown>>;
    };

    assert.equal(summary.object, "list");
    assert.equal(summary.model, "openai/text-embedding-3-large");
    assert.deepEqual(summary.usage, { prompt_tokens: 3, total_tokens: 3 });
    assert.deepEqual(summary.data[0], {
      object: "embedding",
      index: 0,
      embedding: "[embedding: 3072 floats]",
    });
    assert.deepEqual(summary.data[1], {
      object: "embedding",
      index: 1,
      embedding: "[embedding_base64: 200 chars]",
    });
    assert.equal(summary.data[2].embedding, "[embedding: 3 floats]");
    assert.equal(summary.data[3].embedding, "short");

    // Input untouched; client response keeps full vectors.
    assert.deepEqual(payload, before);
    assert.equal(payload.data[0].embedding, floats);
    assert.equal(floats.length, 3072);
    assert.notEqual(summary, payload);
    assert.notEqual(summary.data, payload.data);
  });

  it("returns non-object payloads as-is", () => {
    assert.equal(summarizeEmbeddingsPayloadForLog(null), null);
    assert.equal(summarizeEmbeddingsPayloadForLog("x"), "x");
    assert.equal(summarizeEmbeddingsPayloadForLog(42), 42);
  });
});

// ---------------------------------------------------------------------------
// (b) Call-log artifact writer byte backpressure
// ---------------------------------------------------------------------------
describe("memory-leak: callLogArtifactWriter byte backpressure", () => {
  it("exposes a 32 MiB queued-bytes cap", () => {
    assert.equal(artifactWriter.MAX_QUEUED_ARTIFACT_BYTES, 32 * 1024 * 1024);
  });

  it("bounded estimator short-circuits on huge payloads", () => {
    const huge = { a: "x".repeat(5 * 1024 * 1024), b: Array.from({ length: 1000 }, () => 1) };
    const estimate = artifactWriter.estimateArtifactBytes(huge, 1024);
    assert.ok(estimate <= 1025);
    assert.equal(artifactWriter.estimateArtifactBytes({ ab: "xyz" }, 1024) > 0, true);
  });

  it("rejects new artifacts once queued bytes exceed the cap", async () => {
    const originalWarn = console.warn;
    console.warn = () => {};
    try {
      const big = "x".repeat(1024 * 1024 + 16);
      const makeArtifact = (id: string) =>
        ({ schemaVersion: 5, summary: { id }, requestBody: big }) as unknown as Parameters<
          typeof artifactWriter.writeCallArtifactAsync
        >[0];

      const writes: Array<Promise<unknown>> = [];
      let rejected: Promise<unknown> | null = null;
      for (let i = 0; i < 64; i++) {
        const pending = artifactWriter.writeCallArtifactAsync(makeArtifact(`bytes-${i}`));
        if (artifactWriter.getQueuedArtifactBytesForTests() < artifactWriter.MAX_QUEUED_ARTIFACT_BYTES) {
          writes.push(pending);
          continue;
        }
        // Cap reached: the next enqueue must be rejected immediately.
        writes.push(pending);
        rejected = artifactWriter.writeCallArtifactAsync(makeArtifact(`bytes-over-${i}`));
        break;
      }
      assert.ok(rejected, "queued bytes should reach the cap before 64 items");
      assert.equal(await rejected, null);

      await artifactWriter.closeCallLogArtifactWriter(0);
      await Promise.all(writes);
      assert.equal(artifactWriter.getQueuedArtifactBytesForTests(), 0);
    } finally {
      console.warn = originalWarn;
    }
  });
});

// ---------------------------------------------------------------------------
// (c) Combo quality clone release
// ---------------------------------------------------------------------------
describe("memory-leak: releaseQualityClone", () => {
  function trackedResponse() {
    const state = { cancelled: false };
    const body = new ReadableStream<Uint8Array>({
      pull() {},
      cancel() {
        state.cancelled = true;
      },
    });
    return { response: new Response(body), state };
  }

  it("cancels both the quality clone and the returned clone body", async () => {
    const original = trackedResponse();
    const clone = trackedResponse();
    const qualityClone = trackedResponse();

    releaseQualityClone(clone.response, original.response, {
      clonedResponse: qualityClone.response,
    });
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(qualityClone.state.cancelled, true);
    assert.equal(clone.state.cancelled, true);
    assert.equal(original.state.cancelled, false);
  });

  it("is a no-op when clone === original", async () => {
    const original = trackedResponse();
    const qualityClone = trackedResponse();
    releaseQualityClone(original.response, original.response, {
      clonedResponse: qualityClone.response,
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(original.state.cancelled, false);
    assert.equal(qualityClone.state.cancelled, false);
  });
});

// ── Memory-pressure evictors + resultMemo bounds (Batch 1 regression guards) ──
describe("memory-pressure evictors", () => {
  it("tryEmergencyGc runs registered evictors before GC and clears disposable caches", async () => {
    const heap = await import("../../open-sse/utils/heapPressure.ts");
    const memo = await import("../../open-sse/services/compression/resultMemo.ts");
    const live = await import("../../open-sse/services/compression/liveZone.ts");
    await import("../../src/app/api/v1/models/catalogCache.ts");
    await import("../../src/lib/db/readCache.ts");

    const registry = (globalThis as Record<symbol, unknown>)[
      Symbol.for("omniroute.heapPressure.evictors")
    ] as Map<string, () => void>;
    for (const name of [
      "compression.resultMemo",
      "compression.liveZone",
      "models.catalogCache",
      "db.readCache",
    ]) {
      assert.ok(registry.has(name), `evictor ${name} registered`);
    }

    const order: string[] = [];
    const unregister = heap.registerMemoryPressureEvictor("test.spy", () => order.push("evict"));
    const prevGc = (globalThis as { gc?: unknown }).gc;
    (globalThis as { gc?: unknown }).gc = () => order.push("gc");
    try {
      memo.clearMemoStore();
      memo.memoStore("k1", { body: { a: 1 }, compressed: true, stats: null });
      assert.equal(memo.getMemoStats().size, 1);
      heap.resetEmergencyGcStateForTests();
      assert.equal(heap.tryEmergencyGc(), true);
      assert.deepEqual(order, ["evict", "gc"]);
      assert.equal(memo.getMemoStats().size, 0);
      assert.equal(live.getLiveZoneCacheStats().entries, 0);
      // Debounced: a second call inside the window is a no-op.
      assert.equal(heap.tryEmergencyGc(), false);
    } finally {
      (globalThis as { gc?: unknown }).gc = prevGc;
      unregister();
      heap.resetEmergencyGcStateForTests();
      memo.clearMemoStore();
    }
    assert.equal(registry.has("test.spy"), false);
  });
});

describe("resultMemo byte bounds and TTL", () => {
  const big = (chars: number) => ({ body: { s: "x".repeat(chars) }, compressed: true, stats: null });

  it("skips storing oversized entries but returns an isolated clone", async () => {
    const memo = await import("../../open-sse/services/compression/resultMemo.ts");
    memo.clearMemoStore();
    const input = big(memo.MAX_MEMO_ENTRY_BYTES + 16);
    const stored = memo.memoStore("huge", input);
    assert.notEqual(stored, input);
    assert.equal(stored.body.s, input.body.s);
    assert.equal(memo.getMemoStats().size, 0);
    assert.equal(memo.memoLookup("huge"), null);
    memo.clearMemoStore();
  });

  it("evicts oldest entries once MAX_MEMO_TOTAL_BYTES would be exceeded", async () => {
    const memo = await import("../../open-sse/services/compression/resultMemo.ts");
    memo.clearMemoStore();
    const perEntry = memo.MAX_MEMO_ENTRY_BYTES - 1024;
    const fit = Math.floor(memo.MAX_MEMO_TOTAL_BYTES / perEntry);
    for (let i = 0; i <= fit; i++) memo.memoStore(`k${i}`, big(perEntry - 64));
    assert.ok(memo.getMemoStats().size <= fit);
    assert.equal(memo.memoLookup("k0"), null);
    assert.ok(memo.memoLookup(`k${fit}`));
    memo.clearMemoStore();
  });

  it("expires entries after MEMO_TTL_MS", async (t) => {
    const memo = await import("../../open-sse/services/compression/resultMemo.ts");
    memo.clearMemoStore();
    const realNow = Date.now;
    let now = realNow();
    t.mock.method(Date, "now", () => now);
    memo.memoStore("ttl", { body: { a: 1 }, compressed: true, stats: null });
    assert.ok(memo.memoLookup("ttl"));
    now += memo.MEMO_TTL_MS + 1;
    assert.equal(memo.memoLookup("ttl"), null);
    memo.clearMemoStore();
  });
});
