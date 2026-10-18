import assert from "node:assert/strict";
import test from "node:test";

import {
  antigravityAppNodeUserAgent,
  antigravityAppUserAgent,
  antigravityCliUserAgent,
  getAntigravityAppNodeHeaders,
  getAntigravityContentHeaders,
  getAntigravityLoadCodeAssistMetadata,
  getAntigravityOAuthUserAgent,
} from "../../open-sse/services/antigravityHeaders.ts";
import * as antigravityHeaders from "../../open-sse/services/antigravityHeaders.ts";
import {
  clearAntigravityVersionCaches,
  seedAntigravityAppVersionCache,
  seedAntigravityCliVersionCache,
} from "../../open-sse/services/antigravityVersion.ts";
import { normalizeAntigravityClientProfile } from "../../src/shared/constants/antigravityClientProfile.ts";

test.afterEach(() => {
  clearAntigravityVersionCaches();
});

// The retired IDE grammar (`antigravity/ide/<v>`) and its node form (`antigravity/<v> ...`)
// were replaced by the App (Hub) grammar; these tests encode the App/CLI split instead.
test("official App, App Node, and CLI User-Agent grammars match the native darwin/arm64 client", () => {
  assert.equal(antigravityAppUserAgent("2.24.0"), "antigravity/hub/2.24.0 darwin/arm64");
  assert.equal(
    antigravityAppNodeUserAgent("2.24.0"),
    "antigravity/hub/2.24.0 darwin/arm64 google-api-nodejs-client/10.3.0"
  );
  assert.equal(
    antigravityCliUserAgent("1.1.1"),
    "antigravity/cli/1.1.1 (aidev_client; os_type=darwin; arch=arm64; auth_method=consumer)"
  );
});

test("User-Agent OS/arch token stays pinned to darwin/arm64 regardless of host (fingerprint fidelity)", () => {
  // The upstream Antigravity backend expects the native macOS build, so OmniRoute presents
  // that fingerprint no matter which platform it actually runs on (#8098 protocol fidelity).
  // The CLI builder's second argument is authMethod, not platform — the OS/arch token is
  // never host-derived.
  assert.match(antigravityAppUserAgent("2.24.0"), / darwin\/arm64$/);
  assert.match(antigravityAppNodeUserAgent("2.24.0"), / darwin\/arm64 /);
  assert.equal(
    antigravityCliUserAgent("1.1.1", "oauth"),
    "antigravity/cli/1.1.1 (aidev_client; os_type=darwin; arch=arm64; auth_method=oauth)"
  );
});

test("App and CLI content headers use independent cached versions", () => {
  seedAntigravityAppVersionCache("2.2.0");
  seedAntigravityCliVersionCache("1.2.0");

  const appHeaders = new Headers(getAntigravityContentHeaders("app", "app-token"));
  const cliHeaders = new Headers(getAntigravityContentHeaders("cli", "cli-token"));

  assert.match(appHeaders.get("User-Agent") ?? "", /^antigravity\/hub\/2\.2\.0 /);
  assert.match(cliHeaders.get("User-Agent") ?? "", /^antigravity\/cli\/1\.2\.0 /);
  assert.equal(appHeaders.get("Authorization"), "Bearer app-token");
  assert.equal(cliHeaders.get("Authorization"), "Bearer cli-token");

  for (const headers of [appHeaders, cliHeaders]) {
    for (const absent of [
      "x-client-name",
      "x-client-version",
      "x-machine-id",
      "x-vscode-sessionid",
      "X-Goog-Api-Client",
      "Client-Metadata",
    ]) {
      assert.equal(headers.get(absent), null, `${absent} must be absent from content headers`);
    }
  }
});

test("App Node OAuth and onboarding headers use the Hub identity with the Google Node client", () => {
  seedAntigravityAppVersionCache("2.24.0");
  const headers = new Headers(getAntigravityAppNodeHeaders("token"));

  assert.equal(
    headers.get("User-Agent"),
    "antigravity/hub/2.24.0 darwin/arm64 google-api-nodejs-client/10.3.0"
  );
  assert.equal(headers.get("X-Goog-Api-Client"), "gl-node/22.21.1");
  assert.equal(headers.get("Authorization"), "Bearer token");
  assert.equal(headers.get("Client-Metadata"), null);
});

