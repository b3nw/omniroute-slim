import test from "node:test";
import assert from "node:assert/strict";

// #17113: a family-fallback sibling can reach the upstream under a provider wire
// alias that differs from its catalog id. GitHub's catalog exposes
// `claude-opus-4.5`, which PROVIDER_MODEL_ALIASES maps to the wire id
// `claude-opus-4-5-20251101`. A model lock recorded under that wire id on the
// selected connection must exclude the sibling — the catalog-id lock alone does
// not see it. Locks are real (lockModel/isModelLocked), not mocked.
const locks = await import("../../open-sse/services/accountFallback.ts");
const family = await import("../../open-sse/services/modelFamilyFallback.ts");

const CURRENT = "github/claude-opus-4-7";
const WIRE_MODEL = "claude-opus-4-5-20251101";
const tried = () => new Set([CURRENT, "github/claude-opus-4.6"]);

test.beforeEach(() => locks.clearAllModelLockouts());
test.after(() => locks.clearAllModelLockouts());

test("an unlocked sibling is still returned", () => {
  assert.equal(
    family.getNextEligibleFamilyFallback(CURRENT, tried(), "github", "conn-selected"),
    "github/claude-opus-4.5"
  );
  assert.equal(
    family.isFamilyFallbackEligible("github/claude-opus-4.5", "github", "conn-selected"),
    true
  );
});

test("a sibling locked under its wire alias on the selected connection is skipped", () => {
  locks.lockModel("github", "conn-selected", WIRE_MODEL, "not_found", 60_000);
  assert.equal(locks.isModelLocked("github", "conn-selected", WIRE_MODEL), true);
  assert.equal(
    locks.isModelLocked("github", "conn-selected", "claude-opus-4.5"),
    false,
    "the catalog id itself is not locked — only the wire alias is"
  );

  assert.equal(
    family.isFamilyFallbackEligible("github/claude-opus-4.5", "github", "conn-selected"),
    false
  );
  assert.equal(
    family.getNextEligibleFamilyFallback(CURRENT, tried(), "github", "conn-selected"),
    "github/claude-sonnet-5",
    "the locked wire alias must be excluded from family dispatch"
  );
});

test("a sibling locked under its catalog id on the selected connection is skipped", () => {
  locks.lockModel("github", "conn-selected", "claude-opus-4.5", "not_found", 60_000);
  assert.equal(
    family.getNextEligibleFamilyFallback(CURRENT, tried(), "github", "conn-selected"),
    "github/claude-sonnet-5"
  );
});

test("another account's wire-alias lock does not apply to the selected connection", () => {
  locks.lockModel("github", "conn-other", WIRE_MODEL, "not_found", 60_000);
  assert.equal(locks.isModelLocked("github", "conn-other", WIRE_MODEL), true);
  assert.equal(
    family.getNextEligibleFamilyFallback(CURRENT, tried(), "github", "conn-selected"),
    "github/claude-opus-4.5"
  );
});

test("getNextFamilyFallback stays lock-agnostic for its existing callers", () => {
  locks.lockModel("github", "conn-selected", WIRE_MODEL, "not_found", 60_000);
  assert.equal(family.getNextFamilyFallback(CURRENT, tried(), "github"), "github/claude-opus-4.5");
});
