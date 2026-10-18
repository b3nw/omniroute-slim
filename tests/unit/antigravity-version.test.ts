import assert from "node:assert/strict";
import test from "node:test";

import {
  ANTIGRAVITY_APP_FALLBACK_VERSION,
  ANTIGRAVITY_CLI_FALLBACK_VERSION,
  ANTIGRAVITY_VERSION_CACHE_TTL_MS,
  clearAntigravityVersionCaches,
  getCachedAntigravityAppVersion,
  getCachedAntigravityCliVersion,
  resolveAntigravityAppVersion,
  resolveAntigravityCliVersion,
  seedAntigravityAppVersionCache,
  seedAntigravityCliVersionCache,
} from "../../open-sse/services/antigravityVersion.ts";

const ANTIGRAVITY_APP_MANIFEST_URL =
  "https://antigravity-hub-auto-updater-974169037036.us-central1.run.app/manifest/latest-arm64-mac.yml";

const originalDateNow = Date.now;

test.afterEach(() => {
  Date.now = originalDateNow;
  clearAntigravityVersionCaches();
});

/**
 * Build the electron-builder manifest the Hub auto-updater serves. The `files:` block is
 * included deliberately: it carries `sha512`/`url` keys but no `version`, which is what
 * makes a top-level `version:` line match unambiguous.
 */
function appManifest(version: string): string {
  return [
    `version: ${version}`,
    "files:",
    "  - url: https://storage.googleapis.com/antigravity-public/antigravity-hub/x/darwin-arm/Antigravity.zip",
    "    sha512: abc123==",
    "    size: 183223165",
    "path: Antigravity.zip",
    "sha512: abc123==",
    "",
  ].join("\n");
}

test("App and CLI start with independent captured fallback versions", () => {
  assert.equal(getCachedAntigravityAppVersion(), ANTIGRAVITY_APP_FALLBACK_VERSION);
  assert.equal(getCachedAntigravityCliVersion(), ANTIGRAVITY_CLI_FALLBACK_VERSION);
  // The App feed (2.24.x) long ago overtook the retired IDE feed (2.0.0).
  assert.equal(ANTIGRAVITY_APP_FALLBACK_VERSION, "2.24.0");
  assert.equal(ANTIGRAVITY_CLI_FALLBACK_VERSION, "1.1.5");
});

test("App resolver reads the Hub manifest feed and caches only the App version", async () => {
  const urls: string[] = [];
  const fetchMock = async (url: string | URL | Request) => {
    urls.push(String(url));
    return new Response(appManifest("2.24.0"), {
      status: 200,
      headers: { "Content-Type": "text/yaml" },
    });
  };

  assert.equal(await resolveAntigravityAppVersion(fetchMock as typeof fetch), "2.24.0");
  assert.equal(await resolveAntigravityAppVersion(fetchMock as typeof fetch), "2.24.0");
  assert.equal(urls.length, 1);
  assert.equal(urls[0], ANTIGRAVITY_APP_MANIFEST_URL);
  assert.equal(getCachedAntigravityAppVersion(), "2.24.0");
  assert.equal(getCachedAntigravityCliVersion(), "1.1.5");
});

test("App resolver parses only the top-level version line, ignoring files[].url/sha512", async () => {
  // A numeric-looking value elsewhere in the manifest must not be mistaken for the version.
  const noisy = [
    "version: 2.25.1",
    "files:",
    "  - url: https://example.invalid/9.9.9/Antigravity.zip",
    "    sha512: deadbeef",
    "releaseDate: 10.11.2026",
    "",
  ].join("\n");
  const fetchMock = async () => new Response(noisy, { status: 200 });

  assert.equal(await resolveAntigravityAppVersion(fetchMock as typeof fetch), "2.25.1");
});

test("App resolver never falls below its version floor on a stale or unparseable feed", async () => {
  clearAntigravityVersionCaches();
  const staleFeedFetch = async () => new Response(appManifest("2.0.0"), { status: 200 });

  assert.equal(
    await resolveAntigravityAppVersion(staleFeedFetch as typeof fetch),
    ANTIGRAVITY_APP_FALLBACK_VERSION
  );
  assert.equal(getCachedAntigravityAppVersion(), ANTIGRAVITY_APP_FALLBACK_VERSION);

  clearAntigravityVersionCaches();
  // JSON instead of YAML: the Hub never serves this, and it must not be coerced.
  const wrongShapeFetch = async () =>
    new Response(JSON.stringify([{ version: "2.24.0" }]), { status: 200 });
  assert.equal(
    await resolveAntigravityAppVersion(wrongShapeFetch as typeof fetch),
    ANTIGRAVITY_APP_FALLBACK_VERSION
  );
});

