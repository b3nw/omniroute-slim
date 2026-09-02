import assert from "node:assert/strict";
import test from "node:test";

import { handleImageGeneration } from "../../open-sse/handlers/imageGeneration.ts";

test("central image handler blocks retired common ChatGPT Web ids before network dispatch", async () => {
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    throw new Error("Retired image providers must not reach the network");
  };

  try {
    for (const provider of ["chatgpt-web", "cgpt-web"]) {
      const viaRequestedModel = await handleImageGeneration({
        body: { model: `${provider}/gpt-5.5`, prompt: "draw a lighthouse" },
        credentials: { apiKey: "unused" },
        log: null,
      });
      assert.deepEqual(viaRequestedModel, {
        success: false,
        status: 410,
        error: "Provider is retired and unavailable.",
        code: "PROVIDER_RETIRED",
      });

      const viaBareProviderId = await handleImageGeneration({
        body: { model: provider, prompt: "draw a lighthouse" },
        credentials: { apiKey: "unused" },
        log: null,
      });
      assert.deepEqual(viaBareProviderId, viaRequestedModel);

      const viaResolvedProvider = await handleImageGeneration({
        body: { model: `${provider}/gpt-5.5`, prompt: "draw a lighthouse" },
        credentials: { apiKey: "unused" },
        resolvedProvider: provider,
        log: null,
      });
      assert.deepEqual(viaResolvedProvider, viaRequestedModel);
    }

    const similarButDistinct = await handleImageGeneration({
      body: { model: "chatgpt-web-preview/gpt-5.5", prompt: "draw a lighthouse" },
      credentials: { apiKey: "unused" },
      log: null,
    });
    assert.equal(similarButDistinct.status, 400);
    assert.notEqual((similarButDistinct as { code?: string }).code, "PROVIDER_RETIRED");
    assert.equal(fetchCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
