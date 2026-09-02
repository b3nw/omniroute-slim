import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-passthrough-test-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const { REGISTRY } = await import("@omniroute/open-sse/config/providerRegistry.ts");
const { getModelInfo } = await import("../../src/sse/services/model.ts");
const { getDbInstance, closeDatabase } = await import("../../src/lib/db/core.ts");

test.before(() => {
  getDbInstance();
});

test.after(() => {
  try {
    closeDatabase();
    fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

test("gemini provider has passthroughModels enabled and liveCatalogAuthoritative disabled", () => {
  const gemini = REGISTRY.gemini;
  assert.equal(gemini.passthroughModels, true);
  assert.equal(gemini.liveCatalogAuthoritative, false);
});

test("getModelInfo allows un-synced model IDs when passthroughModels is enabled", async () => {
  const info = await getModelInfo("gemini/gemini-3.5-flash-lite");
  assert.equal(info.provider, "gemini");
  assert.equal(info.model, "gemini-3.5-flash-lite");
  assert.equal(info.errorType, undefined);
});

test("getModelInfo allows static registry models even if connection exists with partial sync", async () => {
  const info = await getModelInfo("gemini/gemini-flash-lite-latest");
  assert.equal(info.provider, "gemini");
  assert.equal(info.model, "gemini-flash-lite-latest");
  assert.equal(info.errorType, undefined);
});
