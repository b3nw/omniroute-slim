import test from "node:test";
import assert from "node:assert/strict";
import { saveCallLog, getCallLogById, normalizeTtftMs } from "../../src/lib/usageDb";

test("normalizeTtftMs unit helper", () => {
  assert.equal(normalizeTtftMs(250), 250);
  assert.equal(normalizeTtftMs(250.7), 251);
  assert.equal(normalizeTtftMs(250.2), 250);
  assert.equal(normalizeTtftMs(0), null);
  assert.equal(normalizeTtftMs(-10), null);
  assert.equal(normalizeTtftMs(null), null);
  assert.equal(normalizeTtftMs(undefined), null);
  assert.equal(normalizeTtftMs(NaN), null);
  assert.equal(normalizeTtftMs(Infinity), null);
  assert.equal(normalizeTtftMs("250"), null);
});

test("call_logs records and retrieves valid ttft_ms", async () => {
  const testId = "test-ttft-valid-" + Date.now();
  await saveCallLog({
    id: testId,
    method: "POST",
    path: "/v1/chat/completions",
    status: 200,
    model: "test-model",
    provider: "test-provider",
    duration: 1500,
    timeToFirstTokenMs: 250.6,
    tokens: { in: 100, out: 50 },
  });

  const entry = await getCallLogById(testId);
  assert.ok(entry, "Entry should be found by id");
  assert.equal(entry.timeToFirstTokenMs, 251, "timeToFirstTokenMs should round 250.6 to 251");
  assert.equal(entry.duration, 1500, "duration should match saved value");
});

test("failed or non-positive streams persist ttft_ms as null", async () => {
  const testIdZero = "test-ttft-zero-" + Date.now();
  await saveCallLog({
    id: testIdZero,
    method: "POST",
    path: "/v1/chat/completions",
    status: 502,
    model: "test-model",
    provider: "test-provider",
    duration: 500,
    timeToFirstTokenMs: 0,
    tokens: { in: 0, out: 0 },
  });

  const entryZero = await getCallLogById(testIdZero);
  assert.ok(entryZero, "Zero-TTFT entry should exist");
  assert.equal(entryZero.timeToFirstTokenMs, null, "ttft 0 should persist as null");

  const testIdNone = "test-ttft-none-" + Date.now();
  await saveCallLog({
    id: testIdNone,
    method: "POST",
    path: "/v1/chat/completions",
    status: 200,
    model: "test-model",
    provider: "test-provider",
    duration: 300,
    tokens: { in: 50, out: 20 },
  });

  const entryNone = await getCallLogById(testIdNone);
  assert.ok(entryNone, "Non-streaming entry should exist");
  assert.equal(entryNone.timeToFirstTokenMs, null, "Non-streaming request should have null TTFT");
});
