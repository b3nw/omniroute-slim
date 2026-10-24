import test from "node:test";
import assert from "node:assert/strict";
import {
  fetchWithFirstByteDeadline,
  createSseFirstDataScanner,
  isGeminiCliFirstByteTimeout,
  GEMINI_CLI_FIRST_BYTE_TIMEOUT_CODE,
  GeminiCliFirstByteTimeoutError,
  type GeminiCliAttemptTiming,
} from "../../open-sse/executors/geminiCliFirstByte.ts";
import { GeminiCliExecutor } from "../../open-sse/executors/geminiCli.ts";
import { isRequestScopedUpstreamFailure } from "../../open-sse/services/combo/comboPredicates.ts";
import { isSelfInflictedUpstreamTimeout } from "../../open-sse/handlers/chatCore/cooldownClassification.ts";
import { getGeminiCliFirstByteConfig } from "../../src/shared/utils/runtimeTimeouts.ts";

const URL_ = "https://cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse";
const FRESH = { kind: "fresh-dispatcher-sentinel" };
const encoder = new TextEncoder();
const decoder = new TextDecoder();

type Call = { init: RequestInit & { dispatcher?: unknown } };

function controlledStream() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const state = { cancelled: false };
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
    cancel() {
      state.cancelled = true;
    },
  });
  return {
    stream,
    state,
    push: (text: string) => controller.enqueue(encoder.encode(text)),
    close: () => controller.close(),
  };
}

function sseResponse(body: ReadableStream<Uint8Array> | string, status = 200): Response {
  return new Response(body, { status, headers: { "Content-Type": "text/event-stream" } });
}

/** A fetch that never resolves until its signal aborts. */
function hangingFetch(init: RequestInit): Promise<Response> {
  return new Promise((_, reject) => {
    init.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
  });
}

function scriptedFetch(handlers: Array<(init: RequestInit) => Promise<Response> | Response>) {
  const calls: Call[] = [];
  const fetchImpl = async (_url: string, init: RequestInit & { dispatcher?: unknown }) => {
    calls.push({ init });
    const handler = handlers[Math.min(calls.length - 1, handlers.length - 1)];
    return handler(init);
  };
  return { calls, fetchImpl };
}

async function readAll(response: Response): Promise<string> {
  const reader = response.body!.getReader();
  let text = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  return text;
}

const baseOptions = {
  url: URL_,
  init: { method: "POST", headers: { "Content-Type": "application/json" }, body: '{"x":1}' },
  getFreshDispatcher: () => FRESH,
};

test("1: headers hang past the deadline → abort, retry on a fresh dispatcher, attempt 2 succeeds", async () => {
  const { calls, fetchImpl } = scriptedFetch([
    hangingFetch,
    () => sseResponse('data: {"ok":true}\n\n'),
  ]);
  const timings: GeminiCliAttemptTiming[] = [];
  const { response, attempts } = await fetchWithFirstByteDeadline({
    ...baseOptions,
    fetchImpl,
    timeoutMs: 30,
    maxAttempts: 3,
    totalBudgetMs: 1000,
    onAttempt: (t) => timings.push(t),
  });

  assert.equal(response.status, 200);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].init.dispatcher, undefined, "attempt 1 uses the default pooled path");
  assert.equal(calls[1].init.dispatcher, FRESH, "retry uses the fresh dispatcher");
  assert.notEqual(calls[0].init.dispatcher, calls[1].init.dispatcher);
  assert.equal(calls[0].init.signal?.aborted, true, "attempt 1 was aborted");
  assert.deepEqual(
    attempts.map((a) => [a.attempt, a.dispatcher, a.outcome]),
    [
      [1, "pooled", "first_byte_timeout"],
      [2, "fresh", "ok"],
    ]
  );
  assert.deepEqual(timings, attempts, "onAttempt receives every attempt");
  assert.equal(attempts[0].upstreamHeadersMs, null);
  assert.equal(typeof attempts[1].upstreamHeadersMs, "number");
  assert.equal(typeof attempts[1].upstreamFirstDataMs, "number");
  assert.equal(attempts[1].status, 200);
  assert.equal(attempts[1].deadlineMs, 45, "retry gets a 1.5x deadline");
  assert.equal(await readAll(response), 'data: {"ok":true}\n\n');
});

