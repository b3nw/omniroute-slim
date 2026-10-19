import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SCRIPT = path.join(repoRoot, "scripts", "flags-drift.mjs");

function run(args: string[]) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8" });
}

function withFiles(files: Record<string, unknown>, fn: (dir: string) => void) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "flags-drift-"));
  try {
    for (const [name, body] of Object.entries(files)) {
      writeFileSync(path.join(dir, name), JSON.stringify(body));
    }
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const expect = {
  dev: { INPUT_SANITIZER_ENABLED: true, ENABLE_TLS_FINGERPRINT: false, SOME_ENUM: "fast" },
};
const flag = (key: string, effectiveValue: string, source: string) => ({
  key,
  effectiveValue,
  source,
});

test("exits 0 and reports sources when the live flags match the expected profile", () => {
  withFiles(
    {
      "expect.json": expect,
      "live.json": {
        flags: [
          flag("INPUT_SANITIZER_ENABLED", "true", "default"),
          flag("ENABLE_TLS_FINGERPRINT", "false", "env"),
          flag("SOME_ENUM", "fast", "db"),
          flag("UNLISTED", "true", "default"),
        ],
      },
    },
    (dir) => {
      const res = run([
        "--tier",
        "dev",
        "--expect",
        path.join(dir, "expect.json"),
        "--file",
        path.join(dir, "live.json"),
        "--json",
      ]);
      assert.equal(res.status, 0, res.stderr);
      const out = JSON.parse(res.stdout);
      assert.equal(out.drift, 0);
      assert.equal(out.unchecked, 1);
      assert.deepEqual(
        out.rows.map((r: { source: string }) => r.source),
        ["default", "env", "db-override"]
      );
    }
  );
});

test("exits 1 on drift and on flags missing from the live response", () => {
  withFiles(
    {
      "expect.json": expect,
      "live.json": [
        flag("INPUT_SANITIZER_ENABLED", "false", "db"),
        flag("ENABLE_TLS_FINGERPRINT", "false", "default"),
      ],
    },
    (dir) => {
      const res = run([
        "--tier=dev",
        "--expect",
        path.join(dir, "expect.json"),
        "--file",
        path.join(dir, "live.json"),
      ]);
      assert.equal(res.status, 1, res.stderr);
      assert.match(res.stdout, /INPUT_SANITIZER_ENABLED\s+true\s+false\s+db-override\s+DRIFT/);
      assert.match(res.stdout, /SOME_ENUM\s+fast\s+—\s+—\s+MISSING/);
    }
  );
});

test("exits 2 on usage errors and unreadable input", () => {
  assert.equal(run([]).status, 2);
  assert.equal(run(["--tier", "staging", "--file", "x.json"]).status, 2);
  assert.equal(run(["--tier", "dev", "--file", "/nonexistent/flags.json"]).status, 2);
  assert.equal(run(["--help"]).status, 0);
});

test("the tracked ops/flags.expect.json has dev and prod profiles of known flag keys", async () => {
  const { FEATURE_FLAG_DEFINITIONS } = await import("@/shared/constants/featureFlagDefinitions");
  const known = new Set(FEATURE_FLAG_DEFINITIONS.map((d: { key: string }) => d.key));
  const tracked = (await import("../../ops/flags.expect.json", { with: { type: "json" } })).default;
  for (const tier of ["dev", "prod"]) {
    const keys = Object.keys(tracked[tier]);
    assert.ok(keys.length > 0, `${tier} profile empty`);
    for (const key of keys) assert.ok(known.has(key), `${tier}: unknown flag ${key}`);
  }
});
