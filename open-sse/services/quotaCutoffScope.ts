/**
 * quotaCutoffScope.ts — group/family-aware window resolution for quota cutoffs.
 *
 * The per-connection "Quota cutoffs" (minimum remaining % per quota window) used
 * to be evaluated against the RAW window map returned by the provider's quota
 * fetcher (`open-sse/services/quotaPreflight.ts`). That map knows nothing about
 * the two aggregation layers OmniRoute puts on top of a provider quota:
 *
 *   1. **DB quota groups** — `qtSd/<groupSlug>/<provider>/<model>` virtual models
 *      (`src/lib/quota/quotaModelNaming.ts`) fan a request out over every member
 *      connection of a `quota_groups` row. The group is one shared upstream pool,
 *      so the group's headroom is the headroom of its most depleted member — not
 *      the headroom of whichever member happened to be selected first.
 *   2. **Provider families** — Antigravity reports a per-model 5h window plus one
 *      aggregate bucket per model family (`gemini_weekly`, `claude_gpt_weekly`;
 *      `gemini_5h`/`claude_gpt_5h` in deployments that surface the 5h family
 *      bucket). A Gemini request must be judged by the Gemini family bucket, and
 *      must NOT be blocked by an exhausted Claude bucket.
 *
 * This module is the single authoritative resolver for "which windows does the
 * cutoff evaluator compare for THIS request". It is pure (no I/O, no DB): the
 * DB-aware scope builder is `src/lib/quota/quotaGroupWindows.ts`, which feeds the
 * member facts in.
 *
 * ── Aggregation rule (authoritative) ───────────────────────────────────────
 * • When the provider exposes an aggregate window for the resolved family/group
 *   (Antigravity family bucket, or the generic fetcher's canonical
 *   `window5h`/`window7d`), that aggregate window is compared directly.
 * • Otherwise the group's member-connection facts are aggregated per matching
 *   window NAME by taking the MINIMUM remaining percent (= maximum percentUsed)
 *   across the members — block as soon as ANY member is at or below the cutoff.
 * • Percentages are NEVER summed, and windows from unrelated families are never
 *   mixed into the comparison.
 *
 * Providers with neither a group mapping nor a family aggregate keep the raw
 * per-window comparison, byte-for-byte as before.
 */

import { parseQuotaModelName } from "@/lib/quota/quotaModelNaming";
import {
  getAntigravityQuotaFamily,
  type AntigravityQuotaFamily,
} from "./antigravityQuotaFamily.ts";

/** Structural window fact — mirrors `QuotaWindowInfo` in quotaPreflight.ts. */
export interface QuotaCutoffWindow {
  percentUsed: number;
  resetAt?: string | null;
}

/**
 * Structural subset of `QuotaInfo` this resolver reads. Declared locally (rather
 * than imported) so quotaPreflight.ts can depend on this module without a cycle.
 */
export interface QuotaCutoffWindowSource {
  windows?: Record<string, QuotaCutoffWindow>;
  window5h?: QuotaCutoffWindow;
  window7d?: QuotaCutoffWindow;
}

/**
 * Identity of the request the cutoff is being evaluated for. Both cutoff gates
 * — `getProviderCredentialsWithQuotaPreflight` (direct chat path) and
 * `resolveQuotaExhaustionCutoffForTarget` (combo path) — build one of these so
 * the two paths share the exact same evaluator semantics.
 */
export interface QuotaCutoffScope {
  /** Provider slug of the connection being evaluated. */
  provider?: string | null;
  /**
   * Model the caller asked for. May be a `qtSd/<group>/<provider>/<model>`
   * virtual model — the group slug and the real model are parsed out of it.
   */
  requestedModel?: string | null;
  /** Explicit group slug, when the caller resolved it from something else. */
  groupSlug?: string | null;
  /**
   * Per-window facts from the OTHER member connections of the same quota group
   * (same provider only — a group may hold pools of different providers, whose
   * quotas are unrelated). Supplied by `buildQuotaCutoffScope`.
   */
  memberWindows?: ReadonlyArray<Readonly<Record<string, QuotaCutoffWindow>>>;
}

