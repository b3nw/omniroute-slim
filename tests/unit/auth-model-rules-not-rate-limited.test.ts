/**
 * getProviderCredentials must not report a connection that its OWN model rules
 * (`excludedModels` / `allowedModels`) block as "rate limited". Previously the
 * cooldown inspection ran over every active connection, so a model-excluded
 * account that also happened to carry a rateLimitedUntil turned a permanent
 * "this model is not served here" into a transient allRateLimited 429/503 —
 * clients then retried forever, and the log claimed "all N active accounts
 * rate limited" while counting accounts that could never serve the model.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-model-rules-rl-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const core = await import("../../src/lib/db/core.ts");
const providersDb = await import("../../src/lib/db/providers.ts");
const auth = await import("../../src/sse/services/auth.ts");
const { getCodexModelScope, getCodexRateLimitKey } =
  await import("../../open-sse/config/codexQuotaScopes.ts");

const PROVIDER = "openai";
const FUTURE = () => new Date(Date.now() + 10 * 60 * 1000).toISOString();

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
  opts: { providerSpecificData?: Record<string, unknown>; rateLimitedUntil?: string } = {}
): Promise<string> {
  const created = (await providersDb.createProviderConnection({
    provider: PROVIDER,
    authType: "apikey",
    name,
    apiKey: `sk-test-${name}`,
    priority: 1,
    isActive: true,
    ...(opts.rateLimitedUntil ? { rateLimitedUntil: opts.rateLimitedUntil } : {}),
    ...(opts.providerSpecificData ? { providerSpecificData: opts.providerSpecificData } : {}),
  })) as { id: string };
  return created.id;
}

test("rate-limited connection that excludes the model is not reported as rate limited", async () => {
  await resetStorage();
  await createConnection("excluded-and-limited", {
    providerSpecificData: { excludedModels: ["gpt-5-pro"] },
    rateLimitedUntil: FUTURE(),
  });

  const result = await auth.getProviderCredentials(PROVIDER, null, null, "gpt-5-pro");
  assert.equal(result, null, "model-blocked pool must surface as no credentials");
});

test("rate-limited connection whose allowlist rejects the model is not reported as rate limited", async () => {
  await resetStorage();
  await createConnection("allowlist-and-limited", {
    providerSpecificData: { allowedModels: ["claude-*"] },
    rateLimitedUntil: FUTURE(),
  });

  const result = await auth.getProviderCredentials(PROVIDER, null, null, "gpt-5-mini");
  assert.equal(result, null);
});

test("mixed pool: only model-eligible accounts drive the rate-limit verdict and count", async () => {
  await resetStorage();
  await createConnection("blocked-a", {
    providerSpecificData: { excludedModels: ["gpt-5*"] },
    rateLimitedUntil: FUTURE(),
  });
  await createConnection("blocked-b", {
    providerSpecificData: { allowedModels: ["claude-*"] },
  });
  const limitedUntil = FUTURE();
  await createConnection("eligible-limited", { rateLimitedUntil: limitedUntil });

  const result = (await auth.getProviderCredentials(PROVIDER, null, null, "gpt-5-mini")) as {
    allRateLimited?: boolean;
    connectionsCount?: number;
    retryAfter?: string;
  } | null;
  assert.ok(result, "expected a rate-limit verdict");
  assert.equal(result.allRateLimited, true);
  assert.equal(result.connectionsCount, 1, "only the model-eligible account counts");
  assert.equal(result.retryAfter, limitedUntil);
});

test("earliest retryAfter ignores a sooner cooldown on a model-blocked account", async () => {
  await resetStorage();
  const soon = new Date(Date.now() + 60 * 1000).toISOString();
  const later = new Date(Date.now() + 30 * 60 * 1000).toISOString();
  await createConnection("blocked-soon", {
    providerSpecificData: { excludedModels: ["gpt-5-mini"] },
    rateLimitedUntil: soon,
  });
  await createConnection("eligible-later", { rateLimitedUntil: later });

  const result = (await auth.getProviderCredentials(PROVIDER, null, null, "gpt-5-mini")) as {
    allRateLimited?: boolean;
    retryAfter?: string;
  } | null;
  assert.equal(result?.allRateLimited, true);
  assert.equal(result?.retryAfter, later, "a blocked account's cooldown must not be advertised");
});

test("an eligible available account is still selected over a blocked one", async () => {
  await resetStorage();
  await createConnection("blocked", {
    providerSpecificData: { excludedModels: ["gpt-5-mini"] },
  });
  const okId = await createConnection("ok");

  const result = (await auth.getProviderCredentials(PROVIDER, null, null, "gpt-5-mini")) as {
    connectionId?: string;
  } | null;
  assert.equal(result?.connectionId, okId);
});

test("model-blocked no-auth provider still falls back to the synthetic no-auth connection", async () => {
  await resetStorage();
  await providersDb.createProviderConnection({
    provider: "aihorde",
    authType: "apikey",
    name: "restricted-horde",
    apiKey: "0000000000-user-key",
    priority: 1,
    isActive: true,
    rateLimitedUntil: FUTURE(),
    providerSpecificData: { allowedModels: ["only-this"] },
  });

  const result = (await auth.getProviderCredentials("aihorde", null, null, "not-permitted")) as {
    connectionId?: string;
  } | null;
  assert.equal(result?.connectionId, "noauth");
});

test("codex Luna models share the spark quota scope", () => {
  assert.equal(getCodexModelScope("gpt-5.6-luna"), "spark");
  assert.equal(getCodexModelScope("GPT-6-Luna"), "spark");
  assert.equal(getCodexModelScope("codex/gpt-5.6-luna"), "spark");
  assert.equal(getCodexRateLimitKey("acct-1", "gpt-5.6-luna"), "acct-1:spark");
});

test("codex scope matching is otherwise unchanged", () => {
  assert.equal(getCodexModelScope("gpt-5.3-codex-spark"), "spark");
  assert.equal(getCodexModelScope("codex-bengalfox"), "spark");
  assert.equal(getCodexModelScope("gpt-5.6-sol"), "codex");
  assert.equal(getCodexModelScope("gpt-5.6-terra"), "codex");
  assert.equal(getCodexModelScope("gpt-5-codex"), "codex");
  assert.equal(getCodexModelScope(null), "codex");
});
