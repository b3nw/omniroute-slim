/**
 * Pure browser-language detector used to pick an initial locale on first
 * visit, before the user has made an explicit selection (no cookie set).
 *
 * Matching order:
 *  1. Exact match against `navigator.languages` entries (case-insensitive).
 *  2. Language-prefix match — e.g. `en-US` matches a supported `en` locale.
 *  3. No match → `null` (caller should keep the existing default).
 *
 * OmniRoute-Slim ships an English-only runtime, so in production `locales` is
 * always `["en"]` and this collapses to "does the browser ask for some flavour
 * of English?". The function stays generic over `locales` (rather than
 * hard-coding `en`) so it remains a pure, directly testable helper.
 *
 * Kept dependency-free (no DOM/`navigator` access) so it is trivially unit
 * testable and reusable from both client components and future server code.
 */
export function detectBrowserLocale(
  languages: readonly string[],
  locales: readonly string[]
): string | null {
  if (!languages || languages.length === 0 || !locales || locales.length === 0) {
    return null;
  }

  const normalizedLocales = locales.map((locale) => locale.toLowerCase());

  for (const rawLanguage of languages) {
    if (!rawLanguage) continue;
    const language = rawLanguage.toLowerCase();

    // 1. Exact match.
    const exactIndex = normalizedLocales.indexOf(language);
    if (exactIndex !== -1) {
      return locales[exactIndex];
    }

    // 2. Language-prefix match (e.g. "en-US" -> "en").
    const prefix = language.split("-")[0];
    const prefixIndex = normalizedLocales.indexOf(prefix);
    if (prefixIndex !== -1) {
      return locales[prefixIndex];
    }
  }

  return null;
}
