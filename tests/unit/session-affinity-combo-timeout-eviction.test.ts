// #6219 follow-up — a COMBO per-model timeout must also evict the sticky session
// pin.
//
// Observed in production: combo "coding" [priority] pinned a session to one codex
// account. That account stalled past comboTargetTimeoutMs, the combo aborted the
// target and synthesized a 524, and — because a stall is not a quota/auth failure —
// nothing called markAccountUnavailable. The #6219 eviction only runs on that
// generic failover path, so the pin survived its full 30-minute TTL and every
// following request in the session was handed straight back to the stalled
// account: four consecutive requests, four 120s timeouts, "all targets exhausted"
// each time, while four sibling codex accounts sat healthy and unused.
//
// The fix classifies the abort reason (open-sse/services/combo/comboAbortReasons.ts)
// and evicts the connection-matched pin from the dispatch site in chat.ts.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-combo-timeout-affinity-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = process.env.API_KEY_SECRET || "combo-timeout-affinity-test-secret";

const core = await import("../../src/lib/db/core.ts");
const affinityDb = await import("../../src/lib/db/sessionAccountAffinity.ts");
const pin = await import("../../src/sse/services/sessionAffinityPin.ts");
const abortReasons = await import("../../open-sse/services/combo/comboAbortReasons.ts");
const { applyComboTargetExhaustion } =
  await import("../../open-sse/services/combo/targetExhaustion.ts");
const providersDb = await import("../../src/lib/db/providers.ts");
const settingsDb = await import("../../src/lib/db/settings.ts");
const apiKeysDb = await import("../../src/lib/db/apiKeys.ts");
const auth = await import("../../src/sse/services/auth.ts");

const PROVIDER = "codex";
const SESSION = "session-combo-timeout";
const STALLED = "conn-stalled";
const HEALTHY = "conn-healthy";
const TTL = 30 * 60_000;

function abortedWith(reason: unknown): AbortSignal {
  const controller = new AbortController();
  controller.abort(reason);
  return controller.signal;
}

const timedOutSignal = () => abortedWith(new Error(abortReasons.COMBO_PER_MODEL_TIMEOUT_REASON));

test.beforeEach(() => {
  core.resetDbInstance();
  apiKeysDb.resetApiKeyState();
  pin.resetSessionAffinityTimeoutStrikesForTests();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
});