test("2: headers arrive but first data is late → abort, release the socket, retry", async () => {
  const stalled = controlledStream();
  const { calls, fetchImpl } = scriptedFetch([
    () => sseResponse(stalled.stream),
    () => sseResponse('data: {"second":true}\n\n'),
  ]);
  const { response, attempts } = await fetchWithFirstByteDeadline({
    ...baseOptions,
    fetchImpl,
    timeoutMs: 30,
    maxAttempts: 3,
    totalBudgetMs: 1000,
  });

  assert.equal(calls.length, 2);
  assert.equal(stalled.state.cancelled, true, "stalled body reader was cancelled");
  assert.equal(attempts[0].outcome, "first_byte_timeout");
  assert.equal(attempts[0].status, 200);
  assert.equal(typeof attempts[0].upstreamHeadersMs, "number");
  assert.equal(attempts[0].upstreamFirstDataMs, null);
  assert.equal(await readAll(response), 'data: {"second":true}\n\n');
});

test("3: keepalive pings and comment frames do not satisfy the deadline", async () => {
  const pinging = controlledStream();
  const { calls, fetchImpl } = scriptedFetch([
    () => {
      setTimeout(() => {
        pinging.push(": keepalive\n\n");
        pinging.push("\n\n");
        pinging.push("event: ping\ndata: {}\n\n");
        pinging.push("data:   \n\n");
      }, 1);
      return sseResponse(pinging.stream);
    },
    () => sseResponse('data: {"real":1}\n\n'),
  ]);
  const { attempts } = await fetchWithFirstByteDeadline({
    ...baseOptions,
    fetchImpl,
    timeoutMs: 40,
    maxAttempts: 2,
    totalBudgetMs: 1000,
  });
  assert.equal(calls.length, 2);
  assert.equal(attempts[0].outcome, "first_byte_timeout");
  assert.equal(attempts[1].outcome, "ok");

  // Scanner unit checks, including a data line split across chunks.
  const scan = createSseFirstDataScanner();
  assert.equal(scan(encoder.encode(": ping\n\n")), false);
  assert.equal(scan(encoder.encode("event: keepalive\ndata: {}\n\n")), false);
  assert.equal(scan(encoder.encode("da")), false);
  assert.equal(scan(encoder.encode('ta: {"a":1}')), false, "incomplete line is not yet an event");
  assert.equal(scan(encoder.encode("\n")), true);
});

test("4: max attempts and total budget are enforced → GEMINI_CLI_FIRST_BYTE_TIMEOUT", async () => {
  // Max attempts.
  const byAttempts = scriptedFetch([hangingFetch]);
  await assert.rejects(
    fetchWithFirstByteDeadline({
      ...baseOptions,
      fetchImpl: byAttempts.fetchImpl,
      timeoutMs: 15,
      maxAttempts: 3,
      totalBudgetMs: 10_000,
    }),
    (err: unknown) => {
      assert.ok(err instanceof GeminiCliFirstByteTimeoutError);
      assert.equal(isGeminiCliFirstByteTimeout(err), true);
      assert.equal((err as { code: string }).code, GEMINI_CLI_FIRST_BYTE_TIMEOUT_CODE);
      assert.equal((err as { status: number }).status, 504);
      assert.equal((err as Error).name, "TimeoutError");
      assert.equal((err as GeminiCliFirstByteTimeoutError).attempts.length, 3);
      assert.ok(
        (err as GeminiCliFirstByteTimeoutError).attempts.every(
          (a) => a.outcome === "first_byte_timeout"
        )
      );
      return true;
    }
  );
  assert.equal(byAttempts.calls.length, 3);

  // Total budget: 40ms budget with a 25ms deadline allows at most 2 attempts,
  // the second capped by the remaining budget.
  const byBudget = scriptedFetch([hangingFetch]);
  const started = Date.now();
  await assert.rejects(
    fetchWithFirstByteDeadline({
      ...baseOptions,
      fetchImpl: byBudget.fetchImpl,
      timeoutMs: 25,
      maxAttempts: 10,
      totalBudgetMs: 40,
    }),
    (err: unknown) => isGeminiCliFirstByteTimeout(err)
  );
  assert.ok(byBudget.calls.length <= 2, `budget capped attempts (got ${byBudget.calls.length})`);
  assert.ok(Date.now() - started < 500, "budget bounds total wall time");

  // Combo/cooldown classification: request-scoped code, self-inflicted 504.
  assert.equal(
    isRequestScopedUpstreamFailure({ code: GEMINI_CLI_FIRST_BYTE_TIMEOUT_CODE, status: 504 }),
    true
  );
  assert.equal(isSelfInflictedUpstreamTimeout(504, "upstream_timeout", "gemini-cli"), true);
});

