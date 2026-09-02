/**
 * Provider Alias Overrides
 * Dynamic customization of provider aliases and public prefixes via environment
 * variables (OMNIROUTE_PROVIDER_ALIAS_OVERRIDES, OMNIROUTE_PROVIDER_ALIASES) or
 * database settings (settings.providerAliases, settings.providerAliasOverrides).
 */

type RegistryLikeEntry = {
  id: string;
  alias?: string;
};

let _runtimeSettingsOverrides: Record<string, string> | null = null;
const _invalidationListeners = new Set<() => void>();

/**
 * Register a callback to be notified when alias overrides change.
 */
export function onAliasCacheInvalidation(cb: () => void): () => void {
  _invalidationListeners.add(cb);
  return () => {
    _invalidationListeners.delete(cb);
  };
}

/**
 * Invalidate cached alias and model maps across provider modules.
 */
export function invalidateAliasCaches(): void {
  for (const listener of _invalidationListeners) {
    try {
      listener();
    } catch (e) {
      console.warn("[ALIAS_OVERRIDES] Invalidation listener error:", e);
    }
  }
}

/**
 * Parse alias overrides from an unknown input (JSON string or object).
 */
export function parseAliasOverridesInput(input: unknown): Record<string, string> {
  if (!input) return {};
  if (typeof input === "object" && !Array.isArray(input)) {
    const result: Record<string, string> = {};
    for (const [k, v] of Object.entries(input)) {
      if (typeof k === "string" && typeof v === "string" && k.trim() && v.trim()) {
        result[k.trim()] = v.trim();
      }
    }
    return result;
  }
  if (typeof input === "string") {
    try {
      const parsed = JSON.parse(input);
      return parseAliasOverridesInput(parsed);
    } catch {
      return {};
    }
  }
  return {};
}

/**
 * Read raw provider alias overrides from environment variables.
 */
export function getEnvProviderAliasOverrides(): Record<string, string> {
  if (typeof process === "undefined" || !process.env) return {};
  const envRaw =
    process.env.OMNIROUTE_PROVIDER_ALIAS_OVERRIDES ||
    process.env.OMNIROUTE_PROVIDER_ALIASES;
  return parseAliasOverridesInput(envRaw);
}

/**
 * Set programmatic or database-persisted provider alias overrides.
 */
export function setProviderAliasOverrides(overrides: unknown): void {
  const parsed = parseAliasOverridesInput(overrides);
  _runtimeSettingsOverrides = parsed;
  invalidateAliasCaches();
}

/**
 * Reset runtime overrides back to environment-only defaults.
 */
export function resetProviderAliasOverrides(): void {
  _runtimeSettingsOverrides = null;
  invalidateAliasCaches();
}

/**
 * Get all raw configured overrides (env + runtime, runtime taking precedence).
 */
export function getRawProviderAliasOverrides(): Record<string, string> {
  const envOverrides = getEnvProviderAliasOverrides();
  if (!_runtimeSettingsOverrides) {
    return { ...envOverrides };
  }
  return {
    ...envOverrides,
    ..._runtimeSettingsOverrides,
  };
}

/**
 * Build the effective PROVIDER_ID_TO_ALIAS map from a registry definition.
 */
export function getEffectiveAliasMap(
  registry: Record<string, RegistryLikeEntry>
): Record<string, string> {
  const rawOverrides = getRawProviderAliasOverrides();
  const map: Record<string, string> = {};

  // 1. Build initial mappings from registry
  for (const entry of Object.values(registry)) {
    const defaultAlias = entry.alias || entry.id;
    map[entry.id] = defaultAlias;
  }

  // 2. Resolve overrides (keys may be canonical providerId or built-in alias)
  for (const [key, overrideAlias] of Object.entries(rawOverrides)) {
    // Check if key is a providerId in registry
    if (registry[key]) {
      map[key] = overrideAlias;
      continue;
    }
    // Check if key is an alias of a provider in registry
    const entryByAlias = Object.values(registry).find((e) => e.alias === key);
    if (entryByAlias) {
      map[entryByAlias.id] = overrideAlias;
      continue;
    }
    // Dynamic or unrecognized provider ID
    map[key] = overrideAlias;
  }

  // 3. For any provider whose built-in alias differs from id, map built-in alias -> effective alias
  for (const entry of Object.values(registry)) {
    const effectiveAlias = map[entry.id] || entry.alias || entry.id;
    map[entry.id] = effectiveAlias;
    if (entry.alias && entry.alias !== entry.id) {
      map[entry.alias] = effectiveAlias;
    }
  }

  return map;
}

/**
 * Build the effective ALIAS_TO_PROVIDER_ID map.
 */
export function getEffectiveAliasToProviderIdMap(
  registry: Record<string, RegistryLikeEntry>,
  manualOverrides: Record<string, string> = {}
): Record<string, string> {
  const rawOverrides = getRawProviderAliasOverrides();
  const map: Record<string, string> = {};

  // 1. Map provider IDs and built-in aliases to canonical providerId
  for (const entry of Object.values(registry)) {
    map[entry.id] = entry.id;
    if (entry.alias) {
      map[entry.alias] = entry.id;
    }
  }

  // 2. Map manual overrides (e.g. opencode -> opencode-zen)
  for (const [slug, canonical] of Object.entries(manualOverrides)) {
    map[slug] = canonical;
  }

  // 3. Map overridden aliases back to canonical provider IDs
  for (const [key, overrideAlias] of Object.entries(rawOverrides)) {
    let canonicalProviderId = key;
    if (registry[key]) {
      canonicalProviderId = registry[key].id;
    } else {
      const entryByAlias = Object.values(registry).find((e) => e.alias === key);
      if (entryByAlias) {
        canonicalProviderId = entryByAlias.id;
      } else if (manualOverrides[key]) {
        canonicalProviderId = manualOverrides[key];
      }
    }
    map[overrideAlias] = canonicalProviderId;
    map[key] = canonicalProviderId;
    map[canonicalProviderId] = canonicalProviderId;
  }

  return map;
}
