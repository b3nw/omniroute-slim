import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-client-version-modes-"));
const ORIGINAL_DATA_DIR = process.env.DATA_DIR;
const ENV_NAMES = [
  "CLAUDE_CODE_CLIENT_VERSION",
  "CODEX_CLIENT_VERSION",
  "CODEX_USER_AGENT",
  "GEMINI_CLI_UA_VERSION",
  "OMNIROUTE_API_KEY",
];
const ORIGINAL_ENV = Object.fromEntries(ENV_NAMES.map((name) => [name, process.env[name]]));

process.env.DATA_DIR = TEST_DATA_DIR;
for (const name of ENV_NAMES) delete process.env[name];

const core = await import("../../src/lib/db/core.ts");
const settingsDb = await import("../../src/lib/db/settings.ts");
const registry = await import("../../src/lib/client-versions/registry.ts");
const upstream = await import("../../src/lib/client-versions/upstream.ts");
const service = await import("../../src/lib/client-versions/service.ts");
const schemas = await import("../../src/lib/client-versions/schemas.ts");
const runtimeSettings = await import("../../src/lib/config/runtimeSettings.ts");
const claudeClient = await import("../../src/shared/constants/claudeCodeClient.ts");
const codexClient = await import("../../open-sse/config/codexClient.ts");
const antigravityVersion = await import("../../open-sse/services/antigravityVersion.ts");
const antigravityHeaders = await import("../../open-sse/services/antigravityHeaders.ts");
const geminiDiscovery = await import("../../open-sse/services/geminiCliDiscovery.ts");
const geminiExecutor = await import("../../open-sse/executors/geminiCli.ts");
const route = await import("../../src/app/api/client-versions/route.ts");
const checkRoute = await import("../../src/app/api/client-versions/check/route.ts");
const cardState =
  await import("../../src/app/(dashboard)/dashboard/settings/components/clientVersionModesState.ts");

type FetchCall = { url: string; init?: RequestInit };
type ProductStatusBody = {
  product: string;
  activeVersion: string;
  source: string;
  config: Record<string, string | undefined>;
  wirePreview: Record<string, string>;
};
type StatusBody = {
  products: ProductStatusBody[];
  checked?: string[];
  skipped?: string[];
};
const fetchCalls: FetchCall[] = [];
let fetchResponder: (url: string, init?: RequestInit) => Response | Promise<Response> = () => {
  throw new Error("unexpected network call");
};

function mockFetch(url: string, init?: RequestInit): Promise<Response> {
  fetchCalls.push({ url, init });
  return Promise.resolve().then(() => fetchResponder(url, init));
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
    ...init,
  });
}

