import test from "node:test";
import assert from "node:assert/strict";
import {
  fetchWithFirstByteDeadline,
  createSseFirstDataScanner,
  isGeminiCliFirstByteTimeout,
  GEMINI_CLI_FIRST_BYTE_TIMEOUT_CODE,
  GeminiCliFirstByteTimeoutError,
  type GeminiCliAttemptTiming,
  computeAdaptiveGeminiCliFirstByteTimeoutMs,
  MAX_ADAPTIVE_GEMINI_CLI_FIRST_BYTE_TIMEOUT_MS,
} from "../../open-sse/executors/geminiCliFirstByte.ts";
import { GeminiCliExecutor } from "../../open-sse/executors/geminiCli.ts";
import { isRequestScopedUpstreamFailure } from "../../open-sse/services/combo/comboPredicates.ts";
import { isSelfInflictedUpstreamTimeout } from "../../open-sse/handlers/chatCore/cooldownClassification.ts";
import { getGeminiCliFirstByteConfig } from "../../src/shared/utils/runtimeTimeouts.ts";
import net from "node:net";
import {
  getFreshDirectRetryDispatcher,
  resolveProxyForRequest,
  runWithProxyContext,
} from "../../open-sse/utils/proxyFetch.ts";
import { getProxyRetryDispatcher } from "../../open-sse/utils/proxyDispatcher.ts";
import { buildTargetTimeoutRunner } from "../../open-sse/services/combo/targetTimeoutRunner.ts";
import {
  disarmComboTargetTimeout,
  propagateComboTargetTimeoutDisarm,
  registerComboTargetTimeoutDisarm,
} from "../../open-sse/services/combo/comboAbortReasons.ts";
import { mergeAbortSignals } from "../../open-sse/executors/base.ts";
import { executeWithUpstreamStartTimeout } from "../../open-sse/handlers/chatCore/upstreamTimeouts.ts";

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

// ── Adaptive deadline / combo single attempt / proxy-aware retry / disarm ──────

test("adaptive: small prompt keeps the base deadline", () => {
  assert.equal(computeAdaptiveGeminiCliFirstByteTimeoutMs({ baseTimeoutMs: 12_000 }), 12_000);
  assert.equal(
    computeAdaptiveGeminiCliFirstByteTimeoutMs({ baseTimeoutMs: 12_000, bodyByteLength: 30_000 }),
    12_000
  );
  assert.equal(
    computeAdaptiveGeminiCliFirstByteTimeoutMs({
      baseTimeoutMs: 12_000,
      bodyByteLength: 30_000,
      thinkingLevel: "medium",
      thinkingBudget: 8_192,
    }),
    12_000
  );
});

test("adaptive: 180KB + thinkingLevel high scales to 22000ms", () => {
  // ceil(140_000 / 40_000) = 4 steps * 1500 = +6000, high thinking +4000.
  assert.equal(
    computeAdaptiveGeminiCliFirstByteTimeoutMs({
      baseTimeoutMs: 12_000,
      bodyByteLength: 180_000,
      thinkingLevel: "HIGH",
    }),
    22_000
  );
  assert.equal(
    computeAdaptiveGeminiCliFirstByteTimeoutMs({ baseTimeoutMs: 12_000, thinkingBudget: -1 }),
    16_000
  );
  assert.equal(
    computeAdaptiveGeminiCliFirstByteTimeoutMs({ baseTimeoutMs: 12_000, thinkingBudget: 16_384 }),
    16_000
  );
});

test("adaptive: 500KB + thinkingLevel high caps at 26000ms; base 0 stays disabled", () => {
  assert.equal(
    computeAdaptiveGeminiCliFirstByteTimeoutMs({
      baseTimeoutMs: 12_000,
      bodyByteLength: 500_000,
      thinkingLevel: "high",
    }),
    MAX_ADAPTIVE_GEMINI_CLI_FIRST_BYTE_TIMEOUT_MS
  );
  assert.equal(MAX_ADAPTIVE_GEMINI_CLI_FIRST_BYTE_TIMEOUT_MS, 26_000);
  assert.equal(
    computeAdaptiveGeminiCliFirstByteTimeoutMs({
      baseTimeoutMs: 0,
      bodyByteLength: 500_000,
      thinkingLevel: "high",
    }),
    0
  );
  // An operator base above the cap is never lowered.
  assert.equal(
    computeAdaptiveGeminiCliFirstByteTimeoutMs({
      baseTimeoutMs: 40_000,
      bodyByteLength: 500_000,
      thinkingLevel: "high",
    }),
    40_000
  );
});

