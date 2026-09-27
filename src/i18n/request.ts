import { getRequestConfig } from "next-intl/server";
import { cookies, headers } from "next/headers";
import { DEFAULT_LOCALE, LOCALES, LOCALE_COOKIE } from "./config";
import type { Locale } from "./config";
import enMessages from "./messages/en.json" with { type: "json" };

/**
 * Sentinel prefix written by `scripts/i18n/sync-ui-keys.mjs` when backfilling a
 * locale file with an untranslated key: `__MISSING__:<english value>`.
 */
export const PLACEHOLDER_PREFIX = "__MISSING__:";

function isUntranslatedPlaceholder(value: unknown): boolean {
  return typeof value === "string" && value.startsWith(PLACEHOLDER_PREFIX);
}

/**
 * Deep merge that mutates `target` with values from `source`.
 * If both have an object at the same key, recurse.
 * Otherwise prefer the existing value in `target` (locale-specific wins) —
 * unless the target value is an untranslated `__MISSING__:` sentinel, in
 * which case it is treated as absent so the clean English value wins (#7258).
 */
export function deepMergeFallback(
  target: Record<string, unknown>,
  source: Record<string, unknown>
): Record<string, unknown> {
  for (const [key, sourceValue] of Object.entries(source)) {
    // Guard against prototype pollution from a crafted locale message tree.
    if (key === "__proto__" || key === "constructor" || key === "prototype") continue;
    const targetValue = target[key];
    if (
      sourceValue !== null &&
      typeof sourceValue === "object" &&
      !Array.isArray(sourceValue) &&
      targetValue !== null &&
      typeof targetValue === "object" &&
      !Array.isArray(targetValue)
    ) {
      deepMergeFallback(
        targetValue as Record<string, unknown>,
        sourceValue as Record<string, unknown>
      );
    } else if (targetValue === undefined || isUntranslatedPlaceholder(targetValue)) {
      target[key] = sourceValue;
    }
  }
  return target;
}

function setNestedValue(target: Record<string, unknown>, dottedKey: string, value: unknown): void {
  const segments = dottedKey.split(".");
  let cursor: Record<string, unknown> = target;

  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    if (
      !segment ||
      segment === "__proto__" ||
      segment === "constructor" ||
      segment === "prototype"
    ) {
      return;
    }

    if (index === segments.length - 1) {
      cursor[segment] = value;
      return;
    }

    const next = cursor[segment];
    if (next && typeof next === "object" && !Array.isArray(next)) {
      cursor = next as Record<string, unknown>;
      continue;
    }

    const created: Record<string, unknown> = {};
    cursor[segment] = created;
    cursor = created;
  }
}

export function normalizeComplianceEventTypes(
  messages: Record<string, unknown>
): Record<string, unknown> {
  const compliance =
    messages.compliance &&
    typeof messages.compliance === "object" &&
    !Array.isArray(messages.compliance)
      ? (messages.compliance as Record<string, unknown>)
      : null;
  const eventTypes =
    compliance?.eventTypes &&
    typeof compliance.eventTypes === "object" &&
    !Array.isArray(compliance.eventTypes)
      ? (compliance.eventTypes as Record<string, unknown>)
      : null;

  if (!compliance || !eventTypes) return messages;

  const normalizedEventTypes: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(eventTypes)) {
    if (key.includes(".")) {
      setNestedValue(normalizedEventTypes, key, value);
    } else {
      normalizedEventTypes[key] = value;
    }
  }

  return {
    ...messages,
    compliance: {
      ...compliance,
      eventTypes: normalizedEventTypes,
    },
  };
}

/**
 * The normalized English catalog, built once at module load.
 *
 * `enMessages` is a static import — the same frozen object on every request —
 * so `normalizeComplianceEventTypes` would produce an identical result each
 * time. It used to run per request, re-walking `compliance.eventTypes` and
 * allocating a fresh top-level spread of the whole ~800-key catalog for every
 * page render and every server action. Hoisting it to module scope makes that
 * a one-time cost.
 */
const NORMALIZED_EN_MESSAGES = normalizeComplianceEventTypes(enMessages as Record<string, unknown>);

/**
 * Resolved (normalized + EN-merged) catalogs keyed by locale. Each catalog is
 * built on first use and reused for the lifetime of the process, so the
 * import/normalize/merge work is not repeated on every request.
 */
const messagesCache = new Map<string, Record<string, unknown>>([
  [DEFAULT_LOCALE, NORMALIZED_EN_MESSAGES],
]);

async function loadMessages(locale: Locale): Promise<Record<string, unknown>> {
  const cached = messagesCache.get(locale);
  if (cached) return cached;

  // Clone before merging: `deepMergeFallback` mutates its target, and the
  // imported JSON module object must stay pristine.
  const imported = (await import(`./messages/${locale}.json`)).default;
  const localeMessages = normalizeComplianceEventTypes(
    structuredClone(imported) as Record<string, unknown>
  );
  const messages = deepMergeFallback(localeMessages, NORMALIZED_EN_MESSAGES);
  messagesCache.set(locale, messages);
  return messages;
}

async function resolveLocale(): Promise<Locale> {
  const cookieStore = await cookies();
  let locale = cookieStore.get(LOCALE_COOKIE)?.value || "";
  if (!locale) {
    const headerStore = await headers();
    locale = headerStore.get("x-locale") || "";
  }
  return LOCALES.includes(locale) ? locale : DEFAULT_LOCALE;
}

export default getRequestConfig(async () => {
  const locale = await resolveLocale();
  return {
    locale,
    messages: await loadMessages(locale),
  };
});