test("OAuth User-Agent selection keeps App and CLI identities independent", () => {
  seedAntigravityAppVersionCache("2.2.0");
  seedAntigravityCliVersionCache("1.2.0");

  assert.equal(
    getAntigravityOAuthUserAgent("app"),
    "antigravity/hub/2.2.0 darwin/arm64 google-api-nodejs-client/10.3.0"
  );
  assert.match(getAntigravityOAuthUserAgent("cli"), /^antigravity\/cli\/1\.2\.0 /);
});

test("legacy persisted ide profile coerces to the Hub identity, never an IDE UA", () => {
  seedAntigravityAppVersionCache("2.24.0");
  // Previously `getAntigravityOAuthUserAgent("ide")` built `antigravity/<v> ...` and content
  // headers built `antigravity/ide/<v>`. `ide` is no longer an AntigravityClientProfile:
  // persisted values pass through normalizeAntigravityClientProfile and land on the App.
  const profile = normalizeAntigravityClientProfile("ide");
  assert.equal(profile, "app");

  const contentUa = new Headers(getAntigravityContentHeaders(profile)).get("User-Agent") ?? "";
  const oauthUa = getAntigravityOAuthUserAgent(profile);
  assert.equal(contentUa, "antigravity/hub/2.24.0 darwin/arm64");
  assert.equal(oauthUa, "antigravity/hub/2.24.0 darwin/arm64 google-api-nodejs-client/10.3.0");
  for (const ua of [contentUa, oauthUa]) {
    assert.doesNotMatch(ua, /\/ide\//);
    assert.doesNotMatch(ua, /^antigravity\/\d/);
  }
});

test("the IDE User-Agent builders are no longer exported", () => {
  const exported = Object.keys(antigravityHeaders);
  assert.equal(exported.includes("antigravityIdeUserAgent"), false);
  assert.equal(exported.includes("antigravityIdeNodeUserAgent"), false);
  assert.equal(exported.includes("getAntigravityIdeNodeHeaders"), false);
});

test("App content headers report the Hub identity with no node suffix or IDE markers", () => {
  seedAntigravityAppVersionCache("2.24.0");
  const headers = new Headers(getAntigravityContentHeaders("app", "app-token"));

  assert.equal(headers.get("User-Agent"), "antigravity/hub/2.24.0 darwin/arm64");
  assert.equal(headers.get("Authorization"), "Bearer app-token");
  // The App must not look like the retired IDE surface, and content requests never carry
  // control-plane identity markers.
  assert.doesNotMatch(headers.get("User-Agent") ?? "", /\/ide\//);
  for (const absent of [
    "x-client-name",
    "x-client-version",
    "x-machine-id",
    "x-vscode-sessionid",
    "X-Goog-Api-Client",
    "Client-Metadata",
  ]) {
    assert.equal(headers.get(absent), null, `${absent} must be absent from content headers`);
  }
});

test("the default Antigravity client profile is the App", () => {
  assert.equal(normalizeAntigravityClientProfile(undefined), "app");
  assert.equal(normalizeAntigravityClientProfile("nonsense"), "app");
  // Legacy persisted values migrate: the retired IDE to the App, harness/sdk to the CLI.
  assert.equal(normalizeAntigravityClientProfile("ide"), "app");
  assert.equal(normalizeAntigravityClientProfile("harness"), "cli");
});

test("loadCodeAssist body metadata remains ideType only", () => {
  assert.deepEqual(getAntigravityLoadCodeAssistMetadata(), { ideType: "ANTIGRAVITY" });
  assert.equal("platform" in getAntigravityLoadCodeAssistMetadata(), false);
  assert.equal("pluginType" in getAntigravityLoadCodeAssistMetadata(), false);
});
