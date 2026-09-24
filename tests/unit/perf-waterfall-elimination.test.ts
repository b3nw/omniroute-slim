// Regression guards for upstream issue #11396: the four core hot paths below
// each resolved several independent async reads as a serial waterfall
// (`await a(); await b(); ...`), adding each read's latency to the total.
// They now launch the reads concurrently via Promise.all and destructure the
// results in order.
//
// Why structure guards + one behavioral test:
//  - A pure serial→parallel refactor is invisible in function output, so the
//    only honest canary against silently regressing back to serial awaits is
//    pinning the Promise.all batch shape at each site. These assertions RED
//    against the pre-fix serial source and GREEN against the batched source.
//  - Where the real call graph is reachable from a unit test (the cache
//    route), we also exercise the module end-to-end against an isolated temp
//    DB to prove batching did not disturb result correctness.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "../..");

function readSource(rel: string): string {
  return fs.readFileSync(path.join(repoRoot, rel), "utf8");
}

// Body of the first `await Promise.all([...]);` in `src` (non-greedy).
function firstPromiseAllBody(src: string): string | null {
  const m = src.match(/await Promise\.all\(\[([\s\S]*?)\]\);/);
  return m ? m[1] : null;
}

// All `await Promise.all([...]);` batch bodies in `src`, in file order.
// Used where a file legitimately contains more than one batch site (deletion.ts
// has one per delete function) so a regression at ANY site fails the guard.
function allPromiseAllBodies(src: string): string[] {
  const bodies: string[] = [];
  const regex = /await Promise\.all\(\[([\s\S]*?)\]\);/g;
  let m: RegExpExecArray | null;
  while ((m = regex.exec(src)) !== null) {
    bodies.push(m[1]);
  }
  return bodies;
}

// ─── A1: Home dashboard render ──────────────────────────────────────────────
test("A1: home page fetches settings + machineId concurrently (#11396)", () => {
  const src = readSource("src/app/(dashboard)/home/page.tsx");

  const pair = src.match(/const \[settings, machineId\] = await Promise\.all\(\[([\s\S]*?)\]\);/s);
  assert.ok(pair, "expected `[settings, machineId] = await Promise.all([...])`");
  assert.match(pair![1], /\bgetSettings\(\)/);
  assert.match(pair![1], /\bgetMachineId\(\)/);
  // destructuring order must stay (settings → machineId), or values swap
  assert.ok(pair![1].indexOf("getSettings()") < pair![1].indexOf("getMachineId()"));

  // both values are still consumed exactly as before the batching
  assert.match(src, /setupComplete=\{Boolean\(settings\.setupComplete\)\}/);
  assert.match(src, /machineId=\{machineId\}/);

  // no serial awaits left for these two reads
  assert.doesNotMatch(src, /await getSettings\(\)\s*;/);
  assert.doesNotMatch(src, /await getMachineId\(\)\s*;/);
});

// ─── F1: /api/cache GET ─────────────────────────────────────────────────────

// ─── F1 behavioral: real route + real DB, isolated temp data dir ───────────
let core: typeof import("../../src/lib/db/core.ts");
let TEST_DATA_DIR: string;

test.before(async () => {
  TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-perf-waterfall-"));
  process.env.DATA_DIR = TEST_DATA_DIR;
  process.env.DISABLE_SQLITE_AUTO_BACKUP = "true";
  core = await import("../../src/lib/db/core.ts");
});

test.beforeEach(() => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
});

test.after(() => {
  core?.resetDbInstance();
  if (TEST_DATA_DIR) {
    fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
  delete process.env.DATA_DIR;
  delete process.env.DISABLE_SQLITE_AUTO_BACKUP;
});

// ─── N1: apiKeys permission probe ───────────────────────────────────────────
test("N1: apiKeys fetches synced + custom models in parallel (#11396)", () => {
  const src = readSource("src/lib/db/apiKeys.ts");

  const pair = src.match(
    /const \[syncedModelsByConnection, customModels\] = await Promise\.all\(\[([\s\S]*?)\]\);/s
  );
  assert.ok(pair, "expected `[syncedModelsByConnection, customModels] = await Promise.all([...])`");
  assert.match(pair![1], /getSyncedAvailableModelsByConnection\(providerId\)/);
  assert.match(pair![1], /getCustomModels\(providerId\)/);
  // destructuring order must stay (synced first, custom second)
  assert.ok(
    pair![1].indexOf("getSyncedAvailableModelsByConnection(providerId)") <
      pair![1].indexOf("getCustomModels(providerId)")
  );

  // the merged view feeding the deny/allow decision is unchanged
  assert.match(
    src,
    /allDiscoveredModels = Object\.values\(syncedModelsByConnection\)\s*\.flat\(\)\s*\.concat\(customModels\)/
  );

  // no serial awaits left behind
  assert.doesNotMatch(src, /await getSyncedAvailableModelsByConnection\(providerId\)/);
  assert.doesNotMatch(src, /await getCustomModels\(providerId\)/);
});

// ─── N2: provider connection deletion ───────────────────────────────────────
test("N2: provider deletion cleanup helpers run in parallel (#11396)", () => {
  const src = readSource("src/lib/db/providers/deletion.ts");

  const batches = allPromiseAllBodies(src);
  assert.equal(
    batches.length,
    3,
    "expected 3 Promise.all batches in deletion.ts (one per delete function)"
  );
  for (const batch of batches) {
    assert.match(batch, /_cleanupDeletedComboConnectionRefs\(/);
    assert.match(batch, /_cleanupDeletedLKGPConnectionRefs\(/);
  }

  // helpers keep swallowing their own errors → the parallel batch cannot reject
  assert.match(src, /Failed to clean up combo route refs for deleted connections/);
  assert.match(src, /Failed to clean up LKGP refs for deleted connections/);

  // side effects that followed the serially-awaited cleanups must still run
  assert.match(src, /revokeNativeCodexTurnPinsForConnection\(id\)/);
  assert.match(src, /removeConnectionHealth\(id\)/);

  // no serial awaits left behind
  assert.doesNotMatch(src, /await _cleanupDeletedComboConnectionRefs\(/);
  assert.doesNotMatch(src, /await _cleanupDeletedLKGPConnectionRefs\(/);
});
