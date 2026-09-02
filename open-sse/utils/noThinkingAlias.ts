/**
 * No-thinking gateway model IDs (free-claude-code port, Fase 8.1).
 *
 * Some clients — most notably Claude Code — always attach a `thinking` block to
 * certain Claude models and offer no UI to turn it off. To let an operator force a
 * thinking-capable model into a no-thinking mode purely by *model selection*, the
 * gateway exposes a synthetic catalog id:
 *
 *     no-think/<provider>/<model>
 *
 * When such an id arrives on a request we strip the prefix back to the real
 * `<provider>/<model>` and suppress reasoning (`thinking:{type:"disabled"}` for the
 * Claude/Messages path; `reasoning_effort:"none"` for the OpenAI path — #6879: a
 * thinks-by-default OpenAI-shape model left with no reasoning field at all keeps
 * thinking with its provider default, so the alias must express "none" rather than
 * merely deleting the field. The `reasoning` object is still dropped, since a
 * Responses-shaped client's `reasoning:{...}` cannot itself express "none" and the
 * translator promotes `reasoning_effort` into it downstream when absent).
 * The existing `normalizeThinkingForModel()` still runs downstream, so models that
 * reject `disabled` are handled exactly as before, and the per-lane
 * unsupported-param strip (open-sse/translator/paramSupport.ts) still removes
 * `reasoning_effort` for lanes known to reject it, falling back to today's
 * delete-only behavior for those.
 *
 * Catalog visibility is gated (see `shouldExposeNoThinkingAlias`): we only advertise
 * the variant for Claude-family models that actually support thinking AND honor
 * `disabled` — advertising it for a model that ignores suppression would be a lie.
 * An explicit registry override (`ModelSpec.noThinkingAlias`) wins over the default.
 *
 * Above both of those sits the `NO_THINKING_ALIAS_ENABLED` DB feature flag (default
 * on) — a global master switch an operator can flip from the dashboard feature-flags
 * page. Its resolved value is *injected* here as `featureEnabled`, never read from
 * the DB by this module: like `ccDiscoveryAliasStrip.ts` and `appendCcDiscoveryAliases`,
 * these helpers stay I/O-free so the branch logic remains testable without a DB, and
 * so the catalog build pays exactly one flag read per request instead of one per model.
 * The `src/` call sites own the read (`isNoThinkingAliasEnabled()` in
 * `src/shared/utils/featureFlags.ts`): `src/app/api/v1/models/catalogResponse.ts` for
 * the catalog, `src/sse/handlers/chat.ts` for dispatch. Omitting the option keeps the
 * feature on, matching the flag default.
 */
import { getModelSpec } from "@/shared/constants/modelSpecs";

export const NO_THINKING_PREFIX = "no-think/";

// Ids that already carry a Claude reasoning-effort suffix (see
// claudeEffortVariants.ts's identical constant) — a no-think variant of an effort
// variant would combine two independent OmniRoute catalog conventions on the same
// id. Dispatch-time, applyNoThinkingAlias pre-sets reasoning_effort:"none" before
// applyClaudeEffortVariant's hasExplicitClaudeEffort() check runs, so the pre-set
// "none" is treated as explicit and the suffix's implied effort is silently
// discarded — semantically incoherent, so never advertise the combination.
const CLAUDE_EFFORT_SUFFIX_RE = /-(?:xhigh|high|medium|low)$/i;

/** True when `modelId` carries the no-thinking gateway prefix. */
export function isNoThinkingAlias(modelId: unknown): modelId is string {
  return typeof modelId === "string" && modelId.startsWith(NO_THINKING_PREFIX);
}

/** Remove the gateway prefix, returning the real `<provider>/<model>` (plain ids pass through). */
export function stripNoThinkingAlias(modelId: string): string {
  return isNoThinkingAlias(modelId) ? modelId.slice(NO_THINKING_PREFIX.length) : modelId;
}

/** Wrap a real qualified model id in the no-thinking gateway prefix. */
export function toNoThinkingAlias(qualifiedModelId: string): string {
  return `${NO_THINKING_PREFIX}${qualifiedModelId}`;
}

interface ApplyResult {
  applied: boolean;
  realModel?: string;
}

/**
 * Request-side hook: if `body.model` is a no-thinking alias, rewrite it to the real
 * model and suppress reasoning in place. No-op (and body untouched) otherwise.
 *
 * `opts.featureEnabled === false` (the `NO_THINKING_ALIAS_ENABLED` flag turned off by
 * an operator) makes this a no-op even for an alias id: the body keeps the literal
 * `no-think/…` model, so downstream resolution treats it exactly like any other
 * unknown model id — the feature behaves as if it did not exist. Omitting the option
 * leaves the feature on.
 */
