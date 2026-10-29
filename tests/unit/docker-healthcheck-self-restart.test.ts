import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Docker never restarts an `unhealthy` container on its own; the healthcheck
// script tracks consecutive failures in a state file and signals PID 1 once
// the server has been armed (seen healthy, or explicitly reports unhealthy).
const { probeHealth, handleHealthcheckOutcome } =
  (await import("../../scripts/dev/healthcheck.mjs")) as any;

const stateFiles: string[] = [];
function tempStateFile(label: string) {
  const file = path.join(
    os.tmpdir(),
    `omniroute-hc-test-${label}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.json`
  );
  stateFiles.push(file);
  return file;
}

test.after(() => {
  for (const file of stateFiles) fs.rmSync(file, { force: true });
});

function harness(label: string, env: Record<string, string> = {}) {
  const stateFilePath = tempStateFile(label);
  const kills: Array<{ pid: number; signal: string }> = [];
  const stderrLines: string[] = [];
  const run = (ok: boolean, error?: unknown) =>
    handleHealthcheckOutcome({
      ok,
      error,
      env,
      stateFilePath,
      killFn: (pid: number, signal: string) => {
        kills.push({ pid, signal });
        return true;
      },
      nowMs: () => 1_700_000_000_000,
      stderr: { write: (s: string) => stderrLines.push(s) },
    });
  return { stateFilePath, kills, stderrLines, run };
}

function httpError(status: number, body: string) {
  return Object.assign(new Error(`127.0.0.1: HTTP ${status}`), { status, body });
}

const econnrefused = new Error("127.0.0.1: fetch failed (ECONNREFUSED)");

test("probeHealth rejects HTTP 503 with status/body attached", async () => {
  const fetchImpl = (async () => ({
    ok: false,
    status: 503,
    text: async () => "unhealthy: resource_pressure\n",
  })) as unknown as typeof fetch;
  await assert.rejects(
    probeHealth({ port: 1, hosts: ["127.0.0.1"], fetchImpl, timeoutMs: 500 }),
    (err: any) => {
      assert.match(err.message, /^127\.0\.0\.1: HTTP 503 \(unhealthy: resource_pressure\)$/);
      assert.equal(err.status, 503);
      assert.equal(err.body, "unhealthy: resource_pressure");
      return true;
    }
  );
});

test("probeHealth drains successful responses and resolves the host", async () => {
  let drained = false;
  const fetchImpl = (async () => ({
    ok: true,
    status: 200,
    text: async () => {
      drained = true;
      return "ok";
    },
  })) as unknown as typeof fetch;
  assert.equal(await probeHealth({ port: 1, hosts: ["localhost"], fetchImpl }), "localhost");
  assert.equal(drained, true);
});

test("cold-start ECONNREFUSED never arms or kills", () => {
  const h = harness("cold");
  for (let i = 0; i < 8; i++) {
    const r = h.run(false, econnrefused);
    assert.equal(r.action, "cold_start_unarmed");
    assert.equal(r.consecutiveFailures, 0);
  }
  assert.deepEqual(h.kills, []);
  assert.equal(JSON.parse(fs.readFileSync(h.stateFilePath, "utf8")).armed, false);
});

test("503 starting/stopping lifecycle responses never arm or kill, even after healthy", () => {
  const h = harness("lifecycle");
  for (const body of ["starting\n", "stopping\n", "starting\ndetail", "STOPPING"]) {
    const r = h.run(false, httpError(503, body));
    assert.equal(r.action, "transient_lifecycle", body);
  }
  h.run(true);
  for (let i = 0; i < 6; i++) {
    assert.equal(h.run(false, httpError(503, "stopping\n")).action, "transient_lifecycle");
  }
  assert.deepEqual(h.kills, []);
});

test("explicit 503 unhealthy arms immediately without a prior 200", () => {
  const h = harness("explicit");
  const err = httpError(503, "unhealthy: resource_pressure");
  assert.deepEqual(h.run(false, err), {
    action: "unhealthy_counted",
    consecutiveFailures: 1,
    armed: true,
  });
  assert.equal(h.run(false, err).consecutiveFailures, 2);
  const third = h.run(false, err);
  assert.equal(third.action, "restart_triggered");
  assert.equal(third.signal, "SIGTERM");
  assert.deepEqual(h.kills, [{ pid: 1, signal: "SIGTERM" }]);
});