test("App resolver keeps a newer cached version when a later feed response is older", async () => {
  let now = 1_000;
  Date.now = () => now;
  seedAntigravityAppVersionCache("2.26.0", now);
  now += ANTIGRAVITY_VERSION_CACHE_TTL_MS + 1;

  const olderFeedFetch = async () => new Response(appManifest("2.24.0"), { status: 200 });

  assert.equal(await resolveAntigravityAppVersion(olderFeedFetch as typeof fetch), "2.26.0");
  assert.equal(getCachedAntigravityAppVersion(), "2.26.0");
});

test("CLI resolver reads the official Google GitHub release and caches only the CLI version", async () => {
  const urls: string[] = [];
  const fetchMock = async (url: string | URL | Request) => {
    urls.push(String(url));
    return new Response(JSON.stringify({ tag_name: "v1.2.0", name: "1.2.0" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };

  assert.equal(await resolveAntigravityCliVersion(fetchMock as typeof fetch), "1.2.0");
  assert.equal(await resolveAntigravityCliVersion(fetchMock as typeof fetch), "1.2.0");
  assert.equal(urls.length, 1);
  assert.equal(
    urls[0],
    "https://api.github.com/repos/google-antigravity/antigravity-cli/releases/latest"
  );
  assert.equal(getCachedAntigravityCliVersion(), "1.2.0");
  assert.equal(getCachedAntigravityAppVersion(), ANTIGRAVITY_APP_FALLBACK_VERSION);
});

test("App and CLI TTL refreshes are independent", async () => {
  let now = 1_000;
  Date.now = () => now;
  seedAntigravityCliVersionCache("1.1.5", now);

  const firstFetch = async () => new Response(appManifest("2.24.0"), { status: 200 });
  const secondFetch = async () => new Response(appManifest("2.25.0"), { status: 200 });

  assert.equal(await resolveAntigravityAppVersion(firstFetch as typeof fetch), "2.24.0");
  now += ANTIGRAVITY_VERSION_CACHE_TTL_MS + 1;
  assert.equal(await resolveAntigravityAppVersion(secondFetch as typeof fetch), "2.25.0");
  assert.equal(getCachedAntigravityCliVersion(), "1.1.5");
});

test("each resolver falls back only to its own last known good version", async () => {
  const failingFetch = async () => {
    throw new Error("network down");
  };

  assert.equal(
    await resolveAntigravityAppVersion(failingFetch as typeof fetch),
    ANTIGRAVITY_APP_FALLBACK_VERSION
  );
  assert.equal(
    await resolveAntigravityCliVersion(failingFetch as typeof fetch),
    ANTIGRAVITY_CLI_FALLBACK_VERSION
  );

  seedAntigravityAppVersionCache("2.24.0", 0);
  seedAntigravityCliVersionCache("1.3.0", 0);
  assert.equal(await resolveAntigravityAppVersion(failingFetch as typeof fetch), "2.24.0");
  assert.equal(await resolveAntigravityCliVersion(failingFetch as typeof fetch), "1.3.0");
});

test("concurrent requests coalesce within each product without crossing products", async () => {
  let appCalls = 0;
  let cliCalls = 0;
  let releaseApp: (() => void) | undefined;
  let releaseCli: (() => void) | undefined;
  const appGate = new Promise<void>((resolve) => {
    releaseApp = resolve;
  });
  const cliGate = new Promise<void>((resolve) => {
    releaseCli = resolve;
  });

  const appFetch = async () => {
    appCalls += 1;
    await appGate;
    return new Response(appManifest("2.25.0"), { status: 200 });
  };
  const cliFetch = async () => {
    cliCalls += 1;
    await cliGate;
    return new Response(JSON.stringify({ tag_name: "1.4.0" }), { status: 200 });
  };

  const appOne = resolveAntigravityAppVersion(appFetch as typeof fetch);
  const appTwo = resolveAntigravityAppVersion(appFetch as typeof fetch);
  const cliOne = resolveAntigravityCliVersion(cliFetch as typeof fetch);
  const cliTwo = resolveAntigravityCliVersion(cliFetch as typeof fetch);
  releaseApp?.();
  releaseCli?.();

  assert.deepEqual(await Promise.all([appOne, appTwo]), ["2.25.0", "2.25.0"]);
  assert.deepEqual(await Promise.all([cliOne, cliTwo]), ["1.4.0", "1.4.0"]);
  assert.equal(appCalls, 1);
  assert.equal(cliCalls, 1);
});
