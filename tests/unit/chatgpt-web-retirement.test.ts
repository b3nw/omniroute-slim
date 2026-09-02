import assert from "node:assert/strict";
import test from "node:test";

import { getRegistryEntry, REGISTRY } from "../../open-sse/config/providerRegistry.ts";
import { getExecutor, hasSpecializedExecutor } from "../../open-sse/executors/index.ts";
import { AI_PROVIDERS } from "../../src/shared/constants/providers.ts";

const RETIRED_PROVIDER_IDS = ["chatgpt-web", "cgpt-web"] as const;

test("common ChatGPT Web is unavailable while ChatGPT Web Codex remains registered", async () => {
  assert.equal(REGISTRY["chatgpt-web"], undefined);
  assert.equal(AI_PROVIDERS["chatgpt-web"], undefined);

  for (const providerId of RETIRED_PROVIDER_IDS) {
    assert.equal(getRegistryEntry(providerId), null);
    assert.equal(hasSpecializedExecutor(providerId), false);
    await assert.rejects(
      () => getExecutor(providerId),
      (error: unknown) => {
        const typed = error as Error & { code?: string; status?: number };
        assert.equal(typed.code, "PROVIDER_RETIRED");
        assert.equal(typed.status, 410);
        assert.equal(typed.message, "Provider is retired and unavailable.");
        return true;
      }
    );
  }

  assert.ok(getRegistryEntry("chatgpt-web-codex"));
  assert.ok(getRegistryEntry("cgpt-codex"));
  assert.equal(hasSpecializedExecutor("chatgpt-web-codex"), true);
  assert.equal(hasSpecializedExecutor("cgpt-codex"), true);
});
