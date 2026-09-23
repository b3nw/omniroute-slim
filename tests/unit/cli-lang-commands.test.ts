import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let tmpDir: string;
let origDataDir: string | undefined;
let origOmniLang: string | undefined;

test.before(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "omniroute-lang-test-"));
  origDataDir = process.env.DATA_DIR;
  origOmniLang = process.env.OMNIROUTE_LANG;
  process.env.DATA_DIR = tmpDir;
  delete process.env.OMNIROUTE_LANG;
});

test.after(() => {
  if (origDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = origDataDir;
  if (origOmniLang === undefined) delete process.env.OMNIROUTE_LANG;
  else process.env.OMNIROUTE_LANG = origOmniLang;
  try {
    rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {}
});

// ── i18n.mjs security ─────────────────────────────────────────────────────────

test("normalize rejeita path traversal com ../", async () => {
  const { resetForTests, setLocale, getLocale } = await import("../../bin/cli/i18n.mjs");
  resetForTests();
  setLocale("../etc/passwd");
  const locale = getLocale();
  assert.equal(locale, "en", `Deveria ter fallback para en, obteve: ${locale}`);
  resetForTests();
});

test("normalize rejeita código com caracteres especiais", async () => {
  const { resetForTests, setLocale, getLocale } = await import("../../bin/cli/i18n.mjs");
  resetForTests();
  setLocale("pt;rm -rf /");
  const locale = getLocale();
  assert.equal(locale, "en", `Deveria ter fallback para en, obteve: ${locale}`);
  resetForTests();
});

test("setLocale resolve um código bem-formado sem catálogo para en", async () => {
  // English-only runtime: `pt-BR` is a valid BCP-47 tag but ships no catalog,
  // so it collapses to the single shipped one instead of half-resolving.
  const { resetForTests, setLocale, getLocale } = await import("../../bin/cli/i18n.mjs");
  resetForTests();
  assert.equal(setLocale("pt-BR"), "en");
  assert.equal(getLocale(), "en");
  resetForTests();
});

// ── config lang get ────────────────────────────────────────────────────────────

// ── config lang list ───────────────────────────────────────────────────────────

// ── config lang set ────────────────────────────────────────────────────────────

// ── upsertEnvLine (testado indiretamente via set) ─────────────────────────────

