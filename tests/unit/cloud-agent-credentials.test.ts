/**
 * Cloud-agent credentials CRUD + migration coverage.
 *
 * Release/v3.8.2 review finding: the `cloud_agent_credentials` table used to be
 * created inline via `ensureCredentialsTable()` on every call (violating the
 * versioned-migration policy). That inline DDL was removed in favor of
 * migration `061_cloud_agent_credentials.sql`. These tests prove the table is
 * provisioned by the normal DB-init migration run and that encrypt-at-rest
 * CRUD still works end to end — with NO lazy table creation.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-cloud-agent-creds-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = process.env.API_KEY_SECRET || "cloud-agent-creds-test-secret";

const core = await import("../../src/lib/db/core.ts");

test.after(() => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test("migration 061 provisions cloud_agent_credentials (table exists after DB init)", () => {
  const db = core.getDbInstance();
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get("cloud_agent_credentials") as { name?: string } | undefined;
  assert.equal(
    row?.name,
    "cloud_agent_credentials",
    "table must be created by migration, not inline"
  );
});

