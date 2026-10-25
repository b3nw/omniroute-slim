import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const dataDir = mkdtempSync(join(tmpdir(), "stream-controller-retention-"));
test.after(() => rmSync(dataDir, { recursive: true, force: true }));
const worker = fileURLToPath(new URL("./stream-controller-retention.worker.ts", import.meta.url));
const child = spawnSync(process.execPath, ["--expose-gc", "--import", "tsx/esm", worker], {
  env: { ...process.env, DATA_DIR: dataDir, NODE_ENV: "test", DISABLE_SQLITE_AUTO_BACKUP: "true" },
  encoding: "utf8", timeout: 180_000,
});
assert.equal(child.status, 0, `${child.stdout}\n${child.stderr}`);
const resultLine = child.stdout.split("\n").find((line) => line.startsWith("RETENTION_RESULT="));
assert.ok(resultLine);
const results = JSON.parse(resultLine.slice("RETENTION_RESULT=".length));

test("active controller callbacks and handoff drain remain live", () => {
  assert.equal(results.find((r) => r.mode === "active").retained, true);
  const handoff = results.find((r) => r.mode === "handoff");
  assert.equal(handoff.draining, true);
  assert.equal(handoff.calls.drain, 1);
});
for (const mode of ["complete", "disconnect", "error", "abort"]) {
  test(`${mode} releases request callback captures`, () => {
    assert.equal(results.find((r) => r.mode === mode).retained, false);
  });
}
