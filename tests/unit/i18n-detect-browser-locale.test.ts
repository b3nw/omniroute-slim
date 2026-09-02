import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { detectBrowserLocale } from "../../src/i18n/detectBrowserLocale";
import { LOCALES } from "../../src/i18n/config";

// The shipped runtime is English-only (config/i18n.json). These are the locale
// lists the detector actually sees in production.
const SHIPPED_LOCALES = LOCALES;

describe("detectBrowserLocale — shipped (English-only) locale set", () => {
  it("ships exactly one locale, so detection can only ever resolve to English", () => {
    assert.deepEqual([...SHIPPED_LOCALES], ["en"]);
  });

  it("returns the exact match when a browser language equals a supported locale", () => {
    assert.equal(detectBrowserLocale(["en"], SHIPPED_LOCALES), "en");
  });

  it("falls back to a language-prefix match for regional English", () => {
    assert.equal(detectBrowserLocale(["en-US"], SHIPPED_LOCALES), "en");
    assert.equal(detectBrowserLocale(["en-GB"], SHIPPED_LOCALES), "en");
  });

  it("returns null for a non-English browser language (caller keeps the default)", () => {
    assert.equal(detectBrowserLocale(["pt-BR"], SHIPPED_LOCALES), null);
    assert.equal(detectBrowserLocale(["zh-HK"], SHIPPED_LOCALES), null);
    assert.equal(detectBrowserLocale(["ja-JP"], SHIPPED_LOCALES), null);
  });

  it("picks English out of a mixed browser preference list", () => {
    assert.equal(detectBrowserLocale(["ja-JP", "fr-CA", "en-US"], SHIPPED_LOCALES), "en");
  });

  it("is case-insensitive", () => {
    assert.equal(detectBrowserLocale(["EN-us"], SHIPPED_LOCALES), "en");
  });
});

// The helper stays generic over `locales` so it is directly testable and does
// not bake in the current single-locale assumption.
describe("detectBrowserLocale — generic matching contract", () => {
  const MULTI = ["en", "pt-BR", "fr"] as const;

  it("returns the exact match, preserving the locale's original casing", () => {
    assert.equal(detectBrowserLocale(["pt-BR"], MULTI), "pt-BR");
    assert.equal(detectBrowserLocale(["PT-br"], MULTI), "pt-BR");
  });

  it("tries each browser language in order until one matches", () => {
    assert.equal(detectBrowserLocale(["ja-JP", "fr-CA"], MULTI), "fr");
  });

  it("prefers an exact match over an earlier language's prefix match", () => {
    assert.equal(detectBrowserLocale(["pt-BR", "en"], MULTI), "pt-BR");
  });

  it("returns null when nothing matches", () => {
    assert.equal(detectBrowserLocale(["ja-JP"], MULTI), null);
  });

  it("returns null for an empty languages list", () => {
    assert.equal(detectBrowserLocale([], MULTI), null);
  });

  it("returns null for an empty locales list", () => {
    assert.equal(detectBrowserLocale(["en-US"], []), null);
  });
});
