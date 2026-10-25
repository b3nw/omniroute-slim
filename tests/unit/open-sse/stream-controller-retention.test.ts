import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const WORKER = join(process.cwd(), "tests/unit/open-sse/stream-controller-retention.worker.ts");

type RetentionEntry = {
  mode: string;
  retained: boolean;
  draining: boolean;
  calls: { disconnect: number; error: number; drain: number };
};

async function runWorker(): Promise<RetentionEntry[]> {
  const dataDir = mkdtempSync(join(tmpdir(), "stream-retention-"));
  try {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      [
        "--expose-gc",
        "--max-old-space-size=4096",
        "--import",
        "tsx/esm",
        "--import",
        "./open-sse/utils/setupPolyfill.ts",
        "--import",
        "./tests/_setup/isolateDataDir.ts",
        WORKER,
      ],
      {
        env: { ...process.env, DATA_DIR: dataDir, DISABLE_SQLITE_AUTO_BACKUP: "true" },
        timeout: 120_000,
        maxBuffer: 16 * 1024 * 1024,
      }
    );
    const line = `${stdout}\n${stderr}`
      .split("\n")
      .find((l) => l.startsWith("RETENTION_RESULT="));
    assert.ok(line, "worker must emit RETENTION_RESULT");
    return JSON.parse(line!.slice("RETENTION_RESULT=".length));
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
}

test("stream controller releases request payloads after abort, complete, disconnect and error", async () => {
  const results = await runWorker();
  const byMode = new Map(results.map((r) => [r.mode, r]));

  // Sanity: a live, un-terminated controller must still hold its payload.
  assert.equal(byMode.get("active")?.retained, true, "active controller should retain its payload");

  // Terminal paths must not retain request-scoped payloads (fixture 0 retained after abort).
  for (const mode of ["abort", "complete", "disconnect", "error"]) {
    const entry = byMode.get(mode);
    assert.ok(entry, `missing mode ${mode}`);
    assert.equal(entry.retained, false, `${mode}: controller retained payload after termination`);
    assert.equal(entry.draining, false, `${mode}: controller should not be draining`);
  }

  assert.equal(byMode.get("abort")?.calls.disconnect, 0, "abort must not fire onDisconnect");
  assert.equal(byMode.get("disconnect")?.calls.disconnect, 1, "disconnect must fire onDisconnect once");
  assert.equal(byMode.get("error")?.calls.error, 1, "error must fire onError once");
});

test("completed tool handoff keeps the drain alive while releasing request callbacks", async () => {
  const results = await runWorker();
  const handoff = results.find((r) => r.mode === "handoff");
  assert.ok(handoff, "missing handoff mode");
  assert.equal(handoff.draining, true, "handoff grace should keep draining");
  assert.equal(handoff.calls.disconnect, 1);
  assert.equal(handoff.calls.drain, 1, "drain callback should run during handoff grace");
});
