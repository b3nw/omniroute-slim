/**
 * #12967: the LLMLingua engine's DEFAULT backend (no injected fake) first POSTs
 * prose to the llmlingua-server HTTP sidecar and only falls back to the in-process
 * worker backend when the sidecar is unreachable, errors, or does not shrink.
 *
 * `globalThis.fetch` is stubbed per test. The worker's optional-deps gate is
 * memoized to "absent" (cwd/argv anchors pointed at an empty temp dir) so the
 * fallback is the deterministic fail-open worker path — no model spawn or
 * download, whether or not the optional deps are installed locally.
 */

import { describe, it, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  llmlinguaEngine,
  setLlmlinguaBackend,
} from "../../../open-sse/services/compression/engines/llmlingua/index.ts";
import {
  depsAvailable,
  __resetLlmlinguaWorkerForTests,
} from "../../../open-sse/services/compression/engines/llmlingua/worker.ts";

const PROSE = "The quick brown fox jumps over the lazy dog and then runs into the forest.";
const SHORTER = "quick fox jumps lazy dog runs forest.";

type FetchCall = { url: string; init: RequestInit | undefined };

const originalFetch = globalThis.fetch;
const originalBaseUrl = process.env.LLMLINGUA_BASE_URL;
let calls: FetchCall[] = [];

function stubFetch(handler: (call: FetchCall) => Response | Promise<Response>): void {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const call = { url: String(input), init };
    calls.push(call);
    return handler(call);
  }) as typeof fetch;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function makeBody(): Record<string, unknown> {
  return {
    model: "gpt-4o",
    messages: [
      { role: "system", content: "You are a helpful assistant." },
      { role: "user", content: PROSE },
    ],
  };
}

async function run(stepConfig: Record<string, unknown> = {}) {
  assert.ok(llmlinguaEngine.applyAsync, "engine must expose applyAsync");
  return llmlinguaEngine.applyAsync(makeBody(), { stepConfig: { minTokens: 0, ...stepConfig } });
}

function forceWorkerDepsAbsent(): void {
  __resetLlmlinguaWorkerForTests();
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "llmlingua-sidecar-"));
  const previousCwd = process.cwd();
  const previousArgv1 = process.argv[1];
  try {
    process.chdir(empty);
    process.argv[1] = path.join(empty, "entry.js");
    assert.equal(depsAvailable(), false, "worker deps gate must memoize as absent");
  } finally {
    process.chdir(previousCwd);
    process.argv[1] = previousArgv1;
    fs.rmSync(empty, { recursive: true, force: true });
  }
}

before(() => {
  setLlmlinguaBackend(null);
  forceWorkerDepsAbsent();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  calls = [];
  if (originalBaseUrl === undefined) delete process.env.LLMLINGUA_BASE_URL;
  else process.env.LLMLINGUA_BASE_URL = originalBaseUrl;
});

after(() => {
  globalThis.fetch = originalFetch;
  __resetLlmlinguaWorkerForTests();
});

describe("llmlingua default backend → HTTP sidecar", () => {
  it("POSTs prose and backend options to LLMLINGUA_BASE_URL/compress", async () => {
    process.env.LLMLINGUA_BASE_URL = "http://sidecar.test:9999";
    stubFetch(() => jsonResponse({ text: SHORTER }));

    await run({ compressionRate: 0.4, model: "tinybert" });

    assert.equal(calls.length, 1, "only the non-system prose segment is sent");
    const [call] = calls;
    assert.equal(call.url, "http://sidecar.test:9999/compress");
    assert.equal(call.init?.method, "POST");
    assert.deepEqual(call.init?.headers, { "Content-Type": "application/json" });
    assert.ok(call.init?.signal instanceof AbortSignal, "request carries a timeout signal");
    assert.deepEqual(JSON.parse(String(call.init?.body)), {
      text: PROSE,
      model: "tinybert",
      compressionRate: 0.4,
    });
  });

  it("defaults to http://127.0.0.1:20135 when LLMLINGUA_BASE_URL is unset", async () => {
    delete process.env.LLMLINGUA_BASE_URL;
    stubFetch(() => jsonResponse({ text: SHORTER }));

    await run();

    assert.equal(calls[0]?.url, "http://127.0.0.1:20135/compress");
  });

  it("uses the sidecar's shorter reply as the compressed prose", async () => {
    stubFetch(() => jsonResponse({ text: SHORTER }));

    const result = await run();

    assert.equal(result.compressed, true);
    const messages = result.body.messages as Array<{ role: string; content: string }>;
    assert.equal(messages[0].content, "You are a helpful assistant.", "system untouched");
    assert.equal(messages[1].content, SHORTER);
  });
});

describe("llmlingua sidecar → worker fallback", () => {
  it("falls back to the worker when the sidecar is unreachable", async () => {
    stubFetch(() => {
      throw new TypeError("fetch failed: ECONNREFUSED");
    });

    const result = await run();

    assert.equal(calls.length, 1, "sidecar was attempted first");
    assert.equal(result.compressed, false, "fail-open worker returns the original prose");
    assert.deepEqual(result.body, makeBody());
  });

  it("falls back to the worker when the sidecar returns a non-ok status", async () => {
    stubFetch(() => jsonResponse({ text: SHORTER }, 503));

    const result = await run();

    assert.equal(calls.length, 1);
    assert.equal(result.compressed, false, "a 503 body must not be used");
  });

  it("falls back to the worker when the sidecar reply does not shrink", async () => {
    stubFetch(() => jsonResponse({ text: `${PROSE} padding` }));

    const result = await run();

    assert.equal(calls.length, 1);
    assert.equal(result.compressed, false);
    assert.deepEqual(result.body, makeBody());
  });

  it("falls back to the worker when the sidecar reply has no text field", async () => {
    stubFetch(() => jsonResponse({ error: "model not loaded" }));

    const result = await run();

    assert.equal(calls.length, 1);
    assert.equal(result.compressed, false);
  });
});
