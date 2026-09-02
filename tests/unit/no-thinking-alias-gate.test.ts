import { describe, it, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

/**
 * DB end of the `NO_THINKING_ALIAS_ENABLED` master switch: the flag definition, the
 * resolver precedence (DB override > env > default), the catalog-invalidation signal
 * the override write must emit, and the two gated behaviors an operator sees when the
 * flag is off (nothing advertised on /v1/models, no dispatch-time stripping).
 *
 * The pure `featureEnabled` branch logic is pinned in tests/unit/no-thinking-alias.test.ts;
 * this file pins the wiring that feeds it.
 */

// Set DATA_DIR to a temp dir before any imports that touch the DB.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-test-nothink-flag-"));
process.env.DATA_DIR = tmpDir;

const FLAG_KEY = "NO_THINKING_ALIAS_ENABLED";

const core = await import("../../src/lib/db/core.ts");
const { FEATURE_FLAG_DEFINITIONS } =
  await import("../../src/shared/constants/featureFlagDefinitions.ts");
const {
  setFeatureFlagOverride,
  removeFeatureFlagOverride,
  clearAllFeatureFlagOverrides,
  getFeatureFlagOverride,
} = await import("../../src/lib/db/featureFlags.ts");
const { isNoThinkingAliasEnabled } = await import("../../src/shared/utils/featureFlags.ts");
const { getModelCatalogCacheVersion } = await import("../../src/lib/db/readCache.ts");
const { appendNoThinkingVariants, applyNoThinkingAlias, isNoThinkingAlias } =
  await import("../../open-sse/utils/noThinkingAlias.ts");

function resetDb() {
  core.resetDbInstance();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  fs.mkdirSync(tmpDir, { recursive: true });
}

const entry = (id: string, owned_by = "anthropic") => ({ id, object: "model", owned_by });

// ──────────────────────────────────────────────────────
// Group 1 — flag definition registry
// ──────────────────────────────────────────────────────
describe(`${FLAG_KEY} flag definition`, () => {
  it("is registered as a runtime boolean flag, default ON", () => {
    const def = FEATURE_FLAG_DEFINITIONS.find((d) => d.key === FLAG_KEY);
    assert.ok(def, `${FLAG_KEY} should exist`);
    assert.strictEqual(def.category, "runtime");
    assert.strictEqual(def.type, "boolean");
    // Default ON preserves the behavior the feature shipped with: making the alias a
    // flag must not silently remove variants from an operator's existing catalog.
    assert.strictEqual(def.defaultValue, "true");
    assert.strictEqual(def.requiresRestart, false);
    assert.strictEqual(def.warningLevel, "info");
    assert.strictEqual(def.descriptionI18nKey, "featureFlagNoThinkingAliasEnabledDescription");
    assert.ok(!def.enumValues, "boolean flags carry no enumValues");
  });

  it("has an English i18n description for its descriptionI18nKey", () => {
    const def = FEATURE_FLAG_DEFINITIONS.find((d) => d.key === FLAG_KEY);
    const en = JSON.parse(
      fs.readFileSync(
        path.resolve(import.meta.dirname, "..", "..", "src", "i18n", "messages", "en.json"),
        "utf8"
      )
    ) as Record<string, unknown>;
    const value = en[def!.descriptionI18nKey];
    assert.strictEqual(typeof value, "string");
    assert.ok((value as string).length > 0);
    // #8747: raw angle brackets in a message make next-intl log UNCLOSED_TAG.
    assert.ok(
      !/no-think\/<[^>\n]+>/.test(value as string),
      "the no-think/<provider>/<model> path must be HTML-entity escaped"
    );
  });
});

// ──────────────────────────────────────────────────────
// Group 2 — resolver precedence (DB > env > default)
// ──────────────────────────────────────────────────────
describe("isNoThinkingAliasEnabled precedence", () => {
  beforeEach(() => {
    resetDb();
    delete process.env[FLAG_KEY];
  });

  after(() => {
    core.resetDbInstance();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    delete process.env[FLAG_KEY];
  });

  it("is enabled with no override and no env var (definition default)", () => {
    assert.strictEqual(isNoThinkingAliasEnabled(), true);
  });

  it("is disabled by a DB override of 'false'", () => {
    setFeatureFlagOverride(FLAG_KEY, "false");
    assert.strictEqual(isNoThinkingAliasEnabled(), false);
  });

  it("is re-enabled by a DB override of 'true'", () => {
    setFeatureFlagOverride(FLAG_KEY, "true");
    assert.strictEqual(isNoThinkingAliasEnabled(), true);
  });

  it("falls back to the env var when no DB override is stored", () => {
    process.env[FLAG_KEY] = "false";
    assert.strictEqual(isNoThinkingAliasEnabled(), false);
  });

  it("lets the DB override win over the env var (generic flag precedence)", () => {
    process.env[FLAG_KEY] = "false";
    setFeatureFlagOverride(FLAG_KEY, "true");
    assert.strictEqual(isNoThinkingAliasEnabled(), true);
  });

  it("returns to the default once the override is removed", () => {
    setFeatureFlagOverride(FLAG_KEY, "false");
    removeFeatureFlagOverride(FLAG_KEY);
    assert.strictEqual(getFeatureFlagOverride(FLAG_KEY), undefined);
    assert.strictEqual(isNoThinkingAliasEnabled(), true);
  });

  it("returns to the default once all overrides are cleared", () => {
    setFeatureFlagOverride(FLAG_KEY, "false");
    clearAllFeatureFlagOverrides();
    assert.strictEqual(getFeatureFlagOverride(FLAG_KEY), undefined);
    assert.strictEqual(isNoThinkingAliasEnabled(), true);
  });
});

// ──────────────────────────────────────────────────────
// Group 3 — catalog-relevance write signal
// ──────────────────────────────────────────────────────
describe(`${FLAG_KEY} is catalog-relevant`, () => {
  beforeEach(() => {
    resetDb();
    delete process.env[FLAG_KEY];
  });

  after(() => {
    core.resetDbInstance();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("setFeatureFlagOverride invalidates the model-catalog cache", () => {
    const before = getModelCatalogCacheVersion();
    setFeatureFlagOverride(FLAG_KEY, "false");
    assert.ok(
      getModelCatalogCacheVersion() > before,
      "toggling the flag changes /v1/models output, so the cached catalog must be dropped"
    );
  });

  it("removeFeatureFlagOverride invalidates the model-catalog cache", () => {
    setFeatureFlagOverride(FLAG_KEY, "false");
    const before = getModelCatalogCacheVersion();
    removeFeatureFlagOverride(FLAG_KEY);
    assert.ok(getModelCatalogCacheVersion() > before);
  });

  it("clearAllFeatureFlagOverrides invalidates the catalog when this flag was overridden", () => {
    setFeatureFlagOverride(FLAG_KEY, "false");
    const before = getModelCatalogCacheVersion();
    clearAllFeatureFlagOverrides();
    assert.ok(getModelCatalogCacheVersion() > before);
  });

  it("clearAllFeatureFlagOverrides works with a non-catalog override stored", () => {
    // Regression guard: the catalog-relevance probe used a hardcoded `IN (?, ?, ?)`
    // list, which throws a parameter-count error as soon as a fourth flag joins the
    // set. Any override at all must be clearable.
    setFeatureFlagOverride("REQUIRE_API_KEY", "true");
    clearAllFeatureFlagOverrides();
    assert.strictEqual(getFeatureFlagOverride("REQUIRE_API_KEY"), undefined);
  });
});

// ──────────────────────────────────────────────────────
// Group 4 — gated behavior an operator actually observes
// ──────────────────────────────────────────────────────
describe("no-thinking alias behavior under the resolved flag", () => {
  beforeEach(() => {
    resetDb();
    delete process.env[FLAG_KEY];
  });

  after(() => {
    core.resetDbInstance();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    delete process.env[FLAG_KEY];
  });

  it("advertises no no-think/ variants on the catalog while the flag is off", () => {
    setFeatureFlagOverride(FLAG_KEY, "false");
    const models = [entry("claude-opus-4-5"), entry("anthropic/claude-sonnet-4-6")];
    const out = appendNoThinkingVariants(models, undefined, {
      featureEnabled: isNoThinkingAliasEnabled(),
    });
    assert.ok(
      !out.some((m) => isNoThinkingAlias(m.id)),
      "catalog must not carry a single no-think/ entry"
    );
    assert.strictEqual(out.length, models.length);
  });

  it("advertises variants again once the flag is back on (default)", () => {
    const models = [entry("claude-opus-4-5")];
    const out = appendNoThinkingVariants(models, undefined, {
      featureEnabled: isNoThinkingAliasEnabled(),
    });
    assert.ok(out.some((m) => m.id === "no-think/claude-opus-4-5"));
  });

  it("does not strip a no-think/ id at dispatch while the flag is off", () => {
    setFeatureFlagOverride(FLAG_KEY, "false");
    const body: Record<string, unknown> = {
      model: "no-think/anthropic/claude-opus-4-5",
      thinking: { type: "enabled" },
      messages: [],
    };
    const res = applyNoThinkingAlias(body, {
      claudeFormat: true,
      featureEnabled: isNoThinkingAliasEnabled(),
    });
    assert.strictEqual(res.applied, false);
    // Unknown-model behavior: the literal id survives untouched for downstream
    // resolution to reject exactly like any other unroutable model id.
    assert.strictEqual(body.model, "no-think/anthropic/claude-opus-4-5");
    assert.deepStrictEqual(body.thinking, { type: "enabled" });
  });

  it("strips and suppresses at dispatch while the flag is on (default)", () => {
    const body: Record<string, unknown> = {
      model: "no-think/anthropic/claude-opus-4-5",
      thinking: { type: "enabled" },
      messages: [],
    };
    const res = applyNoThinkingAlias(body, {
      claudeFormat: true,
      featureEnabled: isNoThinkingAliasEnabled(),
    });
    assert.strictEqual(res.applied, true);
    assert.strictEqual(body.model, "anthropic/claude-opus-4-5");
    assert.deepStrictEqual(body.thinking, { type: "disabled" });
  });
});
