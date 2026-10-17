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

test("(b) a same-status retry with decoupled ids keeps the unwritten attempt, not a second copy of the persisted one", () => {
  // Attempt 1 (429) is persisted under a SQLite UUID; attempt 2 (also 429) is not yet
  // written. Both in-memory details carry trace ids that match no persisted row, and the
  // unwritten attempt is ordered first.
  const common = { correlationId: "retry", model: "gpt-4o", provider: "openai", status: 429 };
  const rows = buildCallLogListRows({
    logs: [{ ...common, id: "sqlite-first", timestamp: new Date(now - 3_000).toISOString() }],
    connections: [],
    pendingDetails: [],
    completedDetails: [
      {
        ...common,
        id: "mem-second",
        callLogId: "trace-second",
        startedAt: now - 1_000,
        completedAt: now - 500,
      },
      {
        ...common,
        id: "mem-first",
        callLogId: "trace-first",
        startedAt: now - 4_000,
        completedAt: now - 3_000,
      },
    ],
    now,
  });

  assert.deepEqual(rows.map((r: any) => r.id).sort(), ["mem-second", "sqlite-first"]);
  assert.equal(rows.find((r: any) => r.id === "mem-second")?.detailState, "in-memory");
});

test("(b) same-status retries with overlapping pairing windows are all deduplicated", () => {
  // Persisted rows at T and T+1.9s, completed details at T+1s and T+3s. Closest-first
  // greedy pairs the T+1s detail with the T+1.9s row (900ms) and strands the T+3s
  // detail; a maximum-cardinality matching pairs T+1s↔T and T+3s↔T+1.9s.
  const T = now - 10_000;
  const common = { correlationId: "overlap", model: "gpt-4o", provider: "openai", status: 200 };
  const rows = buildCallLogListRows({
    logs: [
      { ...common, id: "sqlite-a", timestamp: new Date(T).toISOString() },
      { ...common, id: "sqlite-b", timestamp: new Date(T + 1_900).toISOString() },
    ],
    connections: [],
    pendingDetails: [],
    completedDetails: [
      {
        ...common,
        id: "mem-a",
        callLogId: "trace-a",
        startedAt: T - 500,
        completedAt: T + 1_000,
      },
      {
        ...common,
        id: "mem-b",
        callLogId: "trace-b",
        startedAt: T + 1_500,
        completedAt: T + 3_000,
      },
    ],
    now,
  });

  assert.equal(rows.filter((r: any) => r.completed).length, 0);
  assert.deepEqual(rows.map((r: any) => r.id).sort(), ["sqlite-a", "sqlite-b"]);
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

  // each attempt matches directly by its own callLogId
  assert.equal(findCompletedDetailForCallLog("trace-1", key)?.id, "mem-attempt-1");
  assert.equal(findCompletedDetailForCallLog("trace-2", key)?.id, "mem-attempt-2");
  // attempts linked to their own callLogId are never borrowed via correlation fallback,
  // even when the persisted status singles one out
  assert.equal(findCompletedDetailForCallLog("uuid-2", { ...key, status: 200 }), undefined);
  assert.equal(findCompletedDetailForCallLog("uuid-1", { ...key, status: 429 }), undefined);
  assert.equal(findCompletedDetailForCallLog("uuid-x", key), undefined);
  clearCompletedDetails();

  // unlinked details: ambiguous correlation narrowed by persisted status
  storeCompletedDetail(completed("mem-legacy-1", "corr-ambig", { status: 429 }) as any);
  storeCompletedDetail(completed("mem-legacy-2", "corr-ambig", { status: 200 }) as any);
  assert.equal(
    findCompletedDetailForCallLog("uuid-2", { ...key, status: 200 })?.id,
    "mem-legacy-2"
  );
  assert.equal(
    findCompletedDetailForCallLog("uuid-1", { ...key, status: 429 })?.id,
    "mem-legacy-1"
  );
  // ambiguous without status, or with a status matching no/several attempts, is declined
  assert.equal(findCompletedDetailForCallLog("uuid-x", key), undefined);
  assert.equal(findCompletedDetailForCallLog("uuid-x", { ...key, status: 500 }), undefined);
  storeCompletedDetail(completed("mem-legacy-3", "corr-ambig", { status: 200 }) as any);
  assert.equal(findCompletedDetailForCallLog("uuid-y", { ...key, status: 200 }), undefined);
  clearCompletedDetails();
});

test("findCompletedDetailForCallLog matches a detail whose callLogId is the persisted correlationId (traceId)", () => {
  usageHistory.clearPendingRequests();
  clearCompletedDetails();
  const key = { correlationId: "trace-std", model: "gpt-4o", provider: "openai" };
  storeCompletedDetail(completed("mem-std", "trace-std", { callLogId: "trace-std" }) as any);
  assert.equal(findCompletedDetailForCallLog("uuid-std", key)?.id, "mem-std");
  // an exact callLogId match on the row id still takes precedence
  storeCompletedDetail(completed("mem-exact", "trace-std", { callLogId: "uuid-std" }) as any);
  assert.equal(findCompletedDetailForCallLog("uuid-std", key)?.id, "mem-exact");
  clearCompletedDetails();
});