export interface ResolvedQuotaCutoffWindows {
  /** The window map the cutoff evaluator must compare. */
  windows: Record<string, QuotaCutoffWindow>;
  /** True when group/family aggregation changed the raw window map. */
  aggregated: boolean;
  /** Window names contributed by an aggregate (family bucket / canonical / group). */
  aggregateWindowNames: string[];
  /**
   * True when an aggregation layer APPLIES to this request (the model maps to a
   * DB quota group, or the provider exposes family buckets and the model was
   * classified into one) — regardless of whether it actually changed the map.
   *
   * Callers use this to decide whether a whole-connection exhaustion summary
   * (`QuotaInfo.limitReached`) may be honored verbatim: that flag knows nothing
   * about families, so on Antigravity it flips as soon as ANY family bucket is
   * exhausted. Honoring it before scoping would let an exhausted Claude bucket
   * block a Gemini request — exactly the bug the family path removes.
   */
  scoped: boolean;
  /** Family the request was classified into (`null` when not family-scoped). */
  family: AntigravityQuotaFamily | null;
}

/** Antigravity aliases — the family classifier is provider-scoped to these. */
const ANTIGRAVITY_PROVIDERS = new Set(["antigravity", "agy"]);

/**
 * Family aggregate window names Antigravity surfaces, most specific first.
 * `*_weekly` is what `usage/antigravityWeeklyQuota.ts` slugifies today;
 * `*_5h` is the session-window sibling reported by deployments that expose the
 * 5h family bucket. Both are accepted so the evaluator does not depend on which
 * of the two the account's `retrieveUserQuotaSummary` response carries.
 */
const ANTIGRAVITY_FAMILY_AGGREGATE_WINDOWS: Record<"gemini" | "claude", readonly string[]> = {
  gemini: ["gemini_weekly", "gemini_5h"],
  claude: ["claude_gpt_weekly", "claude_gpt_5h"],
};

export function isAntigravityLikeProvider(provider: string | null | undefined): boolean {
  return ANTIGRAVITY_PROVIDERS.has(String(provider || "").toLowerCase());
}

/**
 * Classify a raw window key into the Antigravity model family it belongs to.
 * Returns `null` for keys that are not family-scoped at all (e.g. `credits`),
 * which are left in the comparison set untouched.
 */
export function antigravityWindowFamily(windowName: string): AntigravityQuotaFamily | null {
  const lower = String(windowName || "").toLowerCase();
  if (!lower) return null;
  // Family aggregate buckets: `gemini_weekly`, `claude_gpt_5h`, …
  if (lower.startsWith("gemini_")) return "gemini";
  if (lower.startsWith("claude_gpt")) return "claude";
  if (lower === "credits") return null;
  // Per-model windows are keyed by the model id itself.
  const family = getAntigravityQuotaFamily(windowName);
  return family === "other" ? null : family;
}

export interface QuotaCutoffIdentity {
  provider: string | null;
  /** Real model id, with the `qtSd/<group>/<provider>/` prefix stripped. */
  model: string | null;
  /** Group slug when the request maps to a DB quota group, else null. */
  groupSlug: string | null;
}

/**
 * Resolve provider / model / group identity for a cutoff evaluation. A
 * `qtSd/...` virtual model wins over the caller-supplied provider, because the
 * virtual name carries the authoritative (group, provider, model) triple.
 */
export function resolveQuotaCutoffIdentity(
  scope: QuotaCutoffScope | null | undefined
): QuotaCutoffIdentity {
  if (!scope) return { provider: null, model: null, groupSlug: null };
  const requested = scope.requestedModel ? String(scope.requestedModel) : null;
  const parsed = requested ? parseQuotaModelName(requested) : null;
  return {
    provider: parsed?.provider || scope.provider || null,
    model: parsed?.model || requested,
    groupSlug: scope.groupSlug || parsed?.groupSlug || null,
  };
}

/**
 * Threshold lookup aliases for a window name. The cutoff a user configured on
 * an Antigravity FAMILY bucket also governs that family's per-model windows —
 * otherwise a cutoff typed against `gemini_weekly` silently leaves every
 * `gemini-*` per-model window on the factory default. Order matters: the exact
 * window name is always tried first, so a per-window override still wins.
 */
export function quotaWindowThresholdLookupNames(
  provider: string | null | undefined,
  windowName: string
): string[] {
  const names = [windowName];
  if (isAntigravityLikeProvider(provider)) {
    const family = antigravityWindowFamily(windowName);
    if (family === "gemini" || family === "claude") {
      names.push(...ANTIGRAVITY_FAMILY_AGGREGATE_WINDOWS[family]);
    }
  }
  return [...new Set(names)];
}

