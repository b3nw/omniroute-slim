// #11853 — the Providers dashboard crashed client-side with
// "TypeError: Cannot read properties of undefined (reading 'color')" and the
// providers error boundary then rendered a misleading "Failed to load
// providers / check your connection" card.
//
// Root cause: `getLobeProviderIcon()` indexed two plain object literals
// (LOBE_PROVIDER_ALIASES → LOBE_ICON_COMPONENTS) without own-key checks. A
// provider id whose lowercased form matches an `Object.prototype` member
// resolved to the inherited value, passed the truthy alias check, and then
// dereferenced `.color` on an `undefined` component entry.
import test from "node:test";
import assert from "node:assert/strict";

import { getLobeProviderIcon } from "../../src/shared/components/lobeProviderIcons.ts";

// Every realistic collision after `.toLowerCase()`: the enumerable-looking
// members of Object.prototype that a computed provider id could produce.
const PROTOTYPE_COLLISION_IDS = [
  "constructor",
  "__proto__",
  "tostring",
  "valueof",
  "hasownproperty",
  "isprototypeof",
  "propertyisenumerable",
  "tolocalestring",
];

test("prototype-colliding provider ids return null instead of throwing", () => {
  for (const id of PROTOTYPE_COLLISION_IDS) {
    for (const type of ["color", "mono"] as const) {
      assert.doesNotThrow(
        () => getLobeProviderIcon(id, type),
        `getLobeProviderIcon(${JSON.stringify(id)}, "${type}") must not throw`
      );
      assert.equal(
        getLobeProviderIcon(id, type),
        null,
        `getLobeProviderIcon(${JSON.stringify(id)}, "${type}") must resolve to null`
      );
    }
  }
});

test("prototype-colliding ids stay null regardless of casing", () => {
  assert.equal(getLobeProviderIcon("CONSTRUCTOR", "mono"), null);
  assert.equal(getLobeProviderIcon("Constructor", "color"), null);
  assert.equal(getLobeProviderIcon("__PROTO__", "color"), null);
  assert.equal(getLobeProviderIcon("ToString", "mono"), null);
});

test("a missing / non-string provider id returns null instead of throwing", () => {
  for (const bogus of [undefined, null, 42, {}, []]) {
    assert.doesNotThrow(() => getLobeProviderIcon(bogus as unknown as string, "color"));
    assert.equal(getLobeProviderIcon(bogus as unknown as string, "color"), null);
  }
});

test("unknown-but-harmless provider ids still return null", () => {
  assert.equal(getLobeProviderIcon("openai-compatible-test-node-xyz", "color"), null);
  assert.equal(getLobeProviderIcon("", "color"), null);
});

test("known provider ids still resolve to an icon component", () => {
  // Both are own keys of LOBE_PROVIDER_ALIASES ("openai" → OpenAI, mono-only;
  // "anthropic" → Anthropic, mono-only; "claude" → ClaudeCode, mono + color).
  for (const id of ["openai", "anthropic", "claude", "gemini", "zhipu"]) {
    for (const type of ["color", "mono"] as const) {
      const icon = getLobeProviderIcon(id, type);
      assert.ok(icon, `getLobeProviderIcon("${id}", "${type}") must resolve to a component`);
    }
  }
});

test("lookup stays case-insensitive for known ids", () => {
  assert.equal(getLobeProviderIcon("OpenAI", "mono"), getLobeProviderIcon("openai", "mono"));
  assert.equal(
    getLobeProviderIcon("ANTHROPIC", "color"),
    getLobeProviderIcon("anthropic", "color")
  );
});

test("color falls back to mono only when the entry has no color variant", () => {
  // OpenAI ships mono only → "color" must reuse the mono component.
  assert.equal(getLobeProviderIcon("openai", "color"), getLobeProviderIcon("openai", "mono"));
  // Zhipu ships both → the two variants must be distinct components.
  assert.notEqual(getLobeProviderIcon("zhipu", "color"), getLobeProviderIcon("zhipu", "mono"));
});

test("the default type is color", () => {
  assert.equal(getLobeProviderIcon("zhipu"), getLobeProviderIcon("zhipu", "color"));
});
