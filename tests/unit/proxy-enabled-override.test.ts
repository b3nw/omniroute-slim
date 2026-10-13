/**
 * resolveProxyForConnection({ proxyEnabledOverride }) resolves against a pending,
 * not-yet-persisted connection proxy toggle (used by the Gemini CLI save-time tier
 * re-probe, which runs before updateProviderConnection).
 *
 * Run: node --import tsx/esm --test tests/unit/proxy-enabled-override.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-proxy-override-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = "test-secret";

const core = await import("../../src/lib/db/core.ts");
const providersDb = await import("../../src/lib/db/providers.ts");
const proxiesDb = await import("../../src/lib/db/proxies.ts");
const settingsDb = await import("../../src/lib/db/settings.ts");

interface ProxyResolution {
  level: string | null;
  proxy: { host?: string } | null;
}

test.after(() => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

async function setup(proxyEnabled: boolean) {
  const conn = (await providersDb.createProviderConnection({
    provider: "gemini-cli",
    authType: "oauth",
    name: `conn-${proxyEnabled ? "on" : "off"}`,
    proxyEnabled,
  })) as unknown as { id: string };
  const proxy = await proxiesDb.createProxy({
    name: `provider-proxy-${conn.id}`,
    type: "http",
    host: "provider.proxy.local",
    port: 8080,
  });
  await proxiesDb.assignProxyToScope("provider", "gemini-cli", proxy.id);
  return conn.id;
}

test("override=true resolves the provider proxy for a connection stored with proxy off", async () => {
  const id = await setup(false);
  const stored = (await settingsDb.resolveProxyForConnection(id)) as ProxyResolution;
  assert.equal(stored.level, "direct");

  const pending = (await settingsDb.resolveProxyForConnection(id, undefined, undefined, {
    proxyEnabledOverride: true,
  })) as ProxyResolution;
  assert.equal(pending.level, "provider");
  assert.equal(pending.proxy?.host, "provider.proxy.local");

  // The override result must not poison the cache for normal lookups.
  const again = (await settingsDb.resolveProxyForConnection(id)) as ProxyResolution;
  assert.equal(again.level, "direct");
});

test("override=false goes direct for a connection stored with proxy on", async () => {
  const id = await setup(true);
  const stored = (await settingsDb.resolveProxyForConnection(id)) as ProxyResolution;
  assert.equal(stored.level, "provider");

  const pending = (await settingsDb.resolveProxyForConnection(id, undefined, undefined, {
    proxyEnabledOverride: false,
  })) as ProxyResolution;
  assert.equal(pending.level, "direct");
  assert.equal(pending.proxy, null);

  const again = (await settingsDb.resolveProxyForConnection(id)) as ProxyResolution;
  assert.equal(again.level, "provider");
});
