import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import test from "node:test";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-combo-empty-models-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const { createComboSchema, updateComboSchema } =
  await import("../../src/shared/validation/schemas/combo.ts");
const combosDb = await import("../../src/lib/db/combos.ts");
const core = await import("../../src/lib/db/core.ts");

test.after(() => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test("an update cannot remove every model from a combo", () => {
  assert.equal(updateComboSchema.safeParse({ models: [] }).success, false);
  assert.equal(updateComboSchema.safeParse({ models: ["openai/gpt-4o-mini"] }).success, true);
  assert.equal(updateComboSchema.safeParse({ name: "renamed" }).success, true);
});

test("creating a combo without a model is refused at the boundary", () => {
  assert.equal(createComboSchema.safeParse({ name: "drafted", models: [] }).success, false);
  assert.equal(createComboSchema.safeParse({ name: "drafted" }).success, false);
});