test('JSON body with "unhealthy" status on 503 arms immediately', () => {
  const h = harness("json");
  const r = h.run(false, httpError(503, '{"status":"unhealthy"}'));
  assert.equal(r.action, "unhealthy_counted");
  assert.equal(r.armed, true);
});

test("arms after first 200; SIGTERM on 3rd failure, SIGKILL on 5th; resets on 200", () => {
  const h = harness("armed");
  assert.deepEqual(h.run(true), { action: "healthy", consecutiveFailures: 0, armed: true });

  const actions = [] as any[];
  for (let i = 0; i < 5; i++) actions.push(h.run(false, econnrefused));
  assert.deepEqual(
    actions.map((a) => [a.action, a.consecutiveFailures, a.signal]),
    [
      ["unhealthy_counted", 1, undefined],
      ["unhealthy_counted", 2, undefined],
      ["restart_triggered", 3, "SIGTERM"],
      ["restart_triggered", 4, "SIGTERM"],
      ["restart_triggered", 5, "SIGKILL"],
    ]
  );
  assert.deepEqual(h.kills, [
    { pid: 1, signal: "SIGTERM" },
    { pid: 1, signal: "SIGTERM" },
    { pid: 1, signal: "SIGKILL" },
  ]);
  assert.match(
    h.stderrLines[0],
    /3 consecutive unhealthy probes \(threshold=3\); sending SIGTERM to PID 1/
  );

  assert.equal(h.run(true).consecutiveFailures, 0);
  const state = JSON.parse(fs.readFileSync(h.stateFilePath, "utf8"));
  assert.deepEqual(state, { armed: true, consecutiveFailures: 0, updatedAt: 1_700_000_000_000 });
  assert.equal(h.run(false, econnrefused).consecutiveFailures, 1);
});

test("respects OMNIROUTE_HEALTHCHECK_SELF_RESTART=0 / false", () => {
  for (const flag of ["0", "false"]) {
    const h = harness(`disabled-${flag}`, { OMNIROUTE_HEALTHCHECK_SELF_RESTART: flag });
    h.run(true);
    let last;
    for (let i = 0; i < 6; i++) last = h.run(false, econnrefused);
    assert.equal(last.action, "unhealthy_counted");
    assert.equal(last.consecutiveFailures, 6);
    assert.deepEqual(h.kills, []);
  }
});

test("honours custom retries and target PID; kill errors are reported, not thrown", () => {
  const stateFilePath = tempStateFile("custom");
  const stderrLines: string[] = [];
  const env = {
    OMNIROUTE_HEALTHCHECK_RESTART_RETRIES: "1",
    OMNIROUTE_HEALTHCHECK_RESTART_PID: "42",
  };
  const r = handleHealthcheckOutcome({
    ok: false,
    error: httpError(503, "unhealthy"),
    env,
    stateFilePath,
    killFn: () => {
      throw new Error("EPERM");
    },
    stderr: { write: (s: string) => stderrLines.push(s) },
  });
  assert.equal(r.action, "restart_triggered");
  assert.equal(r.targetPid, 42);
  assert.equal(r.signal, "SIGTERM");
  assert.ok(stderrLines.some((l) => l.includes("EPERM")));
});

test("corrupt state file falls back to unarmed defaults", () => {
  const h = harness("corrupt");
  fs.writeFileSync(h.stateFilePath, "{not json");
  assert.equal(h.run(false, econnrefused).action, "cold_start_unarmed");
});

test("probeHealth keeps the HTTP status/body when a later host fails at transport level", async () => {
  // Next.js standalone binds 0.0.0.0 (IPv4): 127.0.0.1 answers 503 while ::1 refuses.
  const fetchImpl = async (url: string) => {
    if (url.includes("127.0.0.1")) {
      return { ok: false, status: 503, text: async () => "unhealthy: resource_pressure\n" };
    }
    throw Object.assign(new Error("connect ECONNREFUSED ::1"), { code: "ECONNREFUSED" });
  };
  await assert.rejects(
    probeHealth({ port: 20128, hosts: ["127.0.0.1", "::1"], fetchImpl }),
    (err: any) => {
      assert.equal(err.status, 503);
      assert.equal(err.body, "unhealthy: resource_pressure");
      return true;
    }
  );
});