function patchRequest(body: unknown): Request {
  return new Request("http://localhost/api/client-versions", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function checkRequest(body?: unknown): Request {
  return new Request("http://localhost/api/client-versions/check", {
    method: "POST",
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function resetStorage() {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
}

service.setClientVersionFetchImpl(mockFetch);

test.beforeEach(async () => {
  await service.flushClientVersionChecks();
  for (const name of ENV_NAMES) delete process.env[name];
  fetchCalls.length = 0;
  fetchResponder = () => {
    throw new Error("unexpected network call");
  };
  registry.resetClientVersionRegistry();
  upstream.clearClientVersionEtagCache();
  antigravityVersion.clearAntigravityVersionCaches();
  service.stopClientVersionScheduler();
  runtimeSettings.resetRuntimeSettingsStateForTests();
  await resetStorage();
});

test.after(async () => {
  await service.flushClientVersionChecks();
  service.stopClientVersionScheduler();
  service.setClientVersionFetchImpl(null);
  registry.resetClientVersionRegistry();
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  if (ORIGINAL_DATA_DIR === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = ORIGINAL_DATA_DIR;
  for (const name of ENV_NAMES) {
    if (ORIGINAL_ENV[name] === undefined) delete process.env[name];
    else process.env[name] = ORIGINAL_ENV[name];
  }
});

// ── Default safety ───────────────────────────────────────────────────────────

test("fresh install: all four products default to off and getters keep the baseline pins", async () => {
  const modes = await service.getClientVersionModes();
  assert.deepEqual(modes, registry.createDefaultClientVersionModes());
  for (const product of registry.CLIENT_VERSION_PRODUCTS) {
    assert.equal(modes[product].mode, "off");
    assert.equal(registry.getActiveClientVersion(product), null);
  }

  assert.equal(claudeClient.getClaudeCodeClientVersion(), claudeClient.CLAUDE_CODE_CLIENT_VERSION);
  assert.equal(
    claudeClient.getClaudeCodeUserAgent("cli"),
    `claude-cli/${claudeClient.CLAUDE_CODE_CLIENT_VERSION} (external, cli)`
  );
  assert.equal(codexClient.getCodexClientVersion(), codexClient.DEFAULT_CODEX_CLIENT_VERSION);
  assert.equal(
    antigravityVersion.getCachedAntigravityIdeVersion(),
    antigravityVersion.ANTIGRAVITY_IDE_FALLBACK_VERSION
  );
  assert.equal(
    antigravityVersion.getCachedAntigravityCliVersion(),
    antigravityVersion.ANTIGRAVITY_CLI_FALLBACK_VERSION
  );
  assert.match(
    geminiDiscovery.getGeminiCliAuthHeaders("tok")["User-Agent"],
    /^GeminiCLI\/(?:0\.61\.0|0\.31\.0) /
  );
});

test("all products off: startup apply + explicit check make zero network calls", async () => {
  await runtimeSettings.applyRuntimeSettings(await settingsDb.getSettings(), {
    force: true,
    source: "startup",
  });
  assert.equal(service.isClientVersionSchedulerRunning(), false);

  const result = await service.runClientVersionCheck();
  assert.deepEqual(result.checked, []);
  assert.equal(result.skipped.length, 4);

  const response = await checkRoute.POST(checkRequest());
  assert.equal(response.status, 200);
  assert.equal(fetchCalls.length, 0);
});

// ── Precedence ───────────────────────────────────────────────────────────────

test("resolveConfiguredVersion: manual mode > auto; automatic uses auto then manual", () => {
  const resolve = registry.resolveConfiguredVersion;
  assert.equal(
    resolve({ mode: "off", manualVersion: "9.9.9", autoDetectedVersion: "8.8.8" }),
    null
  );
  assert.equal(
    resolve({ mode: "manual", manualVersion: "9.9.9", autoDetectedVersion: "8.8.8" }),
    "9.9.9"
  );
  assert.equal(resolve({ mode: "manual", autoDetectedVersion: "8.8.8" }), null);
  assert.equal(
    resolve({ mode: "automatic", manualVersion: "9.9.9", autoDetectedVersion: "8.8.8" }),
    "8.8.8"
  );
  assert.equal(resolve({ mode: "automatic", manualVersion: "9.9.9" }), "9.9.9");
  assert.equal(resolve({ mode: "automatic" }), null);
  assert.equal(resolve(undefined), null);
});

test("precedence chain: manual > auto > env > hardcoded for claude-code", () => {
  const pinned = claudeClient.CLAUDE_CODE_CLIENT_VERSION;
  assert.equal(claudeClient.getClaudeCodeClientVersion(), pinned);

  process.env.CLAUDE_CODE_CLIENT_VERSION = "2.1.250";
  assert.equal(claudeClient.getClaudeCodeClientVersion(), "2.1.250", "env beats hardcoded");

  registry.setClientVersionModes({
    "claude-code": { mode: "automatic", autoDetectedVersion: "2.1.282" },
  });
  assert.equal(claudeClient.getClaudeCodeClientVersion(), "2.1.282", "auto beats env");

  registry.setClientVersionModes({
    "claude-code": { mode: "manual", manualVersion: "2.1.299", autoDetectedVersion: "2.1.282" },
  });
  assert.equal(claudeClient.getClaudeCodeClientVersion(), "2.1.299", "manual beats auto");

  registry.setClientVersionModes({ "claude-code": { mode: "off", manualVersion: "2.1.299" } });
  assert.equal(claudeClient.getClaudeCodeClientVersion(), "2.1.250", "off restores env");

  delete process.env.CLAUDE_CODE_CLIENT_VERSION;
  assert.equal(claudeClient.getClaudeCodeClientVersion(), pinned, "off restores the pin");
});

test("each product getter consults the registry first and falls back when off", () => {
  registry.setClientVersionModes({
    "claude-code": { mode: "manual", manualVersion: "2.1.299" },
    codex: { mode: "manual", manualVersion: "0.156.1" },
    antigravity: { mode: "manual", manualVersion: "2.3.0", manualCliVersion: "1.0.5" },
    "gemini-cli": { mode: "manual", manualVersion: "0.40.0" },
  });

  assert.equal(claudeClient.getClaudeCodeUserAgent("cli"), "claude-cli/2.1.299 (external, cli)");
  assert.equal(
    claudeClient.getClaudeCodeClientBillingVersion(),
    `2.1.299.${claudeClient.CLAUDE_CODE_CLIENT_BUILD_REVISION}`
  );

  const codexHeaders = codexClient.getCodexDefaultHeaders();
  assert.equal(codexHeaders.Version, "0.156.1");
  assert.match(codexHeaders["User-Agent"], /^codex-cli\/0\.156\.1 /);
  assert.equal(codexClient.getCodexCliRsHeaders()["User-Agent"], "codex_cli_rs/0.156.1");

  assert.equal(antigravityHeaders.antigravityIdeUserAgent(), "antigravity/ide/2.3.0 darwin/arm64");
  assert.match(antigravityHeaders.antigravityCliUserAgent(), /^antigravity\/cli\/1\.0\.5 /);

  assert.match(
    geminiDiscovery.getGeminiCliAuthHeaders("tok")["User-Agent"],
    /^GeminiCLI\/0\.40\.0 /
  );
  assert.match(geminiExecutor.buildGeminiCliHeaders("tok")["User-Agent"], /^GeminiCLI\/0\.40\.0 /);
  // An explicit per-call version still wins over the registry.
  assert.match(
    geminiExecutor.buildGeminiCliHeaders("tok", undefined, { uaVersion: "0.1.0" })["User-Agent"],
    /^GeminiCLI\/0\.1\.0 /
  );

  registry.resetClientVersionRegistry();
  assert.equal(codexClient.getCodexClientVersion(), codexClient.DEFAULT_CODEX_CLIENT_VERSION);
  assert.match(
    geminiDiscovery.getGeminiCliAuthHeaders("tok")["User-Agent"],
    /^GeminiCLI\/(?:0\.61\.0|0\.31\.0) /
  );
});

test("antigravity resolve* short-circuits to the dynamic version without fetching", async () => {
  registry.setClientVersionModes({
    antigravity: { mode: "manual", manualVersion: "2.4.0", manualCliVersion: "1.0.9" },
  });
  const noFetch = (() => {
    throw new Error("should not fetch");
  }) as unknown as typeof fetch;
  assert.equal(await antigravityVersion.resolveAntigravityIdeVersion(noFetch), "2.4.0");
  assert.equal(await antigravityVersion.resolveAntigravityCliVersion(noFetch), "1.0.9");
});

test("antigravity IDE manual version never leaks into the CLI version", () => {
  registry.setClientVersionModes({ antigravity: { mode: "manual", manualVersion: "2.4.0" } });
  assert.equal(registry.getActiveClientVersion("antigravity"), "2.4.0");
  assert.equal(registry.getActiveClientVersion("antigravity-cli"), null);
  assert.equal(antigravityVersion.getCachedAntigravityIdeVersion(), "2.4.0");
  assert.equal(
    antigravityVersion.getCachedAntigravityCliVersion(),
    antigravityVersion.ANTIGRAVITY_CLI_FALLBACK_VERSION
  );
});

// ── Validation ───────────────────────────────────────────────────────────────

test("schema rejects invalid characters, CRLF injection, bad products and modes", () => {
  const parse = (body: unknown) => schemas.updateClientVersionModeSchema.safeParse(body);
  assert.equal(
    parse({ product: "claude-code", mode: "manual", manualVersion: "2.1.299" }).success,
    true
  );
  assert.equal(parse({ product: "codex", mode: "off" }).success, true);
  assert.equal(parse({ product: "gemini-cli", mode: "automatic" }).success, true);

  for (const manualVersion of [
    "2.1.299\r\nX-Injected: 1",
    "2.1.299\n",
    "2.1 299",
    "2.1.299;evil",
    "-2.1.0",
    "a".repeat(33),
    "../../etc",
  ]) {
    assert.equal(
      parse({ product: "claude-code", mode: "manual", manualVersion }).success,
      false,
      `should reject ${JSON.stringify(manualVersion)}`
    );
  }
  assert.equal(
    parse({ product: "claude-code", mode: "manual" }).success,
    false,
    "manual needs a version"
  );
  assert.equal(
    parse({ product: "claude-code", mode: "manual", manualVersion: "  " }).success,
    false
  );
  assert.equal(parse({ product: "copilot", mode: "off" }).success, false, "only the 4 products");
  assert.equal(parse({ product: "codex", mode: "on" }).success, false);
  assert.equal(parse({ product: "codex", mode: "off", extra: 1 }).success, false);
  assert.equal(
    parse({
      product: "antigravity",
      mode: "manual",
      manualVersion: "2.3.0",
      manualCliVersion: "1.0.2",
    }).success,
    true
  );
  assert.equal(
    parse({ product: "codex", mode: "manual", manualVersion: "0.1.0", manualCliVersion: "1.0.2" })
      .success,
    false,
    "manualCliVersion is antigravity-only"
  );
  assert.equal(
    parse({ product: "antigravity", mode: "off", manualCliVersion: "1.0\r\nX: y" }).success,
    false
  );
});

test("registry ignores unsafe stored versions (e.g. tampered DB rows) and falls back", () => {
  registry.setClientVersionModes({
    "claude-code": { mode: "manual", manualVersion: "2.1.0\r\nX-Evil: 1" },
    codex: { mode: "automatic", autoDetectedVersion: "0.1 0" },
    antigravity: "not-an-object",
    "gemini-cli": { mode: "bogus", manualVersion: "0.40.0" },
  });
  for (const product of registry.CLIENT_VERSION_PRODUCTS) {
    assert.equal(registry.getActiveClientVersion(product), null, product);
  }
  assert.equal(claudeClient.getClaudeCodeClientVersion(), claudeClient.CLAUDE_CODE_CLIENT_VERSION);
  assert.deepEqual(
    registry.normalizeClientVersionModes("{not json"),
    registry.createDefaultClientVersionModes()
  );
});

test("PATCH rejects invalid bodies with 400 and leaves settings untouched", async () => {
  const bad = await route.PATCH(
    patchRequest({ product: "claude-code", mode: "manual", manualVersion: "1.0\r\nX: y" })
  );
  assert.equal(bad.status, 400);
  const malformed = await route.PATCH(patchRequest("{nope"));
  assert.equal(malformed.status, 400);
  const unknownProduct = await route.PATCH(patchRequest({ product: "cursor", mode: "off" }));
  assert.equal(unknownProduct.status, 400);
  assert.equal((await service.getClientVersionModes())["claude-code"].mode, "off");
});

// ── Mode switching (off → manual → automatic → off) ─────────────────────────

test("mode transitions via the API hot-reload the wire headers without restart", async () => {
  fetchResponder = (url) => {
    assert.match(url, /@anthropic-ai%2Fclaude-code\/dist-tags$/);
    return jsonResponse(
      { latest: "2.1.282", next: "2.2.0-beta.1" },
      { headers: { etag: 'W/"abc"' } }
    );
  };

  // off → manual
  let response = await route.PATCH(
    patchRequest({ product: "claude-code", mode: "manual", manualVersion: "2.1.299" })
  );
  assert.equal(response.status, 200);
  let body = (await response.json()) as StatusBody;
  let claude = body.products.find((p) => p.product === "claude-code")!;
  assert.equal(claude.activeVersion, "2.1.299");
  assert.equal(claude.source, "manual");
  assert.equal(claude.wirePreview["User-Agent"], "claude-cli/2.1.299 (external, cli)");
  assert.equal(claudeClient.getClaudeCodeClientVersion(), "2.1.299");
  assert.equal(fetchCalls.length, 0, "manual mode never hits the network");

  // manual → automatic: immediate npm query resolves dist-tags.latest
  response = await route.PATCH(patchRequest({ product: "claude-code", mode: "automatic" }));
  assert.equal(response.status, 200);
  body = (await response.json()) as StatusBody;
  claude = body.products.find((p) => p.product === "claude-code")!;
  assert.equal(fetchCalls.length, 1);
  assert.equal(claude.config.autoDetectedVersion, "2.1.282");
  assert.equal(claude.config.manualVersion, "2.1.299", "manual value retained as fallback");
  assert.ok(claude.config.lastCheckedAt);
  assert.equal(claude.activeVersion, "2.1.282");
  assert.equal(claude.source, "automatic");
  assert.equal(claudeClient.getClaudeCodeUserAgent("cli"), "claude-cli/2.1.282 (external, cli)");

  // persisted in key_value settings under clientVersionModes
  const stored = (await settingsDb.getSettings()).clientVersionModes as Record<
    string,
    Record<string, unknown>
  >;
  assert.equal(stored["claude-code"].mode, "automatic");
  assert.equal(stored["claude-code"].autoDetectedVersion, "2.1.282");

  // automatic → off
  response = await route.PATCH(patchRequest({ product: "claude-code", mode: "off" }));
  body = (await response.json()) as StatusBody;
  claude = body.products.find((p) => p.product === "claude-code")!;
  assert.equal(claude.source, "default");
  assert.equal(claude.activeVersion, claudeClient.CLAUDE_CODE_CLIENT_VERSION);
  assert.equal(claudeClient.getClaudeCodeClientVersion(), claudeClient.CLAUDE_CODE_CLIENT_VERSION);
  assert.equal(service.isClientVersionSchedulerRunning(), false);
});

test("GET reports env source when off and an env override is set", async () => {
  process.env.CODEX_CLIENT_VERSION = "0.150.0";
  const response = await route.GET(new Request("http://localhost/api/client-versions"));
  assert.equal(response.status, 200);
  const body = (await response.json()) as StatusBody;
  assert.deepEqual(
    body.products.map((p) => p.product),
    ["claude-code", "codex", "antigravity", "gemini-cli"]
  );
  const codex = body.products.find((p) => p.product === "codex")!;
  assert.equal(codex.source, "env");
  assert.equal(codex.activeVersion, "0.150.0");
  assert.equal(codex.wirePreview.Version, "0.150.0");
});

test("settings reload through applyRuntimeSettings updates the registry (startup path)", async () => {
  await settingsDb.updateSettings({
    clientVersionModes: { codex: { mode: "manual", manualVersion: "0.160.0" } },
  });
  registry.resetClientVersionRegistry();
  runtimeSettings.resetRuntimeSettingsStateForTests();
  const changes = await runtimeSettings.applyRuntimeSettings(await settingsDb.getSettings(), {
    force: true,
    source: "startup",
  });
  assert.ok(changes.some((c) => c.section === "clientVersionModes"));
  assert.equal(codexClient.getCodexClientVersion(), "0.160.0");
});

// ── Upstream resolution & graceful errors ────────────────────────────────────

test("upstream parsers handle npm dist-tags, GitHub releases and the Antigravity feed", () => {
  assert.equal(upstream.parseNpmDistTags({ latest: "2.1.282" }), "2.1.282");
  assert.equal(upstream.parseNpmDistTags({ "dist-tags": { latest: "0.156.1" } }), "0.156.1");
  assert.equal(upstream.parseNpmDistTags({ latest: "1.0\r\nX-Evil: 1" }), null);
  assert.equal(upstream.parseNpmDistTags(null), null);
  assert.equal(upstream.parseGithubRelease({ tag_name: "rust-v0.156.1" }, /^rust-v/i), "0.156.1");
  assert.equal(upstream.parseGithubRelease({ tag_name: "v0.42.0" }), "0.42.0");
  assert.equal(
    upstream.parseAntigravityReleaseFeed([
      { version: "2.1.1" },
      { version: "2.3.0" },
      { version: "2.2.9" },
    ]),
    "2.3.0"
  );
  assert.equal(upstream.parseAntigravityReleaseFeed({}), null);
});

test("codex falls back to the GitHub release feed and strips rust-v", async () => {
  fetchResponder = (url) =>
    url.includes("registry.npmjs.org")
      ? new Response("down", { status: 503 })
      : jsonResponse({ tag_name: "rust-v0.157.0" });
  assert.equal(await upstream.fetchLatestClientVersion("codex", mockFetch), "0.157.0");
  assert.equal(fetchCalls.length, 2);
  assert.match(fetchCalls[1].url, /api\.github\.com\/repos\/openai\/codex\/releases\/latest/);
});

test("ETag negotiation: 304 Not Modified reuses the cached version", async () => {
  fetchResponder = () => jsonResponse({ latest: "0.45.0" }, { headers: { etag: '"v1"' } });
  assert.equal(await upstream.fetchLatestClientVersion("gemini-cli", mockFetch), "0.45.0");
  fetchResponder = (_url, init) => {
    assert.equal((init?.headers as Record<string, string>)["If-None-Match"], '"v1"');
    return new Response(null, { status: 304 });
  };
  assert.equal(await upstream.fetchLatestClientVersion("gemini-cli", mockFetch), "0.45.0");
});

test("network failure in automatic mode falls back to manual, then baseline, without throwing", async () => {
  fetchResponder = () => {
    throw new TypeError("fetch failed");
  };

  await service.updateClientVersionMode({
    product: "antigravity",
    mode: "automatic",
    manualVersion: "2.2.0",
  });
  // Switching to automatic kicks off one background check; count only the explicit one.
  await service.flushClientVersionChecks();
  fetchCalls.length = 0;
  const result = await service.runClientVersionCheck({ product: "antigravity" });
  assert.deepEqual(result.checked, ["antigravity"]);
  assert.equal(fetchCalls.length, 2, "IDE feed + CLI release feed attempted");

  let modes = await service.getClientVersionModes();
  assert.equal(modes.antigravity.autoDetectedVersion, undefined);
  assert.match(modes.antigravity.lastCheckError!, /IDE: .*fetch failed/);
  assert.match(modes.antigravity.lastCheckError!, /CLI: .*fetch failed/);
  assert.ok(modes.antigravity.lastCheckedAt);
  assert.equal(
    antigravityVersion.getCachedAntigravityIdeVersion(),
    "2.2.0",
    "falls back to manual"
  );
  assert.equal(
    antigravityVersion.getCachedAntigravityCliVersion(),
    antigravityVersion.ANTIGRAVITY_CLI_FALLBACK_VERSION,
    "the IDE manual version is not applied to the CLI"
  );

  await service.updateClientVersionMode({
    product: "antigravity",
    mode: "automatic",
    manualVersion: "",
  });
  modes = await service.getClientVersionModes();
  assert.equal(modes.antigravity.manualVersion, undefined);
  assert.equal(
    antigravityVersion.getCachedAntigravityIdeVersion(),
    antigravityVersion.ANTIGRAVITY_IDE_FALLBACK_VERSION,
    "then to the baseline"
  );
});

test("failed re-check keeps the previously detected version", async () => {
  fetchResponder = () => jsonResponse({ latest: "0.158.0" });
  await service.updateClientVersionMode({ product: "codex", mode: "automatic" });
  await service.runClientVersionCheck({ product: "codex" });
  assert.equal(codexClient.getCodexClientVersion(), "0.158.0");

  fetchResponder = () => new Response("nope", { status: 500 });
  await service.runClientVersionCheck({ product: "codex" });
  const modes = await service.getClientVersionModes();
  assert.equal(modes.codex.autoDetectedVersion, "0.158.0");
  assert.match(modes.codex.lastCheckError!, /HTTP 500/);
  assert.equal(codexClient.getCodexClientVersion(), "0.158.0");
});

test("POST /check only queries products in automatic mode and validates the body", async () => {
  fetchResponder = () => jsonResponse({ latest: "0.46.0" });
  await service.updateClientVersionMode({ product: "gemini-cli", mode: "automatic" });
  // Switching to automatic with no lastCheckedAt kicks off one background check.
  await service.flushClientVersionChecks();
  assert.equal(fetchCalls.length, 1);
  fetchCalls.length = 0;

  const skipped = await checkRoute.POST(checkRequest({ product: "claude-code" }));
  assert.equal(skipped.status, 200);
  assert.deepEqual(((await skipped.json()) as StatusBody).skipped, ["claude-code"]);
  assert.equal(fetchCalls.length, 0);

  const response = await checkRoute.POST(checkRequest());
  assert.equal(response.status, 200);
  const body = (await response.json()) as StatusBody;
  assert.deepEqual(body.checked, ["gemini-cli"]);
  const gemini = body.products.find((p) => p.product === "gemini-cli")!;
  assert.equal(gemini.activeVersion, "0.46.0");
  assert.match(gemini.wirePreview["User-Agent"], /^GeminiCLI\/0\.46\.0 /);

  const invalid = await checkRoute.POST(checkRequest({ product: "nope" }));
  assert.equal(invalid.status, 400);
});

test("scheduler starts only while a product is automatic", async () => {
  fetchResponder = () => jsonResponse({ latest: "2.1.300" });
  service.syncClientVersionScheduler(registry.createDefaultClientVersionModes());
  assert.equal(service.isClientVersionSchedulerRunning(), false);

  service.syncClientVersionScheduler({
    "claude-code": { mode: "automatic", lastCheckedAt: new Date().toISOString() },
  });
  assert.equal(service.isClientVersionSchedulerRunning(), true);
  assert.equal(fetchCalls.length, 0, "fresh lastCheckedAt → no immediate check");

  service.syncClientVersionScheduler({ "claude-code": { mode: "off" } });
  assert.equal(service.isClientVersionSchedulerRunning(), false);
});

// ── Antigravity IDE vs CLI ───────────────────────────────────────────────────

test("antigravity automatic mode stores distinct upstream IDE and CLI versions", async () => {
  fetchResponder = (url) =>
    url.includes("antigravity-auto-updater")
      ? jsonResponse([{ version: "2.3.0" }, { version: "2.2.9" }])
      : jsonResponse({ tag_name: "v1.0.7" });

  await service.updateClientVersionMode({ product: "antigravity", mode: "automatic" });
  await service.runClientVersionCheck({ product: "antigravity" });

  const modes = await service.getClientVersionModes();
  assert.equal(modes.antigravity.autoDetectedVersion, "2.3.0");
  assert.equal(modes.antigravity.autoDetectedCliVersion, "1.0.7");
  assert.equal(modes.antigravity.lastCheckError, undefined);
  assert.equal(await antigravityVersion.resolveAntigravityIdeVersion(), "2.3.0");
  assert.equal(await antigravityVersion.resolveAntigravityCliVersion(), "1.0.7");
  assert.equal(antigravityHeaders.antigravityIdeUserAgent(), "antigravity/ide/2.3.0 darwin/arm64");
  assert.match(antigravityHeaders.antigravityCliUserAgent(), /^antigravity\/cli\/1\.0\.7 /);

  const status = await service.getClientVersionStatus();
  const antigravity = status.products.find((p) => p.product === "antigravity")!;
  assert.equal(antigravity.activeVersion, "2.3.0");
  assert.equal(antigravity.activeCliVersion, "1.0.7");
  assert.equal(antigravity.cliSource, "automatic");
});

test("antigravity IDE feed failure does not borrow the CLI release version", async () => {
  fetchResponder = (url) =>
    url.includes("antigravity-auto-updater")
      ? new Response("down", { status: 503 })
      : jsonResponse({ tag_name: "v1.0.7" });

  await service.updateClientVersionMode({ product: "antigravity", mode: "automatic" });
  await service.runClientVersionCheck({ product: "antigravity" });

  const modes = await service.getClientVersionModes();
  assert.equal(modes.antigravity.autoDetectedVersion, undefined);
  assert.equal(modes.antigravity.autoDetectedCliVersion, "1.0.7");
  assert.match(modes.antigravity.lastCheckError!, /^IDE: .*HTTP 503$/);
  assert.equal(
    antigravityVersion.getCachedAntigravityIdeVersion(),
    antigravityVersion.ANTIGRAVITY_IDE_FALLBACK_VERSION
  );
  assert.equal(antigravityVersion.getCachedAntigravityCliVersion(), "1.0.7");
});

// ── Concurrency & persistence ordering ───────────────────────────────────────

test("concurrent updates to two different products preserve both changes", async () => {
  await Promise.all([
    service.updateClientVersionMode({
      product: "claude-code",
      mode: "manual",
      manualVersion: "2.1.299",
    }),
    service.updateClientVersionMode({ product: "codex", mode: "manual", manualVersion: "0.160.0" }),
    route.PATCH(patchRequest({ product: "gemini-cli", mode: "manual", manualVersion: "0.40.0" })),
  ]);

  const modes = await service.getClientVersionModes();
  assert.equal(modes["claude-code"].manualVersion, "2.1.299");
  assert.equal(modes.codex.manualVersion, "0.160.0");
  assert.equal(modes["gemini-cli"].manualVersion, "0.40.0");
  assert.equal(claudeClient.getClaudeCodeClientVersion(), "2.1.299");
  assert.equal(codexClient.getCodexClientVersion(), "0.160.0");
});

test("a concurrent auto-check does not clobber a PATCH to another product", async () => {
  fetchResponder = () => jsonResponse({ latest: "0.158.0" });
  await service.updateClientVersionMode({ product: "codex", mode: "automatic" });
  await service.flushClientVersionChecks();

  await Promise.all([
    service.runClientVersionCheck({ product: "codex" }),
    service.updateClientVersionMode({
      product: "claude-code",
      mode: "manual",
      manualVersion: "2.1.299",
    }),
  ]);

  const modes = await service.getClientVersionModes();
  assert.equal(modes.codex.autoDetectedVersion, "0.158.0");
  assert.equal(modes["claude-code"].mode, "manual");
  assert.equal(modes["claude-code"].manualVersion, "2.1.299");
});

test("an in-flight auto-check does not overwrite a product switched out of automatic", async () => {
  fetchResponder = () => jsonResponse({ latest: "0.158.0" });
  await service.updateClientVersionMode({ product: "codex", mode: "automatic" });
  await service.flushClientVersionChecks();
  await service.runClientVersionCheck({ product: "codex" });

  let releaseFetch!: () => void;
  const fetchHeld = new Promise<void>((resolve) => (releaseFetch = resolve));
  let fetchStarted!: () => void;
  const started = new Promise<void>((resolve) => (fetchStarted = resolve));
  fetchResponder = async () => {
    fetchStarted();
    await fetchHeld;
    return jsonResponse({ latest: "0.999.0" });
  };

  const pendingCheck = service.runClientVersionCheck({ product: "codex" });
  await started;
  await service.updateClientVersionMode({ product: "codex", mode: "off" });
  const beforeCompletion = (await service.getClientVersionModes()).codex;
  assert.equal(beforeCompletion.mode, "off");

  releaseFetch();
  await pendingCheck;

  const after = (await service.getClientVersionModes()).codex;
  assert.equal(after.mode, "off");
  assert.equal(after.autoDetectedVersion, beforeCompletion.autoDetectedVersion);
  assert.equal(after.autoDetectedVersion, "0.158.0");
  assert.equal(after.lastCheckedAt, beforeCompletion.lastCheckedAt);
  assert.equal(after.lastCheckError, beforeCompletion.lastCheckError);
});

test("a failed settings write leaves the in-memory registry on the previous value", async () => {
  await service.updateClientVersionMode({
    product: "claude-code",
    mode: "manual",
    manualVersion: "2.1.299",
  });
  assert.equal(claudeClient.getClaudeCodeClientVersion(), "2.1.299");

  const db = core.getDbInstance();
  db.exec(`CREATE TRIGGER fail_client_version_write BEFORE INSERT ON key_value
    WHEN NEW.namespace = 'settings' AND NEW.key = 'clientVersionModes'
    BEGIN SELECT RAISE(ABORT, 'simulated write failure'); END;`);
  try {
    await assert.rejects(
      service.updateClientVersionMode({
        product: "claude-code",
        mode: "manual",
        manualVersion: "2.1.300",
      }),
      /simulated write failure/
    );
    assert.equal(registry.getActiveClientVersion("claude-code"), "2.1.299");
    assert.equal(claudeClient.getClaudeCodeClientVersion(), "2.1.299");
  } finally {
    db.exec("DROP TRIGGER IF EXISTS fail_client_version_write;");
  }
  assert.equal((await service.getClientVersionModes())["claude-code"].manualVersion, "2.1.299");
});

// ── Review remediation: read-only status, revisions, check generations, UI state ─

test("GET status is side-effect free: it never rewrites the in-memory registry", async () => {
  await service.updateClientVersionMode({
    product: "codex",
    mode: "manual",
    manualVersion: "0.160.0",
  });
  // Simulate a newer registry value than the one a slow read would observe.
  registry.setClientVersionModes({ codex: { mode: "manual", manualVersion: "0.170.0" } });

  const response = await route.GET(new Request("http://localhost/api/client-versions"));
  assert.equal(response.status, 200);
  const status = await service.getClientVersionStatus();
  assert.equal(status.products.find((p) => p.product === "codex")!.config.manualVersion, "0.160.0");
  assert.equal(registry.getActiveClientVersion("codex"), "0.170.0");
  assert.equal(codexClient.getCodexClientVersion(), "0.170.0");
});

test("registry ignores out-of-order (older revision) reloads", () => {
  assert.equal(
    registry.setClientVersionModes(
      { codex: { mode: "manual", manualVersion: "0.170.0" } },
      { revision: 5 }
    ),
    true
  );
  assert.equal(
    registry.setClientVersionModes(
      { codex: { mode: "manual", manualVersion: "0.160.0" } },
      { revision: 4 }
    ),
    false
  );
  assert.equal(registry.getActiveClientVersion("codex"), "0.170.0");
  assert.equal(registry.getClientVersionRegistryRevision(), 5);
  // Same revision re-applies (the write path and its hot-reload share one revision).
  assert.equal(
    registry.setClientVersionModes(
      { codex: { mode: "manual", manualVersion: "0.170.0" } },
      { revision: 5 }
    ),
    true
  );
  registry.resetClientVersionRegistry();
  assert.equal(registry.getClientVersionRegistryRevision(), null);
});

test("a stale applyRuntimeSettings reload cannot roll back a newer committed write", async () => {
  await service.updateClientVersionMode({
    product: "claude-code",
    mode: "manual",
    manualVersion: "2.1.299",
  });
  const staleSettings = await settingsDb.getSettings();
  const staleRevision = await settingsDb.getSettingsRevision();
  await service.updateClientVersionMode({
    product: "claude-code",
    mode: "manual",
    manualVersion: "2.1.300",
  });
  assert.equal(registry.getClientVersionRegistryRevision(), staleRevision + 1);

  // The older write's hot-reload lands last.
  await runtimeSettings.applyRuntimeSettings(staleSettings, {
    force: true,
    source: "settings:update",
    revision: staleRevision,
  });
  assert.equal(claudeClient.getClaudeCodeClientVersion(), "2.1.300");
});

test("an in-flight check is discarded when the product cycles automatic → off → automatic", async () => {
  fetchResponder = () => jsonResponse({ latest: "0.158.0" });
  await service.updateClientVersionMode({ product: "codex", mode: "automatic" });
  await service.flushClientVersionChecks();
  await service.runClientVersionCheck({ product: "codex" });
  const generationAtStart = service.getClientVersionModeGeneration("codex");

  let releaseFetch!: () => void;
  const fetchHeld = new Promise<void>((resolve) => (releaseFetch = resolve));
  let fetchStarted!: () => void;
  const started = new Promise<void>((resolve) => (fetchStarted = resolve));
  fetchResponder = async () => {
    fetchStarted();
    await fetchHeld;
    return jsonResponse({ latest: "0.999.0" });
  };
  const staleCheck = service.runClientVersionCheck({ product: "codex" });
  await started;

  await service.updateClientVersionMode({ product: "codex", mode: "off" });
  await service.updateClientVersionMode({ product: "codex", mode: "automatic" });
  await service.flushClientVersionChecks();
  assert.equal(service.getClientVersionModeGeneration("codex"), generationAtStart + 2);

  // A check started under the new generation must not join the stale fetch.
  const callsBefore = fetchCalls.length;
  fetchResponder = () => jsonResponse({ latest: "0.200.0" });
  const freshResult = await service.runClientVersionCheck({ product: "codex" });
  assert.equal(fetchCalls.length, callsBefore + 1);
  assert.deepEqual(freshResult.discarded, []);

  releaseFetch();
  const staleResult = await staleCheck;
  assert.deepEqual(staleResult.discarded, ["codex"]);

  const codex = (await service.getClientVersionModes()).codex;
  assert.equal(codex.mode, "automatic");
  assert.equal(codex.autoDetectedVersion, "0.200.0");
  assert.equal(codexClient.getCodexClientVersion(), "0.200.0");
});

test("a failed write does not bump the mode generation", async () => {
  const before = service.getClientVersionModeGeneration("codex");
  const db = core.getDbInstance();
  db.exec(`CREATE TRIGGER fail_client_version_write BEFORE INSERT ON key_value
    WHEN NEW.namespace = 'settings' AND NEW.key = 'clientVersionModes'
    BEGIN SELECT RAISE(ABORT, 'simulated write failure'); END;`);
  try {
    await assert.rejects(
      service.updateClientVersionMode({ product: "codex", mode: "automatic" }),
      /simulated write failure/
    );
  } finally {
    db.exec("DROP TRIGGER IF EXISTS fail_client_version_write;");
  }
  assert.equal(service.getClientVersionModeGeneration("codex"), before);
});

test("card busy state is tracked per product", () => {
  let busy: Record<string, boolean> = {};
  busy = cardState.setProductBusy(busy, "codex", true);
  busy = cardState.setProductBusy(busy, "claude-code", true);
  // codex finishes first: claude-code must stay busy.
  busy = cardState.setProductBusy(busy, "codex", false);
  assert.deepEqual(busy, { "claude-code": true });
  busy = cardState.setProductBusy(busy, "claude-code", false);
  assert.deepEqual(busy, {});
  assert.equal(cardState.setProductBusy(busy, "codex", false), busy, "no-op keeps identity");
});

test("card drafts sync to persisted values unless the input has dirty edits", () => {
  let drafts = cardState.syncDraftsWithPersisted(cardState.EMPTY_DRAFTS, {
    codex: "0.160.0",
    "claude-code": "",
  });
  assert.deepEqual(drafts.values, { codex: "0.160.0", "claude-code": "" });

  // Clean input follows a refreshed server value.
  drafts = cardState.syncDraftsWithPersisted(drafts, { codex: "0.170.0", "claude-code": "" });
  assert.equal(drafts.values.codex, "0.170.0");

  // Saving " 2.1.299 " persists the trimmed value; the input adopts it.
  drafts = cardState.editDraft(drafts, "claude-code", " 2.1.299 ");
  drafts = cardState.syncDraftsWithPersisted(drafts, {
    codex: "0.170.0",
    "claude-code": "2.1.299",
  });
  assert.equal(drafts.values["claude-code"], "2.1.299");

  // A dirty, uncommitted edit survives a refresh (e.g. another product's save).
  drafts = cardState.editDraft(drafts, "codex", "0.18");
  drafts = cardState.syncDraftsWithPersisted(drafts, {
    codex: "0.175.0",
    "claude-code": "2.1.299",
  });
  assert.equal(drafts.values.codex, "0.18");
  assert.equal(drafts.persisted.codex, "0.175.0");

  // Reverting the edit back to the persisted value makes it clean again.
  drafts = cardState.editDraft(drafts, "codex", "0.175.0");
  drafts = cardState.syncDraftsWithPersisted(drafts, {
    codex: "0.180.0",
    "claude-code": "2.1.299",
  });
  assert.equal(drafts.values.codex, "0.180.0");
});
