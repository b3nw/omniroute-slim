import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// The `antigravity` client-version target moved from the retired IDE releases feed to the
// App (Hub) updater manifest. Automatic-mode installs persisted `autoDetectedVersion` from
// the IDE feed (e.g. 2.0.0) with no provenance; advertising it as `antigravity/hub/2.0.0`
// presents a Hub version that never existed. Detection state is only trusted when it
// records the Hub feed.

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-agy-hub-provenance-"));
const ORIGINAL_DATA_DIR = process.env.DATA_DIR;
process.env.DATA_DIR = TEST_DATA_DIR;

const core = await import("../../src/lib/db/core.ts");
const settingsDb = await import("../../src/lib/db/settings.ts");
const registry = await import("../../src/lib/client-versions/registry.ts");
const upstream = await import("../../src/lib/client-versions/upstream.ts");
const service = await import("../../src/lib/client-versions/service.ts");
const runtimeSettings = await import("../../src/lib/config/runtimeSettings.ts");
const antigravityVersion = await import("../../open-sse/services/antigravityVersion.ts");
const antigravityHeaders = await import("../../open-sse/services/antigravityHeaders.ts");

const HUB_URL_FRAGMENT = "antigravity-hub-auto-updater";
const fetchCalls: string[] = [];
let hubAvailable = true;

function mockFetch(input: string | URL | Request): Promise<Response> {
  const url = String(input instanceof Request ? input.url : input);
  fetchCalls.push(url);
  if (url.includes(HUB_URL_FRAGMENT)) {
    return Promise.resolve(
      hubAvailable
        ? new Response("version: 2.24.0\npath: Antigravity.zip\nsha512: abc==\n", {
            status: 200,
            headers: { "content-type": "text/yaml" },
          })
        : new Response("down", { status: 503 })
    );
  }
  return Promise.resolve(
    new Response(JSON.stringify({ tag_name: "v1.1.5" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })
  );
}

const hubCalls = () => fetchCalls.filter((url) => url.includes(HUB_URL_FRAGMENT));

async function seedPersistedModes(antigravity: Record<string, unknown>) {
  await settingsDb.updateSettings({ clientVersionModes: { antigravity } });
  await service.flushClientVersionChecks();
}

service.setClientVersionFetchImpl(mockFetch as typeof fetch);

test.beforeEach(async () => {
  await service.flushClientVersionChecks();
  service.stopClientVersionScheduler();
  fetchCalls.length = 0;
  hubAvailable = true;
  registry.resetClientVersionRegistry();
  upstream.clearClientVersionEtagCache();
  antigravityVersion.clearAntigravityVersionCaches();
  runtimeSettings.resetRuntimeSettingsStateForTests();
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
});

test.after(async () => {
  await service.flushClientVersionChecks();
  service.stopClientVersionScheduler();
  service.setClientVersionFetchImpl(null);
  registry.resetClientVersionRegistry();
  antigravityVersion.clearAntigravityVersionCaches();
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  if (ORIGINAL_DATA_DIR === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = ORIGINAL_DATA_DIR;
});

test("persisted IDE-era automatic version without Hub provenance is not advertised", async () => {
  registry.setClientVersionModes({
    antigravity: { mode: "automatic", autoDetectedVersion: "2.0.0" },
  });

  assert.notEqual(antigravityVersion.getCachedAntigravityAppVersion(), "2.0.0");

  const resolved = await antigravityVersion.resolveAntigravityAppVersion(mockFetch as typeof fetch);
  assert.equal(hubCalls().length, 1, "the Hub manifest is fetched");
  assert.equal(resolved, "2.24.0");
  assert.equal(antigravityVersion.getCachedAntigravityAppVersion(), "2.24.0");

  const ua = antigravityHeaders.antigravityAppUserAgent();
  assert.equal(ua, "antigravity/hub/2.24.0 darwin/arm64");
  assert.doesNotMatch(ua, /\/2\.0\.0/);
});

test("a Hub check records provenance and the persisted value is then trusted without refetch", async () => {
  await seedPersistedModes({
    mode: "automatic",
    autoDetectedVersion: "2.0.0",
    lastCheckedAt: new Date().toISOString(),
  });
  await service.runClientVersionCheck({ product: "antigravity" });

  const modes = await service.getClientVersionModes();
  assert.equal(modes.antigravity.autoDetectedVersion, "2.24.0");
  assert.equal(modes.antigravity.autoDetectedVersionFeed, "antigravity-hub");

  // Provenance survives a normalize round-trip (a fresh boot reading settings).
  assert.equal(
    registry.normalizeClientVersionModes(JSON.stringify(modes)).antigravity.autoDetectedVersionFeed,
    "antigravity-hub"
  );

  antigravityVersion.clearAntigravityVersionCaches();
  registry.resetClientVersionRegistry();
  registry.setClientVersionModes(modes);
  fetchCalls.length = 0;
  assert.equal(
    await antigravityVersion.resolveAntigravityAppVersion(mockFetch as typeof fetch),
    "2.24.0"
  );
  assert.equal(fetchCalls.length, 0, "trusted persisted value needs no fetch");
});

test("the scheduler re-checks IDE-era state immediately despite a fresh lastCheckedAt", async () => {
  await seedPersistedModes({
    mode: "automatic",
    autoDetectedVersion: "2.0.0",
    lastCheckedAt: new Date().toISOString(),
  });
  service.syncClientVersionScheduler(await service.getClientVersionModes());
  await service.flushClientVersionChecks();
  service.stopClientVersionScheduler();

  const modes = await service.getClientVersionModes();
  assert.equal(modes.antigravity.autoDetectedVersion, "2.24.0");
  assert.equal(modes.antigravity.autoDetectedVersionFeed, "antigravity-hub");
});

test("a failed Hub check drops IDE-era detection state instead of keeping it", async () => {
  hubAvailable = false;
  await seedPersistedModes({
    mode: "automatic",
    autoDetectedVersion: "2.0.0",
    lastCheckedAt: new Date().toISOString(),
  });
  await service.runClientVersionCheck({ product: "antigravity" });

  const modes = await service.getClientVersionModes();
  assert.equal(modes.antigravity.autoDetectedVersion, undefined);
  assert.equal(modes.antigravity.autoDetectedVersionFeed, undefined);
  assert.match(modes.antigravity.lastCheckError!, /^App: /);
  assert.equal(
    antigravityVersion.getCachedAntigravityAppVersion(),
    antigravityVersion.ANTIGRAVITY_APP_FALLBACK_VERSION
  );
});

test("manual mode is unaffected by stale detection state", async () => {
  registry.setClientVersionModes({
    antigravity: { mode: "manual", manualVersion: "9.9.9", autoDetectedVersion: "2.0.0" },
  });
  assert.equal(
    await antigravityVersion.resolveAntigravityAppVersion(mockFetch as typeof fetch),
    "9.9.9"
  );
  assert.equal(antigravityHeaders.antigravityAppUserAgent(), "antigravity/hub/9.9.9 darwin/arm64");
  assert.equal(fetchCalls.length, 0);
});

test("the CLI target keeps its persisted automatic version", async () => {
  registry.setClientVersionModes({
    antigravity: {
      mode: "automatic",
      autoDetectedVersion: "2.0.0",
      autoDetectedCliVersion: "1.0.7",
    },
  });
  assert.equal(
    await antigravityVersion.resolveAntigravityCliVersion(mockFetch as typeof fetch),
    "1.0.7"
  );
  assert.equal(antigravityVersion.getCachedAntigravityCliVersion(), "1.0.7");
  assert.equal(fetchCalls.length, 0, "the CLI feed is not consulted");
});
