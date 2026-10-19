/**
 * Vendor-slug-aware hidden-model matching.
 *
 * Passthrough aggregators (Kilo Code, OpenRouter, …) list models under a vendor
 * namespace (`anthropic/claude-fable-5`), so the provider-detail eye toggle stores
 * the hidden flag under that qualified id. Alias-backed catalog rows and alias
 * targets, however, may carry only the bare tail (`kc/claude-fable-5` →
 * `claude-fable-5`). An exact Set lookup misses that pairing and the hidden model
 * leaks into `/v1/models` (and fans out into Claude effort variants).
 *
 * Matching rules for a provider's hidden set:
 *  a) exact id match;
 *  b) a vendor-qualified id (`v/t`) matches a hidden bare tail `t`. When `t` was
 *     explicitly hidden (registered by `buildHiddenModelSet`) it always matches.
 *     Otherwise `t` may be a tail derived from a *different* vendor's `u/t`; if the
 *     set holds any such `u/t`, `t` must not hide `v/t` (cross-vendor collision guard);
 *  c) a bare id (`t`) matches any hidden vendor-qualified `x/t`.
 * An id with its own explicit "visible" entry (registered by `buildHiddenModelSet`)
 * is never hidden by the b/c bridges — the user's explicit choice wins.
 */

/** Last `/`-separated segment of a model id (the id itself when it has no slash). */
export function modelSlugTail(modelId: string): string {
  const slash = modelId.lastIndexOf("/");
  return slash >= 0 ? modelId.slice(slash + 1) : modelId;
}

// Per-set index: tail → vendor-qualified hidden ids carrying that tail. Built once
// per Set instance (catalog builds reuse one map for thousands of lookups).
const tailIndexCache = new WeakMap<ReadonlySet<string>, Map<string, string[]>>();
// Ids explicitly marked visible for the provider a hidden set was built for.
const explicitVisibleBySet = new WeakMap<ReadonlySet<string>, ReadonlySet<string>>();
// Bare ids explicitly hidden (not derived from a qualified sibling) for that set.
const explicitHiddenTailsBySet = new WeakMap<ReadonlySet<string>, ReadonlySet<string>>();

function getTailIndex(hiddenSet: ReadonlySet<string>): Map<string, string[]> {
  let index = tailIndexCache.get(hiddenSet);
  if (index) return index;
  index = new Map<string, string[]>();
  for (const id of hiddenSet) {
    if (!id.includes("/")) continue;
    const tail = modelSlugTail(id);
    if (!tail) continue;
    const list = index.get(tail);
    if (list) list.push(id);
    else index.set(tail, [id]);
  }
  tailIndexCache.set(hiddenSet, index);
  return index;
}

/** Whether `modelId` is hidden under `hiddenSet`, bridging vendor-qualified ↔ bare slugs. */
export function isHiddenModelMatch(
  hiddenSet: ReadonlySet<string> | null | undefined,
  modelId: string
): boolean {
  if (!hiddenSet || hiddenSet.size === 0 || !modelId) return false;
  if (hiddenSet.has(modelId)) return true;
  if (explicitVisibleBySet.get(hiddenSet)?.has(modelId)) return false;

  const index = getTailIndex(hiddenSet);
  if (modelId.includes("/")) {
    const tail = modelSlugTail(modelId);
    if (!tail || !hiddenSet.has(tail)) return false;
    // An explicitly hidden bare tail hides every vendor's `x/<tail>`.
    if (explicitHiddenTailsBySet.get(hiddenSet)?.has(tail)) return true;
    // Possibly derived tail: `modelId` itself is not in the set (checked above), so
    // any qualified entry with this tail belongs to another vendor → ambiguous.
    return (index.get(tail)?.length ?? 0) === 0;
  }
  return index.has(modelId);
}

/**
 * Expand a provider's explicit visibility map (model id → isHidden) into its hidden
 * set: every explicitly hidden id, plus the bare tail of each hidden vendor-qualified
 * id — unless that tail carries its own explicit visibility entry, which wins.
 */
export function buildHiddenModelSet(visibility: ReadonlyMap<string, boolean>): Set<string> {
  const hidden = new Set<string>();
  const explicitVisible = new Set<string>();
  const explicitHiddenTails = new Set<string>();
  for (const [modelId, isHidden] of visibility) {
    if (!isHidden) {
      explicitVisible.add(modelId);
      continue;
    }
    hidden.add(modelId);
    if (modelId.includes("/")) {
      const tail = modelSlugTail(modelId);
      if (tail && !visibility.has(tail)) hidden.add(tail);
    } else {
      explicitHiddenTails.add(modelId);
    }
  }
  if (explicitVisible.size > 0) explicitVisibleBySet.set(hidden, explicitVisible);
  if (explicitHiddenTails.size > 0) explicitHiddenTailsBySet.set(hidden, explicitHiddenTails);
  return hidden;
}
