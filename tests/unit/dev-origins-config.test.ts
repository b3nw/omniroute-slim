import test from "node:test";
import assert from "node:assert/strict";

test("next config allows loopback dev origins by default", async () => {
  const { default: nextConfig } = await import("../../next.config.mjs");

  assert.deepEqual(nextConfig.allowedDevOrigins, ["localhost", "127.0.0.1"]);
});

test("OMNIROUTE_DEV_ORIGINS overrides the dev origin allowlist", async () => {
  const previous = process.env.OMNIROUTE_DEV_ORIGINS;
  process.env.OMNIROUTE_DEV_ORIGINS = "localhost,10.0.0.5,omni.lan";
  try {
    // Cache-busting query: the module is evaluated again so the env var is read fresh.
    const { default: nextConfig } = await import("../../next.config.mjs?dev-origins-override");

    assert.deepEqual(nextConfig.allowedDevOrigins, ["localhost", "10.0.0.5", "omni.lan"]);
  } finally {
    if (previous === undefined) delete process.env.OMNIROUTE_DEV_ORIGINS;
    else process.env.OMNIROUTE_DEV_ORIGINS = previous;
  }
});