function withFirstByteEnv(
  t: { after: (fn: () => void) => void },
  vars: Record<string, string | undefined>
) {
  const originalFetch = globalThis.fetch;
  const saved: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(vars)) {
    saved[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  t.after(() => {
    globalThis.fetch = originalFetch;
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

test("executor: skipUpstreamRetry (combo) runs a single attempt on first-byte timeout", async (t) => {
  withFirstByteEnv(t, {
    GEMINI_CLI_FIRST_BYTE_TIMEOUT_MS: "30",
    GEMINI_CLI_FIRST_BYTE_MAX_ATTEMPTS: "3",
  });
  let calls = 0;
  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    calls++;
    return hangingFetch(init ?? {});
  }) as typeof fetch;

  const logs: Array<[string, string]> = [];
  const executor = new GeminiCliExecutor();
  await assert.rejects(
    executor.execute({
      model: "gemini-3.5-flash",
      body: { messages: [{ role: "user", content: "combo target" }] },
      stream: true,
      credentials: { apiKey: "k", projectId: "test-proj" },
      signal: null,
      skipUpstreamRetry: true,
      log: {
        info: (tag, msg) => logs.push([tag, msg]),
        warn: (tag, msg) => logs.push([tag, msg]),
      },
    }),
    (err: unknown) => isGeminiCliFirstByteTimeout(err)
  );
  assert.equal(calls, 1, "no same-account retry inside a combo target");
  const timingLogs = logs.filter(([tag]) => tag === "GEMINI_CLI_UPSTREAM_TIMING");
  assert.equal(timingLogs.length, 1);
  assert.equal(JSON.parse(timingLogs[0][1]).outcome, "first_byte_timeout");
});

test("executor: large effort=high payload gets the adaptive first-byte deadline", async (t) => {
  withFirstByteEnv(t, {
    GEMINI_CLI_FIRST_BYTE_TIMEOUT_MS: "12000",
    GEMINI_CLI_FIRST_BYTE_MAX_ATTEMPTS: undefined,
  });
  const bodies: string[] = [];
  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    bodies.push(String(init?.body));
    return sseResponse(
      `data: ${JSON.stringify({
        response: { candidates: [{ content: { parts: [{ text: "ok" }] }, finishReason: "STOP" }] },
      })}\n\n`
    );
  }) as typeof fetch;

  const logs: Array<[string, string]> = [];
  const executor = new GeminiCliExecutor();
  const result = await executor.execute({
    model: "gemini-3.5-flash",
    body: {
      messages: [{ role: "user", content: "x".repeat(180_000) }],
      reasoning_effort: "high",
    },
    stream: true,
    credentials: { apiKey: "k", projectId: "test-proj" },
    signal: null,
    skipUpstreamRetry: true,
    log: {
      info: (tag, msg) => logs.push([tag, msg]),
      warn: (tag, msg) => logs.push([tag, msg]),
    },
  });
  assert.ok((await readAll((result as { response: Response }).response)).includes("ok"));

  assert.equal(bodies.length, 1);
  const sent = JSON.parse(bodies[0]);
  assert.equal(sent.request?.generationConfig?.thinkingConfig?.thinkingLevel, "high");
  const expected = computeAdaptiveGeminiCliFirstByteTimeoutMs({
    baseTimeoutMs: 12_000,
    bodyByteLength: Buffer.byteLength(bodies[0], "utf8"),
    thinkingLevel: "high",
  });
  assert.equal(expected, 22_000);
  const timing = JSON.parse(
    logs.find(([tag]) => tag === "GEMINI_CLI_UPSTREAM_TIMING")?.[1] ?? "{}"
  );
  assert.equal(timing.deadlineMs, expected);
  assert.equal(timing.outcome, "ok");
});

