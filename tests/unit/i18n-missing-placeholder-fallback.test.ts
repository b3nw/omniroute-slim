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
// 2. General regression: the shipped catalog carries no raw __MISSING__: leaf.
// ---------------------------------------------------------------------------

test("#7258: the shipped EN catalog has no raw __MISSING__: leaf", () => {
  // The runtime is English-only, so there is no locale⟵EN merge left to check.
  // What survives is the invariant that actually reaches the user: the shipped
  // catalog must never render a raw sync-script sentinel.
  const shipped = readdirSync(messagesDir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.replace(/\.json$/, ""));

  assert.deepEqual(shipped, ["en"], "expected an English-only message catalog");

  const leaves: string[] = [];
  collectPlaceholderLeaves(loadLocale("en"), "", leaves);

  assert.deepEqual(
    leaves,
    [],
    `expected zero __MISSING__: leaves in en.json, found: ${JSON.stringify(leaves)}`
  );
});
