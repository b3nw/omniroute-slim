/**
 * Regression test for #7258 — zh-TW (and other locales) rendering the raw
 * `__MISSING__:<english>` sentinel written by `scripts/i18n/sync-ui-keys.mjs`
 * instead of falling back to the clean English value.
 *
 * `deepMergeFallback` (src/i18n/request.ts) previously only substituted the
 * EN value when a key was entirely `undefined`; a key that existed but still
 * carried the untranslated placeholder passed through untouched and was
 * rendered verbatim to the user.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
const PLACEHOLDER_PREFIX = "__MISSING__:";

const messagesDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "src",
  "i18n",
  "messages"
);

function loadLocale(locale: string): Record<string, unknown> {
  const raw = readFileSync(path.join(messagesDir, `${locale}.json`), "utf8");
  return JSON.parse(raw) as Record<string, unknown>;
}

function collectPlaceholderLeaves(node: unknown, pathPrefix: string, out: string[]): void {
  if (node === null || typeof node !== "object") {
    if (typeof node === "string" && node.startsWith(PLACEHOLDER_PREFIX)) {
      out.push(pathPrefix);
    }
    return;
  }
  if (Array.isArray(node)) return;
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    collectPlaceholderLeaves(value, pathPrefix ? `${pathPrefix}.${key}` : key, out);
  }
}

// ---------------------------------------------------------------------------
// General regression: no shipped catalog carries a raw __MISSING__: leaf.
// ---------------------------------------------------------------------------

const SHIPPED = readdirSync(messagesDir)
  .filter((f) => f.endsWith(".json"))
  .map((f) => f.replace(/\.json$/, ""))
  .sort();

test("#7258: the Tier 1 catalogs are all shipped", () => {
  assert.deepEqual(SHIPPED, ["de", "en", "es", "fr", "ja", "pt-BR", "zh-CN"]);
});

for (const locale of SHIPPED) {
  test(`#7258: ${locale}.json has no raw __MISSING__: leaf`, () => {
    const leaves: string[] = [];
    collectPlaceholderLeaves(loadLocale(locale), "", leaves);

    assert.deepEqual(
      leaves,
      [],
      `expected zero __MISSING__: leaves in ${locale}.json, found: ${JSON.stringify(leaves)}`
    );
  });
}

// ---------------------------------------------------------------------------
// deepMergeFallback treats a sentinel as absent so the English value wins.
// ---------------------------------------------------------------------------

test("#7258: deepMergeFallback replaces __MISSING__: sentinels and absent keys with EN", async () => {
  const { deepMergeFallback } = await import("../../src/i18n/request.ts");
  const merged = deepMergeFallback(
    { a: { kept: "Traduit", stale: `${PLACEHOLDER_PREFIX}Stale` } },
    { a: { kept: "Kept", stale: "Stale", added: "Added" }, b: "Top" }
  );
  assert.deepEqual(merged, {
    a: { kept: "Traduit", stale: "Stale", added: "Added" },
    b: "Top",
  });
});
