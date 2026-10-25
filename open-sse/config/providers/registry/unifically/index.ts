import type { RegistryEntry } from "../../shared.ts";
import { buildOpenAiCompatibleRegistryEntry } from "../../shared.ts";

/** Unifically OpenAI-compatible inference gateway. */
export const unificallyProvider: RegistryEntry = buildOpenAiCompatibleRegistryEntry({
  id: "unifically",
  alias: "unifically",
  baseUrl: "https://api.unifically.com/v1/chat/completions",
  modelsUrl: "https://api.unifically.com/v1/models?category=llm",
  models: [],
  passthroughModels: true,
});
