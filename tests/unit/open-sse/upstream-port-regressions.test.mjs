import test from "node:test";
import assert from "node:assert/strict";
import {
  isClientAbortError,
  isRecoverableUpstreamTimeoutError,
  isHandledStreamLifecycleError,
  shouldSwallowUncaught,
} from "../../../src/shared/utils/httpClientAbortGuard.mjs";

const predicates = await import("../../../open-sse/services/combo/comboPredicates.ts");
const errorModule = await import("../../../open-sse/utils/error.ts");

test("crash guard recognizes relay timeouts and accounted stream errors", () => {
  const relayTimeout = Object.assign(new Error("Relay timed out"), {
    code: "RELAY_TIMEOUT",
    errorCode: "relay_timeout",
  });
  const emptyResponse = Object.assign(new Error("Empty response"), {
    code: "empty_response",
    __omniroutePendingRequestCleared: true,
  });
  assert.equal(isRecoverableUpstreamTimeoutError(relayTimeout), true);
  assert.equal(isRecoverableUpstreamTimeoutError("relay_timeout"), true);
  assert.equal(isHandledStreamLifecycleError(emptyResponse), true);
  assert.equal(isHandledStreamLifecycleError("empty_response"), true);
  assert.equal(shouldSwallowUncaught(relayTimeout, "unhandledRejection"), true);
  assert.equal(shouldSwallowUncaught(emptyResponse, "uncaughtException"), true);
  assert.equal(isClientAbortError(new Error("real bug")), false);
  assert.equal(shouldSwallowUncaught(new Error("real bug"), "uncaughtException"), false);
});

test("memory-pressure sheds are request-scoped, unlike upstream 503s", () => {
  for (const code of ["resource_pressure", "heap_pressure"]) {
    assert.equal(predicates.isRequestScopedUpstreamFailure({ code }), true);
    assert.equal(
      predicates.shouldSkipConnDisable(
        { status: 503, errorCode: code, errorType: "server_error", rawMessage: "pressure" },
        false,
        false,
        "gemini"
      ),
      true
    );
  }
  assert.equal(predicates.isRequestScopedUpstreamFailure({ code: "upstream_5xx" }), false);
});

test("details-only RetryInfo is parsed and relayed on rebuilt error responses", async () => {
  const body = JSON.stringify({
    error: {
      code: 429,
      message: "Quota exhausted",
      details: [{ "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "1104s" }],
    },
  });
  const parsed = await errorModule.parseUpstreamError(new Response(body, { status: 429 }), "gemini");
  assert.equal(parsed.retryAfterMs, 1_104_000);

  const result = errorModule.createErrorResult(429, parsed.message, parsed.retryAfterMs);
  assert.equal(result.response.headers.get("retry-after"), "1104");
  assert.equal(result.retryAfterMs, 1_104_000);
});
