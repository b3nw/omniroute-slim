import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-auth-login-route-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.JWT_SECRET = "test-jwt-secret-for-login-route";

const ORIGINAL_INITIAL_PASSWORD = process.env.INITIAL_PASSWORD;

const core = await import("../../src/lib/db/core.ts");
const settingsDb = await import("../../src/lib/db/settings.ts");
const loginRoute = await import("../../src/app/api/auth/login/route.ts");
const managementPassword = await import("../../src/lib/auth/managementPassword.ts");
const loginGuard = await import("../../src/server/auth/loginGuard.ts");

const originalGetCookieStore = loginRoute.authRouteInternals.getCookieStore;

async function resetStorage() {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
  delete process.env.INITIAL_PASSWORD;
}

test.beforeEach(async () => {
  await resetStorage();
  loginRoute.authRouteInternals.getCookieStore = async () => ({
    set() {},
  });
});

test.afterEach(() => {
  loginRoute.authRouteInternals.getCookieStore = originalGetCookieStore;
});

test.after(() => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  if (ORIGINAL_INITIAL_PASSWORD === undefined) {
    delete process.env.INITIAL_PASSWORD;
  } else {
    process.env.INITIAL_PASSWORD = ORIGINAL_INITIAL_PASSWORD;
  }
});

test("auth login route returns 400 for malformed JSON bodies", async () => {
  const response = await loginRoute.POST(
    new Request("http://localhost/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "a��",
    })
  );

  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), {
    error: {
      message: "Invalid request",
      details: [{ field: "body", message: "Invalid JSON body" }],
    },
  });
});

test("auth login route returns needsSetup when no management password is configured", async () => {
  const response = await loginRoute.POST(
    new Request("http://localhost/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: "missing-password" }),
    })
  );

  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), {
    error: "No password configured. Complete onboarding first.",
    needsSetup: true,
  });
});

test("auth login route lazily migrates INITIAL_PASSWORD to a persisted hash before validating", async () => {
  process.env.INITIAL_PASSWORD = "bootstrap-secret";
  const setCalls: unknown[][] = [];
  loginRoute.authRouteInternals.getCookieStore = async () => ({
    set: (...args: unknown[]) => setCalls.push(args),
  });

  const response = await loginRoute.POST(
    new Request("http://localhost/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-proto": "https" },
      body: JSON.stringify({ password: "bootstrap-secret" }),
    })
  );
  const settings = await settingsDb.getSettings();

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { success: true });
  assert.equal(setCalls.length, 1);
  assert.equal(managementPassword.isBcryptHash(settings.password), true);
  assert.equal(
    await managementPassword.verifyManagementPassword(
      "bootstrap-secret",
      (settings as Record<string, unknown>).password as string
    ),
    true
  );
});

test("auth login route sets a bounded maxAge on the auth_token cookie (Seg3)", async () => {
  process.env.INITIAL_PASSWORD = "bootstrap-secret";
  const setCalls: unknown[][] = [];
  loginRoute.authRouteInternals.getCookieStore = async () => ({
    set: (...args: unknown[]) => setCalls.push(args),
  });

  const response = await loginRoute.POST(
    new Request("http://localhost/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: "bootstrap-secret" }),
    })
  );

  assert.equal(response.status, 200);
  assert.equal(setCalls.length, 1);
  const [cookieName, , options] = setCalls[0] as [string, string, Record<string, unknown>];
  assert.equal(cookieName, "auth_token");
  // 30 days in seconds — must match the JWT 30d expiry so the cookie is not an open-ended
  // session cookie outliving its token.
  assert.equal(options.maxAge, 60 * 60 * 24 * 30);
  assert.equal(options.httpOnly, true);
  assert.equal(options.path, "/");
});

test("auth login route returns 403 when OIDC password login is disabled", async () => {
  process.env.INITIAL_PASSWORD = "bootstrap-secret";
  await settingsDb.updateSettings({
    requireLogin: true,
    oidcEnabled: true,
    oidcDisablePasswordLogin: true,
  });

  const response = await loginRoute.POST(
    new Request("http://localhost/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: "bootstrap-secret" }),
    })
  );

  assert.equal(response.status, 403);
  const body = (await response.json()) as { error?: string };
  assert.match(body.error || "", /Password login is disabled when OIDC is active/);
});

// Regression: the invalid-password path referenced an `auditContext` identifier
// that was never imported or defined, so every wrong-password attempt threw a
// ReferenceError and the catch-all turned the intended 401 into a 500. The
// success path masked it — the trusted peer-IP short-circuit meant the other
// reference was never evaluated when the password was correct.
test("auth login route returns 401 Invalid password for a wrong password", async () => {
  process.env.INITIAL_PASSWORD = "bootstrap-secret";
  loginGuard.resetLoginGuardForTests();

  const response = await loginRoute.POST(
    new Request("http://localhost/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: "definitely-not-the-password" }),
    })
  );

  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: "Invalid password" });
});

// Exercises the header-derived client-IP fallback (no token-verified peer stamp
// present), which is the branch that used to blow up before reaching the 401.
test("auth login route returns 401 for a wrong password when only X-Forwarded-For is present", async () => {
  process.env.INITIAL_PASSWORD = "bootstrap-secret";
  delete process.env.OMNIROUTE_PEER_STAMP_TOKEN;
  loginGuard.resetLoginGuardForTests();

  const response = await loginRoute.POST(
    new Request("http://localhost/api/auth/login", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-forwarded-for": "203.0.113.77",
      },
      body: JSON.stringify({ password: "definitely-not-the-password" }),
    })
  );

  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: "Invalid password" });
});

// The brute-force guard must still key off the derived IP and escalate to 429.
test("auth login route escalates to 429 after repeated wrong passwords from one IP", async () => {
  process.env.INITIAL_PASSWORD = "bootstrap-secret";
  delete process.env.OMNIROUTE_PEER_STAMP_TOKEN;
  loginGuard.resetLoginGuardForTests();
  await settingsDb.updateSettings({ bruteForceProtection: true });

  const attempt = () =>
    loginRoute.POST(
      new Request("http://localhost/api/auth/login", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-forwarded-for": "203.0.113.88",
        },
        body: JSON.stringify({ password: "definitely-not-the-password" }),
      })
    );

  const statuses: number[] = [];
  for (let i = 0; i < loginGuard.LOGIN_GUARD_TUNABLES.FAILURE_THRESHOLD + 1; i++) {
    statuses.push((await attempt()).status);
  }

  // Never a 500 — and the lockout eventually kicks in.
  assert.equal(
    statuses.some((s) => s === 500),
    false,
    `no attempt should 500, got ${statuses.join(",")}`
  );
  assert.equal(statuses[0], 401);
  assert.ok(
    statuses.includes(429),
    `expected a 429 lockout within ${statuses.length} attempts, got ${statuses.join(",")}`
  );
});
