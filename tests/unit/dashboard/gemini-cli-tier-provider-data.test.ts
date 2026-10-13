import test from "node:test";
import assert from "node:assert/strict";

import {
  GEMINI_CLI_TIER_OPTIONS,
  applyGeminiCliTier,
  isGeminiCliTierProvider,
  readGeminiCliTierSetting,
} from "../../../src/app/(dashboard)/dashboard/providers/[id]/components/modals/geminiCliTier.ts";
import {
  getTierFullName,
  normalizeTierName,
} from "../../../open-sse/services/geminiCliDiscovery.ts";

test("tier selector is limited to gemini-cli and gemini_cli", () => {
  assert.equal(isGeminiCliTierProvider("gemini-cli"), true);
  assert.equal(isGeminiCliTierProvider("gemini_cli"), true);
  assert.equal(isGeminiCliTierProvider("antigravity"), false);
  assert.equal(isGeminiCliTierProvider("gemini"), false);
  assert.equal(isGeminiCliTierProvider(undefined), false);
});

test("options cover auto + the three canonical tiers", () => {
  assert.deepEqual(
    GEMINI_CLI_TIER_OPTIONS.map((o) => o.value),
    ["auto", "FREE", "PRO", "ULTRA"]
  );
});

for (const setting of ["FREE", "PRO", "ULTRA"] as const) {
  test(`${setting}: writes tier/tierCanonical/tier_full consistent with discovery normalization`, () => {
    const target: Record<string, unknown> = { tier: "free-tier", projectId: "p" };
    applyGeminiCliTier(target, setting);

    assert.equal(target.tierCanonical, setting);
    assert.equal(target.isTierManual, true);
    assert.equal(target.projectId, "p");
    // The raw id must round-trip through the same helpers the usage/quota
    // code uses, so a pinned tier reads back as the selected one.
    assert.equal(normalizeTierName(target.tier as string), setting);
    assert.equal(target.tier_full, getTierFullName(target.tier as string));
  });
}

test("auto clears the manual flag and keeps discovered tier fields", () => {
  const target: Record<string, unknown> = {
    tier: "g1-pro-tier",
    tierCanonical: "PRO",
    tier_full: "Google One AI PRO",
    isTierManual: true,
  };
  applyGeminiCliTier(target, "auto");
  assert.deepEqual(target, {
    tier: "g1-pro-tier",
    tierCanonical: "PRO",
    tier_full: "Google One AI PRO",
    isTierManual: false,
  });
});

test("readGeminiCliTierSetting maps stored data to the dropdown value", () => {
  assert.equal(readGeminiCliTierSetting(undefined), "auto");
  assert.equal(readGeminiCliTierSetting({ tierCanonical: "PRO" }), "auto");
  assert.equal(readGeminiCliTierSetting({ tierCanonical: "PRO", isTierManual: true }), "PRO");
  assert.equal(readGeminiCliTierSetting({ tierCanonical: "ULTRA", isTierManual: true }), "ULTRA");
  assert.equal(readGeminiCliTierSetting({ tierCanonical: "bogus", isTierManual: true }), "auto");
});

test("every tier option label key exists in all Tier-1 locales", async () => {
  const { readFileSync } = await import("node:fs");
  const keys = [
    "geminiCliTierLabel",
    "geminiCliTierHint",
    ...GEMINI_CLI_TIER_OPTIONS.map((o) => o.labelKey),
  ];
  for (const locale of ["en", "de", "es", "fr", "ja", "pt-BR", "zh-CN"]) {
    const raw = readFileSync(
      new URL(`../../../src/i18n/messages/${locale}.json`, import.meta.url),
      "utf8"
    );
    for (const key of keys) {
      assert.match(raw, new RegExp(`"${key}":\\s*"[^"]+"`), `${locale} is missing ${key}`);
    }
  }
});
