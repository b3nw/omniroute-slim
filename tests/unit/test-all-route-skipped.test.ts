// /api/models/test-all must propagate the runner's `skipped` flag and never
// auto-hide a skipped (never-dispatched) generation-only model.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { makeManagementSessionRequest } from "../helpers/managementSession.ts";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-test-all-skipped-"));
const ORIGINAL_DATA_DIR = process.env.DATA_DIR;
const ORIGINAL_JWT_SECRET = process.env.JWT_SECRET;
process.env.DATA_DIR = TEST_DATA_DIR;

const core = await import("../../src/lib/db/core.ts");
const { addCustomModel, getModelIsHidden } = await import("../../src/lib/db/models.ts");
const route = await import("../../src/app/api/models/test-all/route.ts");

const originalFetch = globalThis.fetch;

test.after(() => {
  globalThis.fetch = originalFetch;
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  if (ORIGINAL_DATA_DIR === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = ORIGINAL_DATA_DIR;
  if (ORIGINAL_JWT_SECRET === undefined) delete process.env.JWT_SECRET;
  else process.env.JWT_SECRET = ORIGINAL_JWT_SECRET;
});

test("skipped generation-only model is flagged and not auto-hidden", async () => {
  await addCustomModel(
    "agnes",
    "agnes-image-2.1-flash",
    undefined,
    "manual",
    "images-generations",
    ["chat", "images"]
  );

  let dispatched = false;
  globalThis.fetch = async () => {
    dispatched = true;
    throw new Error("a generation-only model must not be dispatched");
  };

  try {
    const response = await route.POST(
      await makeManagementSessionRequest("http://localhost/api/models/test-all", {
        method: "POST",
        body: {
          providerId: "agnes",
          modelIds: ["agnes-image-2.1-flash"],
          autoHideFailed: true,
        },
      })
    );
    assert.equal(response.status, 200);
    const body = (await response.json()) as {
      results: Record<string, { status: string; skipped?: boolean; hidden?: boolean }>;
    };
    const entry = body.results["agnes-image-2.1-flash"];

    assert.equal(dispatched, false);
    assert.equal(entry.status, "error");
    assert.equal(entry.skipped, true);
    assert.equal(entry.hidden, undefined);
    assert.equal(getModelIsHidden("agnes", "agnes-image-2.1-flash"), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