export function applyNoThinkingAlias(
  body: Record<string, unknown> | null | undefined,
  opts: { claudeFormat?: boolean; featureEnabled?: boolean } = {}
): ApplyResult {
  if (!body || typeof body !== "object") return { applied: false };
  const model = body.model;
  if (!isNoThinkingAlias(model)) return { applied: false };
  if (opts.featureEnabled === false) return { applied: false }; // master switch off

  const realModel = stripNoThinkingAlias(model);
  if (!realModel) return { applied: false }; // malformed: nothing after the prefix

  body.model = realModel;
  if (opts.claudeFormat === true) {
    body.thinking = { type: "disabled" };
    delete body.reasoning_effort;
  } else {
    // #6879: express "none" instead of deleting, so a thinks-by-default model
    // actually stops thinking instead of falling back to its provider default.
    // Lanes that reject reasoning_effort are still cleaned up downstream by the
    // per-lane unsupported-param strip (paramSupport.ts), which removes it just
    // like it would have been removed here — same end state, correct on more lanes.
    body.reasoning_effort = "none";
  }
  delete body.reasoning;
  return { applied: true, realModel };
}

interface CatalogModelEntry {
  id?: unknown;
  owned_by?: unknown;
  name?: unknown;
  [key: string]: unknown;
}

/** Strip a `<provider>/` prefix to get the bare model name for spec lookup. */
function bareModelName(id: string): string {
  const slash = id.lastIndexOf("/");
  return slash >= 0 ? id.slice(slash + 1) : id;
}

/**
 * Whether the catalog should advertise a no-thinking variant for this entry.
 *
 * Default rule: Claude-family model that supports thinking and does NOT reject
 * `thinking:{type:"disabled"}`. An explicit `ModelSpec.noThinkingAlias` boolean
 * overrides the default in either direction (operator opt-in / opt-out).
 *
 * `opts.featureEnabled === false` (the `NO_THINKING_ALIAS_ENABLED` master switch off)
 * rejects everything, including a model whose spec opted in explicitly — the global
 * flag layers ABOVE the per-model override, it does not compete with it.
 */
export function shouldExposeNoThinkingAlias(
  model: CatalogModelEntry,
  opts: { featureEnabled?: boolean } = {}
): boolean {
  if (opts.featureEnabled === false) return false; // master switch off
  if (!model || typeof model !== "object") return false;
  const id = model.id;
  if (typeof id !== "string" || id.length === 0) return false;
  if (model.owned_by === "combo") return false; // combos are virtual
  if (isNoThinkingAlias(id)) return false; // never double-alias
  if (CLAUDE_EFFORT_SUFFIX_RE.test(id)) return false; // never combine with an effort-suffix id

  const name = bareModelName(id);
  const spec = getModelSpec(name);
  if (!spec) return false;

  if (spec.noThinkingAlias === true) return true;
  if (spec.noThinkingAlias === false) return false;

  return (
    spec.supportsThinking === true && spec.rejectsThinkingDisabled !== true && /claude/i.test(name)
  );
}

/**
 * Normalize the provider prefix inside a qualified model id using an alias→canonical map.
 * e.g. "cc/claude-opus-4-6" → "claude/claude-opus-4-6" when aliasToCanonical["cc"]="claude".
 * Ids without a "/" or whose prefix is not in the map are returned unchanged.
 */
function normalizeProviderPrefix(
  qualifiedId: string,
  aliasToCanonical: Record<string, string>
): string {
  const slash = qualifiedId.indexOf("/");
  if (slash < 0) return qualifiedId;
  const prefix = qualifiedId.slice(0, slash);
  const canonical = aliasToCanonical[prefix];
  return canonical && canonical !== prefix
    ? `${canonical}${qualifiedId.slice(slash)}`
    : qualifiedId;
}

/**
 * Append a no-thinking variant for every eligible model. Returns the original array
 * reference unchanged when nothing is eligible (no allocation in the common case).
 *
 * @param aliasToCanonical - When provided, the inner provider prefix of each variant id is
 *   normalized to its canonical form (e.g. "cc" → "claude"). Pass this when the catalog is
 *   emitting canonical-prefixed ids so no-think variants stay consistent with the prefix mode.
 * @param opts.featureEnabled - Resolved `NO_THINKING_ALIAS_ENABLED` flag value. `false`
 *   returns `models` untouched (nothing advertised); omitted keeps the feature on.
 */
export function appendNoThinkingVariants<T extends CatalogModelEntry>(
  models: T[],
  aliasToCanonical?: Record<string, string>,
  opts: { featureEnabled?: boolean } = {}
): T[] {
  if (!Array.isArray(models)) return models;
  // Master switch resolved once by the caller: advertise nothing at all.
  if (opts.featureEnabled === false) return models;
  const variants: T[] = [];
  for (const model of models) {
    if (!shouldExposeNoThinkingAlias(model, opts)) continue;
    const rawId = model.id as string;
    const qualifiedId = aliasToCanonical ? normalizeProviderPrefix(rawId, aliasToCanonical) : rawId;
    const aliasId = toNoThinkingAlias(qualifiedId);
    const bareRoot = toNoThinkingAlias(bareModelName(qualifiedId));
    const variant: T = { ...model, id: aliasId, root: bareRoot };
    if (typeof model.name === "string" && model.name) {
      variant.name = `${model.name} (no thinking)`;
    }
    variants.push(variant);
  }
  return variants.length > 0 ? [...models, ...variants] : models;
}
