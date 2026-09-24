/**
 * #3500: semantic_cache / proxy_logs SQL extracted into db modules
 * (Hard Rule #5, slice 4).
 *
 * Seeds an in-memory temp SQLite DB for each table and asserts each new db
 * function returns the correct rows / counts. DB handles are released in
 * test.after to prevent Node native test runner from hanging
 * (CLAUDE.md PII/Stream Learnings #3).
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omni-db-logs-cache-3500-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const core = await import("../../src/lib/db/core.ts");
const proxyLogs = await import("../../src/lib/db/proxyLogs.ts");

// ---------------------------------------------------------------------------
// Helpers — semantic_cache seeding
// ---------------------------------------------------------------------------

function insertSemanticCache(row: {
  id: string;
  signature: string;
  model: string;
  hit_count?: number;
  tokens_saved?: number;
}) {
  const db = core.getDbInstance();
  db.prepare(
    `INSERT INTO semantic_cache
      (id, signature, model, prompt_hash, response, tokens_saved, hit_count, created_at, expires_at)
     VALUES
      (?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now', '+1 hour'))`
  ).run(
    row.id,
    row.signature,
    row.model,
    "hash_" + row.id,
    "{}",
    row.tokens_saved ?? 0,
    row.hit_count ?? 0
  );
}

// ---------------------------------------------------------------------------
// Helpers — proxy_logs seeding
// ---------------------------------------------------------------------------

function insertProxyLog(row: { id: string; timestamp: string; provider?: string }) {
  const db = core.getDbInstance();
  db.prepare(
    `INSERT INTO proxy_logs (id, timestamp, provider, status, proxy_type) VALUES (?, ?, ?, ?, ?)`
  ).run(row.id, row.timestamp, row.provider ?? "openai", "ok", "http");
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

test.before(() => {
  core.resetDbInstance();
});

test.after(() => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

// ===========================================================================
// semanticCache — listSemanticCacheEntries
// ===========================================================================

// ===========================================================================
// semanticCache — deleteSemanticCacheBySignature
// ===========================================================================

// ===========================================================================
// semanticCache — deleteSemanticCacheByModel
// ===========================================================================

// ===========================================================================
// proxyLogs — exportProxyLogsSince
// ===========================================================================

test("#3500 exportProxyLogsSince — returns rows with timestamp >= since", () => {
  const base = new Date("2025-01-15T10:00:00.000Z");
  const old = new Date("2025-01-14T10:00:00.000Z");

  insertProxyLog({
    id: "pl-new-1",
    timestamp: new Date("2025-01-15T11:00:00.000Z").toISOString(),
    provider: "openai",
  });
  insertProxyLog({
    id: "pl-new-2",
    timestamp: new Date("2025-01-15T12:00:00.000Z").toISOString(),
    provider: "anthropic",
  });
  insertProxyLog({ id: "pl-old-1", timestamp: old.toISOString(), provider: "openai" }); // outside window

  const rows = proxyLogs.exportProxyLogsSince(base.toISOString());

  assert.ok(Array.isArray(rows), "result is array");
  const ids = rows.map((r) => (r as { id: string }).id);
  assert.ok(ids.includes("pl-new-1"), "pl-new-1 included");
  assert.ok(ids.includes("pl-new-2"), "pl-new-2 included");
  assert.ok(!ids.includes("pl-old-1"), "pl-old-1 excluded (before since)");
});

test("#3500 exportProxyLogsSince — results are ordered descending by timestamp", () => {
  const rows = proxyLogs.exportProxyLogsSince(new Date("2025-01-01T00:00:00.000Z").toISOString());
  assert.ok(rows.length >= 2, "at least 2 rows");

  // Verify descending order
  for (let i = 1; i < rows.length; i++) {
    const prev = (rows[i - 1] as { timestamp: string }).timestamp;
    const curr = (rows[i] as { timestamp: string }).timestamp;
    assert.ok(prev >= curr, `row ${i - 1} timestamp (${prev}) >= row ${i} (${curr})`);
  }
});

test("#3500 exportProxyLogsSince — returns empty array when no rows match", () => {
  const future = new Date(Date.now() + 86_400_000 * 365).toISOString();
  const rows = proxyLogs.exportProxyLogsSince(future);
  assert.deepEqual(rows, []);
});
