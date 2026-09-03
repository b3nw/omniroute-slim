import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const LOCALES_DIR = join(__dirname, "locales");

/**
 * English-only CLI runtime: `locales/` ships a single catalog (`en.json`), so
 * every locale request — `OMNIROUTE_LANG`, `LC_ALL`/`LC_MESSAGES`/`LANG`, or an
 * explicit `setLocale()` — resolves to `en`. The env vars are still read so a
 * `config lang set` write keeps round-tripping, but there is no catalog to
 * negotiate and therefore no cross-locale fallback chain left.
 */
export const LOCALE = "en";

let catalog = null;
let activeLocale = null;

export function detectLocale() {
  return LOCALE;
}

function flattenToMap(obj, prefix, result) {
  for (const [key, value] of Object.entries(obj)) {
    const fullKey = prefix ? `${prefix}.${key}` : key;
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      flattenToMap(value, fullKey, result);
    } else if (typeof value === "string") {
      result.set(fullKey, value);
    }
  }
}

function loadCatalog() {
  if (catalog) return catalog;
  try {
    const parsed = JSON.parse(readFileSync(join(LOCALES_DIR, `${LOCALE}.json`), "utf8"));
    const flat = new Map();
    flattenToMap(parsed, "", flat);
    catalog = flat;
  } catch {
    catalog = new Map();
  }
  return catalog;
}

export function setLocale(_locale) {
  activeLocale = LOCALE;
  loadCatalog();
  return activeLocale;
}

export function getLocale() {
  if (!activeLocale) activeLocale = LOCALE;
  return activeLocale;
}

function interpolate(template, vars) {
  if (!vars) return template;
  const entries = Object.entries(vars);
  if (entries.length === 0) return template;
  const varMap = new Map(entries);
  return template.replace(/\{(\w+)\}/g, (match, name) => {
    const v = varMap.get(name);
    return v !== undefined ? String(v) : match;
  });
}

export function t(key, vars) {
  if (!activeLocale) activeLocale = LOCALE;
  const value = loadCatalog().get(key);
  return value !== undefined ? interpolate(value, vars) : key;
}

export function resetForTests() {
  catalog = null;
  activeLocale = null;
}
