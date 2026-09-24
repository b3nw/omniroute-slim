import { test } from "node:test";
import assert from "node:assert";
import { extractApiKey, isValidApiKey } from "../../src/sse/services/auth";

test("extractApiKey", async (t) => {
  await t.test("should extract bearer token", async () => {
    const req = new Request("http://localhost", {
      headers: { Authorization: "Bearer my-token" },
    });
    assert.strictEqual(extractApiKey(req), "my-token");
  });

  await t.test("should return null if no authorization header", async () => {
    const req = new Request("http://localhost");
    assert.strictEqual(extractApiKey(req), null);
  });

  await t.test("should return null if header is not bearer", async () => {
    const req = new Request("http://localhost", {
      headers: { Authorization: "NotBearer my-token" },
    });
    assert.strictEqual(extractApiKey(req), null);
  });

  await t.test("should return null if header is just 'Bearer '", async () => {
    const req = new Request("http://localhost", {
      headers: { Authorization: "Bearer " },
    });
    assert.strictEqual(extractApiKey(req), null);
  });
});

test("isValidApiKey", async (t) => {
  const originalEnv = process.env.OMNIROUTE_API_KEY;

  await t.test("should return true if key matches OMNIROUTE_API_KEY", async () => {
    process.env.OMNIROUTE_API_KEY = "test-key";
    assert.strictEqual(await isValidApiKey("test-key"), true);
    delete process.env.OMNIROUTE_API_KEY;
  });

  await t.test("should return false for unknown key (when not in env)", async () => {
    // We assume validateApiKey will return false for a dummy key if the DB is empty.
    assert.strictEqual(await isValidApiKey("non-existent-key"), false);
  });

  // Restore original env in case of failure
  process.env.OMNIROUTE_API_KEY = originalEnv;
});

