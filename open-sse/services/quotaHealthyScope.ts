/**
 * #14359 healthy override scope.
 *
 * A successful dispatch only proves the quota bucket that request drew from is
 * usable. Providers with independent buckets on one connection must not let a
 * success in one bucket stand down exhaustion in another: Antigravity Gemini vs
 * Claude families, Codex standard vs Spark, and Gemini CLI model tiers.
 * Everything else is a single connection-wide bucket (`*`).
 *
 * Kept dependency-light (leaf imports only) so both `quotaCache.ts` and
 * `quotaPreflight.ts` can use it without reintroducing the ESM init cycle
 * described in `src/domain/quotaCacheState.ts`.
 */
import {
  getQuotaScopedModelForProvider,
  isAntigravityQuotaProvider,
} from "./antigravityQuotaFamily.ts";
import { getCodexModelScope } from "../config/codexQuotaScopes.ts";
import { getGeminiCliQuotaTier, isGeminiCliProvider } from "./geminiCliQuotaTier.ts";

export const CONNECTION_WIDE_QUOTA_SCOPE = "*";

export function resolveQuotaHealthyScope(
  provider: string | null | undefined,
  model: string | null | undefined
): string {
  const requestedModel = typeof model === "string" ? model.trim() : "";
  if (!requestedModel) return CONNECTION_WIDE_QUOTA_SCOPE;

  if (isAntigravityQuotaProvider(provider)) {
    const scoped = getQuotaScopedModelForProvider(provider, requestedModel);
    return scoped ? `antigravity:${scoped.toLowerCase()}` : CONNECTION_WIDE_QUOTA_SCOPE;
  }
  if (provider === "codex") {
    return `codex:${getCodexModelScope(requestedModel)}`;
  }
  if (isGeminiCliProvider(provider)) {
    const tier = getGeminiCliQuotaTier(requestedModel);
    return tier
      ? `gemini-cli:tier:${tier}`
      : `gemini-cli:model:${requestedModel.toLowerCase().replace(/^.*\//, "")}`;
  }
  return CONNECTION_WIDE_QUOTA_SCOPE;
}
