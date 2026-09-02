// Import directly from file to avoid pulling in server-side dependencies via index.js
export {
  PROVIDER_MODELS,
  getProviderModels,
  getDefaultModel,
  isValidModel as isValidModelCore,
  findModelName,
  getModelTargetFormat,
  PROVIDER_ID_TO_ALIAS,
  getModelsByProviderId,
} from "@omniroute/open-sse/config/providerModels.ts";
export {
  setProviderAliasOverrides,
  getRawProviderAliasOverrides,
  resetProviderAliasOverrides,
} from "@omniroute/open-sse/config/providerAliasOverrides.ts";

import {
  AI_PROVIDERS,
  isAnthropicCompatibleProvider,
  isOpenAICompatibleProvider,
} from "./providers";
import {
  PROVIDER_MODELS as MODELS,
  PROVIDER_ID_TO_ALIAS,
} from "@omniroute/open-sse/config/providerModels.ts";

// Providers that accept any model (passthrough)
const PASSTHROUGH_PROVIDERS = new Set(
  Object.entries(AI_PROVIDERS)
    .filter(([, p]) => (p as any).passthroughModels)
    .flatMap(([key, provider]) => {
      const alias = (provider as { alias?: unknown }).alias;
      const effectiveAlias = PROVIDER_ID_TO_ALIAS[key] || alias;
      const results = [key];
      if (typeof alias === "string" && alias.length > 0) results.push(alias);
      if (typeof effectiveAlias === "string" && effectiveAlias.length > 0) results.push(effectiveAlias);
      return results;
    })
);

// Wrap isValidModel with passthrough providers
export function isValidModel(aliasOrId: string, modelId: string) {
  if (isOpenAICompatibleProvider(aliasOrId)) return true;
  if (isAnthropicCompatibleProvider(aliasOrId)) return true;
  if (PASSTHROUGH_PROVIDERS.has(aliasOrId)) return true;
  const alias = PROVIDER_ID_TO_ALIAS[aliasOrId] || aliasOrId;
  const models = MODELS[alias] || MODELS[aliasOrId];
  if (!models) return false;
  return models.some((m) => m.id === modelId);
}

// Legacy AI_MODELS for backward compatibility
export const AI_MODELS = Object.entries(MODELS).flatMap(([alias, models]) =>
  models.map((m) => ({ provider: alias, model: m.id, name: m.name }))
);

