// Upstream #14530 / #14949 through Slim's retained handleComboChat priority path (Slim keeps the
// pre-dispatch gate inline in combo.ts; upstream's split executeTargetGates.ts does not exist):
//  - an OPEN connection-scoped breaker skips only that connection; a sibling connection on the
//    same provider is still dispatched;
//  - when every target sits behind an OPEN connection breaker the combo answers the named
//    all_targets_cooling_down 503 instead of the generic ALL_TARGETS_SKIPPED.
import test from "node:test";
import assert from "node:assert/strict";
import { handleComboChat } from "../../open-sse/services/combo.ts";
import {
  getCircuitBreaker,
  resetAllCircuitBreakers,
} from "../../src/shared/utils/circuitBreaker.ts";
import { connectionCircuitBreakerName } from "../../open-sse/services/connectionCircuitBreaker.ts";

const silentLog = { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} };
const PROVIDER = "deepseek";

function openConnectionBreaker(connectionId: string) {
  const breaker = getCircuitBreaker(connectionCircuitBreakerName(PROVIDER, connectionId), {
    failureThreshold: 1,
    resetTimeout: 600_000,
  });
  breaker._onFailure();
  assert.equal(breaker.getStatus().state, "OPEN");
}

function comboFor(name: string, connectionIds: string[]) {
  return {
    name,
    strategy: "priority",
    models: connectionIds.map((connectionId, index) => ({
      kind: "model",
      provider: PROVIDER,
      providerId: PROVIDER,
      model: "deepseek-chat",
      connectionId,
      id: `${name}-${index}`,
    })),
  };
}

test.beforeEach(() => resetAllCircuitBreakers());
test.after(() => resetAllCircuitBreakers());

test("an OPEN connection breaker skips only that connection; its sibling still serves", async () => {
  openConnectionBreaker("conn-dead");
  const dispatched: Array<string | null> = [];
  const result = await handleComboChat({
    body: { messages: [{ role: "user", content: "hello" }] },
    combo: comboFor("combo-14530-sibling", ["conn-dead", "conn-live"]),
    handleSingleModel: async (_body, _modelStr, target) => {
      dispatched.push(target?.connectionId ?? null);
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    },
    isModelAvailable: async () => true,
    log: silentLog,
    settings: null,
    relayOptions: null,
    allCombos: null,
  });

  assert.equal(result.status, 200);
  assert.deepEqual(dispatched, ["conn-live"]);
  assert.equal(getCircuitBreaker(PROVIDER).getStatus().state, "CLOSED");
});

test("every connection breaker OPEN → named all_targets_cooling_down 503", async () => {
  openConnectionBreaker("conn-a");
  openConnectionBreaker("conn-b");
  const result = await handleComboChat({
    body: { messages: [{ role: "user", content: "hello" }] },
    combo: comboFor("combo-14949-all-conn-open", ["conn-a", "conn-b"]),
    handleSingleModel: async () => {
      throw new Error("no target may be dispatched");
    },
    isModelAvailable: async () => true,
    log: silentLog,
    settings: null,
    relayOptions: null,
    allCombos: null,
  });

  assert.equal(result.status, 503);
  assert.ok(Number(result.headers.get("Retry-After")) > 0, "Retry-After names the next probe");
  const body = await result.json();
  assert.equal(body.error?.code, "all_targets_cooling_down");
  assert.match(String(body.error?.message), /deepseek\/deepseek-chat: circuit_open \(\d+s\)/);
});
