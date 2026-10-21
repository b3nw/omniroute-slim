import test from "node:test";
import assert from "node:assert/strict";

const { APIKEY_PROVIDERS } = await import("../../src/shared/constants/providers.ts");
const { REGISTRY } = await import("../../open-sse/config/providerRegistry.ts");
const { NAMED_OPENAI_STYLE_PROVIDERS, isNamedOpenAIStyleProvider } = await import(
  "../../src/app/api/providers/[id]/models/discovery/providerSets.ts"
);
const { PROVIDER_MODELS_CONFIG } = await import(
  "../../src/app/api/providers/[id]/models/discovery/providerModelsConfig.ts"
);

const ID = "unifically";
const CHAT_URL = "https://api.unifically.com/v1/chat/completions";

test("Unifically is registered as an OpenAI-compatible API-key provider", () => {
  const apiKeyProvider = APIKEY_PROVIDERS[ID];
  assert.ok(apiKeyProvider);
  assert.equal(apiKeyProvider.id, ID);
  assert.equal(apiKeyProvider.name, "Unifically");
  assert.equal(apiKeyProvider.passthroughModels, true);

  const registryProvider = REGISTRY[ID];
  assert.ok(registryProvider);
  assert.equal(registryProvider.format, "openai");
  assert.equal(registryProvider.executor, "default");
  assert.equal(registryProvider.authType, "apikey");
  assert.equal(registryProvider.authHeader, "bearer");
  assert.equal(registryProvider.baseUrl, CHAT_URL);
});

test("Unifically uses authenticated live model discovery", () => {
  assert.ok(NAMED_OPENAI_STYLE_PROVIDERS.has(ID));
  assert.equal(isNamedOpenAIStyleProvider(ID), true);
  assert.deepEqual(
    {
      url: PROVIDER_MODELS_CONFIG[ID].url,
      method: PROVIDER_MODELS_CONFIG[ID].method,
      authHeader: PROVIDER_MODELS_CONFIG[ID].authHeader,
      authPrefix: PROVIDER_MODELS_CONFIG[ID].authPrefix,
    },
    {
      url: "https://api.unifically.com/v1/models",
      method: "GET",
      authHeader: "Authorization",
      authPrefix: "Bearer ",
    }
  );
});
