import test from "node:test";
import assert from "node:assert/strict";
import { SignJWT } from "jose";

const keysRoute = await import("../../src/app/api/keys/route.ts");
const { createApiKey, deleteApiKey } = await import("../../src/lib/db/apiKeys.ts");

const originalJwtSecret = process.env.JWT_SECRET;
const originalApiKeySecret = process.env.API_KEY_SECRET;

async function createAuthCookie() {
  process.env.JWT_SECRET = "test-cli-tools-keys-secret";
  const secret = new TextEncoder().encode(process.env.JWT_SECRET);
  const token = await new SignJWT({ sub: "test-user" })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(secret);

  return `auth_token=${token}`;
}

test.afterEach(() => {
  if (originalJwtSecret === undefined) delete process.env.JWT_SECRET;
  else process.env.JWT_SECRET = originalJwtSecret;
  if (originalApiKeySecret === undefined) delete process.env.API_KEY_SECRET;
  else process.env.API_KEY_SECRET = originalApiKeySecret;
});

test("general keys route stays masked for non-CLI consumers", async () => {
  process.env.API_KEY_SECRET = "test-api-key-secret";
  const created = await createApiKey("Masked Key Test", "test-machine-masked");

  try {
    const cookie = await createAuthCookie();
    const request = new Request("http://localhost/api/keys", {
      headers: { cookie },
    });

    const response = await keysRoute.GET(request);
    assert.equal(response.status, 200);
    const payload = await response.json();
    const key = payload.keys.find((entry) => entry.id === created.id);

    assert.ok(key, "created key should be present");
    assert.notEqual(key.key, created.key);
    assert.match(key.key, /^.{8}\*\*\*\*.*$/);
  } finally {
    await deleteApiKey(created.id);
  }
});
