import assert from "node:assert/strict";
import test from "node:test";

// Regression coverage for the Antigravity IDE → App identity migration. Under the retired
// `antigravity/ide/<v>` identity, `gemini-4-argon-*` returned 429 RESOURCE_EXHAUSTED and was
// absent from `:fetchAvailableModels`; OmniRoute also had no argon/3.8 ids or specs, so
// requests fell back to the generic 16384 output clamp.

import {
  ANTIGRAVITY_PUBLIC_MODELS,
  resolveAntigravityModelId,
} from "../../open-sse/config/antigravityModelAliases.ts";
import { getModelSpec } from "../../src/shared/constants/modelSpecs.ts";
import {
  ANTIGRAVITY_CLIENT_PROFILE_OPTIONS,
  ANTIGRAVITY_CLIENT_PROFILE_VALUES,
  DEFAULT_ANTIGRAVITY_CLIENT_PROFILE,
  normalizeAntigravityClientProfile,
} from "../../src/shared/constants/antigravityClientProfile.ts";
import {
  antigravityAppUserAgent,
  getAntigravityContentHeaders,
  getAntigravityOAuthUserAgent,
} from "../../open-sse/services/antigravityHeaders.ts";
import {
  ANTIGRAVITY_APP_FALLBACK_VERSION,
  clearAntigravityVersionCaches,
  getCachedAntigravityAppVersion,
  seedAntigravityAppVersionCache,
} from "../../open-sse/services/antigravityVersion.ts";
import { parseAntigravityAppManifest } from "../../src/lib/client-versions/upstream.ts";

test.afterEach(() => {
  clearAntigravityVersionCaches();
});

test("bare gemini-4-argon resolves to Medium and tiered ids resolve to themselves", () => {
  assert.equal(resolveAntigravityModelId("gemini-4-argon"), "gemini-4-argon-medium");
  for (const tier of ["high", "medium", "low"]) {
    const id = `gemini-4-argon-${tier}`;
    assert.equal(resolveAntigravityModelId(id), id);
    assert.ok(
      ANTIGRAVITY_PUBLIC_MODELS.some((model) => model.id === id),
      `${id} must be in the Antigravity catalog`
    );
  }
});

test("argon and 3.8 Flash specs carry their real output caps, not the 16384 clamp", () => {
  assert.equal(getModelSpec("gemini-4-argon-high")?.maxOutputTokens, 65535);
  assert.equal(getModelSpec("gemini-3.8-flash-tiered")?.maxOutputTokens, 65536);
});

test("the client profile surface is exactly app (default) and cli", () => {
  assert.deepEqual([...ANTIGRAVITY_CLIENT_PROFILE_VALUES], ["app", "cli"]);
  assert.equal(DEFAULT_ANTIGRAVITY_CLIENT_PROFILE, "app");
  assert.deepEqual(
    ANTIGRAVITY_CLIENT_PROFILE_OPTIONS.map((option) => option.value),
    ["app", "cli"]
  );
});

test("legacy persisted ide profile migrates to app", () => {
  assert.equal(normalizeAntigravityClientProfile("ide"), "app");
  assert.equal(normalizeAntigravityClientProfile("IDE"), "app");
});

test("App UA is antigravity/hub/<v> darwin/arm64 and never contains /ide/", () => {
  assert.equal(antigravityAppUserAgent("2.24.0"), "antigravity/hub/2.24.0 darwin/arm64");

  assert.equal(getCachedAntigravityAppVersion(), ANTIGRAVITY_APP_FALLBACK_VERSION);
  seedAntigravityAppVersionCache("2.25.1");
  const legacyProfile = normalizeAntigravityClientProfile("ide");
  const userAgents = [
    antigravityAppUserAgent(),
    getAntigravityContentHeaders(legacyProfile)["User-Agent"],
    getAntigravityOAuthUserAgent(legacyProfile),
  ];
  assert.equal(userAgents[0], "antigravity/hub/2.25.1 darwin/arm64");
  for (const ua of userAgents) {
    assert.match(ua, /^antigravity\/hub\/2\.25\.1 darwin\/arm64/);
    assert.doesNotMatch(ua, /\/ide\//);
  }
});

test("parseAntigravityAppManifest reads only the top-level version, not files: entries", () => {
  const manifest = [
    "files:",
    "  - url: https://storage.googleapis.com/antigravity-public/9.99.9/Antigravity-9.99.9-arm64.zip",
    "    version: 9.99.9",
    "    sha512: abc==",
    "    size: 123",
    "version: 2.24.0",
    "path: Antigravity.zip",
    "sha512: abc==",
    "releaseDate: '2026-10-01T00:00:00.000Z'",
  ].join("\n");
  assert.equal(parseAntigravityAppManifest(manifest), "2.24.0");

  // A manifest whose only version-shaped string is nested under files: has no App version.
  assert.equal(parseAntigravityAppManifest("files:\n  - url: x.zip\n    version: 9.99.9\n"), null);
  assert.equal(parseAntigravityAppManifest({ version: "2.24.0" }), null);
});
