import { test } from "node:test";
import assert from "node:assert/strict";
import {
  getComboTargetSelectedConnection,
  propagateComboTargetTimeoutDisarm,
  recordComboTargetSelectedConnection,
  trackComboTargetSelectedConnection,
} from "../../open-sse/services/combo/comboAbortReasons.ts";
import { mergeAbortSignals } from "../../open-sse/executors/base.ts";
import { buildTargetTimeoutRunner } from "../../open-sse/services/combo/targetTimeoutRunner.ts";
import { runComboWithSafetyLatch } from "../../open-sse/services/combo/safetyStopLatch.ts";
import {
  buildUniversalHandoffSystemMessage,
  hasPriorConversationTurn,
  injectUniversalHandoffBody,
} from "../../open-sse/services/contextHandoff.ts";
import type {
  ComboLogger,
  HandleComboChatOptions,
  SingleModelTarget,
} from "../../open-sse/services/combo/types.ts";

type ChatMessage = { role: string; content: string | Array<{ type: string; text: string }> };
type ChatBody = { messages: ChatMessage[] };

const noopLog: ComboLogger = { warn() {}, info() {}, error() {}, debug() {} };

// ── (a) selected-connection registry ───────────────────────────────────────

test("registry: record on a mergeAbortSignals-derived signal is visible on the source", () => {
  const source = new AbortController().signal;
  trackComboTargetSelectedConnection(source);
  const derived = mergeAbortSignals(new AbortController().signal, source);
  const twiceDerived = mergeAbortSignals(derived, new AbortController().signal);
  recordComboTargetSelectedConnection(twiceDerived, "58a9f936");
  assert.equal(getComboTargetSelectedConnection(source), "58a9f936");
  assert.equal(getComboTargetSelectedConnection(derived), "58a9f936");
});

test("registry: AbortSignal.any wrapper shares the holder once propagated", () => {
  const source = new AbortController().signal;
  trackComboTargetSelectedConnection(source);
  const wrapped = AbortSignal.any([new AbortController().signal, source]);
  recordComboTargetSelectedConnection(wrapped, "lost");
  assert.equal(getComboTargetSelectedConnection(source), undefined, "unpropagated: no link");
  propagateComboTargetTimeoutDisarm(wrapped, source);
  recordComboTargetSelectedConnection(wrapped, "58a9f936");
  assert.equal(getComboTargetSelectedConnection(source), "58a9f936");
});

test("registry: untracked signals and empty ids are no-ops", () => {
  const untracked = new AbortController().signal;
  recordComboTargetSelectedConnection(untracked, "x");
  assert.equal(getComboTargetSelectedConnection(untracked), undefined);
  const tracked = new AbortController().signal;
  trackComboTargetSelectedConnection(tracked);
  recordComboTargetSelectedConnection(tracked, "");
  recordComboTargetSelectedConnection(tracked, null);
  assert.equal(getComboTargetSelectedConnection(tracked), undefined);
  assert.equal(getComboTargetSelectedConnection(null), undefined);
});

// ── (b) targetTimeoutRunner synthetic 504 attribution ──────────────────────

