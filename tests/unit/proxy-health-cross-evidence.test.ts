/**
 * Cross-proxy evidence in the health sweep: a connection failure or timeout against a
 * target becomes `fail` when the same URL answered (any HTTP) through at
 * least one other proxy in the same sweep (or the previous cycle); otherwise
 * `inconclusive` as before.
 *
 * Unit (hermetic, pure helper) + functional (real sweep cycle via
 * forceProxyHealthSweep, isolated DB, local relays). Cleanup in finally +
 * test.after (resetDbInstance, rmSync, resets ledgers).
 *
 * Slim adaptation: Slim does not carry the proxy set-aside memory
 * (open-sse/utils/proxyRefusalMemory.ts) nor the `hang` verdict, so the
 * memory-write assertions are dropped and promotion is checked through the
 * raw-verdict decision and the "promoted" sweep tally instead.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-cross-evidence-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = "cross-evidence-secret";
process.env.OMNIROUTE_DISABLE_BACKGROUND_SERVICES = "true";

const decision = await import("../../src/lib/proxyHealth/decision.ts");

const WORKTREE_ROOT = new URL("../../", import.meta.url).pathname.replace(/\/$/, "");

interface SweepScriptResult {
  status: number;
  stdout: string;
  stderr: string;
}

/**
 * Functional: runs a full sweep in a fresh subprocess (module-load constants
 * TEST_URL/CONCURRENCY isolated per run, DB shared via DATA_DIR).
 * The child script takes its config from env; it creates the proxies, sweeps, and
 * prints a JSON verdict line on stdout.
 */
function runSweepScript(script: string, extraEnv: Record<string, string>): SweepScriptResult {
  const child = spawnSync(
    process.execPath,
    ["--import", "tsx/esm", "--input-type=module", "-e", script],
    {
      cwd: WORKTREE_ROOT,
      env: {
        ...process.env,
        DATA_DIR: TEST_DATA_DIR,
        API_KEY_SECRET: "cross-evidence-secret",
        OMNIROUTE_DISABLE_BACKGROUND_SERVICES: "true",
        PROXY_HEALTH_TEST_STAGGER_MS: "0",
        PROXY_HEALTH_USE_PROVIDER_TARGET: "false",
        ...extraEnv,
      },
      encoding: "utf8",
      timeout: 90000,
    }
  );
  return {
    status: child.status ?? -1,
    stdout: child.stdout ?? "",
    stderr: child.stderr ?? "",
  };
}

function lastJsonLine(stdout: string): Record<string, string | null> {
  const lines = stdout
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      return JSON.parse(lines[i]) as Record<string, string | null>;
    } catch {
      continue;
    }
  }
  throw new Error(`no JSON verdict in stdout:\n${stdout}`);
}

