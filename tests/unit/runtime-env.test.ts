import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { EventEmitter } from "node:events";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const childProcess = require("node:child_process");
const modulePath = path.join(process.cwd(), "scripts/build/runtime-env.mjs");

const originalSpawn = childProcess.spawn;
const originalProcessOn = process.on;
const originalProcessOff = process.off;
const originalProcessExit = process.exit;
const originalProcessKill = process.kill;

async function loadRuntimeEnv(label) {
  return import(`${pathToFileURL(modulePath).href}?case=${label}-${Date.now()}`);
}

test.afterEach(() => {
  childProcess.spawn = originalSpawn;
  process.on = originalProcessOn;
  process.off = originalProcessOff;
  process.exit = originalProcessExit;
  process.kill = originalProcessKill;
  syncBuiltinESMExports();
});

test("runtime env helpers normalize runtime ports and conflicting color flags", async () => {
  const runtimeEnv = await loadRuntimeEnv("helpers");

  assert.deepEqual(
    runtimeEnv.withRuntimePortEnv(
      { NODE_ENV: "test" },
      { basePort: 20128, apiPort: 21128, dashboardPort: 22128 }
    ),
    {
      NODE_ENV: "test",
      OMNIROUTE_PORT: "20128",
      PORT: "22128",
      DASHBOARD_PORT: "22128",
      API_PORT: "21128",
      // #8999 (docker entrypoint moved to /app) made withRuntimePortEnv also pin
      // the bind address, defaulting to 0.0.0.0 when OMNIROUTE_HOSTNAME is unset.
      HOSTNAME: "0.0.0.0",
    }
  );

  assert.deepEqual(
    runtimeEnv.sanitizeColorEnv({ FORCE_COLOR: "1", NO_COLOR: "1", TERM: "xterm-256color" }),
    { NO_COLOR: "1", TERM: "xterm-256color" }
  );
  assert.deepEqual(runtimeEnv.sanitizeColorEnv({ FORCE_COLOR: "1" }), { FORCE_COLOR: "1" });
});

function installSpawnHarness() {
  const h = {
    signalHandlers: new Map(),
    removedHandlers: [],
    childKillSignals: [],
    processKills: [],
    processExits: [],
    spawnCalls: [],
    child: null,
  };
  childProcess.spawn = (command, args, options) => {
    h.spawnCalls.push({ command, args, options });
    h.child = new EventEmitter();
    h.child.kill = (signal) => h.childKillSignals.push(signal);
    return h.child;
  };
  process.on = (signal, handler) => {
    h.signalHandlers.set(signal, handler);
    return process;
  };
  process.off = (signal, handler) => {
    h.removedHandlers.push(signal);
    if (h.signalHandlers.get(signal) === handler) h.signalHandlers.delete(signal);
    return process;
  };
  process.exit = (code) => {
    h.processExits.push(code);
  };
  process.kill = (pid, signal) => {
    h.processKills.push({ pid, signal });
    return true;
  };
  syncBuiltinESMExports();
  return h;
}

test("spawnWithForwardedSignals forwards process signals and exit status", async () => {
  const h = installSpawnHarness();
  const runtimeEnv = await loadRuntimeEnv("spawn");
  const returnedChild = runtimeEnv.spawnWithForwardedSignals("node", ["server.js"], {
    stdio: "inherit",
    shutdownTimeoutMs: 0,
  });

  assert.equal(returnedChild, h.child);
  assert.deepEqual(h.spawnCalls, [
    {
      command: "node",
      args: ["server.js"],
      options: { stdio: "inherit" },
    },
  ]);

  h.signalHandlers.get("SIGINT")();
  h.signalHandlers.get("SIGTERM")();
  assert.deepEqual(h.childKillSignals, ["SIGINT", "SIGTERM"]);

  h.child.emit("exit", 3, null);
  // Second exit event is ignored (idempotent).
  h.child.emit("exit", null, "SIGTERM");

  assert.deepEqual(h.processExits, [3]);
  assert.deepEqual(h.processKills, []);
  assert.deepEqual(h.removedHandlers.sort(), ["SIGINT", "SIGTERM"]);
  assert.equal(h.signalHandlers.size, 0);
});

test("spawnWithForwardedSignals maps signal exits to 143/130 without self-kill", async () => {
  for (const [signal, expected] of [
    ["SIGTERM", 143],
    ["SIGINT", 130],
    ["SIGHUP", 1],
  ] as const) {
    const h = installSpawnHarness();
    const runtimeEnv = await loadRuntimeEnv(`signal-${signal}`);
    runtimeEnv.spawnWithForwardedSignals("node", ["server.js"], { shutdownTimeoutMs: 0 });
    h.child.emit("exit", null, signal);
    assert.deepEqual(h.processExits, [expected], signal);
    assert.deepEqual(h.processKills, [], signal);
  }
});

test("spawnWithForwardedSignals escalates to SIGKILL when child ignores SIGTERM", async () => {
  const h = installSpawnHarness();
  const runtimeEnv = await loadRuntimeEnv("watchdog");
  runtimeEnv.spawnWithForwardedSignals("node", ["server.js"], {
    stdio: "inherit",
    shutdownTimeoutMs: 20,
  });
  assert.deepEqual(h.spawnCalls[0].options, { stdio: "inherit" });

  h.signalHandlers.get("SIGTERM")();
  // Repeated signal must not schedule a second watchdog.
  h.signalHandlers.get("SIGTERM")();
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.deepEqual(h.childKillSignals, ["SIGTERM", "SIGTERM", "SIGKILL"]);

  h.child.emit("exit", null, "SIGKILL");
  assert.deepEqual(h.processExits, [1]);
  assert.deepEqual(h.processKills, []);
});

test("spawnWithForwardedSignals watchdog is cancelled when child exits in time", async () => {
  const h = installSpawnHarness();
  const runtimeEnv = await loadRuntimeEnv("watchdog-cancel");
  runtimeEnv.spawnWithForwardedSignals("node", ["server.js"], { shutdownTimeoutMs: 20 });

  h.signalHandlers.get("SIGTERM")();
  h.child.emit("exit", 0, null);
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.deepEqual(h.childKillSignals, ["SIGTERM"]);
  assert.deepEqual(h.processExits, [0]);
});
