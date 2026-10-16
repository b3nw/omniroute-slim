/**
 * Regression and conformance test suite for native OpenCode v2 request shaping alignment.
 *
 * Validates the 6 deltas identified between native opencode v2 and OmniRoute's OpencodeExecutor:
 * 1. User-Agent preservation for both opencode/... (native v2) and opencode-cli/...
 * 2. x-opencode-session-id forwarding and stable conversation fingerprint vs UUID decision
 * 3. Complete native header forwarding (x-opencode-parent-session-id, x-parent-session-id, x-session-affinity, X-Session-Id)
 * 4. DeepSeek effort tier model rewriting (opencode-go contract)
 * 5. json_schema -> json_object fallback on deepseek-v4-flash-free
 * 6. Client metadata stripping, reasoning_content injection, muse-spark UUID enforcement
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { forwardOpencodeClientHeaders } from "../../open-sse/utils/opencodeHeaders.ts";
import { OpencodeExecutor } from "../../open-sse/executors/opencode.ts";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SESSION_HASH_RE = /^[0-9a-f]{16}$/i;

const CLI_DEFAULTS = {
  userAgent: "opencode",
  client: "desktop",
  project: "global",
};

describe("Delta 1: User-Agent preservation guard", () => {
  it("preserves native opencode v2 User-Agent (opencode/{channel}/{version}/{name})", () => {
    const headers: Record<string, string> = {};
    const clientHeaders = {
      "User-Agent": "opencode/stable/2.1.0/opencode",
    };
    forwardOpencodeClientHeaders(headers, clientHeaders, { cliDefaults: CLI_DEFAULTS });
    assert.equal(headers["User-Agent"], "opencode/stable/2.1.0/opencode");
  });

  it("preserves native opencode v2 User-Agent with arbitrary channel and client name", () => {
    const headers: Record<string, string> = {};
    const clientHeaders = {
      "user-agent": "opencode/insiders/3.0.0-beta.1/desktop-app",
    };
    forwardOpencodeClientHeaders(headers, clientHeaders, { cliDefaults: CLI_DEFAULTS });
    assert.equal(headers["User-Agent"], "opencode/insiders/3.0.0-beta.1/desktop-app");
  });

  it("preserves legacy CLI User-Agent (opencode-cli/...)", () => {
    const headers: Record<string, string> = {};
    const clientHeaders = {
      "User-Agent": "opencode-cli/1.2.3",
    };
    forwardOpencodeClientHeaders(headers, clientHeaders, { cliDefaults: CLI_DEFAULTS });
    assert.equal(headers["User-Agent"], "opencode-cli/1.2.3");
  });

  it("replaces truly generic User-Agents (curl, python, SDKs) with cliDefaults.userAgent", () => {
    const genericUas = [
      "curl/8.5.0",
      "python-requests/2.31.0",
      "node-fetch/1.0",
      "OpenAI/NodeJS 4.0.0",
    ];

    for (const ua of genericUas) {
      const headers: Record<string, string> = {};
      forwardOpencodeClientHeaders(
        headers,
        { "User-Agent": ua },
        {
          cliDefaults: { userAgent: "opencode-cli/synthesized", client: "cli", project: "default" },
        }
      );
      assert.equal(
        headers["User-Agent"],
        "opencode-cli/synthesized",
        `expected ${ua} to be replaced`
      );
    }
  });
});

describe("Delta 2: x-opencode-session and x-opencode-session-id handling", () => {
  it("forwards client-supplied x-opencode-session-id", () => {
    const headers: Record<string, string> = {};
    const clientHeaders = {
      "x-opencode-session-id": "ses_01K46JDFR0E75SG2Q8K172KF3Y",
    };
    forwardOpencodeClientHeaders(headers, clientHeaders, { cliDefaults: CLI_DEFAULTS });
    assert.equal(headers["x-opencode-session-id"], "ses_01K46JDFR0E75SG2Q8K172KF3Y");
  });

  it("does NOT inject x-opencode-session-id when client did not supply it (no accidental injection)", () => {
    const headers: Record<string, string> = {};
    forwardOpencodeClientHeaders(headers, {}, { cliDefaults: CLI_DEFAULTS });
    assert.equal(headers["x-opencode-session-id"], undefined);
  });

  it("synthesizes conversation-stable fingerprint for prompt-cache affinity when body provided", () => {
    const headersA: Record<string, string> = {};
    const conversation = {
      model: "deepseek-v4-flash",
      messages: [{ role: "user", content: "Implement Dijkstra algorithm" }],
    };
    forwardOpencodeClientHeaders(
      headersA,
      {},
      { cliDefaults: CLI_DEFAULTS, sessionBody: conversation }
    );
    assert.match(headersA["x-opencode-session"] ?? "", SESSION_HASH_RE);

    // Second turn in same conversation has matching fingerprint
    const headersB: Record<string, string> = {};
    const turn2 = {
      model: "deepseek-v4-flash",
      messages: [
        { role: "user", content: "Implement Dijkstra algorithm" },
        { role: "assistant", content: "Here is the code..." },
        { role: "user", content: "Can you optimize it?" },
      ],
    };
    forwardOpencodeClientHeaders(headersB, {}, { cliDefaults: CLI_DEFAULTS, sessionBody: turn2 });
    assert.equal(headersA["x-opencode-session"], headersB["x-opencode-session"]);
  });

  it("maps x-opencode-session-id to x-opencode-session when latter is missing", () => {
    const headers: Record<string, string> = {};
    const clientHeaders = {
      "x-opencode-session-id": "ses_native_parent_123",
    };
    forwardOpencodeClientHeaders(headers, clientHeaders, {
      synthesizeRequestId: true,
      cliDefaults: CLI_DEFAULTS,
    });
    assert.equal(headers["x-opencode-session"], "ses_native_parent_123");
    assert.equal(headers["x-opencode-session-id"], "ses_native_parent_123");
  });
});

describe("Delta 3: Complete native header set forwarding", () => {
  it("forwards all native lineage and affinity headers faithfully", () => {
    const headers: Record<string, string> = {};
    const nativeHeaders = {
      "x-opencode-session-id": "ses_child_01",
      "x-opencode-parent-session-id": "ses_parent_01",
      "x-session-affinity": "ses_affinity_root",
      "X-Session-Id": "ses_affinity_root",
      "x-parent-session-id": "ses_parent_01",
      "x-opencode-project": "prj_zen_01",
      "x-opencode-session": "ses_affinity_root",
      "x-opencode-client": "opencode",
    };
    forwardOpencodeClientHeaders(headers, nativeHeaders, { cliDefaults: CLI_DEFAULTS });

    assert.equal(headers["x-opencode-session-id"], "ses_child_01");
    assert.equal(headers["x-opencode-parent-session-id"], "ses_parent_01");
    assert.equal(headers["x-session-affinity"], "ses_affinity_root");
    assert.equal(headers["x-session-id"], "ses_affinity_root");
    assert.equal(headers["x-parent-session-id"], "ses_parent_01");
    assert.equal(headers["x-opencode-project"], "prj_zen_01");
    assert.equal(headers["x-opencode-session"], "ses_affinity_root");
    assert.equal(headers["x-opencode-client"], "opencode");
  });

  it("matches native headers case-insensitively and respects client values", () => {
    const headers: Record<string, string> = {};
    const clientHeaders = {
      "X-OpenCode-Session-Id": "ses_custom_1",
      "X-OpenCode-Parent-Session-Id": "ses_custom_parent",
      "X-Session-Affinity": "aff_custom",
      "X-Parent-Session-Id": "parent_custom",
    };
    forwardOpencodeClientHeaders(headers, clientHeaders);

    assert.equal(headers["x-opencode-session-id"], "ses_custom_1");
    assert.equal(headers["x-opencode-parent-session-id"], "ses_custom_parent");
    assert.equal(headers["x-session-affinity"], "aff_custom");
    assert.equal(headers["x-parent-session-id"], "parent_custom");
  });
});

describe("Delta 4: DeepSeek effort tier model rewrite contract", () => {
  const executor = new OpencodeExecutor("opencode");

  it("rewrites deepseek-v4-pro effort tier to base model and reasoning_effort", () => {
    const transformed = executor.transformRequest(
      "deepseek-v4-pro-high",
      { messages: [{ role: "user", content: "hi" }] },
      false,
      { apiKey: "test" }
    );
    assert.equal(transformed.model, "deepseek-v4-pro");
    assert.equal(transformed.reasoning_effort, "high");
  });

  it("rewrites deepseek-v4-flash effort tier to base model and reasoning_effort", () => {
    const transformed = executor.transformRequest(
      "deepseek-v4-flash-low",
      { messages: [{ role: "user", content: "hi" }] },
      false,
      { apiKey: "test" }
    );
    assert.equal(transformed.model, "deepseek-v4-flash");
    assert.equal(transformed.reasoning_effort, "low");
  });

  it("preserves explicit reasoning_effort when already provided", () => {
    const transformed = executor.transformRequest(
      "deepseek-v4-flash-high",
      { messages: [{ role: "user", content: "hi" }], reasoning_effort: "max" },
      false,
      { apiKey: "test" }
    );
    assert.equal(transformed.model, "deepseek-v4-flash");
    assert.equal(transformed.reasoning_effort, "max");
  });

  it("does not rewrite non-DeepSeek model tiers (#10788 opencode-go contract)", () => {
    const transformed = executor.transformRequest(
      "kimi-k2.6-high",
      { model: "kimi-k2.6-high", messages: [{ role: "user", content: "hi" }] },
      false,
      { apiKey: "test" }
    );
    assert.equal(transformed.model, "kimi-k2.6-high");
    assert.equal(transformed.reasoning_effort, undefined);
  });
});

describe("Delta 5: json_schema to json_object downgrade on deepseek-v4-flash-free", () => {
  const executor = new OpencodeExecutor("opencode");

  it("downgrades json_schema to json_object and injects schema into system prompt", () => {
    const schema = {
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
    };
    const body = {
      model: "deepseek-v4-flash-free",
      messages: [{ role: "user", content: "extract name" }],
      response_format: {
        type: "json_schema",
        json_schema: { schema },
      },
    };

    const transformed = executor.transformRequest("deepseek-v4-flash-free", body, false, {
      apiKey: "test",
    });

    assert.equal(transformed.response_format.type, "json_object");
    const sysMsg = transformed.messages.find((m: Record<string, unknown>) => m.role === "system");
    assert.ok(sysMsg, "expected injected system message");
    assert.ok(
      typeof sysMsg.content === "string" &&
        sysMsg.content.includes(
          "You must respond with valid JSON that strictly follows this JSON schema"
        )
    );
    assert.ok(
      typeof sysMsg.content === "string" && sysMsg.content.includes(JSON.stringify(schema, null, 2))
    );
  });

  it("leaves json_schema untouched for paid/standard models", () => {
    const body = {
      model: "deepseek-v4-pro",
      messages: [{ role: "user", content: "extract name" }],
      response_format: {
        type: "json_schema",
        json_schema: { schema: { type: "object" } },
      },
    };

    const transformed = executor.transformRequest("deepseek-v4-pro", body, false, {
      apiKey: "test",
    });

    assert.equal(transformed.response_format.type, "json_schema");
  });
});

describe("Delta 6: Low-risk verified transforms", () => {
  const executor = new OpencodeExecutor("opencode");

  it("strips client_metadata from outbound body (prevents 400 Extra inputs)", () => {
    const body = {
      model: "kimi-k2.6",
      messages: [{ role: "user", content: "hello" }],
      client_metadata: { ide: "vscode", version: "1.0.0" },
    };

    const transformed = executor.transformRequest("kimi-k2.6", body, false, { apiKey: "test" });

    assert.equal(transformed.client_metadata, undefined);
  });

  it("injects placeholder reasoning_content for thinking models lacking it across turns", () => {
    const body = {
      model: "deepseek-v4-flash",
      messages: [
        { role: "user", content: "first question" },
        { role: "assistant", content: "first answer" },
        { role: "user", content: "second question" },
      ],
    };

    const transformed = executor.transformRequest("deepseek-v4-flash", body, false, {
      apiKey: "test",
    });

    const assistantMsg = transformed.messages.find(
      (m: Record<string, unknown>) => m.role === "assistant"
    );
    assert.ok(assistantMsg, "expected assistant message");
    assert.equal(typeof assistantMsg.reasoning_content, "string");
  });

  it("forces real UUID for muse-spark on openai-responses format", () => {
    const respExecutor = new OpencodeExecutor("opencode");
    (respExecutor as unknown as { _requestFormat: string })._requestFormat = "openai-responses";

    const headers = respExecutor.buildHeaders(
      { apiKey: "test" },
      true,
      undefined,
      "muse-spark-1.3",
      undefined,
      { model: "muse-spark-1.3", messages: [{ role: "user", content: "hi" }] }
    );

    assert.match(headers["x-opencode-session"] ?? "", UUID_RE);
  });
});
