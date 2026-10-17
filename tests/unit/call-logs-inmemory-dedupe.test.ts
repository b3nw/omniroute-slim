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
const { findCompletedDetailForCallLog, storeCompletedDetail, clearCompletedDetails } =
  await import("../../src/lib/usage/completedRequestDetails.ts");
const { buildCallLogListRows, rowMatchesFilter } =
  await import("../../src/app/api/usage/call-logs/route.ts");

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
  // by correlation key, fallback matches even when detail has a callLogId (e.g. traceId) differing from persisted SQLite UUID
  assert.equal(
    findCompletedDetailForCallLog("other1", {
      correlationId: "corr-detail",
      model: "gpt-4o",
      provider: "openai",
    })?.id,
    linkedId
  );
  // never matched on a null correlation
  assert.equal(
    findCompletedDetailForCallLog("zzz999", { correlationId: null, model: "claude" }),
    undefined
  );
  usageHistory.clearPendingRequests();
});

test("(a) in-memory copy with callLogId (traceId) differing from persisted SQLite UUID is dropped via correlation fallback", () => {
  const sqliteUuid = "uuid-sqlite-12345";
  const traceId = "trace-chatcore-67890";
  const rows = buildCallLogListRows({
    logs: [persisted(sqliteUuid, "corr-uuid-mismatch")],
    connections: [],
    pendingDetails: [],
    completedDetails: [
      completed(`${now - 3_000}-fedcba`, "corr-uuid-mismatch", { callLogId: traceId }),
    ],
    now,
  });

  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, sqliteUuid);
  assert.equal(rows[0].completed, undefined);
});

test("(b) combo retry attempts with distinct SQLite UUIDs and traceIds are both deduplicated correctly", () => {
  const rows = buildCallLogListRows({
    logs: [
      persisted("sqlite-attempt-1", "corr-combo-retry", { status: 429 }),
      persisted("sqlite-attempt-2", "corr-combo-retry", { status: 200 }),
    ],
    connections: [],
    pendingDetails: [],
    completedDetails: [
      completed(`${now - 3_000}-aaaaaa`, "corr-combo-retry", {
        callLogId: "trace-attempt-1",
        status: 429,
      }),
      completed(`${now - 2_500}-bbbbbb`, "corr-combo-retry", {
        callLogId: "trace-attempt-2",
        status: 200,
      }),
    ],
    now,
  });

  assert.deepEqual(rows.map((r: any) => r.id).sort(), ["sqlite-attempt-1", "sqlite-attempt-2"]);
  assert.ok(rows.every((r: any) => r.completed === undefined));
});

test("(b) an unwritten retry preceding an exactly linked completed detail is preserved when only the second attempt is persisted", () => {
  const rows = buildCallLogListRows({
    logs: [persisted("retry2", "corr-order", { status: 200 })],
    connections: [],
    pendingDetails: [],
    completedDetails: [
      completed(`${now - 3_000}-aaaaaa`, "corr-order", { callLogId: "retry1", status: 429 }),
      completed(`${now - 2_500}-bbbbbb`, "corr-order", { callLogId: "retry2" }),
    ],
    now,
  });

  assert.deepEqual(rows.map((r: any) => r.id).sort(), [`${now - 3_000}-aaaaaa`, "retry2"]);
});

test("(b) dedupe accepts single-use iterators for completed details", () => {
  const details = new Map([
    ["c1", completed("c1", "corr-iter", { callLogId: "trace-1", status: 429 })],
    ["c2", completed("c2", "corr-iter", { callLogId: "persisted-2" })],
  ]);
  const rows = buildCallLogListRows({
    logs: [persisted("persisted-2", "corr-iter")],
    connections: [],
    pendingDetails: [],
    completedDetails: details.values(),
    now,
  });

  assert.deepEqual(rows.map((r: any) => r.id).sort(), ["c1", "persisted-2"]);
});

