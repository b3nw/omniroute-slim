/**
 * Providers that accept a system-role message ONLY at index 0 (a `system`
 * message at any later position is rejected with HTTP 400). See #6135.
 *
 * Populated with the Xiaomi MiMo endpoint (provider id `xiaomi-mimo`, registry
 * alias `mimo`, serving mimo-v2.5) confirmed live to 400 on a non-first system
 * message, and the TokenRouter gateway (provider id `tokenrouter`), confirmed
 * live on 2026-08-22 to reject mid-array system messages. Add other providers
 * here only when they are documented as strict.
 *
 * Self-hosted deployments can extend this list without a source change via
 * OMNIROUTE_STRICT_SYSTEM_PROVIDERS (comma-separated provider ids,
 * case-insensitive) — e.g. a custom OpenAI-compatible connection in front of a
 * self-hosted Qwen3.5+/3.6 model, whose chat template enforces the same
 * single-leading-system-message constraint as xiaomi-mimo.
 */
const BUILTIN_PROVIDERS_SYSTEM_MUST_BE_FIRST = new Set(["xiaomi-mimo", "mimo", "tokenrouter"]);

/**
 * Parses OMNIROUTE_STRICT_SYSTEM_PROVIDERS into a normalized id list.
 * Exported for tests; not expected to be called directly by other modules.
 */
export function parseStrictSystemProvidersEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  const raw = env.OMNIROUTE_STRICT_SYSTEM_PROVIDERS ?? "";
  return raw
    .split(",")
    .map((id) => id.trim().toLowerCase())
    .filter(Boolean);
}

function resolveProvidersSystemMustBeFirst(env: NodeJS.ProcessEnv = process.env): Set<string> {
  const extra = parseStrictSystemProvidersEnv(env);
  if (extra.length === 0) return BUILTIN_PROVIDERS_SYSTEM_MUST_BE_FIRST;
  return new Set([...BUILTIN_PROVIDERS_SYSTEM_MUST_BE_FIRST, ...extra]);
}

/**
 * Returns true when the given provider requires the system message to be first.
 * Falls back to false for unknown/null providers (preserves current behavior).
 * Honors OMNIROUTE_STRICT_SYSTEM_PROVIDERS for self-hosted additions (see above).
 */
export function systemMessageMustBeFirst(
  provider: string | null | undefined,
  env: NodeJS.ProcessEnv = process.env
): boolean {
  if (!provider) return false;
  const normalized = provider.toLowerCase().trim();
  return resolveProvidersSystemMustBeFirst(env).has(normalized);
}
