// #15481: a native Codex turn pin must allow same-model failover to another
// active account and must never resurrect a disabled/removed pinned account.
import { test } from "node:test";
import assert from "node:assert/strict";

import { applyNativeCodexTurnPin } from "../../open-sse/services/combo/nativeCodexTurnPin.ts";
import type { ResolvedComboTarget } from "../../open-sse/services/combo/types.ts";

function makeTarget(connectionId: string | null): ResolvedComboTarget {
  return {
    kind: "model",
    stepId: `step-${connectionId ?? "dynamic"}`,
    executionKey: `ek-${connectionId ?? "dynamic"}`,
    modelStr: "gpt-5.6-sol",
    provider: "codex",
    providerId: null,
    connectionId,
    weight: 1,
    label: null,
  };
}

function makePin(connectionId: string) {
  return {
    comboName: "test",
    modelStr: "gpt-5.6-sol",
    provider: "codex",
    connectionId,
    createdAt: 0,
    expiresAt: Date.now() + 60_000,
  };
}

test("a dynamic target expands into one target per eligible active connection", () => {
  const dynamic = makeTarget(null);
  const result = applyNativeCodexTurnPin([dynamic], makePin("conn-b"), ["conn-a", "conn-b"]);

  assert.deepEqual(
    result.map((t) => t.connectionId),
    ["conn-b", "conn-a"],
    "pinned connection first, active sibling kept as same-model failover"
  );
  assert.deepEqual(
    result.map((t) => t.executionKey),
    ["ek-dynamic@conn-b", "ek-dynamic@conn-a"]
  );
  for (const target of result) {
    assert.deepEqual(target.allowedConnectionIds, ["conn-a", "conn-b"]);
  }
});

test("dynamic expansion respects the target's own allowedConnectionIds", () => {
  const dynamic = { ...makeTarget(null), allowedConnectionIds: ["conn-a"] };
  const result = applyNativeCodexTurnPin([dynamic], makePin("conn-a"), ["conn-a", "conn-b"]);

  assert.deepEqual(
    result.map((t) => t.connectionId),
    ["conn-a"]
  );
  assert.deepEqual(result[0].allowedConnectionIds, ["conn-a"]);
});

test("a pin absent from the active pool is not resurrected onto candidate[0]", () => {
  const healthy = makeTarget("healthy");
  const result = applyNativeCodexTurnPin([healthy], makePin("disabled"));

  assert.deepEqual(
    result.map((t) => t.connectionId),
    ["healthy"],
    "the healthy sibling survives and keeps its connection"
  );
  assert.ok(!result.some((t) => t.allowedConnectionIds?.includes("disabled")));
});

test("a removed pin keeps the healthy dynamic pool in its original order", () => {
  const dynamic = makeTarget(null);
  const result = applyNativeCodexTurnPin([dynamic], makePin("disabled"), ["conn-a", "conn-b"]);

  assert.deepEqual(
    result.map((t) => t.connectionId),
    ["conn-a", "conn-b"]
  );
  assert.ok(!result.some((t) => t.allowedConnectionIds?.includes("disabled")));
});

test("a pin present in the pool is still ordered first", () => {
  const targets = [makeTarget("conn-1"), makeTarget("conn-2"), makeTarget("conn-3")];
  const result = applyNativeCodexTurnPin(targets, makePin("conn-3"));

  assert.deepEqual(
    result.map((t) => t.connectionId),
    ["conn-3", "conn-1", "conn-2"]
  );
});

test("turn affinity cannot widen explicit per-step connection restrictions", () => {
  const targets = ["a", "b"].map((id) => ({ ...makeTarget(id), allowedConnectionIds: [id] }));
  const result = applyNativeCodexTurnPin(targets, makePin("a"));

  assert.deepEqual(
    result.map((t) => t.allowedConnectionIds),
    [["a"], ["b"]]
  );
});
