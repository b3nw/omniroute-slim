// Custom compatible provider nodes are routed under their internal
// `provider_nodes.id` (openai-compatible-chat-<uuid>). Log lines and log APIs
// must show the node's configured name/prefix (e.g. INFERX) instead of the raw
// upper-cased uuid id, while built-in and unmatched ids stay unchanged.
import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "omni-provider-log-label-test-"));
process.env.DATA_DIR = testDataDir;

const coreDb = await import("../../src/lib/db/core.ts");
const providersDb = await import("../../src/lib/db/providers.ts");
const {
  resolveProviderLogLabel,
  formatProviderUpperLabel,
  formatModelTargetLogLabel,
  invalidateProviderLogLabelCache,
} = await import("../../src/lib/display/providerLogLabel.ts");
const { formatProxyEgressConsoleLine } = await import("../../src/lib/proxyLogger.ts");
const rateLimitManager = await import("../../open-sse/services/rateLimitManager.ts");
const { logUsage } = await import("../../open-sse/utils/usageTracking.ts");
const { recordNonStreamingUsageStats } =
  await import("../../open-sse/handlers/chatCore/nonStreamingUsageStats.ts");
const { createStreamController } = await import("../../open-sse/utils/streamHandler.ts");
const { getRecentLogs, clearPendingRequests } = await import("../../src/lib/usage/usageHistory.ts");

const NODE_ID = "openai-compatible-chat-ea7d9940-2279-48c8-ab33-8b56cb06e1a9";
const RAW_UPPER = NODE_ID.toUpperCase();

async function seedInferxNode(overrides: Record<string, unknown> = {}) {
  return providersDb.createProviderNode({
    id: NODE_ID,
    type: "openai-compatible",
    name: "inferx",
    prefix: "inferx",
    apiType: "chat",
    baseUrl: "https://inferx.example/v1",
    ...overrides,
  });
}

function captureConsole(fn: () => void): string[] {
  const original = console.log;
  const captured: string[] = [];
  console.log = (...args: unknown[]) => {
    captured.push(args.map(String).join(" "));
  };
  try {
    fn();
  } finally {
    console.log = original;
  }
  return captured;
}

before(() => {
  coreDb.getDbInstance();
});

beforeEach(async () => {
  await providersDb.deleteProviderNode(NODE_ID);
  invalidateProviderLogLabelCache();
});

after(async () => {
  clearPendingRequests();
  await rateLimitManager.__resetRateLimitManagerForTests();
  coreDb.resetDbInstance();
  fs.rmSync(testDataDir, { recursive: true, force: true });
});

test("built-in and empty providers bypass node lookup", () => {
  assert.equal(resolveProviderLogLabel("openai"), "openai");
  assert.equal(resolveProviderLogLabel("trace-prov"), "trace-prov");
  assert.equal(formatProviderUpperLabel("anthropic"), "ANTHROPIC");
  assert.equal(resolveProviderLogLabel(undefined, "fb"), "fb");
  assert.equal(resolveProviderLogLabel("   ", "fb"), "fb");
  assert.equal(formatProviderUpperLabel(null), "UNKNOWN");
  assert.equal(formatProviderUpperLabel("", "-"), "-");
});

test("unmatched compatible ids fall back to the raw id", () => {
  assert.equal(resolveProviderLogLabel("openai-compatible-chat-xyz"), "openai-compatible-chat-xyz");
  assert.equal(
    formatProviderUpperLabel("openai-compatible-chat-xyz"),
    "OPENAI-COMPATIBLE-CHAT-XYZ"
  );
});

test("seeded compatible node resolves to its name (case-insensitive id match)", async () => {
  await seedInferxNode();
  assert.equal(resolveProviderLogLabel(NODE_ID), "inferx");
  assert.equal(resolveProviderLogLabel(RAW_UPPER), "inferx");
  assert.equal(formatProviderUpperLabel(NODE_ID), "INFERX");
});

