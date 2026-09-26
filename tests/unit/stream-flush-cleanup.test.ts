import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// When anything inside createSSEStream's flush() threw (e.g. a translator handing back a
// `null` item → "Cannot read properties of null (reading 'choices')"), execution jumped
// to the outer catch and skipped clearPendingRequestFromStream(). The request stayed in
// pendingById — shown as "Running" on the dashboard — until the 60-minute sweeper.

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-stream-flush-"));
process.env.DATA_DIR = TEST_DATA_DIR;
const core = await import("../../src/lib/db/core.ts");
const { createSSEStream } = await import("../../open-sse/utils/stream.ts");
const { FORMATS } = await import("../../open-sse/translator/formats.ts");
const { translateResponse } = await import("../../open-sse/translator/index.ts");
const { hasValuableContent } = await import("../../open-sse/utils/streamHelpers.ts");
const {
  translateNonStreamingResponse,
} = await import("../../open-sse/handlers/responseTranslator.ts");
const { trackPendingRequest, finalizePendingRequestById, getPendingById, clearPendingRequests } =
  await import("../../src/lib/usage/usageHistory.ts");

const enc = new TextEncoder();
const MODEL = "gemini-3.8-flash";
const PROVIDER = "gemini-cli";
const CONNECTION_ID = "conn-stream-flush";

const OPENAI_CONTENT_CHUNK = `data: ${JSON.stringify({
  id: "chatcmpl-flush",
  object: "chat.completion.chunk",
  model: MODEL,
  choices: [{ index: 0, delta: { role: "assistant", content: "hello" }, finish_reason: null }],
})}\n\n`;
const OPENAI_FINISH_CHUNK = `data: ${JSON.stringify({
  id: "chatcmpl-flush",
  object: "chat.completion.chunk",
  model: MODEL,
  choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
  usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
})}\n\n`;

async function readTransformed(chunks: string[], options: Record<string, unknown>) {
  const source = new ReadableStream<Uint8Array>({
    start(c) {
      for (const chunk of chunks) c.enqueue(enc.encode(chunk));
      c.close();
    },
  });
  return new Response(source.pipeThrough(createSSEStream(options as never))).text();
}

function pendingIdsForConnection(): string[] {
  return [...getPendingById().values()]
    .filter((detail) => detail.connectionId === CONNECTION_ID)
    .map((detail) => detail.id);
}

/** A reqLogger that blows up while flush() writes the terminal `[DONE]` line. */
function throwingOnDoneLogger() {
  return {
    appendConvertedChunk(output: string) {
      if (output.includes("[DONE]")) throw new Error("simulated flush failure");
    },
  };
}

function baseOptions(extra: Record<string, unknown> = {}) {
  return {
    mode: "translate",
    targetFormat: FORMATS.OPENAI,
    sourceFormat: FORMATS.OPENAI,
    provider: PROVIDER,
    model: MODEL,
    connectionId: CONNECTION_ID,
    body: { messages: [{ role: "user", content: "hi" }] },
    ...extra,
  };
}

test.beforeEach(() => {
  clearPendingRequests();
});