test.after(() => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test("evicts the pin when the combo per-model timeout abandons the pinned account", () => {
  affinityDb.upsertSessionAccountAffinity(SESSION, PROVIDER, STALLED, Date.now(), TTL);

  const evicted = pin.evictSessionAffinityOnComboTimeout({
    sessionKey: SESSION,
    provider: PROVIDER,
    connectionId: STALLED,
    modelAbortSignal: timedOutSignal(),
  });

  assert.equal(evicted, true, "a timed-out pinned account must lose its pin");
  assert.equal(
    affinityDb.getSessionAccountAffinity(SESSION, PROVIDER, TTL),
    null,
    "the next request must be free to pick another account"
  );
});

test("leaves the pin intact on a client disconnect", () => {
  affinityDb.upsertSessionAccountAffinity(SESSION, PROVIDER, STALLED, Date.now(), TTL);

  const evicted = pin.evictSessionAffinityOnComboTimeout({
    sessionKey: SESSION,
    provider: PROVIDER,
    connectionId: STALLED,
    modelAbortSignal: abortedWith(new Error("request_signal_aborted")),
  });

  assert.equal(evicted, false, "a client hanging up says nothing about account health");
  assert.equal(
    affinityDb.getSessionAccountAffinity(SESSION, PROVIDER, TTL)?.connectionId,
    STALLED,
    "pin must survive so the session keeps its prompt-cache locality"
  );
});

test("leaves the pin intact when a hedged sibling cancelled this target", () => {
  affinityDb.upsertSessionAccountAffinity(SESSION, PROVIDER, STALLED, Date.now(), TTL);

  const evicted = pin.evictSessionAffinityOnComboTimeout({
    sessionKey: SESSION,
    provider: PROVIDER,
    connectionId: STALLED,
    modelAbortSignal: abortedWith(new Error(abortReasons.COMBO_HEDGE_CANCELLED_REASON)),
  });

  assert.equal(evicted, false, "losing a hedge race is not an account failure");
  assert.equal(affinityDb.getSessionAccountAffinity(SESSION, PROVIDER, TTL)?.connectionId, STALLED);
});

test("leaves the pin intact when the dispatch was never aborted", () => {
  affinityDb.upsertSessionAccountAffinity(SESSION, PROVIDER, STALLED, Date.now(), TTL);

  const evicted = pin.evictSessionAffinityOnComboTimeout({
    sessionKey: SESSION,
    provider: PROVIDER,
    connectionId: STALLED,
    modelAbortSignal: new AbortController().signal,
  });

  assert.equal(evicted, false);
  assert.equal(affinityDb.getSessionAccountAffinity(SESSION, PROVIDER, TTL)?.connectionId, STALLED);
});

test("never evicts a pin that points at a different (healthy) account", () => {
  affinityDb.upsertSessionAccountAffinity(SESSION, PROVIDER, HEALTHY, Date.now(), TTL);

  const evicted = pin.evictSessionAffinityOnComboTimeout({
    sessionKey: SESSION,
    provider: PROVIDER,
    connectionId: STALLED,
    modelAbortSignal: timedOutSignal(),
  });

  assert.equal(evicted, false, "connection-matched guard must hold");
  assert.equal(affinityDb.getSessionAccountAffinity(SESSION, PROVIDER, TTL)?.connectionId, HEALTHY);
});

test("no-ops without a session key or connection id", () => {
  const signal = timedOutSignal();
  assert.equal(
    pin.evictSessionAffinityOnComboTimeout({
      sessionKey: null,
      provider: PROVIDER,
      connectionId: STALLED,
      modelAbortSignal: signal,
    }),
    false
  );
  assert.equal(
    pin.evictSessionAffinityOnComboTimeout({
      sessionKey: SESSION,
      provider: PROVIDER,
      connectionId: null,
      modelAbortSignal: signal,
    }),
    false
  );
});

test("isComboPerModelTimeoutAbort accepts a bare string abort reason", () => {
  assert.equal(
    abortReasons.isComboPerModelTimeoutAbort(
      abortedWith(abortReasons.COMBO_PER_MODEL_TIMEOUT_REASON)
    ),
    true
  );
  assert.equal(abortReasons.isComboPerModelTimeoutAbort(null), false);
});

test("the combo timeout runner aborts with the shared reason constant", () => {
  const src = fs.readFileSync(
    new URL("../../open-sse/services/combo/targetTimeoutRunner.ts", import.meta.url),
    "utf8"
  );
  assert.match(
    src,
    /const abortErr = new Error\(COMBO_PER_MODEL_TIMEOUT_REASON\)/,
    "the runner must construct the shared timeout reason"
  );
  assert.match(
    src,
    /timeoutController\.abort\(abortErr\)/,
    "the runner must abort with that Error so the eviction predicate matches"
  );
});

test("chat.ts routes its upstream dispatch through the eviction-aware seam", () => {
  const src = fs.readFileSync(new URL("../../src/sse/handlers/chat.ts", import.meta.url), "utf8");
  assert.match(
    src,
    /dispatchChatWithAffinityEviction\(/,
    "chat.ts must dispatch through the seam that owns the eviction"
  );
  assert.doesNotMatch(
    src,
    /await executeChatWithBreaker\(/,
    "chat.ts must not bypass the seam by calling executeChatWithBreaker directly"
  );
});

test("the dispatch seam evicts when a dispatch is abandoned", () => {
  const src = fs.readFileSync(
    new URL("../../src/sse/handlers/chatDispatch.ts", import.meta.url),
    "utf8"
  );
  assert.match(
    src,
    /evictSessionAffinityOnComboTimeout\(/,
    "chatDispatch.ts must call the eviction"
  );
});

test("a 504 GEMINI_CLI_FIRST_BYTE_TIMEOUT never evicts the persistent pin", () => {
  affinityDb.upsertSessionAccountAffinity(SESSION, "gemini-cli", STALLED, Date.now(), TTL);
  const firstByteTimeout = { status: 504, errorCode: "GEMINI_CLI_FIRST_BYTE_TIMEOUT" };

  assert.equal(
    pin.isTimeoutEvictionResult(firstByteTimeout),
    true,
    "chat.ts must recognise the transient first-byte 504 and skip pin eviction"
  );

  const evicted = pin.evictSessionAffinityOnComboTimeout({
    sessionKey: SESSION,
    provider: "gemini-cli",
    connectionId: STALLED,
    modelAbortSignal: new AbortController().signal,
  });

  assert.equal(evicted, false, "a transient stall must not drop the cross-turn prompt-cache pin");
  assert.equal(
    affinityDb.getSessionAccountAffinity(SESSION, "gemini-cli", TTL)?.connectionId,
    STALLED
  );
});

test("selectSessionAffinityConnection serves a request-excluded pin's fallback without unpinning", async () => {
  affinityDb.upsertSessionAccountAffinity(SESSION, "gemini-cli", STALLED, Date.now(), TTL);

  const selected = await pin.selectSessionAffinityConnection(
    "gemini-cli",
    SESSION,
    [{ id: HEALTHY }],
    TTL,
    new Set([STALLED])
  );

  assert.equal(selected?.id, HEALTHY, "this request must fall back to the healthy account");
  assert.equal(
    affinityDb.getSessionAccountAffinity(SESSION, "gemini-cli", TTL)?.connectionId,
    STALLED,
    "the persistent pin must survive a per-request exclusion"
  );
});

test("planSessionAffinityConnection commit keeps a request-excluded pin intact", async () => {
  affinityDb.upsertSessionAccountAffinity(SESSION, "gemini-cli", STALLED, Date.now(), TTL);

  const plan = pin.planSessionAffinityConnection(
    "gemini-cli",
    SESSION,
    [{ id: HEALTHY }],
    TTL,
    new Set([STALLED])
  );
  assert.equal(plan?.connection.id, HEALTHY);
  await plan?.commit();

  assert.equal(
    affinityDb.getSessionAccountAffinity(SESSION, "gemini-cli", TTL)?.connectionId,
    STALLED,
    "planned commit must not overwrite the persistent pin"
  );
});

test("leaves the pin intact when the failed result is a client disconnect", () => {
  affinityDb.upsertSessionAccountAffinity(SESSION, PROVIDER, STALLED, Date.now(), TTL);

  const evicted = pin.evictSessionAffinityOnComboTimeout({
    sessionKey: SESSION,
    provider: PROVIDER,
    connectionId: STALLED,
    modelAbortSignal: new AbortController().signal,
    result: { status: 499, errorCode: "client_disconnected" },
  });

  assert.equal(evicted, false);
  assert.equal(affinityDb.getSessionAccountAffinity(SESSION, PROVIDER, TTL)?.connectionId, STALLED);
});

test("a first-byte timeout exhausts the stalled connection for the rest of the combo request", () => {
  const sets = {
    exhaustedProviders: new Set<string>(),
    exhaustedConnections: new Set<string>(),
    transientRateLimitedProviders: new Set<string>(),
  };
  const target = {
    kind: "model",
    executionKey: "ek",
    modelStr: "gemini-cli/gemini-3.8-flash",
    provider: "gemini-cli",
    providerId: null,
    connectionId: STALLED,
  } as Parameters<typeof applyComboTargetExhaustion>[0];

  applyComboTargetExhaustion(target, {
    result: { status: 504 },
    fallbackResult: {} as Parameters<typeof applyComboTargetExhaustion>[1]["fallbackResult"],
    errorText: "Gemini CLI upstream produced no first data event within 12000ms",
    rawModel: "gemini-3.8-flash",
    isTokenLimitBreach: false,
    allAccountsRateLimited: false,
    requestScopedFailure: true,
    sets,
    log: { info() {}, warn() {}, error() {}, debug() {} },
    tag: "COMBO",
    exhaustedLogLevel: "info",
    structuredError: { code: "GEMINI_CLI_FIRST_BYTE_TIMEOUT" },
  });

  assert.ok(sets.exhaustedConnections.has(`gemini-cli:${STALLED}`));
  assert.equal(sets.exhaustedProviders.has("gemini-cli"), false);
});

test("a brand-new session overrides a busy forcedConnectionId with the LRU connection", async () => {
  const EXISTING_SESSION = "session-existing-lru";
  const NEW_SESSION = "session-new-lru";
  const BUSY = "conn-a";
  const IDLE = "conn-b";
  const OLDER = "conn-c";
  affinityDb.upsertSessionAccountAffinity(EXISTING_SESSION, PROVIDER, BUSY, Date.now(), TTL);

  const connections = [
    { id: BUSY, lastUsedAt: "2026-10-20T00:00:00.000Z", consecutiveUseCount: 3, priority: 1 },
    { id: IDLE, lastUsedAt: null, consecutiveUseCount: 0, priority: 2 },
    { id: OLDER, lastUsedAt: "2026-10-01T00:00:00.000Z", consecutiveUseCount: 1, priority: 3 },
  ];

  const overridden = pin.applySessionAffinityPin({
    forcedConnectionId: BUSY,
    options: { sessionKey: NEW_SESSION },
    sessionAffinityTtlMs: TTL,
    connections,
    provider: PROVIDER,
    requestedModel: null,
    excludedConnectionIds: new Set<string>(),
    isTerminalConnectionStatus: () => false,
    isCodexScopeUnavailable: () => false,
    isQuotaPolicyBlocked: () => false,
  });

  assert.equal(overridden, IDLE, "the never-used connection takes the new session");

  const selected = await pin.selectSessionAffinityConnection(
    PROVIDER,
    NEW_SESSION,
    connections.filter((conn) => conn.id === overridden),
    TTL
  );
  assert.equal(selected?.id, IDLE);
  assert.equal(
    affinityDb.getSessionAccountAffinity(NEW_SESSION, PROVIDER, TTL)?.connectionId,
    IDLE,
    "the new session is pinned to the LRU connection"
  );
  assert.equal(
    affinityDb.getSessionAccountAffinity(EXISTING_SESSION, PROVIDER, TTL)?.connectionId,
    BUSY,
    "the existing session keeps its pin"
  );
});

// ── Opportunity 2: evict the pin after 2 consecutive first-byte/target timeouts ──

const GEMINI = "gemini-cli";
const FIRST_BYTE_504 = { status: 504, errorCode: "GEMINI_CLI_FIRST_BYTE_TIMEOUT" };

test("1st first-byte 504 keeps the pin; a success on the same account resets its strikes", () => {
  affinityDb.upsertSessionAccountAffinity(SESSION, GEMINI, STALLED, Date.now(), TTL);
  assert.equal(pin.isTimeoutEvictionResult(FIRST_BYTE_504), true);

  assert.deepEqual(pin.recordSessionAffinityTimeoutStrike(SESSION, GEMINI, STALLED), {
    strikes: 1,
    evicted: false,
  });
  assert.equal(
    affinityDb.getSessionAccountAffinity(SESSION, GEMINI, TTL)?.connectionId,
    STALLED,
    "a single transient stall must keep the cross-turn prompt-cache pin"
  );

  // Next turn: the pinned account itself succeeds.
  pin.clearSessionAffinityTimeoutStrikes(SESSION, GEMINI, STALLED);

  assert.deepEqual(
    pin.recordSessionAffinityTimeoutStrike(SESSION, GEMINI, STALLED),
    { strikes: 1, evicted: false },
    "a later 504 after a success is again only strike 1"
  );
  assert.equal(affinityDb.getSessionAccountAffinity(SESSION, GEMINI, TTL)?.connectionId, STALLED);
});

test("a fallback account's success does not clear the pinned account's strike; 2nd 504 evicts", async () => {
  affinityDb.upsertSessionAccountAffinity(SESSION, GEMINI, STALLED, Date.now(), TTL);

  // Turn 1: STALLED times out, fallback HEALTHY serves the request.
  assert.deepEqual(pin.recordSessionAffinityTimeoutStrike(SESSION, GEMINI, STALLED), {
    strikes: 1,
    evicted: false,
  });
  pin.clearSessionAffinityTimeoutStrikes(SESSION, GEMINI, HEALTHY);
  assert.equal(affinityDb.getSessionAccountAffinity(SESSION, GEMINI, TTL)?.connectionId, STALLED);

  // Turn 2: the pin routes back to STALLED, which times out again.
  assert.deepEqual(pin.recordSessionAffinityTimeoutStrike(SESSION, GEMINI, STALLED), {
    strikes: 2,
    evicted: true,
  });
  assert.equal(
    affinityDb.getSessionAccountAffinity(SESSION, GEMINI, TTL),
    null,
    "two consecutive timeouts on the pinned account must evict the pin"
  );

  const selected = await pin.selectSessionAffinityConnection(
    GEMINI,
    SESSION,
    [{ id: HEALTHY }],
    TTL,
    new Set([STALLED])
  );
  assert.equal(selected?.id, HEALTHY);
  assert.equal(
    affinityDb.getSessionAccountAffinity(SESSION, GEMINI, TTL)?.connectionId,
    HEALTHY,
    "the session re-pins to the healthy account"
  );
});

test("timeout strikes reset when a different connection times out and never evict another pin", () => {
  affinityDb.upsertSessionAccountAffinity(SESSION, GEMINI, HEALTHY, Date.now(), TTL);
  assert.equal(pin.recordSessionAffinityTimeoutStrike(SESSION, GEMINI, STALLED).strikes, 1);
  assert.equal(pin.recordSessionAffinityTimeoutStrike(SESSION, GEMINI, HEALTHY).strikes, 1);
  assert.deepEqual(pin.recordSessionAffinityTimeoutStrike(null, GEMINI, STALLED), {
    strikes: 0,
    evicted: false,
  });
  const second = pin.recordSessionAffinityTimeoutStrike(SESSION, GEMINI, STALLED);
  assert.deepEqual(second, { strikes: 1, evicted: false });
  assert.equal(affinityDb.getSessionAccountAffinity(SESSION, GEMINI, TTL)?.connectionId, HEALTHY);
});

test("chat.ts records timeout strikes instead of skipping eviction, and clears them on success", () => {
  const src = fs.readFileSync(new URL("../../src/sse/handlers/chat.ts", import.meta.url), "utf8");
  assert.match(src, /isTimeoutEvictionResult\(result\)\s*\?\s*recordSessionAffinityTimeoutStrike/);
  assert.match(
    src,
    /clearSessionAffinityTimeoutStrikes\(affinityKey, provider, credentials\.connectionId\)/
  );
  assert.match(src, /probeOnly: true/);
});

// ── Opportunity 1: read-only availability probing ──

async function seedGlmConnection(name: string) {
  return providersDb.createProviderConnection({
    provider: "glm",
    authType: "api_key",
    name,
    apiKey: `key-${name}`,
    isActive: true,
    testStatus: "active",
    providerSpecificData: {},
  });
}

for (const fallbackStrategy of ["round-robin", "least-used", "fill-first"]) {
  test(`getProviderCredentials probeOnly does not pin or advance lastUsedAt (${fallbackStrategy})`, async () => {
    await settingsDb.updateSettings({ sessionAffinityTtlMs: 60_000, fallbackStrategy });
    const a = await seedGlmConnection("probe-a");
    const b = await seedGlmConnection("probe-b");

    // Without a session key the strategy's own lastUsedAt commit path is exercised.
    await auth.getProviderCredentials("glm", null, null, "glm-4.6", { probeOnly: true });
    const probe = await auth.getProviderCredentials("glm", null, null, "glm-4.6", {
      sessionKey: "session-probe",
      probeOnly: true,
    });
    assert.ok(probe && "connectionId" in probe && probe.connectionId, "probe reports availability");
    assert.equal(
      affinityDb.getSessionAccountAffinity("session-probe", "glm", 60_000),
      null,
      "a probe must not create a session affinity pin"
    );
    for (const conn of [a, b]) {
      const row = (await providersDb.getProviderConnectionById(conn.id)) as Record<string, unknown>;
      assert.ok(!row.lastUsedAt, "a probe must not stamp lastUsedAt");
      assert.ok(!row.consecutiveUseCount, "a probe must not advance consecutiveUseCount");
    }

    // A real selection pins; a later probe must not touch that pin's account either.
    const real = await auth.getProviderCredentials("glm", null, null, "glm-4.6", {
      sessionKey: "session-probe",
    });
    const pinned = affinityDb.getSessionAccountAffinity("session-probe", "glm", 60_000);
    assert.equal(pinned?.connectionId, (real as { connectionId: string }).connectionId);
    const before = (await providersDb.getProviderConnectionById(pinned!.connectionId)) as Record<
      string,
      unknown
    >;

    const probe2 = await auth.getProviderCredentials("glm", null, null, "glm-4.6", {
      sessionKey: "session-probe",
      probeOnly: true,
    });
    assert.equal((probe2 as { connectionId: string }).connectionId, pinned!.connectionId);
    const after = (await providersDb.getProviderConnectionById(pinned!.connectionId)) as Record<
      string,
      unknown
    >;
    assert.equal(after.lastUsedAt, before.lastUsedAt);
    assert.equal(after.consecutiveUseCount, before.consecutiveUseCount);
  });
}