test("findCompletedDetailForCallLog disambiguates retry attempts sharing a correlation key", () => {
  usageHistory.clearPendingRequests();
  clearCompletedDetails();
  const key = { correlationId: "corr-ambig", model: "gpt-4o", provider: "openai" };
  storeCompletedDetail(
    completed("mem-attempt-1", "corr-ambig", { callLogId: "trace-1", status: 429 }) as any
  );
  storeCompletedDetail(
    completed("mem-attempt-2", "corr-ambig", { callLogId: "trace-2", status: 200 }) as any
  );

  // exact callLogId still wins
  assert.equal(findCompletedDetailForCallLog("trace-2", key)?.id, "mem-attempt-2");
  // ambiguous correlation narrowed by persisted status
  assert.equal(
    findCompletedDetailForCallLog("uuid-2", { ...key, status: 200 })?.id,
    "mem-attempt-2"
  );
  assert.equal(
    findCompletedDetailForCallLog("uuid-1", { ...key, status: 429 })?.id,
    "mem-attempt-1"
  );
  // ambiguous without status, or with a status matching no/several attempts, is declined
  assert.equal(findCompletedDetailForCallLog("uuid-x", key), undefined);
  assert.equal(findCompletedDetailForCallLog("uuid-x", { ...key, status: 500 }), undefined);
  storeCompletedDetail(
    completed("mem-attempt-3", "corr-ambig", { callLogId: "trace-3", status: 200 }) as any
  );
  assert.equal(findCompletedDetailForCallLog("uuid-y", { ...key, status: 200 }), undefined);
  clearCompletedDetails();
});

test("(b) a status-filtered 429 → 200 retry pairs the persisted 200 with the in-memory 200, not the earlier 429", () => {
  // `status=ok` returns only the persisted 200; both completed attempts have decoupled ids.
  const rows = buildCallLogListRows({
    logs: [persisted("sqlite-200", "corr-status", { status: 200 })],
    connections: [],
    pendingDetails: [],
    completedDetails: [
      completed(`${now - 3_000}-aaaaaa`, "corr-status", { callLogId: "trace-1", status: 429 }),
      completed(`${now - 2_500}-bbbbbb`, "corr-status", { callLogId: "trace-2", status: 200 }),
    ],
    now,
  });

  // the 429 is not consumed by the 200 row; the in-memory 200 is
  assert.deepEqual(rows.map((r: any) => r.id).sort(), [`${now - 3_000}-aaaaaa`, "sqlite-200"]);
  const ok = rows.filter((r: any) => rowMatchesFilter(r, { status: "ok" }));
  assert.deepEqual(
    ok.map((r: any) => r.id),
    ["sqlite-200"]
  );
});

test("findCompletedDetailForCallLog declines a singleton correlation candidate with a different status", () => {
  usageHistory.clearPendingRequests();
  clearCompletedDetails();
  const key = { correlationId: "corr-single", model: "gpt-4o", provider: "openai" };
  // the cached 429 attempt has expired; only the 200 attempt remains
  storeCompletedDetail(
    completed("mem-attempt-200", "corr-single", { callLogId: "trace-200", status: 200 }) as any
  );

  assert.equal(findCompletedDetailForCallLog("uuid-429", { ...key, status: 429 }), undefined);
  assert.equal(
    findCompletedDetailForCallLog("uuid-200", { ...key, status: 200 })?.id,
    "mem-attempt-200"
  );
  clearCompletedDetails();
});

test("findCompletedDetailForCallLog declines a singleton correlation candidate whose timestamp indicates a different retry attempt", () => {
  usageHistory.clearPendingRequests();
  clearCompletedDetails();
  const key = { correlationId: "corr-time", model: "gpt-4o", provider: "openai", status: 200 };
  // attempt 1 has expired from the cache; only attempt 2 (same key and status) remains
  storeCompletedDetail(
    completed("mem-attempt-2", "corr-time", { callLogId: "trace-2", status: 200 }) as any
  );

  assert.equal(
    findCompletedDetailForCallLog("uuid-1", {
      ...key,
      timestamp: new Date(now - 30_000).toISOString(),
    }),
    undefined
  );
  assert.equal(
    findCompletedDetailForCallLog("uuid-1", { ...key, timestamp: now - 30_000 }),
    undefined
  );
  assert.equal(
    findCompletedDetailForCallLog("uuid-2", {
      ...key,
      timestamp: new Date(now - 1_000).toISOString(),
    })?.id,
    "mem-attempt-2"
  );
  clearCompletedDetails();
});