function stallUntilAbort(signal: AbortSignal | null | undefined): Promise<Response> {
  return new Promise((_resolve, reject) => {
    signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}

test("runner: synthetic 504 carries X-OmniRoute-Selected-Connection-Id of the dispatched connection", async () => {
  const runner = buildTargetTimeoutRunner({
    handleSingleModel: async (_b, _m, target) => {
      // Mirrors the chat path: dispatch goes through a merged signal (clientRawRequest)
      // and the pinned connection differs from target.connectionId.
      const dispatchSignal = mergeAbortSignals(
        new AbortController().signal,
        target!.modelAbortSignal!
      );
      recordComboTargetSelectedConnection(dispatchSignal, "58a9f936");
      return stallUntilAbort(dispatchSignal);
    },
    comboTargetTimeoutMs: 20,
    log: noopLog,
  });
  const res = await runner({}, "nvidia/gemma", {
    modelStr: "nvidia/gemma",
    connectionId: "4f774048",
  } as unknown as SingleModelTarget);
  assert.equal(res.status, 504);
  assert.equal(res.headers.get("X-OmniRoute-Selected-Connection-Id"), "58a9f936");
});

test("runner: synthetic 504 omits the header when no connection was recorded", async () => {
  const runner = buildTargetTimeoutRunner({
    handleSingleModel: async (_b, _m, target) => stallUntilAbort(target?.modelAbortSignal),
    comboTargetTimeoutMs: 20,
    log: noopLog,
  });
  const res = await runner({}, "nvidia/gemma");
  assert.equal(res.status, 504);
  assert.equal(res.headers.get("X-OmniRoute-Selected-Connection-Id"), null);
});

test("runner: attribution survives the PROVIDER_SAFETY_STOPS_TERMINAL latch wrapper", async () => {
  let res: Response | null = null;
  await runComboWithSafetyLatch(
    {
      handleSingleModel: async (_b, _m, target) => {
        recordComboTargetSelectedConnection(target?.modelAbortSignal, "58a9f936");
        return stallUntilAbort(target?.modelAbortSignal);
      },
    } as unknown as HandleComboChatOptions,
    "inv-1",
    async (opts) => {
      const runner = buildTargetTimeoutRunner({
        handleSingleModel: opts.handleSingleModel,
        comboTargetTimeoutMs: 20,
        log: noopLog,
      });
      res = await runner({}, "nvidia/gemma");
      return res;
    }
  );
  assert.equal(res!.status, 504);
  assert.equal(res!.headers.get("X-OmniRoute-Selected-Connection-Id"), "58a9f936");
});

// ── (c) universal handoff gate + system-message merge ──────────────────────

test("hasPriorConversationTurn: skips [system, user], injects with an assistant turn", () => {
  assert.equal(
    hasPriorConversationTurn({
      messages: [
        { role: "system", content: "sys" },
        { role: "user", content: "hi" },
      ],
    }),
    false
  );
  assert.equal(
    hasPriorConversationTurn({
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: "hello" },
        { role: "user", content: "more" },
      ],
    }),
    true
  );
  assert.equal(hasPriorConversationTurn({ input: "hi" }), false);
  assert.equal(hasPriorConversationTurn({ input: [{ role: "user", content: "hi" }] }), false);
  assert.equal(
    hasPriorConversationTurn({ input: [{ type: "message", role: "assistant", content: [] }] }),
    true
  );
  assert.equal(hasPriorConversationTurn({ input: [{ type: "function_call_output" }] }), true);
  assert.equal(hasPriorConversationTurn({ contents: [{ role: "model", parts: [] }] }), true);
  assert.equal(hasPriorConversationTurn(null), false);
});

test("injectUniversalHandoffBody merges into a leading string system message", () => {
  const body = {
    messages: [
      { role: "system", content: "Be helpful" },
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi" },
    ],
  };
  const r = injectUniversalHandoffBody(body, "a", "b", "reason", null) as unknown as ChatBody;
  assert.equal(r.messages.length, 3);
  assert.equal(r.messages[0].role, "system");
  assert.notEqual(r.messages[1].role, "system", "no consecutive system messages");
  const merged = String(r.messages[0].content);
  assert.ok(merged.startsWith("<context_handoff>"));
  assert.ok(merged.endsWith("\n\nBe helpful"));
  assert.equal(body.messages[0].content, "Be helpful", "input body not mutated");
});

test("injectUniversalHandoffBody prepends a text part to an array-content system message", () => {
  const body = {
    messages: [
      { role: "system", content: [{ type: "text", text: "Be helpful" }] },
      { role: "user", content: "Hello" },
    ],
  };
  const r = injectUniversalHandoffBody(body, "a", "b", "reason", null) as unknown as ChatBody;
  assert.equal(r.messages.length, 2);
  const parts = r.messages[0].content as Array<{ type: string; text: string }>;
  assert.equal(parts.length, 2);
  assert.ok(parts[0].text.includes("<context_handoff>"));
  assert.equal(parts[1].text, "Be helpful");
});

test("injectUniversalHandoffBody without a system message still prepends one", () => {
  const r = injectUniversalHandoffBody(
    { messages: [{ role: "user", content: "Hello" }] },
    "a",
    "b",
    "reason",
    null
  ) as unknown as ChatBody;
  assert.equal(r.messages.length, 2);
  assert.equal(r.messages[0].role, "system");
});

// ── (d) English note ────────────────────────────────────────────────────────

test("buildUniversalHandoffSystemMessage note is English and claims no summary without one", () => {
  const msg = buildUniversalHandoffSystemMessage("a", "b", "reason", null);
  assert.ok(!/continuaci|perder el hilo/i.test(msg));
  assert.match(msg, /<note>[A-Za-z .,]+<\/note>/);
  assert.ok(!/summar/i.test(msg), "must not claim a summary follows");
});
