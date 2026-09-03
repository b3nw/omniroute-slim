import { getRequestConfig } from "next-intl/server";
import { DEFAULT_LOCALE } from "./config";
import enMessages from "./messages/en.json" with { type: "json" };

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
 * English-only runtime: `config/i18n.json` ships a single locale, so there is
 * no cookie/header negotiation and no cross-locale fallback merge left to do —
 * every request resolves to `en` and serves `./messages/en.json` directly.
 */
export default getRequestConfig(async () => ({
  locale: DEFAULT_LOCALE,
  messages: NORMALIZED_EN_MESSAGES,
}));