test("findCompletedDetailForCallLog does not borrow a surviving retry's payloads for an expired attempt", () => {
  usageHistory.clearPendingRequests();
  clearCompletedDetails();
  // attempt 1 (same key, status, and time window) has expired; only attempt 2 remains
  const key = {
    correlationId: "corr-expired",
    model: "gpt-4o",
    provider: "openai",
    status: 200,
    timestamp: new Date(now - 1_000).toISOString(),
  };
  storeCompletedDetail(
    completed("mem-attempt-2", "corr-expired", { callLogId: "trace-2", status: 200 }) as any
  );
  assert.equal(findCompletedDetailForCallLog("uuid-1", key), undefined);
  assert.equal(findCompletedDetailForCallLog("trace-2", key)?.id, "mem-attempt-2");
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
  // the cached 429 attempt has expired; only the (unlinked) 200 attempt remains
  storeCompletedDetail(completed("mem-attempt-200", "corr-single", { status: 200 }) as any);

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
  // attempt 1 has expired from the cache; only unlinked attempt 2 (same key and status) remains
  storeCompletedDetail(completed("mem-attempt-2", "corr-time", { status: 200 }) as any);

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

test("findCompletedDetailForCallLog declines a candidate with missing/unknown status when persisted status is a failure (e.g. 429)", () => {
  usageHistory.clearPendingRequests();
  clearCompletedDetails();
  const key = { correlationId: "corr-unknown", model: "gpt-4o", provider: "openai" };
  // the cached 429 attempt has expired; only a status-less 200 attempt remains
  storeCompletedDetail(
    completed("mem-attempt-ok", "corr-unknown", {
      status: undefined,
      clientResponse: { choices: [{ message: { content: "ok" } }] },
    }) as any
  );
  assert.equal(findCompletedDetailForCallLog("uuid-429", { ...key, status: 429 }), undefined);
  // a response payload resolves the unknown status to 200
  assert.equal(
    findCompletedDetailForCallLog("uuid-ok", { ...key, status: 200 })?.id,
    "mem-attempt-ok"
  );
  clearCompletedDetails();

  // no status, no error, no payload: unknown status never matches a known persisted status
  storeCompletedDetail(
    completed("mem-attempt-unknown", "corr-unknown", { status: undefined }) as any
  );
  assert.equal(findCompletedDetailForCallLog("uuid-429", { ...key, status: 429 }), undefined);
  assert.equal(findCompletedDetailForCallLog("uuid-200", { ...key, status: 200 }), undefined);
  clearCompletedDetails();
});

test("(b) buildCallLogListRows declines an in-memory detail with unknown/missing status against a known persisted status", () => {
  const common = { correlationId: "corr-status-unknown", model: "gpt-4o", provider: "openai" };
  const rows = buildCallLogListRows({
    logs: [
      { ...common, id: "sqlite-200", status: 200, timestamp: new Date(now - 1_000).toISOString() },
    ],
    connections: [],
    pendingDetails: [],
    completedDetails: [
      {
        ...common,
        id: "mem-unknown",
        callLogId: "trace-unknown",
        status: undefined,
        startedAt: now - 1_500,
        completedAt: now - 1_000,
      },
    ],
    now,
  });

  // Unknown detail status must not consume the persisted 200 row; both must remain.
  assert.deepEqual(rows.map((r: any) => r.id).sort(), ["mem-unknown", "sqlite-200"]);
  assert.equal(rows.find((r: any) => r.id === "mem-unknown")?.detailState, "in-memory");
});

test("(b) buildCallLogListRows preserves detail lookup for correlation-deduplicated rows", () => {
  clearCompletedDetails();
  const common = {
    correlationId: "corr-detail-lookup",
    model: "gpt-4o",
    provider: "openai",
    status: 200,
  };
  const sqliteUuid = "uuid-sqlite-preserved";
  const traceId = "trace-chatcore-preserved";
  const detailObj = completed("mem-preserved", "corr-detail-lookup", {
    callLogId: traceId,
    status: 200,
    clientRequest: { prompt: "hello" },
    clientResponse: { text: "world" },
  });
  storeCompletedDetail(detailObj as any);

  const rows = buildCallLogListRows({
    logs: [
      { ...common, id: sqliteUuid, timestamp: new Date(now - 1_000).toISOString() },
    ],
    connections: [],
    pendingDetails: [],
    completedDetails: [detailObj],
    now,
  });

  // The in-memory duplicate is suppressed from the list
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, sqliteUuid);

  // Detail lookup for the surviving persisted row must find the paired in-memory detail
  const found = findCompletedDetailForCallLog(sqliteUuid, {
    correlationId: "corr-detail-lookup",
    model: "gpt-4o",
    provider: "openai",
    status: 200,
  });
  assert.ok(found);
  assert.equal(found.id, "mem-preserved");
  assert.deepEqual(found.clientRequest, { prompt: "hello" });
  clearCompletedDetails();
});