/**
 * Merge member-connection window facts into the base map by MINIMUM remaining
 * percent (= maximum percentUsed). Never sums: the group is one shared upstream
 * pool, so its headroom is that of its most depleted member.
 *
 * `family` is the family the request was scoped to (`null` when the provider has
 * no family layer). Member facts are filtered by it BEFORE merging — the member
 * maps come straight out of each sibling's quota cache and carry every family's
 * windows, so an unfiltered merge would re-inject the very cross-family window
 * the family path just dropped (a sibling's exhausted `claude_gpt_weekly`
 * blocking a Gemini group request). Non-family keys (`credits`) still pass.
 */
function mergeGroupMemberWindows(
  base: Record<string, QuotaCutoffWindow>,
  memberWindows: ReadonlyArray<Readonly<Record<string, QuotaCutoffWindow>>>,
  family: AntigravityQuotaFamily | null
): { merged: Record<string, QuotaCutoffWindow>; touched: string[] } {
  const merged: Record<string, QuotaCutoffWindow> = { ...base };
  const touched: string[] = [];
  for (const member of memberWindows) {
    if (!member) continue;
    for (const [name, info] of Object.entries(member)) {
      if (!info || !Number.isFinite(info.percentUsed)) continue;
      if (family) {
        const memberFamily = antigravityWindowFamily(name);
        if (memberFamily !== null && memberFamily !== family) continue;
      }
      const current = merged[name];
      if (current && current.percentUsed >= info.percentUsed) continue;
      merged[name] = { percentUsed: info.percentUsed, resetAt: info.resetAt ?? null };
      touched.push(name);
    }
  }
  return { merged, touched: [...new Set(touched)] };
}

/**
 * Resolve the window map the cutoff evaluator must compare for this request.
 *
 * Returns the raw fetcher windows untouched when the request maps to neither a
 * quota group nor a provider family — that is the pre-existing behavior for
 * every non-group, non-family provider and must stay byte-identical.
 */
export function resolveQuotaCutoffWindows(
  quota: QuotaCutoffWindowSource | null | undefined,
  scope?: QuotaCutoffScope | null
): ResolvedQuotaCutoffWindows {
  const raw = (quota?.windows || {}) as Record<string, QuotaCutoffWindow>;
  const identity = resolveQuotaCutoffIdentity(scope);
  const family = isAntigravityLikeProvider(identity.provider)
    ? antigravityWindowFamily(identity.model || "")
    : null;

  // Neither aggregation layer applies → raw per-window comparison, as before.
  if (!identity.groupSlug && !family) {
    return { windows: raw, aggregated: false, aggregateWindowNames: [], scoped: false, family };
  }

  let windows = raw;
  const aggregateWindowNames: string[] = [];
  let aggregated = false;

  if (family) {
    // Family path — compare the requested family's aggregate bucket plus that
    // family's own per-model windows. Windows belonging to a DIFFERENT family
    // are dropped: an exhausted Claude bucket must not block a Gemini request.
    // Non-family keys (e.g. `credits`) are kept so nothing that used to block
    // silently stops blocking.
    const scopedEntries = Object.entries(raw).filter(([name]) => {
      const windowFamily = antigravityWindowFamily(name);
      return windowFamily === null || windowFamily === family;
    });
    if (scopedEntries.length !== Object.keys(raw).length) aggregated = true;
    windows = Object.fromEntries(scopedEntries);
    for (const name of ANTIGRAVITY_FAMILY_AGGREGATE_WINDOWS[family]) {
      if (name in windows) {
        aggregateWindowNames.push(name);
        aggregated = true;
      }
    }
  } else {
    // Group path on a provider without native family buckets — fold in the
    // fetcher's canonical structural aggregates (`window5h` / `window7d`, see
    // genericQuotaFetcher.ts::normalizeQuotaWindows) so a group request is
    // judged by the aggregate window and not only by provider-native keys.
    const canonical: Array<[string, QuotaCutoffWindow | undefined]> = [
      ["window5h", quota?.window5h],
      ["window7d", quota?.window7d],
    ];
    for (const [name, info] of canonical) {
      if (!info || !Number.isFinite(info.percentUsed) || name in windows) continue;
      windows = { ...windows, [name]: info };
      aggregateWindowNames.push(name);
      aggregated = true;
    }
  }

  // Group path — aggregate the other member connections of the same group.
  if (identity.groupSlug && scope?.memberWindows?.length) {
    const { merged, touched } = mergeGroupMemberWindows(windows, scope.memberWindows, family);
    if (touched.length > 0) {
      windows = merged;
      aggregateWindowNames.push(...touched);
      aggregated = true;
    }
  }

  return {
    windows,
    aggregated,
    aggregateWindowNames: [...new Set(aggregateWindowNames)],
    scoped: true,
    family,
  };
}
