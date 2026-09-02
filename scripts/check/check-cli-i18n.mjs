#!/usr/bin/env node
/**
 * Validates the English-only CLI catalog (`bin/cli/locales/en.json`):
 *   1. Every t("key") call in bin/cli/commands/ resolves to a key that exists.
 *   2. The catalog carries no `__MISSING__:` sentinel left over from the
 *      retired multi-language sync tooling.
 *
 * The CLI ships a single catalog, so there is no cross-locale parity to check.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..");
const COMMANDS_DIR = join(ROOT, "bin", "cli", "commands");
const LOCALES_DIR = join(ROOT, "bin", "cli", "locales");
const PLACEHOLDER_PREFIX = "__MISSING__:";

// Paths that look like t() keys but are actually import paths — skip them.
const IGNORE_AS_KEY = new Set([".", ".."]);
const IMPORT_PATH_RE = /^(\.\.?\/|node:|\/)/;

function walk(dir) {
  const results = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      results.push(...walk(full));
    } else if (entry.endsWith(".mjs") || entry.endsWith(".js")) {
      results.push(full);
    }
  }
  return results;
}

function flattenEntries(obj, prefix = "") {
  const entries = [];
  for (const [k, v] of Object.entries(obj)) {
    const full = prefix ? `${prefix}.${k}` : k;
    if (v !== null && typeof v === "object" && !Array.isArray(v)) {
      entries.push(...flattenEntries(v, full));
    } else {
      entries.push([full, v]);
    }
  }
  return entries;
}

function collectTKeys(files) {
  const used = new Set();
  const re = /\bt\(\s*["']([^"']+)["']/g;
  for (const file of files) {
    const src = readFileSync(file, "utf8");
    let m;
    re.lastIndex = 0;
    while ((m = re.exec(src)) !== null) {
      const key = m[1];
      if (IGNORE_AS_KEY.has(key) || IMPORT_PATH_RE.test(key)) continue;
      used.add(key);
    }
  }
  return used;
}

// Guard the English-only invariant itself: an extra catalog would silently
// resurrect the fallback chain that `bin/cli/i18n.mjs` no longer implements.
const shipped = readdirSync(LOCALES_DIR)
  .filter((f) => f.endsWith(".json"))
  .sort();

const files = walk(COMMANDS_DIR);
const usedKeys = collectTKeys(files);
const enEntries = flattenEntries(JSON.parse(readFileSync(join(LOCALES_DIR, "en.json"), "utf8")));
const enKeys = new Set(enEntries.map(([k]) => k));

let errors = 0;

// Check 0: en.json is the only catalog shipped.
if (shipped.length !== 1 || shipped[0] !== "en.json") {
  console.error("[cli-i18n] bin/cli/locales must contain exactly en.json, found:");
  for (const f of shipped) console.error(`  ✗ ${f}`);
  errors += 1;
} else {
  console.log("[cli-i18n] ✓ English-only catalog (en.json)");
}

// Check 1: all used keys exist in en.json
const missingInEn = [...usedKeys].filter((k) => !enKeys.has(k));
if (missingInEn.length > 0) {
  console.error("[cli-i18n] Keys used in commands but missing in en.json:");
  for (const k of missingInEn) console.error(`  ✗ ${k}`);
  errors += missingInEn.length;
} else {
  console.log(`[cli-i18n] ✓ All ${usedKeys.size} t() keys found in en.json`);
}

// Check 2: no untranslated sentinel survived the multi-language cleanup.
const sentinels = enEntries.filter(
  ([, v]) => typeof v === "string" && v.startsWith(PLACEHOLDER_PREFIX)
);
if (sentinels.length > 0) {
  console.error(`[cli-i18n] en.json still carries ${PLACEHOLDER_PREFIX} sentinels:`);
  for (const [k] of sentinels) console.error(`  ✗ ${k}`);
  errors += sentinels.length;
} else {
  console.log(`[cli-i18n] ✓ No ${PLACEHOLDER_PREFIX} sentinels in ${enKeys.size} keys`);
}

if (errors > 0) {
  console.error(`[cli-i18n] FAIL — ${errors} error(s) found`);
  process.exit(1);
} else {
  console.log("[cli-i18n] PASS — CLI i18n is consistent");
}