test("falls back to prefix when the node has no name", async () => {
  await seedInferxNode({ name: "", prefix: "ifx" });
  assert.equal(resolveProviderLogLabel(NODE_ID), "ifx");
});

test("cache is invalidated by provider node create / update / delete", async () => {
  // Prime the cache with the "no node" result.
  assert.equal(resolveProviderLogLabel(NODE_ID), NODE_ID);

  await seedInferxNode();
  assert.equal(resolveProviderLogLabel(NODE_ID), "inferx");

  await providersDb.updateProviderNode(NODE_ID, { name: "inferx-renamed" });
  assert.equal(resolveProviderLogLabel(NODE_ID), "inferx-renamed");

  await providersDb.deleteProviderNode(NODE_ID);
  assert.equal(resolveProviderLogLabel(NODE_ID), NODE_ID);
});

test("logUsage prints the friendly upper-cased node label", async () => {
  await seedInferxNode();
  const lines = captureConsole(() =>
    logUsage(NODE_ID, { prompt_tokens: 3, completion_tokens: 2 }, "m", "conn-12345678")
  );
  const usageLine = lines.find((l) => l.includes("[USAGE]"));
  assert.ok(usageLine);
  assert.match(usageLine as string, /\[USAGE\] INFERX \|/);
  assert.ok(!(usageLine as string).includes(RAW_UPPER));
});

test("non-streaming usage trace line prints the friendly upper-cased node label", async () => {
  await seedInferxNode();
  const lines = captureConsole(() =>
    recordNonStreamingUsageStats({ prompt_tokens: 3, completion_tokens: 2 }, {
      traceEnabled: true,
      provider: NODE_ID,
      connectionId: "conn-12345678abc",
      model: "deepseek-v4-flash",
      startTime: Date.now() - 50,
      apiKeyInfo: null,
      effectiveServiceTier: "standard",
      isCombo: false,
      comboStrategy: null,
    } as Parameters<typeof recordNonStreamingUsageStats>[1])
  );
  const usageLine = lines.find((l) => l.includes("[USAGE]"));
  assert.ok(usageLine);
  assert.match(usageLine as string, /\[USAGE\] INFERX \|/);
});

test("stream controller log line prints the friendly upper-cased node label", async () => {
  await seedInferxNode();
  const lines = captureConsole(() => {
    const controller = createStreamController({ provider: NODE_ID, model: "deepseek-v4-flash" });
    controller.handleComplete();
  });
  const streamLine = lines.find((l) => l.includes("[STREAM]"));
  assert.ok(streamLine);
  assert.match(streamLine as string, /\[STREAM\] INFERX \| deepseek-v4-flash/);
});