test("5: success on attempt 2 replays the buffered first chunk plus the rest intact", async () => {
  const good = controlledStream();
  const { fetchImpl } = scriptedFetch([
    hangingFetch,
    () => {
      setTimeout(() => {
        good.push(": warmup\n\n");
        good.push('data: {"n":1}\n\n');
        setTimeout(() => {
          good.push('data: {"n":2}\n\n');
          good.push("data: [DONE]\n\n");
          good.close();
        }, 5);
      }, 1);
      return sseResponse(good.stream);
    },
  ]);
  const { response, attempts } = await fetchWithFirstByteDeadline({
    ...baseOptions,
    fetchImpl,
    timeoutMs: 25,
    maxAttempts: 3,
    totalBudgetMs: 1000,
  });
  assert.equal(attempts.length, 2);
  assert.equal(
    await readAll(response),
    ': warmup\n\ndata: {"n":1}\n\ndata: {"n":2}\n\ndata: [DONE]\n\n'
  );
});

test("6: caller abort cancels immediately with no retry", async () => {
  const caller = new AbortController();
  const { calls, fetchImpl } = scriptedFetch([hangingFetch]);
  setTimeout(() => caller.abort(new DOMException("client gone", "AbortError")), 10);
  const started = Date.now();
  await assert.rejects(
    fetchWithFirstByteDeadline({
      ...baseOptions,
      fetchImpl,
      signal: caller.signal,
      timeoutMs: 1000,
      maxAttempts: 3,
      totalBudgetMs: 5000,
    }),
    (err: unknown) => {
      assert.equal((err as Error).name, "AbortError");
      assert.equal(isGeminiCliFirstByteTimeout(err), false);
      return true;
    }
  );
  assert.equal(calls.length, 1);
  assert.ok(Date.now() - started < 500);

  // Abort during the read-ahead phase also stops without retry.
  const caller2 = new AbortController();
  const stalled = controlledStream();
  const second = scriptedFetch([() => sseResponse(stalled.stream)]);
  setTimeout(() => caller2.abort(), 10);
  await assert.rejects(
    fetchWithFirstByteDeadline({
      ...baseOptions,
      fetchImpl: second.fetchImpl,
      signal: caller2.signal,
      timeoutMs: 1000,
      maxAttempts: 3,
      totalBudgetMs: 5000,
    })
  );
  assert.equal(second.calls.length, 1);
  assert.equal(stalled.state.cancelled, true);
});

test("7: executor sends a byte-identical body (session_id / user_prompt_id) on every attempt", async (t) => {
  const originalFetch = globalThis.fetch;
  const saved = process.env.GEMINI_CLI_FIRST_BYTE_TIMEOUT_MS;
  t.after(() => {
    globalThis.fetch = originalFetch;
    if (saved === undefined) delete process.env.GEMINI_CLI_FIRST_BYTE_TIMEOUT_MS;
    else process.env.GEMINI_CLI_FIRST_BYTE_TIMEOUT_MS = saved;
  });
  process.env.GEMINI_CLI_FIRST_BYTE_TIMEOUT_MS = "30";

  const bodies: string[] = [];
  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    bodies.push(String(init?.body));
    if (bodies.length === 1) return hangingFetch(init ?? {});
    return sseResponse(
      `data: ${JSON.stringify({
        response: { candidates: [{ content: { parts: [{ text: "hi" }] }, finishReason: "STOP" }] },
      })}\n\n`
    );
  }) as typeof fetch;

  const logs: Array<[string, string]> = [];
  const executor = new GeminiCliExecutor();
  const result = await executor.execute({
    model: "gemini-3.5-flash",
    body: { messages: [{ role: "user", content: "identical body test" }] },
    stream: true,
    credentials: { apiKey: "k", projectId: "test-proj" },
    signal: null,
    log: {
      info: (tag, msg) => logs.push([tag, msg]),
      warn: (tag, msg) => logs.push([tag, msg]),
    },
  });
  const text = await readAll((result as { response: Response }).response);
  assert.ok(text.includes("hi"));

  assert.equal(bodies.length, 2);
  assert.equal(bodies[0], bodies[1], "request body is byte-identical across attempts");
  const parsed = JSON.parse(bodies[0]);
  assert.ok(parsed.user_prompt_id, "user_prompt_id present");
  assert.ok(
    parsed.request?.session_id ?? parsed.session_id,
    "session_id present in the replayed body"
  );

  const timingLogs = logs.filter(([tag]) => tag === "GEMINI_CLI_UPSTREAM_TIMING");
  assert.equal(timingLogs.length, 2);
  const [first, secondLog] = timingLogs.map(([, msg]) => JSON.parse(msg));
  assert.equal(first.outcome, "first_byte_timeout");
  assert.equal(first.attempt, 1);
  assert.equal(secondLog.outcome, "ok");
  assert.equal(secondLog.attempt, 2);
  assert.equal(secondLog.status, 200);
  assert.ok(["pooled", "fresh"].includes(secondLog.dispatcher));
});

