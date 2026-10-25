/**
 * #17049 (PROVIDER_SAFETY_STOPS_TERMINAL) and #16438 (EMPTY_STREAM_SIBLING_RECOVERY_ENABLED)
 * ported into the Slim combo. Both flags are default-off; every test that depends on the
 * flag state sets it explicitly and restores the environment afterwards.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-safety-empty-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = process.env.API_KEY_SECRET || "safety-empty-test-secret";

const { handleComboChat } = await import("../../../open-sse/services/combo.ts");
const providerSafety = await import("../../../open-sse/utils/providerSafety.ts");
const { runComboWithSafetyLatch } =
  await import("../../../open-sse/services/combo/safetyStopLatch.ts");
const { createChaosHeaderBarrier } =
  await import("../../../open-sse/services/combo/chaosHeaderBarrier.ts");
const { isEmptyStreamSiblingRecoveryEnabled } =
  await import("../../../open-sse/services/streamRecovery.ts");
const { normalizeStreamFailurePayload } =
  await import("../../../open-sse/utils/streamErrorFormat.ts");

const SAFETY_FLAG = "PROVIDER_SAFETY_STOPS_TERMINAL";
const EMPTY_FLAG = "EMPTY_STREAM_SIBLING_RECOVERY_ENABLED";
const noop = () => {};
const log = { info: noop, warn: noop, debug: noop, error: noop };

/** Run fn with the given env flags set (or unset when value is undefined), then restore. */
async function withFlags(
  flags: Record<string, string | undefined>,
  fn: () => Promise<void> | void
): Promise<void> {
  const saved: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(flags)) {
    saved[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    await fn();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

const safetyBody = {
  error: {
    code: "content_policy_violation",
    type: "invalid_request_error",
    message: "Request blocked by safety policy",
  },
};

function healthy200(model: string) {
  return jsonResponse(200, {
    id: "ok",
    object: "chat.completion",
    model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: `hello from ${model}` },
        finish_reason: "stop",
      },
    ],
  });
}

function emptyContent502(headers: Record<string, string> = {}) {
  return jsonResponse(
    502,
    { error: { message: "Provider returned empty content", code: "empty_content" } },
    headers
  );
}

const request = { model: "test", messages: [{ role: "user", content: "hi" }] };

// ---------------------------------------------------------------------------
// Provider safety classification (#17049)
// ---------------------------------------------------------------------------

test("provider safety classification is inert with the flag off", async () => {
  await withFlags({ [SAFETY_FLAG]: undefined }, () => {
    assert.equal(providerSafety.isProviderSafetyStopsEnabled(), false);
    assert.equal(
      providerSafety.classifyProviderSafetyError({ status: 400, code: "content_policy_violation" }),
      null
    );
    assert.equal(providerSafety.isPublicProviderSafetyCode("content_policy_violation"), false);
  });
});

test("provider safety classification keeps explicit codes and the bounded legacy label", async () => {
  await withFlags({ [SAFETY_FLAG]: "true" }, () => {
    assert.equal(providerSafety.isProviderSafetyStopsEnabled(), true);
    assert.deepEqual(
      providerSafety.classifyProviderSafetyError({
        status: 403,
        code: "misalignment_policy_violation",
      }),
      { status: 403, code: "misalignment_policy_violation" }
    );
    assert.deepEqual(
      providerSafety.classifyProviderSafetyError({
        code: undefined,
        type: "invalid_request_error",
        message:
          "This request was blocked by our safety systems. Reason: Potentially unintended activity.",
      }),
      { status: 400, code: "provider_safety_rejection" }
    );
    // Ordinary request errors are not safety stops.
    assert.equal(
      providerSafety.classifyProviderSafetyError({
        status: 400,
        code: "invalid_request_error",
        type: "invalid_request_error",
        message: "bad field",
      }),
      null
    );
    assert.equal(providerSafety.isPublicProviderSafetyCode("CONTENT_POLICY_VIOLATION"), true);
  });
});

test("stream failure normalization projects a safety stop only with the flag on", async () => {
  const payload = {
    error: {
      code: "misalignment_policy_violation",
      type: "server_error",
      message: "blocked",
    },
  };
  await withFlags({ [SAFETY_FLAG]: undefined }, () => {
    const off = normalizeStreamFailurePayload(payload);
    assert.equal(off?.status, 502, "flag off keeps the ordinary 502 classification");
    assert.equal(off?.type, "server_error");
  });
  await withFlags({ [SAFETY_FLAG]: "true" }, () => {
    const on = normalizeStreamFailurePayload(payload);
    assert.equal(on?.status, 403);
    assert.equal(on?.code, "misalignment_policy_violation");
    assert.equal(on?.type, "invalid_request_error");
  });
});

// ---------------------------------------------------------------------------
// Safety latch and chaos header barrier (#17049)
// ---------------------------------------------------------------------------