test("getRecentLogs returns the friendly upper-cased node label", async () => {
  await seedInferxNode();
  const db = coreDb.getDbInstance();
  db.prepare(
    `INSERT INTO call_logs (id, timestamp, status, model, provider, account, tokens_in, tokens_out)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run("log-1", new Date().toISOString(), 200, "deepseek-v4-flash", NODE_ID, "acct", 5, 7);
  db.prepare(
    `INSERT INTO call_logs (id, timestamp, status, model, provider, account, tokens_in, tokens_out)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run("log-2", new Date(Date.now() - 1000).toISOString(), 200, "gpt-x", "openai", "acct", 1, 1);

  const logs = await getRecentLogs(10);
  assert.ok(logs.some((l: string) => l.includes("| deepseek-v4-flash | INFERX |")));
  assert.ok(logs.some((l: string) => l.includes("| gpt-x | OPENAI |")));
  assert.ok(!logs.some((l: string) => l.includes(RAW_UPPER)));
});

test("requests-by-provider-date rows resolve node ids and merge same-label rows", async () => {
  await seedInferxNode();
  const { buildProviderDailyDisplayRows } =
    await import("../../src/lib/usage/providerDisplayNames.ts");
  const row = (date: string, provider: string, requests: number) => ({
    date,
    provider,
    requests,
    promptTokens: requests * 10,
    completionTokens: requests,
    totalTokens: requests * 11,
  });

  const rows = await buildProviderDailyDisplayRows([
    row("2026-10-30", NODE_ID, 3),
    row("2026-10-30", RAW_UPPER, 2),
    row("2026-10-30", "openai", 4),
    row("2026-10-29", NODE_ID, 1),
  ]);

  assert.deepEqual(
    rows.map((r) => [r.date, r.provider, r.requests, r.totalTokens]),
    [
      ["2026-10-30", "inferx", 5, 55],
      ["2026-10-30", "OpenAI", 4, 44],
      ["2026-10-29", "inferx", 1, 11],
    ]
  );
});

test("formatModelTargetLogLabel resolves only the provider prefix of a target", async () => {
  assert.equal(formatModelTargetLogLabel(undefined, "fb"), "fb");
  assert.equal(formatModelTargetLogLabel("openai/gpt-4o"), "openai/gpt-4o");
  assert.equal(
    formatModelTargetLogLabel(`${NODE_ID}/gemma-4-31B-it-fp8`),
    `${NODE_ID}/gemma-4-31B-it-fp8`
  );

  await seedInferxNode();
  assert.equal(
    formatModelTargetLogLabel(`${NODE_ID}/gemma-4-31B-it-fp8`),
    "inferx/gemma-4-31B-it-fp8"
  );
  // Only the first `/` splits; the rest of the model path is preserved verbatim.
  assert.equal(formatModelTargetLogLabel(`${NODE_ID}/org/model:tag`), "inferx/org/model:tag");
  assert.equal(formatModelTargetLogLabel(NODE_ID), "inferx");
  assert.equal(formatModelTargetLogLabel("/leading-slash"), "/leading-slash");
});

test("[ProxyEgress] console line prints the node label (summary and detailed)", async () => {
  await seedInferxNode();
  const base = {
    provider: NODE_ID,
    account: "acct",
    clientIp: "1.2.3.4",
    egressIp: "5.6.7.8",
    level: "global",
    proxyHost: "proxy.local",
    status: "success",
  };
  assert.equal(formatProxyEgressConsoleLine(base), "[ProxyEgress] inferx status=success");
  assert.match(
    formatProxyEgressConsoleLine({ ...base, includeDetails: true }),
    /^\[ProxyEgress\] inferx\/acct in=1\.2\.3\.4 /
  );
  assert.equal(
    formatProxyEgressConsoleLine({ ...base, provider: null }),
    "[ProxyEgress] - status=success"
  );
});

test("[RATE-LIMIT] 429 console line prints the node label", async () => {
  await seedInferxNode();
  const connectionId = "79875219-aaaa-bbbb-cccc-000000000000";
  rateLimitManager.enableRateLimitProtection(connectionId);
  // rateLimitManager silences its console output inside node:test children.
  const savedCtx = process.env.NODE_TEST_CONTEXT;
  delete process.env.NODE_TEST_CONTEXT;
  let lines: string[];
  try {
    lines = captureConsole(() =>
      rateLimitManager.updateFromHeaders(NODE_ID, connectionId, { "retry-after": "1" }, 429)
    );
  } finally {
    if (savedCtx !== undefined) process.env.NODE_TEST_CONTEXT = savedCtx;
    rateLimitManager.disableRateLimitProtection(connectionId);
  }
  const rlLine = lines.find((l) => l.includes("[RATE-LIMIT]"));
  assert.ok(rlLine, `expected a [RATE-LIMIT] line, got: ${JSON.stringify(lines)}`);
  assert.match(rlLine as string, /\[RATE-LIMIT\] inferx:79875219 — 429 received/);
  assert.ok(!(rlLine as string).includes(NODE_ID));
});
