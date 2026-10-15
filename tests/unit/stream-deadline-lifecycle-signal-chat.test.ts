// #14808/#15010 through the retained handleChat path: the streaming routes no longer rebuild
// the framework Request to carry the slow-stream deadline — they hand handleChat an explicit
// lifecycle signal (createStreamDeadlineSignal). That signal, not request.signal, must reach
// the upstream provider dispatch, so a deadline abort tears provider work down exactly like a
// client disconnect even though the framework Request's own signal never fires.
import test from "node:test";
import assert from "node:assert/strict";

import { createChatPipelineHarness } from "../integration/_chatPipelineHarness.ts";
import { createStreamDeadlineSignal } from "../../open-sse/utils/streamDeadlineSignal.ts";

const harness = await createChatPipelineHarness("stream-deadline-lifecycle");
const { BaseExecutor, buildRequest, handleChat, resetStorage, seedConnection } = harness;

test.beforeEach(async () => {
  BaseExecutor.RETRY_CONFIG.delayMs = 0;
  process.env.REQUIRE_API_KEY = "false";
  await resetStorage();
});

test.after(async () => {
  await harness.cleanup();
});

function body() {
  return {
    model: "openai/gpt-4.1",
    stream: true,
    messages: [{ role: "user", content: "hello" }],
  };
}

test("handleChat: aborting the explicit lifecycle (deadline) signal aborts the upstream fetch", async () => {
  await seedConnection("openai", { apiKey: "sk-openai-deadline" });
  let upstreamSignal: AbortSignal | null = null;
  let markFetched: () => void = () => {};
  const fetched = new Promise<void>((resolve) => {
    markFetched = resolve;
  });
  globalThis.fetch = (async (_url: unknown, init: RequestInit = {}) => {
    upstreamSignal = (init.signal as AbortSignal) ?? null;
    markFetched();
    // A stuck upstream: only an abort of the dispatch signal ends this request.
    return new Promise<Response>((_resolve, reject) => {
      const signal = init.signal as AbortSignal | undefined;
      const fail = () => reject(signal?.reason ?? new DOMException("aborted", "AbortError"));
      if (signal?.aborted) fail();
      else signal?.addEventListener("abort", fail, { once: true });
    });
  }) as typeof fetch;

  const request = buildRequest({ body: body() });
  const { signal, deadlineController } = createStreamDeadlineSignal(request.signal);
  const pending = handleChat(request, null, body(), "deadline-corr", signal);

  await Promise.race([
    fetched,
    new Promise((_r, reject) => setTimeout(() => reject(new Error("fetch never called")), 5000)),
  ]);
  assert.ok(upstreamSignal, "upstream dispatch must carry an abort signal");
  assert.equal(request.signal.aborted, false, "framework Request signal stays untouched");
  assert.equal(upstreamSignal!.aborted, false);

  deadlineController.abort();

  const settled = await Promise.race([
    pending.then(
      () => "settled",
      () => "settled"
    ),
    new Promise((resolve) => setTimeout(() => resolve("hung"), 5000)),
  ]);
  assert.equal(settled, "settled", "handleChat must tear down once the deadline fires");
  assert.equal(upstreamSignal!.aborted, true, "deadline abort must reach the provider fetch");
});

function stuckUpstream(onFetch: (signal: AbortSignal | null) => void) {
  globalThis.fetch = (async (_url: unknown, init: RequestInit = {}) => {
    onFetch((init.signal as AbortSignal) ?? null);
    return new Promise<Response>((_resolve, reject) => {
      const signal = init.signal as AbortSignal | undefined;
      const fail = () => reject(signal?.reason ?? new DOMException("aborted", "AbortError"));
      if (signal?.aborted) fail();
      else signal?.addEventListener("abort", fail, { once: true });
    });
  }) as typeof fetch;
}

test("handleChat: without a lifecycle signal the framework request.signal still governs dispatch", async () => {
  await seedConnection("openai", { apiKey: "sk-openai-deadline-2" });
  let upstreamSignal: AbortSignal | null = null;
  let markFetched: () => void = () => {};
  const fetched = new Promise<void>((resolve) => {
    markFetched = resolve;
  });
  stuckUpstream((signal) => {
    upstreamSignal = signal;
    markFetched();
  });

  const clientController = new AbortController();
  const request = new Request("http://localhost/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body()),
    signal: clientController.signal,
  });
  const pending = handleChat(request, null, body());
  await Promise.race([
    fetched,
    new Promise((_r, reject) => setTimeout(() => reject(new Error("fetch never called")), 5000)),
  ]);
  assert.ok(upstreamSignal, "upstream dispatch must carry an abort signal");
  clientController.abort();
  const settled = await Promise.race([
    pending.then(
      () => "settled",
      () => "settled"
    ),
    new Promise((resolve) => setTimeout(() => resolve("hung"), 5000)),
  ]);
  assert.equal(settled, "settled");
  assert.equal(upstreamSignal!.aborted, true, "client abort still reaches the dispatch signal");
});
