/**
 * Per-connection model allowlist (`providerSpecificData.allowedModels`).
 *
 * getProviderCredentials must skip a connection whose allowlist does not
 * match the requested model, keep the default-open behaviour for connections
 * without an allowlist, and let `excludedModels` win over `allowedModels`.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-allowed-models-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const core = await import("../../src/lib/db/core.ts");
const providersDb = await import("../../src/lib/db/providers.ts");
const auth = await import("../../src/sse/services/auth.ts");

const PROVIDER = "openai";

async function resetStorage() {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
}

test.after(() => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

async function createConnection(
  name: string,
  priority: number,
  providerSpecificData?: Record<string, unknown>
): Promise<string> {
  const created = (await providersDb.createProviderConnection({
    provider: PROVIDER,
    authType: "apikey",
    name,
    apiKey: `sk-test-${name}`,
    priority,
    isActive: true,
    ...(providerSpecificData ? { providerSpecificData } : {}),
  })) as { id: string };
  return created.id;
}

function selectedConnectionId(selected: unknown): string | null {
  if (!selected || typeof selected !== "object") return null;
  const id = (selected as { connectionId?: unknown }).connectionId;
  return typeof id === "string" ? id : null;
}

test("skips a higher-priority connection whose allowlist does not match the model", async () => {
  await resetStorage();
  await createConnection("claude-only", 1, { allowedModels: ["claude-*"] });
  const openId = await createConnection("open", 2);

  const selected = await auth.getProviderCredentials(PROVIDER, null, null, "gpt-5-mini");
  assert.equal(selectedConnectionId(selected), openId);
});

test("selects the connection whose allowlist matches (wildcard and exact)", async () => {
  await resetStorage();
  const gptId = await createConnection("gpt", 1, { allowedModels: ["gpt-6.1-sol", "gpt-5*"] });
  const claudeId = await createConnection("claude", 2, { allowedModels: "claude-*" });

  assert.equal(
    selectedConnectionId(await auth.getProviderCredentials(PROVIDER, null, null, "gpt-5-mini")),
    gptId
  );
  assert.equal(
    selectedConnectionId(await auth.getProviderCredentials(PROVIDER, null, null, "gpt-6.1-sol")),
    gptId
  );
  assert.equal(
    selectedConnectionId(
      await auth.getProviderCredentials(PROVIDER, null, null, "claude-sonnet-4-5")
    ),
    claudeId
  );
});

test("returns no connection when every allowlist rejects the model", async () => {
  await resetStorage();
  await createConnection("gpt", 1, { allowedModels: ["gpt-5*"] });
  await createConnection("claude", 2, { allowedModels: ["claude-*"] });

  const selected = await auth.getProviderCredentials(PROVIDER, null, null, "gemini-2.5-pro");
  assert.equal(selectedConnectionId(selected), null);
});

test("an empty allowlist is default-open", async () => {
  await resetStorage();
  const id = await createConnection("empty", 1, { allowedModels: [] });

  const selected = await auth.getProviderCredentials(PROVIDER, null, null, "anything-goes");
  assert.equal(selectedConnectionId(selected), id);
});

test("excludedModels takes precedence over a matching allowlist", async () => {
  await resetStorage();
  await createConnection("gpt-no-pro", 1, {
    allowedModels: ["gpt-5*"],
    excludedModels: ["gpt-5-pro"],
  });
  const fallbackId = await createConnection("fallback", 2);

  const selected = await auth.getProviderCredentials(PROVIDER, null, null, "gpt-5-pro");
  assert.equal(selectedConnectionId(selected), fallbackId);
});

test("optional-key no-auth provider (aihorde) skips stored key when model is not permitted", async () => {
  await resetStorage();
  const hordeId = (await providersDb.createProviderConnection({
    provider: "aihorde",
    authType: "apikey",
    name: "restricted-horde",
    apiKey: "0000000000-user-key",
    priority: 1,
    isActive: true,
    providerSpecificData: { allowedModels: ["only-this"] },
  })) as { id: string };

  const permitted = await auth.getProviderCredentials("aihorde", null, null, "only-this");
  assert.equal(selectedConnectionId(permitted), hordeId.id);
  assert.equal((permitted as { apiKey?: string })?.apiKey, "0000000000-user-key");

  const skipped = await auth.getProviderCredentials("aihorde", null, null, "not-permitted");
  assert.notEqual(selectedConnectionId(skipped), hordeId.id);
  assert.equal(selectedConnectionId(skipped), "noauth");
});
