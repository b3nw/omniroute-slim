import assert from "node:assert/strict";
import test from "node:test";

import {
  normalizeAntigravityClientProfile,
  type AntigravityClientProfile,
} from "../../src/shared/constants/antigravityClientProfile.ts";
import { validateProviderSpecificData } from "../../src/shared/validation/providerSpecificData.ts";
import {
  applyAntigravityClientProfileHeaders,
  getAntigravityClientProfile,
} from "../../open-sse/services/antigravityClientProfile.ts";
import { getAntigravityEnvelopeUserAgent } from "../../open-sse/services/antigravityIdentity.ts";
import {
  clearAntigravityVersionCaches,
  seedAntigravityAppVersionCache,
  seedAntigravityCliVersionCache,
} from "../../open-sse/services/antigravityVersion.ts";

test.afterEach(() => {
  clearAntigravityVersionCaches();
});

test("normalizeAntigravityClientProfile defaults to the App and maps persisted legacy profiles", () => {
  assert.equal(normalizeAntigravityClientProfile("cli"), "cli");
  assert.equal(normalizeAntigravityClientProfile("CLI"), "cli");
  // The retired IDE identity migrates to the App rather than surviving as a profile.
  assert.equal(normalizeAntigravityClientProfile("ide"), "app");
  assert.equal(normalizeAntigravityClientProfile(" IDE "), "app");
  assert.equal(normalizeAntigravityClientProfile("app"), "app");
  assert.equal(normalizeAntigravityClientProfile(undefined), "app");
  assert.equal(normalizeAntigravityClientProfile(null), "app");
  assert.equal(normalizeAntigravityClientProfile("harness"), "cli");
  assert.equal(normalizeAntigravityClientProfile("sdk"), "cli");
  assert.equal(normalizeAntigravityClientProfile(""), "app");
  assert.equal(normalizeAntigravityClientProfile(42), "app");
});

function validateClientProfile(value: unknown): string[] {
  const messages: string[] = [];
  const ctx = {
    addIssue: (issue: { message: string }) => messages.push(issue.message),
  } as unknown as Parameters<typeof validateProviderSpecificData>[1];

  validateProviderSpecificData({ clientProfile: value }, ctx);
  return messages;
}

test("provider-specific validation rejects legacy Antigravity client profiles", () => {
  assert.deepEqual(validateClientProfile("app"), []);
  assert.deepEqual(validateClientProfile("CLI"), []);
  assert.deepEqual(validateClientProfile(undefined), []);
  assert.deepEqual(validateClientProfile(null), []);

  // `ide` joins harness/sdk as a read-only legacy value: new writes cannot store it.
  for (const invalid of ["ide", "harness", "sdk", "", 42]) {
    assert.deepEqual(validateClientProfile(invalid), [
      "providerSpecificData.clientProfile must be app or cli",
    ]);
  }
});

test("getAntigravityClientProfile preserves legacy CLI identity for persisted values", () => {
  assert.equal(
    getAntigravityClientProfile({ providerSpecificData: { clientProfile: "cli" } }),
    "cli"
  );
  assert.equal(getAntigravityClientProfile({ providerSpecificData: {} }), "app");
  assert.equal(
    getAntigravityClientProfile({ providerSpecificData: { clientProfile: "harness" } }),
    "cli"
  );
  // Connections persisted with the retired IDE profile are migrated to the App at read time.
  assert.equal(
    getAntigravityClientProfile({ providerSpecificData: { clientProfile: "ide" } }),
    "app"
  );
});

function assertIdentityHeadersAbsent(headers: Record<string, string>): void {
  const normalized = new Headers(headers);
  for (const name of [
    "x-client-name",
    "x-client-version",
    "x-machine-id",
    "x-vscode-sessionid",
    "X-Goog-Api-Client",
    "Client-Metadata",
  ]) {
    assert.equal(normalized.get(name), null, `${name} must be removed`);
  }
}

function applyProfile(profile: AntigravityClientProfile | "ide"): Record<string, string> {
  const headers: Record<string, string> = {
    Authorization: "Bearer token",
    "Content-Type": "application/json",
    "X-Client-Name": "legacy-name",
    "x-client-version": "4.2.0",
    "X-Machine-Id": "legacy-machine",
    "x-vscode-sessionid": "legacy-session",
    "X-Goog-Api-Client": "legacy-api-client",
    "client-metadata": "legacy-metadata",
  };

  applyAntigravityClientProfileHeaders(
    headers,
    { connectionId: `connection-${profile}`, providerSpecificData: { clientProfile: profile } },
    { project: "project-1" }
  );
  return headers;
}

test("content header application emits App and CLI identities and strips fake headers", () => {
  seedAntigravityAppVersionCache("2.24.0");
  seedAntigravityCliVersionCache("1.1.1");

  const appHeaders = applyProfile("app");
  // A connection persisted with the retired IDE profile must emit the App identity.
  const legacyIdeHeaders = applyProfile("ide");
  const cliHeaders = applyProfile("cli");

  assert.equal(appHeaders["User-Agent"], "antigravity/hub/2.24.0 darwin/arm64");
  assert.equal(legacyIdeHeaders["User-Agent"], appHeaders["User-Agent"]);
  assert.match(
    cliHeaders["User-Agent"],
    /^antigravity\/cli\/1\.1\.1 \(aidev_client; os_type=.+; arch=.+; auth_method=consumer\)$/
  );
  for (const headers of [appHeaders, legacyIdeHeaders, cliHeaders]) {
    assert.doesNotMatch(headers["User-Agent"], /\/ide\//);
    assertIdentityHeadersAbsent(headers);
    assert.equal(headers["x-goog-user-project"], "project-1");
  }
});

test("public request envelopes never infer the internal jetski identity from email", () => {
  assert.equal(getAntigravityEnvelopeUserAgent({ email: "user@gmail.com" }), "antigravity");
  assert.equal(getAntigravityEnvelopeUserAgent({ email: "user@company.example" }), "antigravity");
  assert.equal(getAntigravityEnvelopeUserAgent(null), "antigravity");
});
