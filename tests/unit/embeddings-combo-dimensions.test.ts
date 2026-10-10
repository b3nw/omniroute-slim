/**
 * TDD regression guard: embedding combo `dimensions` field is persisted and
 * injected into upstream embedding requests. Ported from decolua/9router#1530.
 *
 * Test 1: `dimensions` can be stored on a combo and is read back correctly.
 * Test 2: When the client omits `dimensions`, the combo-stored value is injected
 *         into the body forwarded to handleComboChat as an integer.
 * Test 3: A client-supplied `dimensions` value wins over the combo default.
 * Test 4: Combos without `dimensions` leave the upstream body unchanged.
 *
 * Uses a throwaway DATA_DIR so migrations run against a temp DB.
 * DB handle released in test.after() per CLAUDE.md learning #3.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "omniroute-embed-dim-"));

const { createCombo, getComboByName } = await import("../../src/lib/db/combos.ts");
const { resetDbInstance } = await import("../../src/lib/db/core.ts");

test.after(() => {
  resetDbInstance();
});

// ─── Test 1: dimensions stored and retrieved from combo ───────────────────────

test("combo created with dimensions persists the value", async () => {
  await createCombo({
    name: "dim-test-store",
    strategy: "priority",
    models: ["openai/text-embedding-3-small"],
    dimensions: "1024",
  });

  const stored = await getComboByName("dim-test-store");
  assert.ok(stored !== null, "combo should exist");
  assert.equal(
    String((stored as Record<string, unknown>).dimensions),
    "1024",
    "dimensions must be persisted in the combo record"
  );
});

test("combo created without dimensions has no dimensions field", async () => {
  await createCombo({
    name: "dim-test-no-dim",
    strategy: "priority",
    models: ["openai/text-embedding-3-small"],
  });

  const stored = await getComboByName("dim-test-no-dim");
  assert.ok(stored !== null, "combo should exist");
  const record = stored as Record<string, unknown>;
  const dim = record.dimensions;
  // dimensions should be absent or null/undefined — not set to some bogus value
  assert.ok(
    dim === undefined || dim === null,
    `dimensions should be absent/null when not set, got: ${JSON.stringify(dim)}`
  );
});

// ─── Test 2–4: dimensions injection logic (unit-level) ───────────────────────
//
// applyComboDimensions is the exact helper createEmbeddingResponse uses before
// dispatching to handleComboChat.

const { applyComboDimensions } = await import("../../src/lib/embeddings/service.ts");

test("combo dimensions injected as an integer when client body has no dimensions", () => {
  const body = { model: "my-combo", input: "hello" };
  const combo = { name: "my-combo", dimensions: "512" };
  const result = applyComboDimensions(body, combo);
  assert.strictEqual(result.dimensions, 512, "combo dimensions must be injected as a number");
});

test("numeric combo dimensions are injected unchanged", () => {
  const result = applyComboDimensions({ model: "my-combo" }, { dimensions: 768 });
  assert.strictEqual(result.dimensions, 768);
});

test("client-supplied dimensions take precedence over combo dimensions", () => {
  const body = { model: "my-combo", input: "hello", dimensions: 256 };
  const combo = { name: "my-combo", dimensions: "512" };
  const result = applyComboDimensions(body, combo);
  assert.strictEqual(result.dimensions, 256, "client dimensions must not be overridden");
});

test("no dimensions injected when combo has none", () => {
  const body = { model: "my-combo", input: "hello" };
  const combo = { name: "my-combo" }; // no dimensions
  const result = applyComboDimensions(body, combo);
  assert.equal(result.dimensions, undefined, "dimensions must not appear when combo has none");
});

test("null combo dimensions treated as absent — no injection", () => {
  const body = { model: "my-combo", input: "hello" };
  const combo = { name: "my-combo", dimensions: null };
  const result = applyComboDimensions(body, combo);
  assert.equal(result.dimensions, undefined, "null combo dimensions must not be injected");
});

test("non-integer or non-positive combo dimensions are ignored", () => {
  for (const dimensions of ["abc", "12.5", "0", "-8", ""]) {
    const result = applyComboDimensions({ model: "my-combo" }, { dimensions });
    assert.equal(result.dimensions, undefined, `invalid dimensions ${JSON.stringify(dimensions)}`);
  }
});
