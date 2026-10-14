import test from "node:test";
import assert from "node:assert/strict";

const { injectSystemPrompt, setSystemPromptConfig, getSystemPromptConfig } =
  await import("../../open-sse/services/systemPrompt.ts");

// ─── Config ─────────────────────────────────────────────────────────────────

test("default config: disabled", () => {
  const config = getSystemPromptConfig();
  assert.equal(config.enabled, false);
  assert.equal(config.prefixPrompt, "");
  assert.equal(config.suffixPrompt, "");
});

test("setSystemPromptConfig: legacy prompt migrates to suffixPrompt", () => {
  setSystemPromptConfig({ enabled: true, prompt: "legacy text" });
  const config = getSystemPromptConfig();
  assert.equal(config.suffixPrompt, "legacy text");
});

test("setSystemPromptConfig: explicit prefix/suffix clears legacy prompt", () => {
  setSystemPromptConfig({ enabled: true, prefixPrompt: "PRE", suffixPrompt: "SUF" });
  const config = getSystemPromptConfig();
  assert.equal(config.prefixPrompt, "PRE");
  assert.equal(config.suffixPrompt, "SUF");
});

// ─── Injection ──────────────────────────────────────────────────────────────

test("injectSystemPrompt: disabled → no change", () => {
  setSystemPromptConfig({ enabled: false, suffixPrompt: "system" });
  const body = { messages: [{ role: "user", content: "hi" }] };
  const result = injectSystemPrompt(body);
  assert.deepEqual(result, body);
});

test("injectSystemPrompt: empty prefix and suffix → no change", () => {
  setSystemPromptConfig({ enabled: true, prefixPrompt: "", suffixPrompt: "" });
  const body = { messages: [{ role: "user", content: "hi" }] };
  const result = injectSystemPrompt(body);
  assert.deepEqual(result, body);
});

test("injectSystemPrompt: suffix adds system message when none exists", () => {
  setSystemPromptConfig({ enabled: true, prefixPrompt: "", suffixPrompt: "You are an AI." });
  const body = { messages: [{ role: "user", content: "hi" }] };
  const result = injectSystemPrompt(body);
  assert.equal(result.messages[0].role, "system");
  assert.ok(result.messages[0].content.includes("You are an AI."));
  assert.equal(result.messages.length, 2);
});

test("injectSystemPrompt: prefix + suffix wrap existing system message (#2468)", () => {
  setSystemPromptConfig({ enabled: true, prefixPrompt: "BEFORE", suffixPrompt: "AFTER" });
  const body = {
    messages: [
      { role: "system", content: "Original prompt" },
      { role: "user", content: "hi" },
    ],
  };
  const result = injectSystemPrompt(body);
  assert.ok(result.messages[0].content.startsWith("BEFORE"));
  assert.ok(result.messages[0].content.includes("Original prompt"));
  assert.ok(result.messages[0].content.trimEnd().endsWith("AFTER"));
  assert.equal(result.messages.length, 2);
});

test("injectSystemPrompt: only prefix prepends before system message", () => {
  setSystemPromptConfig({ enabled: true, prefixPrompt: "PREFIX", suffixPrompt: "" });
  const body = {
    messages: [
      { role: "system", content: "Agent instructions" },
      { role: "user", content: "hi" },
    ],
  };
  const result = injectSystemPrompt(body);
  assert.ok(result.messages[0].content.startsWith("PREFIX"));
  assert.ok(result.messages[0].content.includes("Agent instructions"));
});

test("injectSystemPrompt: Claude body.system string — prefix/suffix wrap (#2468)", () => {
  setSystemPromptConfig({ enabled: true, prefixPrompt: "PRE", suffixPrompt: "SUF" });
  const body = {
    system: "Claude prompt",
    messages: [{ role: "user", content: "hi" }],
  };
  const result = injectSystemPrompt(body);
  assert.ok(result.system.startsWith("PRE"));
  assert.ok(result.system.includes("Claude prompt"));
  assert.ok(result.system.trimEnd().endsWith("SUF"));
});

test("injectSystemPrompt: Claude array system field — prefix/suffix wrap (#2468)", () => {
  setSystemPromptConfig({ enabled: true, prefixPrompt: "PRE", suffixPrompt: "SUF" });
  const body = {
    system: [{ type: "text", text: "Claude prompt" }],
    messages: [{ role: "user", content: "hi" }],
  };
  const result = injectSystemPrompt(body);
  assert.ok(Array.isArray(result.system));
  assert.equal(result.system[0].text, "PRE");
  assert.equal(result.system[1].text, "Claude prompt");
  assert.equal(result.system[2].text, "SUF");
  assert.equal(result.system.length, 3);
});

test("injectSystemPrompt: _skipSystemPrompt bypasses", () => {
  setSystemPromptConfig({ enabled: true, suffixPrompt: "GLOBAL:" });
  const body = {
    _skipSystemPrompt: true,
    messages: [{ role: "user", content: "hi" }],
  };
  const result = injectSystemPrompt(body);
  assert.deepEqual(result, body);
});

test("injectSystemPrompt: null body returns as-is", () => {
  setSystemPromptConfig({ enabled: true, suffixPrompt: "test" });
  assert.equal(injectSystemPrompt(null), null);
});

test("injectSystemPrompt: developer role treated as system", () => {
  setSystemPromptConfig({ enabled: true, prefixPrompt: "PRE", suffixPrompt: "SUF" });
  const body = {
    messages: [
      { role: "developer", content: "Dev instructions" },
      { role: "user", content: "hi" },
    ],
  };
  const result = injectSystemPrompt(body);
  assert.ok(result.messages[0].content.startsWith("PRE"));
  assert.ok(result.messages[0].content.includes("Dev instructions"));
  assert.ok(result.messages[0].content.trimEnd().endsWith("SUF"));
});

// Reset
test.after(() => setSystemPromptConfig({ enabled: false, prefixPrompt: "", suffixPrompt: "" }));

test("injectSystemPrompt: claude-shaped body keeps prompt out of messages[0] (#12584)", () => {
  setSystemPromptConfig({ enabled: true, prefixPrompt: "PRE", suffixPrompt: "SUF" });
  const body = {
    system: "You are Claude Code.",
    messages: [{ role: "user", content: "hi" }],
  };
  const result = injectSystemPrompt(body);
  assert.equal(result.messages.length, 1);
  assert.equal(result.messages[0].role, "user");
  assert.ok(String(result.system).includes("You are Claude Code."));
  assert.ok(String(result.system).includes("PRE"));
  assert.ok(String(result.system).includes("SUF"));
});

test("injectSystemPrompt: malformed null system still receives the prompt (#12584)", () => {
  setSystemPromptConfig({ enabled: true, prefixPrompt: "PRE", suffixPrompt: "SUF" });
  const body = {
    system: null,
    messages: [{ role: "user", content: "hi" }],
  };
  const result = injectSystemPrompt(body);
  assert.equal(typeof result.system, "string", "null system is normalized, not skipped");
  assert.ok(String(result.system).includes("PRE"), "prefix is not silently dropped");
  assert.ok(String(result.system).includes("SUF"), "suffix is not silently dropped");
  assert.equal(result.messages.length, 1, "prompt does not leak into messages");
  assert.equal(result.messages[0].role, "user");
});