test("getFreshDirectRetryDispatcher returns the proxy retry dispatcher under an HTTP proxy context", async () => {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  try {
    const { dispatcher, proxyUrl } = await runWithProxyContext(
      { type: "http", host: "127.0.0.1", port: String(address.port) },
      async () => ({
        dispatcher: getFreshDirectRetryDispatcher(URL_),
        proxyUrl: resolveProxyForRequest(URL_).proxyUrl,
      })
    );
    assert.ok(proxyUrl, "proxy context resolves to a proxy URL");
    assert.notEqual(dispatcher, null, "proxied retries get a fresh dispatcher, not pooled");
    assert.equal(dispatcher, getProxyRetryDispatcher(proxyUrl!));
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("combo target timeout: disarm on first byte lets a stream:false body finish buffering", async () => {
  const runner = buildTargetTimeoutRunner({
    comboTargetTimeoutMs: 30,
    log: { warn() {}, info() {}, error() {}, debug() {} },
    handleSingleModel: async (_b, _m, target) => {
      const targetSignal = (target as { modelAbortSignal: AbortSignal }).modelAbortSignal;
      // chat.ts merges the target signal into clientRawRequest.signal before dispatch.
      const clientSignal = mergeAbortSignals(new AbortController().signal, targetSignal);
      await new Promise((r) => setTimeout(r, 10)); // first byte at ~10ms
      disarmComboTargetTimeout(clientSignal);
      await new Promise((r) => setTimeout(r, 80)); // buffering until ~90ms
      if (targetSignal.aborted) throw new Error("aborted mid-buffer");
      return new Response('{"ok":true}', { status: 200 });
    },
  });
  const res = await runner({}, "gemini-cli/gemini-3.8-flash");
  assert.equal(res.status, 200);
  assert.equal(await res.text(), '{"ok":true}');
});

test("combo target timeout: without disarm the startup timeout still fires", async () => {
  const runner = buildTargetTimeoutRunner({
    comboTargetTimeoutMs: 30,
    log: { warn() {}, info() {}, error() {}, debug() {} },
    handleSingleModel: async () => {
      await new Promise((r) => setTimeout(r, 80));
      return new Response("late", { status: 200 });
    },
  });
  const res = await runner({}, "gemini-cli/gemini-3.8-flash");
  assert.equal(res.status, 504);
});

test("disarm propagation through derived signals is one-shot and ignores unrelated signals", () => {
  let disarms = 0;
  const source = new AbortController().signal;
  registerComboTargetTimeoutDisarm(source, () => disarms++);

  const derived = mergeAbortSignals(source, new AbortController().signal);
  const twiceDerived = new AbortController().signal;
  propagateComboTargetTimeoutDisarm(twiceDerived, derived, null);
  disarmComboTargetTimeout(twiceDerived);
  assert.equal(disarms, 1);
  disarmComboTargetTimeout(twiceDerived);
  assert.equal(disarms, 1, "one-shot per signal");

  const unrelated = new AbortController().signal;
  const derivedUnregistered = new AbortController().signal;
  propagateComboTargetTimeoutDisarm(derivedUnregistered, unrelated);
  disarmComboTargetTimeout(derivedUnregistered);
  disarmComboTargetTimeout(null);
  assert.equal(disarms, 1);
});

test("fetchWithFirstByteDeadline disarms the caller's combo target timeout on first data", async () => {
  let disarmed = false;
  const runner = buildTargetTimeoutRunner({
    comboTargetTimeoutMs: 40,
    log: { warn() {}, info() {}, error() {}, debug() {} },
    handleSingleModel: async (_b, _m, target) => {
      const signal = (target as { modelAbortSignal: AbortSignal }).modelAbortSignal;
      const { fetchImpl } = scriptedFetch([() => sseResponse('data: {"a":1}\n\n')]);
      const { response } = await fetchWithFirstByteDeadline({
        ...baseOptions,
        fetchImpl,
        signal,
        timeoutMs: 1000,
        maxAttempts: 1,
        totalBudgetMs: 1000,
      });
      await readAll(response);
      await new Promise((r) => setTimeout(r, 70)); // past the 40ms target timeout
      disarmed = !signal.aborted;
      return new Response("done", { status: 200 });
    },
  });
  const res = await runner({}, "gemini-cli/gemini-3.8-flash");
  assert.equal(res.status, 200);
  assert.equal(disarmed, true);
});

test("combo + upstream-start timeouts: stream:false gemini-cli disarms both on first SSE data", async (t) => {
  withFirstByteEnv(t, {
    GEMINI_CLI_FIRST_BYTE_TIMEOUT_MS: "1000",
    GEMINI_CLI_FIRST_BYTE_MAX_ATTEMPTS: "1",
  });
  const sseChunk = (text: string, finishReason?: string) =>
    `data: ${JSON.stringify({
      response: {
        candidates: [{ content: { parts: [{ text }] }, ...(finishReason ? { finishReason } : {}) }],
      },
    })}\n\n`;
  globalThis.fetch = (async () => {
    const s = controlledStream();
    setTimeout(() => s.push(sseChunk("hello ")), 5); // first data well inside both timers
    setTimeout(() => {
      s.push(sseChunk("world", "STOP")); // past both 40ms timers
      s.close();
    }, 90);
    return sseResponse(s.stream);
  }) as typeof fetch;

  const executor = new GeminiCliExecutor();
  const runner = buildTargetTimeoutRunner({
    comboTargetTimeoutMs: 40,
    log: { warn() {}, info() {}, error() {}, debug() {} },
    handleSingleModel: async (_b, _m, target) => {
      const targetSignal = (target as { modelAbortSignal: AbortSignal }).modelAbortSignal;
      // chat.ts merges the target signal into clientRawRequest.signal before dispatch.
      const clientSignal = mergeAbortSignals(new AbortController().signal, targetSignal);
      const result = await executeWithUpstreamStartTimeout({
        executor,
        provider: "gemini-cli",
        model: "gemini-3.5-flash",
        connectionTimeoutMs: 40,
        signal: clientSignal,
        execute: (signal) =>
          executor.execute({
            model: "gemini-3.5-flash",
            body: { messages: [{ role: "user", content: "slow second chunk" }] },
            stream: false,
            credentials: { apiKey: "k", projectId: "test-proj" },
            signal,
            skipUpstreamRetry: true,
            log: { info() {}, warn() {} },
          }),
      });
      return (result as { response: Response }).response;
    },
  });

  const res = await runner({}, "gemini-cli/gemini-3.5-flash");
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.equal(json.choices?.[0]?.message?.content, "hello world");
});
