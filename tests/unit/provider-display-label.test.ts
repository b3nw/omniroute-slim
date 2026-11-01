import test from "node:test";
import assert from "node:assert/strict";
import { getProviderDisplayLabel } from "../../src/shared/utils/providerDisplayLabel.ts";
import { getProtocolColor, normalizeProtocolKey } from "../../src/shared/constants/colors.ts";

test("returns matched node name for openai-compatible UUID id", () => {
  const providerNodes = [
    { id: "openai-compatible-chat-02669115-2545-4896-b003-cb4dac09d441", prefix: undefined, name: "My Custom OAI" },
  ];
  const result = getProviderDisplayLabel(
    "openai-compatible-chat-02669115-2545-4896-b003-cb4dac09d441",
    providerNodes
  );
  assert.equal(result, "My Custom OAI");
});

test("returns matched node name when matched by prefix", () => {
  const providerNodes = [
    { id: "some-other-id", prefix: "openai-compatible-myservice", name: "My Service" },
  ];
  const result = getProviderDisplayLabel("openai-compatible-myservice", providerNodes);
  assert.equal(result, "My Service");
});

test("returns OAI-COMPAT fallback for openai-compatible UUID when no matching node", () => {
  const result = getProviderDisplayLabel(
    "openai-compatible-chat-02669115-2545-4896-b003-cb4dac09d441",
    []
  );
  assert.equal(result, "OAI-COMPAT");
});

test("returns OAI-COMPAT fallback for openai-compatible UUID when providerNodes is undefined", () => {
  const result = getProviderDisplayLabel(
    "openai-compatible-chat-02669115-2545-4896-b003-cb4dac09d441"
  );
  assert.equal(result, "OAI-COMPAT");
});

test("returns OAI: prefix label for openai-compatible short name (no UUID)", () => {
  const result = getProviderDisplayLabel("openai-compatible-myserver", []);
  assert.equal(result, "OAI: MYSERVER");
});

test("returns ANT-COMPAT fallback for anthropic-compatible UUID when no matching node", () => {
  const result = getProviderDisplayLabel(
    "anthropic-compatible-chat-02669115-2545-4896-b003-cb4dac09d441",
    []
  );
  assert.equal(result, "ANT-COMPAT");
});

test("returns ANT: prefix label for anthropic-compatible short name (no UUID)", () => {
  const result = getProviderDisplayLabel("anthropic-compatible-myserver", []);
  assert.equal(result, "ANT: MYSERVER");
});

test("returns null for a plain provider like openai", () => {
  const result = getProviderDisplayLabel("openai", []);
  assert.equal(result, null);
});

test("returns null for a plain provider like anthropic", () => {
  const result = getProviderDisplayLabel("anthropic", []);
  assert.equal(result, null);
});

test("returns null for a plain provider with no providerNodes arg", () => {
  const result = getProviderDisplayLabel("gemini");
  assert.equal(result, null);
});

test("matched node name wins over fallback for anthropic-compatible UUID", () => {
  const providerNodes = [
    { id: "anthropic-compatible-chat-02669115-2545-4896-b003-cb4dac09d441", name: "My Custom ANT" },
  ];
  const result = getProviderDisplayLabel(
    "anthropic-compatible-chat-02669115-2545-4896-b003-cb4dac09d441",
    providerNodes
  );
  assert.equal(result, "My Custom ANT");
});

test("matches node id case-insensitively for upper-cased compatible ids", () => {
  const providerNodes = [
    { id: "openai-compatible-chat-ea7d9940-2279-48c8-ab33-8b56cb06e1a9", name: "inferx" },
  ];
  const result = getProviderDisplayLabel(
    "OPENAI-COMPATIBLE-CHAT-EA7D9940-2279-48C8-AB33-8B56CB06E1A9",
    providerNodes
  );
  assert.equal(result, "inferx");
});

test("matches node prefix case-insensitively", () => {
  const providerNodes = [{ id: "x", prefix: "anthropic-compatible-MySvc", name: "My Svc" }];
  assert.equal(getProviderDisplayLabel("ANTHROPIC-COMPATIBLE-mysvc", providerNodes), "My Svc");
});

test("returns generic compat labels for upper-cased ids without a matching node", () => {
  assert.equal(
    getProviderDisplayLabel("OPENAI-COMPATIBLE-CHAT-EA7D9940-2279-48C8-AB33-8B56CB06E1A9", []),
    "OAI-COMPAT"
  );
  assert.equal(
    getProviderDisplayLabel("ANTHROPIC-COMPATIBLE-MSG-EA7D9940-2279-48C8-AB33-8B56CB06E1A9"),
    "ANT-COMPAT"
  );
});

const CUSTOM_OAI_ID = "openai-compatible-chat-ea7d9940-2279-48c8-ab33-8b56cb06e1a9";
const OPENAI_CHAT_BADGE = { bg: "#1A1A2E", text: "#fff", label: "OpenAI-Chat" };

test("getProtocolColor maps custom openai-compatible chat node ids to OpenAI-Chat", () => {
  assert.deepEqual(getProtocolColor(CUSTOM_OAI_ID, CUSTOM_OAI_ID), OPENAI_CHAT_BADGE);
});

test("getProtocolColor falls back to normalized provider when protocol is null", () => {
  assert.deepEqual(getProtocolColor(null, CUSTOM_OAI_ID), OPENAI_CHAT_BADGE);
});

test("getProtocolColor maps custom openai-compatible responses node ids to OpenAI-Responses", () => {
  assert.deepEqual(
    getProtocolColor("openai-compatible-responses-12345678", "openai-compatible-responses-12345678"),
    { bg: "#1A1A2E", text: "#fff", label: "OpenAI-Responses" }
  );
});

test("getProtocolColor maps custom anthropic-compatible node ids to Claude", () => {
  assert.deepEqual(
    getProtocolColor("anthropic-compatible-chat-12345678", "anthropic-compatible-chat-12345678"),
    { bg: "#D97757", text: "#fff", label: "Claude" }
  );
});

test("normalizeProtocolKey handles aliases case-insensitively", () => {
  assert.equal(normalizeProtocolKey("OPENAI-COMPATIBLE-CHAT-EA7D9940"), "openai");
  assert.equal(normalizeProtocolKey("openai-compatible"), "openai");
  assert.equal(normalizeProtocolKey("Openai-Compatible-Responses"), "openai-responses");
  assert.equal(normalizeProtocolKey("anthropic"), "claude");
  assert.equal(normalizeProtocolKey("anthropic-compatible"), "claude");
  assert.equal(normalizeProtocolKey("gemini-cli"), "gemini");
  assert.equal(normalizeProtocolKey("GEMINI_CLI"), "gemini");
  assert.equal(normalizeProtocolKey("openai-chat"), "openai");
  assert.equal(normalizeProtocolKey("openai-response"), "openai-responses");
  assert.equal(normalizeProtocolKey("warmup"), "warmup");
  assert.equal(normalizeProtocolKey(null), null);
});

test("getProtocolColor keeps uppercase fallback for unknown protocols", () => {
  assert.equal(getProtocolColor("mystery", null).label, "MYSTERY");
});
