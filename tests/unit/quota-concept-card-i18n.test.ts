import test from "node:test";
import assert from "node:assert/strict";
import en from "../../src/i18n/messages/en.json" with { type: "json" };

const KEYS = [
  "conceptKeyHowTitle",
  "conceptKeyHowDesc",
  "conceptExclusiveTitle",
  "conceptExclusiveDesc",
];
test("explanatory card i18n keys exist", () => {
  for (const k of KEYS) {
    assert.equal(typeof (en as any).quotaShare[k], "string", `en missing ${k}`);
  }
});