test("8: no retry after the first chunk has been delivered (mid-stream stall)", async () => {
  const s = controlledStream();
  const { calls, fetchImpl } = scriptedFetch([
    () => {
      setTimeout(() => s.push('data: {"first":1}\n\n'), 1);
      return sseResponse(s.stream);
    },
  ]);
  const { response } = await fetchWithFirstByteDeadline({
    ...baseOptions,
    fetchImpl,
    timeoutMs: 20,
    maxAttempts: 3,
    totalBudgetMs: 1000,
  });
  const reader = response.body!.getReader();
  const first = await reader.read();
  assert.equal(decoder.decode(first.value), 'data: {"first":1}\n\n');

  // Stall well past the per-attempt deadline, then resume.
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(calls.length, 1, "a mid-stream stall is never retried here");
  assert.equal(s.state.cancelled, false, "the delivered stream is not torn down");
  s.push('data: {"second":2}\n\n');
  s.close();
  const second = await reader.read();
  assert.equal(decoder.decode(second.value), 'data: {"second":2}\n\n');
  assert.equal((await reader.read()).done, true);
});

test("9: GEMINI_CLI_FIRST_BYTE_TIMEOUT_MS=0 restores the original single-fetch behavior", async (t) => {
  const saved = process.env.GEMINI_CLI_FIRST_BYTE_TIMEOUT_MS;
  t.after(() => {
    if (saved === undefined) delete process.env.GEMINI_CLI_FIRST_BYTE_TIMEOUT_MS;
    else process.env.GEMINI_CLI_FIRST_BYTE_TIMEOUT_MS = saved;
  });
  process.env.GEMINI_CLI_FIRST_BYTE_TIMEOUT_MS = "0";
  assert.equal(getGeminiCliFirstByteConfig().timeoutMs, 0);

  const upstream = sseResponse('data: {"a":1}\n\n');
  const caller = new AbortController();
  const { calls, fetchImpl } = scriptedFetch([() => upstream]);
  const { response, attempts } = await fetchWithFirstByteDeadline({
    ...baseOptions,
    fetchImpl,
    signal: caller.signal,
  });
  assert.equal(response, upstream, "upstream Response is returned untouched");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].init.signal, caller.signal, "caller signal passed through as-is");
  assert.equal(calls[0].init.dispatcher, undefined);
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0].deadlineMs, null);
  assert.equal(attempts[0].outcome, "ok");
});

test("10: non-2xx (429) is returned as-is with no first-byte retry", async () => {
  const upstream = new Response('{"error":{"code":429,"message":"quota"}}', { status: 429 });
  const { calls, fetchImpl } = scriptedFetch([() => upstream]);
  const { response, attempts } = await fetchWithFirstByteDeadline({
    ...baseOptions,
    fetchImpl,
    timeoutMs: 20,
    maxAttempts: 3,
    totalBudgetMs: 1000,
  });
  assert.equal(response, upstream);
  assert.equal(response.status, 429);
  assert.equal(await response.text(), '{"error":{"code":429,"message":"quota"}}');
  // Body read after the deadline would have fired: timer must have been cleared.
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(calls.length, 1);
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0].status, 429);
  assert.equal(attempts[0].outcome, "error");
});

test("config defaults: 12000ms / 3 attempts / 45000ms budget", () => {
  assert.deepEqual(getGeminiCliFirstByteConfig({}), {
    timeoutMs: 12_000,
    maxAttempts: 3,
    totalBudgetMs: 45_000,
  });
  assert.deepEqual(
    getGeminiCliFirstByteConfig({
      GEMINI_CLI_FIRST_BYTE_TIMEOUT_MS: "5000",
      GEMINI_CLI_FIRST_BYTE_MAX_ATTEMPTS: "2",
      GEMINI_CLI_FIRST_BYTE_TOTAL_BUDGET_MS: "20000",
    }),
    { timeoutMs: 5000, maxAttempts: 2, totalBudgetMs: 20_000 }
  );
});
