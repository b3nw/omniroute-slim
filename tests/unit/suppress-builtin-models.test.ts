import { describe, it, beforeEach, afterEach, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(
  path.join(os.tmpdir(), "omniroute-suppress-builtin-models-test-")
);
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = process.env.API_KEY_SECRET || "suppress-builtin-models-test-secret";

const core = await import("../../src/lib/db/core.ts");
const providersDb = await import("../../src/lib/db/providers.ts");
const modelsDb = await import("../../src/lib/db/models.ts");
const combosDb = await import("../../src/lib/db/combos.ts");
const featureFlagsDb = await import("../../src/lib/db/featureFlags.ts");
const apiKeysDb = await import("../../src/lib/db/apiKeys.ts");
const { FEATURE_FLAG_DEFINITIONS } = await import(
  "../../src/shared/constants/featureFlagDefinitions.ts"
);
const {
  isSuppressBuiltinModelsEnabled,
  isDisableStaticRegistryModelsEnabled,
  resolveFeatureFlag,
} = await import("../../src/shared/utils/featureFlags.ts");
const v1ModelsCatalog = await import("../../src/app/api/v1/models/catalog.ts");

type ModelsResponseBody = {
  data: Array<{ id: string; owned_by?: string; root?: string }>;
};

async function resetStorage() {
  core.resetDbInstance();
  apiKeysDb.resetApiKeyState();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
}

async function seedConnection(provider: string, accessToken = "test-token") {
  return providersDb.createProviderConnection({
    provider,
    authType: "oauth",
    name: `${provider}-test-conn`,
    apiKey: null,
    accessToken,
    isActive: true,
    testStatus: "active",
    providerSpecificData: {},
  });
}

async function getCatalogIds(url = "http://localhost/api/v1/models"): Promise<Set<string>> {
  v1ModelsCatalog.__resetCatalogBuilderRunsForTest();
  const response = await v1ModelsCatalog.getUnifiedModelsResponse(new Request(url));
  assert.equal(response.status, 200);
  const body = (await response.json()) as ModelsResponseBody;
  return new Set(body.data.map((item) => item.id));
}

describe("Suppress Built-in Models Feature Flag", () => {
  beforeEach(async () => {
    delete process.env.OMNIROUTE_SUPPRESS_BUILTIN_MODELS;
    delete process.env.OMNIROUTE_DISABLE_STATIC_REGISTRY_MODELS;
    await resetStorage();
  });

  afterEach(() => {
    delete process.env.OMNIROUTE_SUPPRESS_BUILTIN_MODELS;
    delete process.env.OMNIROUTE_DISABLE_STATIC_REGISTRY_MODELS;
  });

  after(async () => {
    core.resetDbInstance();
    apiKeysDb.resetApiKeyState();
    fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  describe("Flag Registration & Resolution", () => {
    it("is registered in FEATURE_FLAG_DEFINITIONS with defaultValue 'false'", () => {
      const def = FEATURE_FLAG_DEFINITIONS.find(
        (d) => d.key === "OMNIROUTE_SUPPRESS_BUILTIN_MODELS"
      );
      assert.ok(def, "OMNIROUTE_SUPPRESS_BUILTIN_MODELS must exist in FEATURE_FLAG_DEFINITIONS");
      assert.strictEqual(def.category, "runtime");
      assert.strictEqual(def.type, "boolean");
      assert.strictEqual(def.defaultValue, "false");
      assert.strictEqual(def.requiresRestart, false);
      assert.strictEqual(def.warningLevel, "info");
    });

    it("defaults to false when neither env var nor DB override is set", () => {
      assert.strictEqual(isSuppressBuiltinModelsEnabled(), false);
      assert.strictEqual(isDisableStaticRegistryModelsEnabled(), false);
      assert.strictEqual(resolveFeatureFlag("OMNIROUTE_SUPPRESS_BUILTIN_MODELS"), "false");
    });

    it("enables via OMNIROUTE_SUPPRESS_BUILTIN_MODELS environment variable", () => {
      for (const val of ["true", "1", "yes"]) {
        process.env.OMNIROUTE_SUPPRESS_BUILTIN_MODELS = val;
        assert.strictEqual(
          isSuppressBuiltinModelsEnabled(),
          true,
          `expected true for env val ${val}`
        );
        assert.strictEqual(
          isDisableStaticRegistryModelsEnabled(),
          true,
          `expected true for env val ${val}`
        );
      }
    });

    it("enables via OMNIROUTE_DISABLE_STATIC_REGISTRY_MODELS alias environment variable", () => {
      for (const val of ["true", "1", "yes"]) {
        process.env.OMNIROUTE_DISABLE_STATIC_REGISTRY_MODELS = val;
        assert.strictEqual(
          isSuppressBuiltinModelsEnabled(),
          true,
          `expected true for alias env val ${val}`
        );
        assert.strictEqual(
          isDisableStaticRegistryModelsEnabled(),
          true,
          `expected true for alias env val ${val}`
        );
      }
    });

    it("enables via DB override and takes priority over environment variable", () => {
      process.env.OMNIROUTE_SUPPRESS_BUILTIN_MODELS = "false";
      featureFlagsDb.setFeatureFlagOverride("OMNIROUTE_SUPPRESS_BUILTIN_MODELS", "true");
      try {
        assert.strictEqual(isSuppressBuiltinModelsEnabled(), true);
        assert.strictEqual(isDisableStaticRegistryModelsEnabled(), true);
      } finally {
        featureFlagsDb.removeFeatureFlagOverride("OMNIROUTE_SUPPRESS_BUILTIN_MODELS");
      }
    });
  });

  describe("Catalog /v1/models Behavior", () => {
    it("lists static registry models when flag is disabled (default/backward compatible)", async () => {
      await seedConnection("claude", "claude-test-token");
      const ids = await getCatalogIds();

      // Static Claude models from PROVIDER_MODELS should be present
      assert.ok(
        ids.has("cc/claude-sonnet-4-6") || ids.has("claude/claude-sonnet-4-6"),
        "expected static claude models to be present when flag is disabled"
      );
    });

    it("suppresses static registry models when flag is enabled", async () => {
      await seedConnection("claude", "claude-test-token");

      featureFlagsDb.setFeatureFlagOverride("OMNIROUTE_SUPPRESS_BUILTIN_MODELS", "true");
      try {
        const ids = await getCatalogIds();

        // Static Claude models from PROVIDER_MODELS should NOT be present
        assert.strictEqual(
          ids.has("cc/claude-sonnet-4-6"),
          false,
          "static cc/claude-sonnet-4-6 must be suppressed"
        );
        assert.strictEqual(
          ids.has("claude/claude-sonnet-4-6"),
          false,
          "static claude/claude-sonnet-4-6 must be suppressed"
        );
      } finally {
        featureFlagsDb.removeFeatureFlagOverride("OMNIROUTE_SUPPRESS_BUILTIN_MODELS");
      }
    });

    it("preserves dynamically synced models when flag is enabled", async () => {
      const conn = await seedConnection("claude", "claude-test-token");
      await modelsDb.replaceSyncedAvailableModelsForConnection("claude", conn.id, [
        {
          id: "custom-synced-claude-model",
          name: "Custom Synced Claude",
          supportedEndpoints: ["chat"],
        },
      ]);

      featureFlagsDb.setFeatureFlagOverride("OMNIROUTE_SUPPRESS_BUILTIN_MODELS", "true");
      try {
        const ids = await getCatalogIds();

        // Synced model must be preserved
        assert.ok(
          ids.has("cc/custom-synced-claude-model") || ids.has("claude/custom-synced-claude-model"),
          "dynamically synced model must be present in catalog"
        );

        // Static model must be suppressed
        assert.strictEqual(
          ids.has("cc/claude-sonnet-4-6"),
          false,
          "static model must be suppressed"
        );
      } finally {
        featureFlagsDb.removeFeatureFlagOverride("OMNIROUTE_SUPPRESS_BUILTIN_MODELS");
      }
    });

    it("preserves custom user-defined models when flag is enabled", async () => {
      await seedConnection("openai", "openai-test-token");
      await modelsDb.addCustomModel("openai", "custom-gpt-experiment", "Custom GPT Experiment");

      featureFlagsDb.setFeatureFlagOverride("OMNIROUTE_SUPPRESS_BUILTIN_MODELS", "true");
      try {
        const ids = await getCatalogIds();

        // Custom model must be preserved
        assert.ok(
          ids.has("openai/custom-gpt-experiment") || ids.has("oa/custom-gpt-experiment"),
          "custom model must be present in catalog"
        );
      } finally {
        featureFlagsDb.removeFeatureFlagOverride("OMNIROUTE_SUPPRESS_BUILTIN_MODELS");
      }
    });

    it("preserves active user combos when flag is enabled", async () => {
      await seedConnection("claude", "claude-test-token");
      await combosDb.createCombo({
        name: "combo/smart-routing",
        models: [{ provider: "claude", model: "claude-sonnet-4-6" }],
        isActive: true,
      });

      featureFlagsDb.setFeatureFlagOverride("OMNIROUTE_SUPPRESS_BUILTIN_MODELS", "true");
      try {
        const ids = await getCatalogIds();

        assert.ok(ids.has("combo/smart-routing"), "active combo must be listed in catalog");
      } finally {
        featureFlagsDb.removeFeatureFlagOverride("OMNIROUTE_SUPPRESS_BUILTIN_MODELS");
      }
    });

    it("invalidates model catalog cache dynamically when flag is toggled in DB", async () => {
      await seedConnection("claude", "claude-test-token");

      // 1. Initial request with flag OFF -> static models present
      const initialIds = await getCatalogIds();
      assert.ok(initialIds.has("cc/claude-sonnet-4-6") || initialIds.has("claude/claude-sonnet-4-6"));

      // 2. Set DB override to ON -> static models suppressed without manual cache flush
      featureFlagsDb.setFeatureFlagOverride("OMNIROUTE_SUPPRESS_BUILTIN_MODELS", "true");
      try {
        const afterEnabledIds = await getCatalogIds();
        assert.strictEqual(afterEnabledIds.has("cc/claude-sonnet-4-6"), false);
        assert.strictEqual(afterEnabledIds.has("claude/claude-sonnet-4-6"), false);

        // 3. Remove DB override -> static models restored
        featureFlagsDb.removeFeatureFlagOverride("OMNIROUTE_SUPPRESS_BUILTIN_MODELS");
        const afterDisabledIds = await getCatalogIds();
        assert.ok(
          afterDisabledIds.has("cc/claude-sonnet-4-6") ||
            afterDisabledIds.has("claude/claude-sonnet-4-6")
        );
      } finally {
        featureFlagsDb.removeFeatureFlagOverride("OMNIROUTE_SUPPRESS_BUILTIN_MODELS");
      }
    });
  });
});
