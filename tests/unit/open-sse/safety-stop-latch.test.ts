import { after, afterEach, before, describe, it } from "node:test";
import assert from "node:assert/strict";

import { runComboWithSafetyLatch } from "../../../open-sse/services/combo/safetyStopLatch.ts";
import {
  classifyProviderSafetyError,
  PROVIDER_SAFETY_STOPS_TERMINAL_FLAG,
} from "../../../open-sse/utils/providerSafety.ts";

const FLAG = PROVIDER_SAFETY_STOPS_TERMINAL_FLAG;
const LEGACY_MESSAGE =
  "This request was blocked by our safety systems. Reason: Potentially unintended activity.";

let previousFlag: string | undefined;

before(() => {
  previousFlag = process.env[FLAG];
  process.env[FLAG] = "true";
});

after(() => {
  if (previousFlag === undefined) delete process.env[FLAG];
  else process.env[FLAG] = previousFlag;
});

afterEach(() => {
  process.env[FLAG] = "true";
});

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function safetyResponse(code = "content_policy_violation", status = 400): Response {
  return jsonResponse(status, { error: { message: "blocked", code, type: "invalid_request_error" } });
}

const noopLog = { info() {}, warn() {}, error() {}, debug() {} };

/** Minimal options object; the latch only touches signal, handleSingleModel and invocationId. */
function makeOptions(handleSingleModel: (...args: unknown[]) => Promise<Response>) {
  return {
    body: { model: "combo", messages: [] },
    log: noopLog,
    handleSingleModel,
  } as unknown as Parameters<typeof runComboWithSafetyLatch>[0];
}

describe("classifyProviderSafetyError", () => {
  it("classifies explicit protocol safety codes", () => {
    assert.deepEqual(
      classifyProviderSafetyError({ code: "misalignment_policy_violation", status: 403 }),
      { status: 403, code: "misalignment_policy_violation" }
    );
    assert.deepEqual(classifyProviderSafetyError({ code: "content_policy_violation", status: 400 }), {
      status: 400,
      code: "content_policy_violation",
    });
  });

  it("maps the legacy prose shape to a bounded local label", () => {
    assert.deepEqual(
      classifyProviderSafetyError({
        type: "invalid_request_error",
        message: LEGACY_MESSAGE,
        status: 400,
      }),
      { status: 400, code: "provider_safety_rejection" }
    );
  });

  it("ignores ordinary errors and non-400/403 statuses", () => {
    assert.equal(classifyProviderSafetyError({ code: "rate_limit_exceeded", status: 429 }), null);
    assert.equal(classifyProviderSafetyError({ code: "content_policy_violation", status: 500 }), null);
  });

  it("returns null when the feature flag is off", () => {
    process.env[FLAG] = "false";
    assert.equal(classifyProviderSafetyError({ code: "content_policy_violation", status: 400 }), null);
  });
});

describe("runComboWithSafetyLatch", () => {
  it("returns the safety refusal and stops sibling retries from replacing it", async () => {
    const calls: string[] = [];
    const inner = async (options: any) => {
      // Strategy tries target A (refused), then would try B; the latch must short-circuit B.
      const first = await options.handleSingleModel({}, "a", {});
      calls.push("a");
      let secondResult: Response | null = null;
      try {
        secondResult = await options.handleSingleModel({}, "b", {});
        calls.push("b");
      } catch {
        calls.push("b-aborted");
      }
      assert.equal(first.status, 403);
      return secondResult ?? new Response("ok", { status: 200 });
    };

    let upstreamCalls = 0;
    const options = makeOptions(async (_body: unknown, model: unknown) => {
      upstreamCalls++;
      if (model === "a") return safetyResponse("misalignment_policy_violation", 403);
      return new Response("should not be reached", { status: 200 });
    });

    const response = await runComboWithSafetyLatch(options, "inv-1", inner as any);
    assert.equal(response.status, 403);
    const body = (await response.json()) as { error: { code: string } };
    assert.equal(body.error.code, "misalignment_policy_violation");
    assert.equal(upstreamCalls, 1, "target B must not be dispatched after a safety stop");
    assert.ok(calls.includes("a"));
  });

  it("passes ordinary 400 responses through without latching", async () => {
    const ordinary = jsonResponse(400, { error: { message: "bad", code: "invalid_value" } });
    const inner = async (options: any) => options.handleSingleModel({}, "a", {});
    const options = makeOptions(async () => ordinary.clone());

    const response = await runComboWithSafetyLatch(options, "inv-2", inner as any);
    assert.equal(response.status, 400);
    const body = (await response.json()) as { error: { code: string } };
    assert.equal(body.error.code, "invalid_value");
  });

  it("returns the latched refusal when the inner strategy throws afterwards", async () => {
    const inner = async (options: any) => {
      await options.handleSingleModel({}, "a", {});
      throw new Error("sibling failed after stop");
    };
    const options = makeOptions(async () => safetyResponse());

    const response = await runComboWithSafetyLatch(options, "inv-3", inner as any);
    assert.equal(response.status, 400);
  });

  it("rethrows inner errors when no safety stop occurred", async () => {
    const inner = async () => {
      throw new Error("plain failure");
    };
    const options = makeOptions(async () => new Response("ok"));
    await assert.rejects(runComboWithSafetyLatch(options, "inv-4", inner as any), /plain failure/);
  });

  it("returns a replayable clone for repeated dispatches after latching", async () => {
    const inner = async (options: any) => {
      await options.handleSingleModel({}, "a", {});
      return options.handleSingleModel({}, "b", {});
    };
    const options = makeOptions(async () => safetyResponse());

    const response = await runComboWithSafetyLatch(options, "inv-5", inner as any);
    assert.equal(response.status, 400);
    const body = (await response.json()) as { error: { code: string } };
    assert.equal(body.error.code, "content_policy_violation");
  });
});
