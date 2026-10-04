import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Regression coverage for the in-memory/persisted call-log dedupe after #13481 keyed
// persisted call_logs rows on the chatCore traceId instead of the pending-request id.
// The in-memory completed detail keeps the pending id (`${now}-${uuid6}`), so the
// id-only dedupe in buildCallLogListRows never matched and every request rendered a
// phantom second row sharing its correlationId ("· 2 attempts").
//
// The pre-existing dedupe test in call-logs-correlation-sort.test.ts gives the
// persisted row and the in-memory detail the same id (`dup-1`), which is why it could
// not catch this: in production the two ids are now always different.

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-calllog-dedupe-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const core = await import("../../src/lib/db/core.ts");
const usageHistory = await import("../../src/lib/usage/usageHistory.ts");
const { findCompletedDetailForCallLog } =
  await import("../../src/lib/usage/completedRequestDetails.ts");
const { buildCallLogListRows } = await import("../../src/app/api/usage/call-logs/route.ts");

test.after(() => {
  usageHistory.clearPendingRequests();
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

const now = 5_000_000;

function persisted(id: string, correlationId: string | null, extra: Record<string, unknown> = {}) {
  return {
    id,
    timestamp: new Date(now - 1_000).toISOString(),
    status: 200,
    model: "gpt-4o",
    provider: "openai",
    connectionId: "conn-1",
    correlationId,
    ...extra,
  };
}

function completed(id: string, correlationId: string | null, extra: Record<string, unknown> = {}) {
  return {
    id,
    startedAt: now - 3_000,
    completedAt: now - 2_000,
    status: 200,
    model: "gpt-4o",
    provider: "openai",
    connectionId: "conn-1",
    correlationId,
    ...extra,
  };
}

test("(a) in-memory copy with a different id but same correlation/model/provider is dropped", () => {
  const rows = buildCallLogListRows({
    logs: [persisted("a1b2c3", "corr-1")],
    connections: [],
    pendingDetails: [],
    completedDetails: [completed(`${now - 3_000}-d4e5f6`, "corr-1")],
    now,
  });

  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, "a1b2c3");
  assert.equal(rows[0].completed, undefined);
});

test("(a) correlation fallback ignores connectionId (account rotated after start)", () => {
  const rows = buildCallLogListRows({
    logs: [persisted("a1b2c3", "corr-rot", { connectionId: "conn-rotated" })],
    connections: [],
    pendingDetails: [],
    completedDetails: [completed(`${now - 3_000}-d4e5f6`, "corr-rot", { connectionId: "conn-1" })],
    now,
  });

  assert.deepEqual(
    rows.map((r: any) => r.id),
    ["a1b2c3"]
  );
});

test("(a) in-memory copy carrying callLogId is dropped when that persisted row exists", () => {
  const rows = buildCallLogListRows({
    logs: [persisted("a1b2c3", "corr-1")],
    connections: [],
    pendingDetails: [],
    completedDetails: [completed(`${now - 3_000}-d4e5f6`, "corr-1", { callLogId: "a1b2c3" })],
    now,
  });

  assert.deepEqual(
    rows.map((r: any) => r.id),
    ["a1b2c3"]
  );
});

test("(b) two persisted rows sharing a correlationId (a real retry) are both returned", () => {
  const rows = buildCallLogListRows({
    logs: [
      persisted("retry1", "corr-retry", { status: 429 }),
      persisted("retry2", "corr-retry", { status: 200 }),
    ],
    connections: [],
    pendingDetails: [],
    completedDetails: [
      completed(`${now - 3_000}-aaaaaa`, "corr-retry", { callLogId: "retry1", status: 429 }),
      completed(`${now - 2_500}-bbbbbb`, "corr-retry", { callLogId: "retry2" }),
    ],
    now,
  });

  assert.deepEqual(rows.map((r: any) => r.id).sort(), ["retry1", "retry2"]);
  assert.ok(rows.every((r: any) => r.completed === undefined));
});

test("(b) a retry whose own persisted row is not written yet keeps its in-memory row", () => {
  const rows = buildCallLogListRows({
    logs: [persisted("retry1", "corr-retry", { status: 429 })],
    connections: [],
    pendingDetails: [],
    completedDetails: [
      completed(`${now - 3_000}-aaaaaa`, "corr-retry", { callLogId: "retry1", status: 429 }),
      completed(`${now - 2_500}-bbbbbb`, "corr-retry", { callLogId: "retry2" }),
    ],
    now,
  });

  assert.deepEqual(rows.map((r: any) => r.id).sort(), [`${now - 2_500}-bbbbbb`, "retry1"]);
});

test("(c) rows with a null correlationId and differing ids are both returned", () => {
  const rows = buildCallLogListRows({
    logs: [persisted("p-null", null)],
    connections: [],
    pendingDetails: [],
    completedDetails: [completed(`${now - 3_000}-cccccc`, null)],
    now,
  });

  assert.deepEqual(rows.map((r: any) => r.id).sort(), [`${now - 3_000}-cccccc`, "p-null"]);
});

test("(d) an in-flight row is still returned alongside its correlation group", () => {
  const rows = buildCallLogListRows({
    logs: [persisted("first", "corr-live", { status: 429 })],
    connections: [],
    pendingDetails: [
      {
        id: `${now - 500}-eeeeee`,
        startedAt: now - 500,
        model: "gpt-4o",
        provider: "openai",
        connectionId: "conn-2",
        correlationId: "corr-live",
        callLogId: "second",
      },
    ],
    completedDetails: [completed(`${now - 3_000}-dddddd`, "corr-live", { status: 429 })],
    now,
  });

  assert.deepEqual(
    rows.map((r: any) => r.id),
    [`${now - 500}-eeeeee`, "first"]
  );
  assert.equal(rows[0].active, true);
});

test("trackPendingRequest carries callLogId through finalize so the list dedupe matches", () => {
  usageHistory.clearPendingRequests();
  const pendingId = usageHistory.trackPendingRequest("gpt-4o", "openai", "conn-1", true, {
    correlationId: "corr-real",
    callLogId: "f00baa",
  });
  assert.ok(pendingId);
  assert.notEqual(pendingId, "f00baa");
  assert.equal(usageHistory.finalizePendingRequestById(pendingId, { status: 200 }), true);

  const detail = usageHistory.getCompletedDetails().get(pendingId!);
  assert.equal(detail?.callLogId, "f00baa");

  const rows = buildCallLogListRows({
    logs: [persisted("f00baa", "corr-real")],
    connections: [],
    pendingDetails: usageHistory.getPendingById().values(),
    completedDetails: usageHistory.getCompletedDetails().values(),
    now,
  });
  assert.deepEqual(
    rows.map((r: any) => r.id),
    ["f00baa"]
  );
  usageHistory.clearPendingRequests();
});

test("findCompletedDetailForCallLog resolves a persisted row to its in-memory detail", () => {
  usageHistory.clearPendingRequests();
  const linkedId = usageHistory.trackPendingRequest("gpt-4o", "openai", "conn-1", true, {
    correlationId: "corr-detail",
    callLogId: "abc123",
  });
  usageHistory.finalizePendingRequestById(linkedId, { status: 200 });
  const legacyId = usageHistory.trackPendingRequest("claude", "anthropic", "conn-2", true, {
    correlationId: "corr-legacy",
  });
  usageHistory.finalizePendingRequestById(legacyId, { status: 200 });

  // by in-memory id
  assert.equal(findCompletedDetailForCallLog(linkedId!)?.id, linkedId);
  // by callLogId (persisted id)
  assert.equal(findCompletedDetailForCallLog("abc123")?.id, linkedId);
  // by correlation key, for a detail without callLogId
  assert.equal(
    findCompletedDetailForCallLog("zzz999", {
      correlationId: "corr-legacy",
      model: "claude",
      provider: "anthropic",
    })?.id,
    legacyId
  );
  // a detail with a different callLogId belongs to another attempt — not matched
  assert.equal(
    findCompletedDetailForCallLog("other1", {
      correlationId: "corr-detail",
      model: "gpt-4o",
      provider: "openai",
    }),
    undefined
  );
  // never matched on a null correlation
  assert.equal(
    findCompletedDetailForCallLog("zzz999", { correlationId: null, model: "claude" }),
    undefined
  );
  usageHistory.clearPendingRequests();
});
