/**
 * Alias-backed models must honor vendor-qualified hidden flags.
 *
 * Passthrough aggregators (Kilo Code `kc`) list models under a vendor namespace, so
 * the provider-detail eye toggle stores `modelCompatOverrides["kilocode"]` entries
 * like `anthropic/claude-fable-5`. Alias rows registered by the dashboard stripped
 * the vendor (`"claude-fable-5": "kc/claude-fable-5"`), so the alias-backed loop in
 * `/v1/models` looked up the bare tail, missed the hidden flag, and leaked the model
 * — then `appendClaudeEffortVariants` fanned each leak out into -low/-medium/-high/
 * -xhigh rows.
 */
import { describe, it, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-hidden-alias-models-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = process.env.API_KEY_SECRET || "hidden-alias-models-test-secret";

const core = await import("../../src/lib/db/core.ts");
const providersDb = await import("../../src/lib/db/providers.ts");
const modelsDb = await import("../../src/lib/db/models.ts");
const aliasesDb = await import("../../src/lib/db/models/aliases.ts");
const featureFlagsDb = await import("../../src/lib/db/featureFlags.ts");
const apiKeysDb = await import("../../src/lib/db/apiKeys.ts");
const v1ModelsCatalog = await import("../../src/app/api/v1/models/catalog.ts");
const aliasResolver = await import("../../src/lib/modelAliasResolver.ts");
const { isHiddenModelMatch, buildHiddenModelSet } =
  await import("../../src/shared/utils/hiddenModelMatch.ts");
const { buildQualifiedAliasTarget } =
  await import("../../src/shared/utils/providerModelAliases.ts");

const PROVIDER_ID = "kilocode";
const PROVIDER_ALIAS = "kc";
const HIDDEN = "claude-fable-5";
const VISIBLE = "claude-sonnet-5";
const EFFORT_SUFFIXES = ["-low", "-medium", "-high", "-xhigh"];

async function resetStorage() {
  core.resetDbInstance();
  apiKeysDb.resetApiKeyState();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
  aliasResolver.invalidateAliasCache();
}

async function seedKilocode() {
  await providersDb.createProviderConnection({
    provider: PROVIDER_ID,
    authType: "oauth",
    name: "kilocode-test-conn",
    apiKey: null,
    accessToken: "kilo-test-token",
    isActive: true,
    testStatus: "active",
    providerSpecificData: {},
  });
  featureFlagsDb.setFeatureFlagOverride("OMNIROUTE_SUPPRESS_BUILTIN_MODELS", "true");
  // Bare-tail alias rows, as the pre-fix dashboard registered them.
  await aliasesDb.setModelAlias(HIDDEN, `${PROVIDER_ALIAS}/${HIDDEN}`);
  await aliasesDb.setModelAlias(VISIBLE, `${PROVIDER_ALIAS}/${VISIBLE}`);
  // Hidden flag stored under the vendor-qualified upstream id.
  modelsDb.setModelIsHidden(PROVIDER_ID, `anthropic/${HIDDEN}`, true);
}

async function getCatalogIds(query = ""): Promise<string[]> {
  v1ModelsCatalog.__resetCatalogBuilderRunsForTest();
  const response = await v1ModelsCatalog.getUnifiedModelsResponse(
    new Request(`http://localhost/api/v1/models${query}`)
  );
  assert.equal(response.status, 200);
  const body = (await response.json()) as { data: Array<{ id: string }> };
  return body.data.map((m) => m.id);
}

describe("isHiddenModelMatch / buildHiddenModelSet", () => {
  it("bare id matches a hidden vendor-qualified id", () => {
    const set = buildHiddenModelSet(new Map([["anthropic/claude-fable-5", true]]));
    assert.equal(set.has("anthropic/claude-fable-5"), true);
    assert.equal(set.has("claude-fable-5"), true, "tail is indexed");
    assert.equal(isHiddenModelMatch(set, "claude-fable-5"), true);
    assert.equal(isHiddenModelMatch(set, "anthropic/claude-fable-5"), true);
    assert.equal(isHiddenModelMatch(set, "claude-sonnet-5"), false);
  });

  it("vendor-qualified id matches a hidden bare tail (rule b)", () => {
    const set = new Set(["claude-fable-5"]);
    assert.equal(isHiddenModelMatch(set, "anthropic/claude-fable-5"), true);
  });

  it("bare id matches any hidden x/<id> even without tail indexing (rule c)", () => {
    const set = new Set(["anthropic/claude-fable-5"]);
    assert.equal(isHiddenModelMatch(set, "claude-fable-5"), true);
    assert.equal(isHiddenModelMatch(set, "fable-5"), false, "no partial-segment match");
  });

  it("does not hide a different vendor sharing the same tail", () => {
    const set = buildHiddenModelSet(new Map([["openai/gpt-oss", true]]));
    assert.equal(isHiddenModelMatch(set, "openai/gpt-oss"), true);
    assert.equal(isHiddenModelMatch(set, "groq/gpt-oss"), false);
  });

  it("an explicit visible entry beats the slug bridge", () => {
    const set = buildHiddenModelSet(
      new Map([
        ["anthropic/claude-fable-5", true],
        ["claude-fable-5", false],
      ])
    );
    assert.equal(isHiddenModelMatch(set, "anthropic/claude-fable-5"), true);
    assert.equal(isHiddenModelMatch(set, "claude-fable-5"), false);
  });

  it("empty / missing sets never hide", () => {
    assert.equal(isHiddenModelMatch(undefined, "x"), false);
    assert.equal(isHiddenModelMatch(new Set(), "x"), false);
    assert.equal(isHiddenModelMatch(new Set(["x"]), ""), false);
  });
});

describe("buildQualifiedAliasTarget", () => {
  it("preserves vendor namespaces for passthrough aggregators", () => {
    assert.equal(
      buildQualifiedAliasTarget("anthropic/claude-fable-5", "kc", "kilocode"),
      "kc/anthropic/claude-fable-5"
    );
  });

  it("strips only a leading provider alias or provider id", () => {
    assert.equal(
      buildQualifiedAliasTarget("kc/claude-fable-5", "kc", "kilocode"),
      "kc/claude-fable-5"
    );
    assert.equal(
      buildQualifiedAliasTarget("kilocode/claude-fable-5", "kc", "kilocode"),
      "kc/claude-fable-5"
    );
    assert.equal(buildQualifiedAliasTarget("gpt-5", "openai", "openai"), "openai/gpt-5");
  });

  it("returns the model id untouched when no provider alias is given", () => {
    assert.equal(buildQualifiedAliasTarget("anthropic/claude-fable-5"), "anthropic/claude-fable-5");
  });
});

describe("/v1/models alias-backed hidden models", () => {
  beforeEach(async () => {
    delete process.env.OMNIROUTE_SUPPRESS_BUILTIN_MODELS;
    await resetStorage();
  });

  after(() => {
    core.resetDbInstance();
    apiKeysDb.resetApiKeyState();
    fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it("getHiddenModelsByProvider indexes both the qualified id and its tail", async () => {
    await seedKilocode();
    const hidden = modelsDb.getHiddenModelsByProvider().get(PROVIDER_ID);
    assert.ok(hidden);
    assert.equal(hidden.has(`anthropic/${HIDDEN}`), true);
    assert.equal(hidden.has(HIDDEN), true);
    assert.equal(hidden.has(VISIBLE), false);
  });

  for (const query of ["", "?prefix=alias", "?prefix=dual", "?prefix=canonical"]) {
    it(`vendor-qualified hidden flag suppresses the bare alias-backed model (${query || "default"})`, async () => {
      await seedKilocode();
      const ids = await getCatalogIds(query);

      const leaked = ids.filter((id) => id.endsWith(`/${HIDDEN}`) || id === HIDDEN);
      assert.deepEqual(leaked, [], `hidden model leaked: ${JSON.stringify(leaked)}`);

      // Control: the un-hidden alias-backed sibling is still published, so the
      // assertion above is not vacuous.
      assert.ok(
        ids.some((id) => id.endsWith(`/${VISIBLE}`)),
        `expected visible ${VISIBLE} in ${JSON.stringify(ids)}`
      );
    });

    it(`no effort variants are spawned for the hidden alias model (${query || "default"})`, async () => {
      await seedKilocode();
      const ids = await getCatalogIds(query);

      for (const suffix of EFFORT_SUFFIXES) {
        const variants = ids.filter((id) => id.endsWith(`/${HIDDEN}${suffix}`));
        assert.deepEqual(variants, [], `effort variant leaked: ${JSON.stringify(variants)}`);
      }
      // Control: the visible Claude sibling still gets its effort variants.
      assert.ok(
        ids.some((id) => id.endsWith(`/${VISIBLE}-high`)),
        `expected ${VISIBLE}-high effort variant in ${JSON.stringify(ids)}`
      );
    });
  }

  it("un-hiding the vendor-qualified id restores the alias-backed model", async () => {
    await seedKilocode();
    modelsDb.setModelIsHidden(PROVIDER_ID, `anthropic/${HIDDEN}`, false);
    const ids = await getCatalogIds();
    assert.ok(
      ids.some((id) => id.endsWith(`/${HIDDEN}`)),
      JSON.stringify(ids)
    );
    assert.ok(
      ids.some((id) => id.endsWith(`/${HIDDEN}-high`)),
      JSON.stringify(ids)
    );
  });

  it("runtime alias resolution refuses a target hidden under its vendor-qualified id", async () => {
    await seedKilocode();
    aliasResolver.invalidateAliasCache();
    assert.equal(await aliasResolver.resolveModelAliasWithSeedFallback(HIDDEN), HIDDEN);
    assert.equal(
      await aliasResolver.resolveModelAliasWithSeedFallback(VISIBLE),
      `${PROVIDER_ALIAS}/${VISIBLE}`
    );
  });

  it("runtime alias resolution refuses a vendor-qualified target hidden by its bare tail", async () => {
    await seedKilocode();
    modelsDb.setModelIsHidden(PROVIDER_ID, VISIBLE, true);
    await aliasesDb.setModelAlias("sonnet-qualified", `${PROVIDER_ALIAS}/anthropic/${VISIBLE}`);
    aliasResolver.invalidateAliasCache();
    assert.equal(
      await aliasResolver.resolveModelAliasWithSeedFallback("sonnet-qualified"),
      "sonnet-qualified"
    );
  });
});

describe("setModelIsHidden persists explicit visibility across the vendor-slug bridge", () => {
  const QUALIFIED = `anthropic/${HIDDEN}`;
  const QUALIFIED_ALIAS = "fable-qualified";
  const BARE_ALIAS = "fable-bare";

  beforeEach(async () => {
    delete process.env.OMNIROUTE_SUPPRESS_BUILTIN_MODELS;
    await resetStorage();
    await providersDb.createProviderConnection({
      provider: PROVIDER_ID,
      authType: "oauth",
      name: "kilocode-test-conn",
      apiKey: null,
      accessToken: "kilo-test-token",
      isActive: true,
      testStatus: "active",
      providerSpecificData: {},
    });
    featureFlagsDb.setFeatureFlagOverride("OMNIROUTE_SUPPRESS_BUILTIN_MODELS", "true");
    await aliasesDb.setModelAlias(QUALIFIED_ALIAS, `${PROVIDER_ALIAS}/${QUALIFIED}`);
    await aliasesDb.setModelAlias(BARE_ALIAS, `${PROVIDER_ALIAS}/${HIDDEN}`);
  });

  after(() => {
    core.resetDbInstance();
    apiKeysDb.resetApiKeyState();
    fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  function effectiveHidden(modelId: string): boolean {
    return isHiddenModelMatch(modelsDb.getHiddenModelSetForProvider(PROVIDER_ID), modelId);
  }

  async function resolve(alias: string): Promise<string> {
    aliasResolver.invalidateAliasCache();
    return aliasResolver.resolveModelAliasWithSeedFallback(alias);
  }

  it("unhide persists an explicit isHidden:false compat entry, even with no prior entry", () => {
    modelsDb.setModelIsHidden(PROVIDER_ID, QUALIFIED, false);
    const entry = modelsDb.getModelCompatOverrides(PROVIDER_ID).find((e) => e.id === QUALIFIED);
    assert.deepEqual(entry, { id: QUALIFIED, isHidden: false });
    assert.equal(modelsDb.getModelIsHidden(PROVIDER_ID, QUALIFIED), false);
  });

  it("hide bare -> hide qualified -> unhide qualified: qualified alias is published and resolves", async () => {
    modelsDb.setModelIsHidden(PROVIDER_ID, HIDDEN, true);
    modelsDb.setModelIsHidden(PROVIDER_ID, QUALIFIED, true);
    modelsDb.setModelIsHidden(PROVIDER_ID, QUALIFIED, false);

    assert.equal(modelsDb.getModelIsHidden(PROVIDER_ID, QUALIFIED), false);
    assert.equal(effectiveHidden(QUALIFIED), false, "bare-tail bridge must not re-hide");
    assert.equal(effectiveHidden(HIDDEN), true, "bare id stays explicitly hidden");

    const ids = await getCatalogIds();
    assert.ok(ids.includes(`${PROVIDER_ALIAS}/${QUALIFIED}`), "qualified model is published");
    assert.ok(ids.includes(`${PROVIDER_ALIAS}/${QUALIFIED}-high`), "qualified effort variant");
    assert.ok(!ids.includes(`${PROVIDER_ALIAS}/${HIDDEN}`), "bare model stays hidden");

    assert.equal(await resolve(QUALIFIED_ALIAS), `${PROVIDER_ALIAS}/${QUALIFIED}`);
    assert.equal(await resolve(BARE_ALIAS), BARE_ALIAS, "hidden bare target stays unresolved");
  });

  it("hide qualified -> hide bare -> unhide bare: bare alias is published and resolves", async () => {
    modelsDb.setModelIsHidden(PROVIDER_ID, QUALIFIED, true);
    modelsDb.setModelIsHidden(PROVIDER_ID, HIDDEN, true);
    modelsDb.setModelIsHidden(PROVIDER_ID, HIDDEN, false);

    assert.equal(modelsDb.getModelIsHidden(PROVIDER_ID, HIDDEN), false);
    assert.equal(effectiveHidden(HIDDEN), false, "qualified-sibling bridge must not re-hide");
    assert.equal(effectiveHidden(QUALIFIED), true, "qualified id stays explicitly hidden");

    const ids = await getCatalogIds();
    assert.ok(ids.includes(`${PROVIDER_ALIAS}/${HIDDEN}`), "bare model is published");
    assert.ok(ids.includes(`${PROVIDER_ALIAS}/${HIDDEN}-high`), "bare effort variant");
    assert.ok(!ids.includes(`${PROVIDER_ALIAS}/${QUALIFIED}`), "qualified model stays hidden");

    assert.equal(await resolve(BARE_ALIAS), `${PROVIDER_ALIAS}/${HIDDEN}`);
    assert.equal(
      await resolve(QUALIFIED_ALIAS),
      QUALIFIED_ALIAS,
      "hidden qualified target stays unresolved"
    );
  });
});
