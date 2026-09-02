/**
 * Pure merge of registry / synced / custom model rows for the provider detail
 * dashboard (and thus Test All targets). Cursor exclusive listing prefers the
 * live synced catalog when non-empty.
 */

import { ensureCursorAutoCatalogEntry } from "@/lib/providerModels/cursorAutoCatalog";
import { mergeModelsWithCustomPrecedence } from "@/lib/providers/modelMetadataPrecedence";
import {
  providerUsesCuratedModelsOnly,
  providerUsesExclusiveSyncedListing,
} from "@/lib/providers/modelListingCapability";

export type ProviderListingModel = {
  id: string;
  name?: string;
  source?: string;
  [key: string]: unknown;
};

export type MergeProviderModelListingInput = {
  providerId: string;
  registryModels: Array<{ id: string; name?: string }>;
  syncedModels: Array<{ id: string; name?: string; [key: string]: unknown }>;
  customModels: Array<{ id: string; name?: string; source?: string; [key: string]: unknown }>;
  usesCuratedModelsOnly?: boolean;
};

function normalizeCustomSource(source: unknown): "imported" | "custom" {
  return source === "imported" ? "imported" : "custom";
}

function dedupeById(models: ProviderListingModel[]): ProviderListingModel[] {
  const deduped = new Map<string, ProviderListingModel>();
  for (const m of models) {
    if (m.id && !deduped.has(m.id)) deduped.set(m.id, m);
  }
  return Array.from(deduped.values());
}

export function mergeProviderModelListing(
  input: MergeProviderModelListingInput
): ProviderListingModel[] {
  const curated =
    input.usesCuratedModelsOnly === true || providerUsesCuratedModelsOnly(input.providerId);
  const synced = curated ? [] : input.syncedModels.filter((m) => m?.id);
  const custom = curated ? [] : input.customModels.filter((m) => m?.id);

  const exclusive = providerUsesExclusiveSyncedListing(input.providerId) && synced.length > 0;

  if (exclusive) {
    const withAuto = ensureCursorAutoCatalogEntry(
      synced.map((model) => ({
        ...model,
        id: model.id,
        name: model.name || model.id,
        owned_by: "cursor",
        source: "imported",
      }))
    );
    const normalizedCustom = custom.map((model) => ({
      ...model,
      id: model.id,
      name: model.name || model.id,
      source: normalizeCustomSource(model.source),
    }));
    return dedupeById(mergeModelsWithCustomPrecedence(withAuto, normalizedCustom));
  }

  // #12093: once a provider has a live synced catalog, a static registry entry the
  // sync did NOT return is a different beast from a built-in the sync confirmed —
  // it is only routable because #9217 preserves un-synced static models in
  // `/v1/models`. Badge it `static` ("Static Registry") so the operator can find
  // those rows and toggle them off. With no sync at all every row is static, so
  // the plain "Built-in" badge stays (no signal to add).
  const syncedIds = new Set(synced.map((model) => model.id));
  const builtInModels = input.registryModels.map((model) => ({
    ...model,
    source: syncedIds.size > 0 && !syncedIds.has(model.id) ? "static" : "system",
  }));
  const registryIds = new Set(builtInModels.map((model) => model.id));
  const syncedExtras = synced
    .filter((model) => model.id && !registryIds.has(model.id))
    .map((model) => ({
      ...model,
      id: model.id,
      name: model.name || model.id,
      source: "imported",
    }));
  const normalizedCustom = custom.map((model) => ({
    ...model,
    id: model.id,
    name: model.name || model.id,
    source: normalizeCustomSource(model.source),
  }));

  return dedupeById(
    mergeModelsWithCustomPrecedence([...builtInModels, ...syncedExtras], normalizedCustom)
  );
}