test.after(() => {
  clearPendingRequests();
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test("flush() error without onComplete still clears the pending request", async () => {
  trackPendingRequest(MODEL, PROVIDER, CONNECTION_ID, true);
  assert.equal(pendingIdsForConnection().length, 1);

  await readTransformed(
    [OPENAI_CONTENT_CHUNK, OPENAI_FINISH_CHUNK],
    baseOptions({ reqLogger: throwingOnDoneLogger() })
  );

  assert.deepEqual(
    pendingIdsForConnection(),
    [],
    "pending request must not leak after flush error"
  );
});

test("flush() error before onComplete runs clears the pending request", async () => {
  trackPendingRequest(MODEL, PROVIDER, CONNECTION_ID, true);
  let onCompleteCalls = 0;

  await readTransformed(
    [OPENAI_CONTENT_CHUNK, OPENAI_FINISH_CHUNK],
    baseOptions({
      reqLogger: throwingOnDoneLogger(),
      onComplete: () => {
        onCompleteCalls++;
      },
    })
  );

  assert.equal(onCompleteCalls, 0, "the simulated throw happens before onComplete");
  assert.deepEqual(pendingIdsForConnection(), []);
});

test("flush() error inside onComplete still clears the pending request", async () => {
  trackPendingRequest(MODEL, PROVIDER, CONNECTION_ID, true);
  assert.equal(pendingIdsForConnection().length, 1);

  await readTransformed(
    [OPENAI_CONTENT_CHUNK, OPENAI_FINISH_CHUNK],
    baseOptions({
      onComplete: () => {
        throw new Error("simulated onComplete error");
      },
    })
  );

  assert.deepEqual(
    pendingIdsForConnection(),
    [],
    "pending request must not leak when onComplete throws"
  );
});

test("flush() does not double-clear when onComplete already owns pending cleanup", async () => {
  // Two concurrent requests on the same model/connection. onComplete (like chatCore's
  // onStreamComplete) finalizes its own entry; the stream must not FIFO-evict the other.
  trackPendingRequest(MODEL, PROVIDER, CONNECTION_ID, true);
  trackPendingRequest(MODEL, PROVIDER, CONNECTION_ID, true);
  const [ownId, otherId] = pendingIdsForConnection();
  assert.ok(ownId && otherId);

  await readTransformed(
    [OPENAI_CONTENT_CHUNK, OPENAI_FINISH_CHUNK],
    baseOptions({
      onComplete: () => {
        trackPendingRequest(MODEL, PROVIDER, CONNECTION_ID, false);
      },
    })
  );

  assert.deepEqual(pendingIdsForConnection(), [otherId]);
});

test("translateResponse flush never yields null items (codex → openai has no translator)", () => {
  const result = translateResponse(FORMATS.CODEX, FORMATS.OPENAI, null, {});
  assert.ok(Array.isArray(result));
  assert.equal(
    result.some((item: unknown) => item == null),
    false
  );
});

test("hasValuableContent tolerates a null chunk for every format", () => {
  for (const format of Object.values(FORMATS)) {
    assert.equal(hasValuableContent(null as never, format), false, format);
  }
});

test("translate-mode stream without a reverse translator completes and clears pending", async () => {
  trackPendingRequest(MODEL, PROVIDER, CONNECTION_ID, true);
  const logs: unknown[][] = [];
  const originalLog = console.log;
  console.log = (...args: unknown[]) => {
    logs.push(args);
  };
  let output: string;
  try {
    output = await readTransformed(
      [OPENAI_CONTENT_CHUNK, OPENAI_FINISH_CHUNK],
      baseOptions({ targetFormat: FORMATS.CODEX })
    );
  } finally {
    console.log = originalLog;
  }

  const flushErrors = logs.filter((args) => String(args[0]).includes("Error in flush"));
  assert.deepEqual(flushErrors, [], "flush must not throw on a null translator item");
  assert.match(output, /data: \[DONE\]/);
  assert.deepEqual(pendingIdsForConnection(), []);
});

test("translateNonStreamingResponse does not throw on null or undefined bodies", () => {
  for (const [target, source] of [
    [FORMATS.OPENAI, FORMATS.CLAUDE],
    [FORMATS.OPENAI, FORMATS.GEMINI],
    [FORMATS.OPENAI, FORMATS.ANTIGRAVITY],
    [FORMATS.OPENAI_RESPONSES, FORMATS.OPENAI],
    [FORMATS.GEMINI, FORMATS.OPENAI],
    [FORMATS.CLAUDE, FORMATS.OPENAI],
    [FORMATS.OPENAI, FORMATS.OPENAI],
  ]) {
    assert.doesNotThrow(
      () => translateNonStreamingResponse(null, target, source),
      `${target}→${source}`
    );
    assert.doesNotThrow(
      () => translateNonStreamingResponse(undefined, target, source),
      `${target}→${source}`
    );
  }
});

test("two concurrent requests: onComplete finalizes own ID and throws, other request remains pending", async () => {
  const id1 = trackPendingRequest(MODEL, PROVIDER, CONNECTION_ID, true);
  const id2 = trackPendingRequest(MODEL, PROVIDER, CONNECTION_ID, true);
  assert.equal(pendingIdsForConnection().length, 2);

  await readTransformed(
    [OPENAI_CONTENT_CHUNK, OPENAI_FINISH_CHUNK],
    baseOptions({
      pendingRequestId: id1,
      onComplete: () => {
        // Finalize own ID first (like chatCore does), then throw an exception later in callback
        finalizePendingRequestById(id1, { status: 200 });
        throw new Error("simulated post-finalization failure in onComplete");
      },
    })
  );

  // id1 was finalized, id2 must still be pending (never shifted or evicted)
  assert.deepEqual(pendingIdsForConnection(), [id2]);
});

test("pendingRequestId stream failing flush only cleans up its own ID", async () => {
  const id1 = trackPendingRequest(MODEL, PROVIDER, CONNECTION_ID, true);
  const id2 = trackPendingRequest(MODEL, PROVIDER, CONNECTION_ID, true);
  assert.equal(pendingIdsForConnection().length, 2);

  await readTransformed(
    [OPENAI_CONTENT_CHUNK, OPENAI_FINISH_CHUNK],
    baseOptions({
      pendingRequestId: id1,
      reqLogger: throwingOnDoneLogger(),
    })
  );

  // id1 was cleaned up via finalizePendingRequestById in finally; id2 is untouched
  assert.deepEqual(pendingIdsForConnection(), [id2]);
});
