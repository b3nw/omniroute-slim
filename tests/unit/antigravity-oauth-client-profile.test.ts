import assert from "node:assert/strict";
import test from "node:test";

import { AGY_CONFIG, ANTIGRAVITY_CONFIG } from "../../src/lib/oauth/constants/oauth.ts";
import { agy } from "../../src/lib/oauth/providers/agy.ts";
import { antigravity } from "../../src/lib/oauth/providers/antigravity.ts";
import {
  clearAntigravityVersionCaches,
  seedAntigravityAppVersionCache,
  seedAntigravityCliVersionCache,
} from "../../open-sse/services/antigravityVersion.ts";

const originalFetch = globalThis.fetch;

test.afterEach(() => {
  globalThis.fetch = originalFetch;
  clearAntigravityVersionCaches();
});

// The antigravity OAuth provider used to present the retired IDE Node identity
// (`antigravity/<v> ... google-api-nodejs-client`); it now presents the App (Hub) Node identity.
test("token exchange selects the App Node and CLI User-Agent independently", async () => {
  seedAntigravityAppVersionCache("2.24.0");
  seedAntigravityCliVersionCache("1.1.1");
  const userAgents: string[] = [];

  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    userAgents.push(new Headers(init?.headers).get("User-Agent") ?? "");
    return Response.json({ access_token: "token", refresh_token: "refresh", expires_in: 3600 });
  }) as typeof fetch;

  await antigravity.exchangeToken(ANTIGRAVITY_CONFIG, "app-code", "http://localhost/callback");
  await agy.exchangeToken(AGY_CONFIG, "cli-code", "http://localhost/callback");

  assert.equal(
    userAgents[0],
    "antigravity/hub/2.24.0 darwin/arm64 google-api-nodejs-client/10.3.0"
  );
  assert.match(
    userAgents[1],
    /^antigravity\/cli\/1\.1\.1 \(aidev_client; os_type=.+; arch=.+; auth_method=consumer\)$/
  );
});

for (const [name, provider, expectedProfile] of [
  ["antigravity", antigravity, "app"],
  ["agy", agy, "cli"],
] as const) {
  test(`${name} post-exchange and onboarding use the selected ${expectedProfile} identity`, async () => {
    seedAntigravityAppVersionCache("2.24.0");
    seedAntigravityCliVersionCache("1.1.1");
    const cloudCodeHeaders: Headers[] = [];

    globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
      const urlString = String(url);
      if (urlString.includes("userinfo")) {
        return Response.json({ email: `${name}@example.com` });
      }
      if (urlString.includes("loadCodeAssist")) {
        cloudCodeHeaders.push(new Headers(init?.headers));
        return Response.json({
          cloudaicompanionProject: `${name}-project`,
          allowedTiers: [{ id: "legacy-tier", isDefault: true }],
        });
      }
      if (urlString.includes("onboardUser")) {
        cloudCodeHeaders.push(new Headers(init?.headers));
        return Response.json({ done: true });
      }
      return Response.json({});
    }) as typeof fetch;

    const extra = await provider.postExchange({ access_token: `${name}-token` } as never);
    const mapped = provider.mapTokens({ access_token: `${name}-token` } as never, extra);
    await new Promise((resolve) => setTimeout(resolve, 25));

    assert.ok(cloudCodeHeaders.length >= 2);
    for (const headers of cloudCodeHeaders) {
      if (expectedProfile === "app") {
        assert.equal(
          headers.get("User-Agent"),
          "antigravity/hub/2.24.0 darwin/arm64 google-api-nodejs-client/10.3.0"
        );
        assert.equal(headers.get("X-Goog-Api-Client"), "gl-node/22.21.1");
      } else {
        assert.match(headers.get("User-Agent") ?? "", /^antigravity\/cli\/1\.1\.1 /);
        assert.equal(headers.get("X-Goog-Api-Client"), null);
      }
      assert.equal(headers.get("Client-Metadata"), null);
    }
    assert.equal(mapped.providerSpecificData.clientProfile, expectedProfile);
  });
}