test("safety latch returns the first safety-coded refusal and skips later targets", async () => {
  await withFlags({ [SAFETY_FLAG]: "true" }, async () => {
    const dispatched: string[] = [];
    const inner = async (opts: any) => {
      // Mirrors a strategy that keeps trying targets after a 403.
      await opts.handleSingleModel(opts.body, "provider-a/model-1", {});
      await opts.handleSingleModel(opts.body, "provider-b/model-2", {});
      return healthy200("never-reached");
    };
    const options: any = {
      body: request,
      combo: { name: "latch" },
      log,
      signal: undefined,
      handleSingleModel: async (_body: unknown, model: string) => {
        dispatched.push(model);
        return jsonResponse(403, safetyBody);
      },
    };
    const response = await runComboWithSafetyLatch(options, "inv-latch", inner);
    assert.equal(response.status, 403);
    const body = (await response.json()) as { error: { code: string } };
    assert.equal(body.error.code, "content_policy_violation");
    assert.deepEqual(dispatched, ["provider-a/model-1"], "second target must not be dispatched");
  });
});

test("chaos header barrier resolves once the accepted attempt returns headers", async () => {
  const barrier = createChaosHeaderBarrier(async (_body, model) => healthy200(model));
  const response = await barrier.handleSingleModel({ stream: true }, "provider-c/model-3", {});
  assert.equal(response.status, 200);
  await barrier.wait();
});

// ---------------------------------------------------------------------------
// Empty-content sibling recovery (#16438)
// ---------------------------------------------------------------------------

test("empty-content sibling recovery flag is default-off and env-driven", async () => {
  await withFlags({ [EMPTY_FLAG]: undefined }, () => {
    assert.equal(isEmptyStreamSiblingRecoveryEnabled(), false);
  });
  await withFlags({ [EMPTY_FLAG]: "true" }, () => {
    assert.equal(isEmptyStreamSiblingRecoveryEnabled(), true);
  });
});

test("flag off: an empty_content 502 retries the same target without a sibling hint", async () => {
  await withFlags({ [EMPTY_FLAG]: undefined }, async () => {
    const seenHints: unknown[] = [];
    let calls = 0;
    const result = await handleComboChat({
      body: request,
      combo: {
        name: "empty-off",
        strategy: "priority",
        models: [{ model: "provider-d/model-4" }],
        config: { maxRetries: 1, retryDelayMs: 0 },
      } as any,
      handleSingleModel: async (_body: unknown, _model: string, target: any) => {
        calls++;
        seenHints.push(target?.emptyTurnConnectionId);
        return calls === 1
          ? emptyContent502({ "X-OmniRoute-Selected-Connection-Id": "conn-off" })
          : healthy200("provider-d/model-4");
      },
      log,
      settings: {},
      allCombos: [],
    } as any);
    assert.equal(result.status, 200);
    assert.equal(calls, 2);
    assert.notEqual(seenHints[1], "conn-off", "no sibling hint when the flag is off");
  });
});

test("flag on: an empty_content 502 spends the retry with the empty-turn connection hint", async () => {
  await withFlags({ [EMPTY_FLAG]: "true" }, async () => {
    const seenHints: unknown[] = [];
    let calls = 0;
    const result = await handleComboChat({
      body: request,
      combo: {
        name: "empty-on",
        strategy: "priority",
        models: [{ model: "provider-e/model-5" }],
        config: { maxRetries: 1, retryDelayMs: 0 },
      } as any,
      handleSingleModel: async (_body: unknown, _model: string, target: any) => {
        calls++;
        seenHints.push(target?.emptyTurnConnectionId);
        return calls === 1
          ? emptyContent502({ "X-OmniRoute-Selected-Connection-Id": "conn-empty" })
          : healthy200("provider-e/model-5");
      },
      log,
      settings: {},
      allCombos: [],
    } as any);
    assert.equal(result.status, 200);
    assert.equal(calls, 2);
    assert.equal(seenHints[1], "conn-empty", "retry must prefer a sibling of the empty connection");
  });
});

test("flag on: a combo with a safety-coded 403 stops; flag off it falls through to the next target", async () => {
  const buildCombo = (name: string) => ({
    name,
    strategy: "priority",
    models: [{ model: "provider-f/model-6" }, { model: "provider-g/model-7" }],
    config: { maxRetries: 0, retryDelayMs: 0 },
  });
  const run = (name: string) => {
    const dispatched: string[] = [];
    return {
      dispatched,
      promise: handleComboChat({
        body: request,
        combo: buildCombo(name) as any,
        handleSingleModel: async (_body: unknown, model: string) => {
          dispatched.push(model);
          return model.startsWith("provider-f") ? jsonResponse(403, safetyBody) : healthy200(model);
        },
        log,
        settings: {},
        allCombos: [],
      } as any),
    };
  };

  await withFlags({ [SAFETY_FLAG]: "true" }, async () => {
    const on = run("safety-on");
    const response = await on.promise;
    assert.equal(response.status, 403);
    assert.deepEqual(on.dispatched, ["provider-f/model-6"]);
  });

  await withFlags({ [SAFETY_FLAG]: undefined }, async () => {
    const off = run("safety-off");
    const response = await off.promise;
    assert.equal(
      response.status,
      200,
      "flag off keeps the existing fallback to the healthy target"
    );
    assert.deepEqual(off.dispatched, ["provider-f/model-6", "provider-g/model-7"]);
  });
});