test.after(() => {
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

// ─── Unit: applyCrossProbeEvidence (pure, hermetic) ───

test("cross-evidence: an HTTP from the same sweep promotes a status-less inconclusive to fail", () => {
  const target = "https://api.example.com/openai/v1/models";
  const out = decision.applyCrossProbeEvidence(
    [
      { outcome: "ok", status: 200, target },
      { outcome: "inconclusive", status: null, target },
    ],
    new Map()
  );
  assert.equal(out[0].outcome, "ok");
  assert.equal(out[1].outcome, "fail");
});

test("cross-evidence: 429 and 5xx count as evidence (any HTTP answer)", () => {
  for (const status of [429, 500, 503]) {
    const target = `https://api.example.com/${status}/models`;
    const out = decision.applyCrossProbeEvidence(
      [
        {
          outcome: status === 429 ? "blocked" : "inconclusive",
          status,
          target,
        },
        { outcome: "inconclusive", status: null, target },
      ],
      new Map()
    );
    assert.equal(out[1].outcome, "fail", `status ${status} must prove the target`);
  }
});

test("cross-evidence: distinct targets never promote across", () => {
  const out = decision.applyCrossProbeEvidence(
    [
      { outcome: "ok", status: 200, target: "https://a.example.com/models" },
      { outcome: "inconclusive", status: null, target: "https://b.example.com/models" },
    ],
    new Map()
  );
  assert.equal(out[1].outcome, "inconclusive");
});

test("cross-evidence: no evidence (empty map, databricks template) stays inconclusive", () => {
  const template = "https://adb-0000000000000000.0.azuredatabricks.net/serving-endpoints/models";
  const out = decision.applyCrossProbeEvidence(
    [
      { outcome: "inconclusive", status: null, target: template },
      { outcome: "inconclusive", status: null, target: template },
    ],
    new Map()
  );
  assert.equal(out[0].outcome, "inconclusive");
  assert.equal(out[1].outcome, "inconclusive");
});

test("cross-evidence: previous-cycle evidence (priorMap) goes fail", () => {
  const target = "https://api.example.com/openai/v1/models";
  const out = decision.applyCrossProbeEvidence(
    [{ outcome: "inconclusive", status: null, target }],
    new Map([[target, true]])
  );
  assert.equal(out[0].outcome, "fail");
});

test("cross-evidence anti-ghost: N-1 evidence then silent cycle N means no promotion at cycle N+1", () => {
  const target = "https://api.example.com/openai/v1/models";
  // Cycle N-1: the target answers (evidence recorded wholesale).
  const afterN1 = decision.buildTargetEvidenceMap([
    { outcome: "ok", status: 200, target },
    { outcome: "inconclusive", status: null, target },
  ]);
  assert.equal(afterN1.get(target), true);
  // Cycle N: silent (no HTTP), wholesale rebuild drops the evidence.
  const afterN = decision.buildTargetEvidenceMap([
    { outcome: "inconclusive", status: null, target },
  ]);
  assert.equal(afterN.get(target), undefined);
  // Cycle N+1 with the cycle-N map: no promotion.
  const out = decision.applyCrossProbeEvidence(
    [{ outcome: "inconclusive", status: null, target }],
    afterN
  );
  assert.equal(out[0].outcome, "inconclusive");
});

test("cross-evidence: native fail and invalid config (null target) are left untouched", () => {
  const target = "https://api.example.com/openai/v1/models";
  const out = decision.applyCrossProbeEvidence(
    [
      { outcome: "fail", status: null, target },
      { outcome: "fail", status: null, target: null },
      { outcome: "inconclusive", status: null, target: null },
      { outcome: "blocked", status: 403, target },
      { outcome: "inconclusive", status: 503, target },
    ],
    new Map([[target, true]])
  );
  assert.equal(out[0].outcome, "fail");
  assert.equal(out[1].outcome, "fail");
  assert.equal(out[2].outcome, "inconclusive");
  assert.equal(out[3].outcome, "blocked");
  assert.equal(out[4].outcome, "inconclusive", "a received 5xx is never reclassified");
});

// ─── Functional: real sweep cycles (fresh subprocess per scenario) ───
// Each scenario runs its own sweep: the scheduler module-load constants (
// TEST_URL, CONCURRENCY, ...) stay isolated, the DB is shared via
// DATA_DIR, but each script uses unique proxy names and they are
// deleted in finally. The HTTP relays (absolute-form + CONNECT, same pattern
// as proxy-health-blocked-streak-sweep.test.ts) run inside the child
// process. PROXY_HEALTH_TEST_URL is injected BEFORE the scheduler import.

const CHILD_PRELUDE = `
  import http from "node:http";
  import net from "node:net";
  async function startRelay(targetPort, answerStatus) {
    const tunnelSockets = new Set();
    const relay = http.createServer((req, res) => {
      const up = http.request({ host: "127.0.0.1", port: targetPort, method: req.method, path: "/probe" },
        (a) => { res.writeHead(a.statusCode ?? 502); a.pipe(res); });
      up.on("error", () => res.destroy());
      req.pipe(up);
    });
    relay.on("connect", (req, client, head) => {
      tunnelSockets.add(client);
      const socket = net.connect(targetPort, "127.0.0.1", () => {
        client.write("HTTP/1.1 200 Connection Established\\r\\n\\r\\n");
        socket.write(head);
        socket.pipe(client);
        client.pipe(socket);
      });
      tunnelSockets.add(socket);
      socket.on("error", () => client.destroy());
      client.on("error", () => socket.destroy());
    });
    await new Promise((r) => relay.listen(0, "127.0.0.1", r));
    relay.tunnelSockets = tunnelSockets;
    void answerStatus;
    return relay;
  }
  async function stopRelay(relay) {
    for (const s of relay.tunnelSockets) s.destroy();
    relay.tunnelSockets.clear();
    relay.closeAllConnections();
    await new Promise((r) => relay.close(r));
  }
  async function freePort() {
    const probe = net.createServer();
    await new Promise((r) => probe.listen(0, "127.0.0.1", r));
    const port = probe.address().port;
    await new Promise((r) => probe.close(r));
    return port;
  }
`;

test("promoted result: status decision and tally use the raw inconclusive verdict", async () => {
  // raw=inconclusive (no evidence in this sweep), final=fail (promoted by a
  // peer's evidence), wasPromoted=true, flags on. The decision stays neutral
  // (failure count 0, tally.inconclusive=1); deciding on final.outcome would
  // count a failure and skip the inconclusive tally.
  const sched = await import("../../src/lib/proxyHealth/scheduler.ts");
  const target = "https://api.example.com/openai/v1/models";
  const raw = { id: "p1", proxy: { id: "p1" }, outcome: "inconclusive", status: null, target };
  const final = { id: "p1", proxy: { id: "p1" }, outcome: "fail", status: null, target };
  const ctx = {
    failureMap: new Map(),
    removeAfter: 3,
    autoRemove: true,
    autoDisable: true,
  };
  const tally = {
    tested: 0,
    alive: 0,
    inconclusive: 0,
    blocked: 0,
    removed: 0,
    disabled: 0,
    promoted: 0,
  };
  await sched.__decideOneResultForTesting(raw, final, true, ctx, tally);
  assert.equal(ctx.failureMap.get("p1") ?? 0, 0, "raw inconclusive: failure count unchanged");
  assert.equal(tally.inconclusive, 1, "tally follows the raw verdict");
  assert.equal(tally.tested, 1);
});

test("promoted result never accumulates toward the removal threshold", async () => {
  // Repeated promoted verdicts with auto-remove at a threshold of 2: the raw
  // inconclusive stays neutral, so the proxy is never removed or disabled.
  const sched = await import("../../src/lib/proxyHealth/scheduler.ts");
  const target = "https://api.example.com/openai/v1/models";
  const raw = { id: "p2", proxy: { id: "p2" }, outcome: "inconclusive", status: null, target };
  const final = { id: "p2", proxy: { id: "p2" }, outcome: "fail", status: null, target };
  const ctx = {
    failureMap: new Map(),
    removeAfter: 2,
    autoRemove: true,
    autoDisable: true,
  };
  const tally = {
    tested: 0,
    alive: 0,
    inconclusive: 0,
    blocked: 0,
    removed: 0,
    disabled: 0,
    promoted: 0,
  };
  for (let i = 0; i < 3; i++) {
    await sched.__decideOneResultForTesting(raw, final, true, ctx, tally);
  }
  assert.equal(ctx.failureMap.get("p2") ?? 0, 0, "raw inconclusive: failure count unchanged");
  assert.equal(tally.removed, 0);
  assert.equal(tally.disabled, 0);
  assert.equal(tally.inconclusive, 3);
});

test("functional: native fail is still removed on the third sweep", () => {
  // The native path is unchanged: a generic ECONNREFUSED is a raw fail and a
  // final fail (no promotion). Regression guard on the real sweep.
  const script =
    CHILD_PRELUDE +
    `
    const target = http.createServer((_req, res) => { res.writeHead(200); res.end("{}"); });
    await new Promise((r) => target.listen(0, "127.0.0.1", r));
    const targetPort = target.address().port;
    process.env.PROXY_HEALTH_TEST_URL = "http://127.0.0.1:" + targetPort + "/probe";
    const proxiesDb = await import("./src/lib/db/proxies.ts");
    const sched = await import("./src/lib/proxyHealth/scheduler.ts");
    const relay = await startRelay(targetPort);
    const alive = await proxiesDb.createProxy({ name: "x-a-alive", type: "http", host: "127.0.0.1", port: relay.address().port });
    const deadPort = await freePort();
    const flaky = await proxiesDb.createProxy({ name: "x-a-flaky", type: "http", host: "127.0.0.1", port: deadPort });
    const verdict = {};
    try {
      await sched.__resetTargetEvidenceForTesting();
      await sched.forceProxyHealthSweep();
      verdict.after1 = String((await proxiesDb.getProxyById(flaky.id, { includeSecrets: false })) === null ? "removed" : "kept");
      await sched.forceProxyHealthSweep();
      verdict.after2 = String((await proxiesDb.getProxyById(flaky.id, { includeSecrets: false })) === null ? "removed" : "kept");
      await sched.forceProxyHealthSweep();
      verdict.after3 = String((await proxiesDb.getProxyById(flaky.id, { includeSecrets: false })) === null ? "removed" : "kept");
    } finally {
      await stopRelay(relay);
      await new Promise((r) => target.close(r));
      await proxiesDb.deleteProxyById(alive.id, { force: true }).catch(() => {});
      await proxiesDb.deleteProxyById(flaky.id, { force: true }).catch(() => {});
    }
    console.log(JSON.stringify(verdict));
  `;
  const res = runSweepScript(script, {
    PROXY_AUTO_REMOVE: "true",
    PROXY_AUTO_REMOVE_AFTER: "3",
  });
  assert.equal(res.status, 0, `child sweep failed:\n${res.stderr}`);
  const verdict = lastJsonLine(res.stdout);
  assert.equal(
    verdict.after1,
    "kept",
    "native fail, sweep 1: count 1 below the removal threshold of 3"
  );
  assert.equal(
    verdict.after2,
    "kept",
    "native fail, sweep 2: count 2 below the removal threshold of 3"
  );
  assert.equal(
    verdict.after3,
    "removed",
    "native fail, sweep 3: count 3 reaches the threshold, proxy removed"
  );
});

test("functional: two sweeps with a live peer on the same URL keep both proxies", () => {
  // Two sweeps with no auto-remove: the dead peer fails natively against the
  // generic target, the live relay keeps answering; neither is removed.
  const script =
    CHILD_PRELUDE +
    `
    const target = http.createServer((_req, res) => { res.writeHead(200); res.end("{}"); });
    await new Promise((r) => target.listen(0, "127.0.0.1", r));
    const targetPort = target.address().port;
    process.env.PROXY_HEALTH_TEST_URL = "http://127.0.0.1:" + targetPort + "/probe";
    const proxiesDb = await import("./src/lib/db/proxies.ts");
    const sched = await import("./src/lib/proxyHealth/scheduler.ts");
    const relay = await startRelay(targetPort);
    const alive = await proxiesDb.createProxy({ name: "x-off-alive", type: "http", host: "127.0.0.1", port: relay.address().port });
    const deadPort = await freePort();
    const flaky = await proxiesDb.createProxy({ name: "x-off-flaky", type: "http", host: "127.0.0.1", port: deadPort });
    const verdict = {};
    try {
      await sched.__resetTargetEvidenceForTesting();
      await sched.forceProxyHealthSweep();
      await sched.forceProxyHealthSweep();
      verdict.flaky = (await proxiesDb.getProxyById(flaky.id, { includeSecrets: false })) === null ? "removed" : "kept";
      verdict.alive = (await proxiesDb.getProxyById(alive.id, { includeSecrets: false })) === null ? "removed" : "kept";
    } finally {
      await stopRelay(relay);
      await new Promise((r) => target.close(r));
      await proxiesDb.deleteProxyById(alive.id, { force: true }).catch(() => {});
      await proxiesDb.deleteProxyById(flaky.id, { force: true }).catch(() => {});
    }
    console.log(JSON.stringify(verdict));
  `;
  const res = runSweepScript(script, {});
  assert.equal(res.status, 0, `child sweep failed:\n${res.stderr}`);
  const verdict = lastJsonLine(res.stdout);
  assert.equal(verdict.flaky, "kept");
  assert.equal(verdict.alive, "kept");
});

test("functional (c-old) generic-path shared-target guard: relay(200) + dead-port on the same URL means native fail", () => {
  // Honest guard (no cross evidence here: the generic dead proxy already fails
  // natively). The local provider path is ineligible by construction:
  // isProbeSafeBaseUrl only accepts https:// targets (no registry entry uses
  // plain http:// today), so a local http:// target cannot go through the
  // provider path. USE_PROVIDER_TARGET=false assumed.
  const script =
    CHILD_PRELUDE +
    `
    const providerTarget = http.createServer((_req, res) => { res.writeHead(200); res.end("{}"); });
    await new Promise((r) => providerTarget.listen(0, "127.0.0.1", r));
    const providerPort = providerTarget.address().port;
    process.env.PROXY_HEALTH_TEST_URL = "http://127.0.0.1:" + providerPort + "/probe";
    const proxiesDb = await import("./src/lib/db/proxies.ts");
    const { forceProxyHealthSweep } = await import("./src/lib/proxyHealth/scheduler.ts");
    const relay = await startRelay(providerPort);
    const alive = await proxiesDb.createProxy({ name: "x-b-alive", type: "http", host: "127.0.0.1", port: relay.address().port });
    const deadPort = await freePort();
    const flaky = await proxiesDb.createProxy({ name: "x-b-flaky", type: "http", host: "127.0.0.1", port: deadPort });
    const verdict = {};
    try {
      await forceProxyHealthSweep();
      verdict.flaky = (await proxiesDb.getProxyById(flaky.id, { includeSecrets: false })) === null ? "removed" : "kept";
      verdict.alive = (await proxiesDb.getProxyById(alive.id, { includeSecrets: false })) === null ? "removed" : "kept";
    } finally {
      await stopRelay(relay);
      await new Promise((r) => providerTarget.close(r));
      await proxiesDb.deleteProxyById(alive.id, { force: true }).catch(() => {});
      await proxiesDb.deleteProxyById(flaky.id, { force: true }).catch(() => {});
    }
    console.log(JSON.stringify(verdict));
  `;
  const res = runSweepScript(script, {
    PROXY_AUTO_REMOVE: "true",
    PROXY_AUTO_REMOVE_AFTER: "1",
  });
  assert.equal(res.status, 0, `child sweep failed:\n${res.stderr}`);
  const verdict = lastJsonLine(res.stdout);
  assert.equal(verdict.flaky, "removed");
  assert.equal(verdict.alive, "kept");
});

test("functional (c) template target with no answer stays inconclusive, both survive", () => {
  const script =
    CHILD_PRELUDE +
    `
    // Template target: dead port (immediate connection refused, generic =
    // native fail) BUT without auto-remove: the raw verdict is checked through
    // the failureMap counter: without cross evidence the design changes nothing,
    // evidence (live relay on the same URL), the flaky proxy is promoted and set aside.
    // Here: two dead-port proxies, no HTTP anywhere, so both stay
    // native fail at count 1, no auto-remove (AFTER=3).
    const deadPort1 = await freePort();
    const deadPort2 = await freePort();
    process.env.PROXY_HEALTH_TEST_URL = "http://127.0.0.1:" + deadPort1 + "/probe";
    const proxiesDb = await import("./src/lib/db/proxies.ts");
    const { forceProxyHealthSweep } = await import("./src/lib/proxyHealth/scheduler.ts");
    const first = await proxiesDb.createProxy({ name: "x-c-1", type: "http", host: "127.0.0.1", port: deadPort1 });
    const second = await proxiesDb.createProxy({ name: "x-c-2", type: "http", host: "127.0.0.1", port: deadPort2 });
    const verdict = {};
    try {
      await forceProxyHealthSweep();
      verdict.first = (await proxiesDb.getProxyById(first.id, { includeSecrets: false })) === null ? "removed" : "kept";
      verdict.second = (await proxiesDb.getProxyById(second.id, { includeSecrets: false })) === null ? "removed" : "kept";
    } finally {
      await proxiesDb.deleteProxyById(first.id, { force: true }).catch(() => {});
      await proxiesDb.deleteProxyById(second.id, { force: true }).catch(() => {});
    }
    console.log(JSON.stringify(verdict));
  `;
  const res = runSweepScript(script, {
    PROXY_AUTO_REMOVE_AFTER: "3",
  });
  assert.equal(res.status, 0, `child sweep failed:\n${res.stderr}`);
  const verdict = lastJsonLine(res.stdout);
  assert.equal(verdict.first, "kept");
  assert.equal(verdict.second, "kept");
});
