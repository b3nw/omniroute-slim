type AliasMap = Record<string, string>;

export function getDefaultModelAliasBase(modelId: string): string {
  const trimmed = modelId.trim();
  if (!trimmed) return "";

  const segments = trimmed
    .split("/")
    .map((segment) => segment.trim())
    .filter(Boolean);
  return segments[segments.length - 1] || trimmed;
}

export function resolveManagedModelAlias({
  modelId,
  fullModel,
  providerDisplayAlias,
  existingAliases,
}: {
  modelId: string;
  fullModel: string;
  providerDisplayAlias: string;
  existingAliases: AliasMap;
}): string | null {
  const baseAlias = getDefaultModelAliasBase(modelId);
  if (!baseAlias) return null;

  for (const [alias, value] of Object.entries(existingAliases)) {
    if (value === fullModel) return alias;
  }

  const displayAlias = providerDisplayAlias.trim();
  const candidates: string[] = [];
  const seen = new Set<string>();
  const pushCandidate = (candidate: string) => {
    const trimmed = candidate.trim();
    if (!trimmed || seen.has(trimmed)) return;
    seen.add(trimmed);
    candidates.push(trimmed);
  };

  pushCandidate(baseAlias);
  if (displayAlias) {
    pushCandidate(`${displayAlias}-${baseAlias}`);
  }

  for (const candidate of candidates) {
    if (!(candidate in existingAliases) || existingAliases[candidate] === fullModel) {
      return candidate;
    }
  }

  for (let suffix = 2; suffix <= 5000; suffix += 1) {
    if (displayAlias) {
      const prefixed = `${displayAlias}-${baseAlias}-${suffix}`;
      if (!(prefixed in existingAliases) || existingAliases[prefixed] === fullModel) {
        return prefixed;
      }
    }

    const fallback = `${baseAlias}-${suffix}`;
    if (!(fallback in existingAliases) || existingAliases[fallback] === fullModel) {
      return fallback;
    }
  }

  return null;
}

/**
 * Build the `<providerAlias>/<modelId>` alias target stored by the provider-detail
 * page. Only a leading provider prefix (`<providerAlias>/` or `<providerId>/`) is
 * stripped before re-qualifying — vendor namespaces on passthrough aggregators
 * (`anthropic/claude-fable-5` on Kilo Code / OpenRouter) are part of the upstream
 * model id and must survive, otherwise the alias target no longer matches the id
 * the visibility toggle stored (`kc/claude-fable-5` vs `anthropic/claude-fable-5`).
 */
export function buildQualifiedAliasTarget(
  modelId: string,
  providerAlias?: string,
  providerId?: string
): string {
  if (!providerAlias) return modelId;
  for (const prefix of [providerAlias, providerId]) {
    if (prefix && modelId.startsWith(`${prefix}/`)) {
      return `${providerAlias}/${modelId.slice(prefix.length + 1)}`;
    }
  }
  return `${providerAlias}/${modelId}`;
}
