/**
 * quota/quotaGroupWindows.ts — DB-aware builder for the quota-cutoff scope.
 *
 * The cutoff evaluator itself (`open-sse/services/quotaCutoffScope.ts`) is pure:
 * it decides WHICH windows to compare given the request identity plus the quota
 * facts of the group's member connections. This module is the thin DB layer that
 * resolves that identity and collects those facts:
 *
 *   `qtSd/<groupSlug>/<provider>/<model>`  (src/lib/quota/quotaModelNaming.ts)
 *        → quota_groups row whose slugified name matches <groupSlug>
 *        → quota_pools of that group (quota_pools.group_id)
 *        → member connection ids
 *        → each member's cached per-window quota facts (src/domain/quotaCache.ts)
 *
 * Member facts come from the in-memory quota cache only — never an upstream
 * fetch. Preflight already pays for one upstream call on the selected
 * connection; fanning out N more on the hot path is not acceptable, and a group
 * member with no cached facts simply contributes nothing (fail-open).
 *
 * Only members of the SAME provider are aggregated: a group may hold pools of
 * different providers, whose upstream quotas are unrelated and must never be
 * mixed into one comparison.
 */

import {
  isAntigravityLikeProvider,
  resolveQuotaCutoffIdentity,
  type QuotaCutoffScope,
  type QuotaCutoffWindow,
} from "@omniroute/open-sse/services/quotaCutoffScope.ts";
import { getQuotaCache } from "@/domain/quotaCache";
import { listGroups } from "@/lib/db/quotaGroups";
import { getPoolsByGroup } from "@/lib/db/quotaPools";
import { getCachedProviderConnectionById } from "@/lib/db/readCache";
import { quotaGroupSlug } from "./quotaModelNaming";

/** Resolve a group slug (from a `qtSd/...` model name) back to its group id. */
function findGroupIdBySlug(groupSlug: string): string | null {
  let groups: ReturnType<typeof listGroups>;
  try {
    groups = listGroups();
  } catch {
    return null;
  }
  for (const group of groups) {
    if (quotaGroupSlug(group.name) === groupSlug) return group.id;
  }
  return null;
}

/** Member connection ids of every pool in the group, excluding `selfConnectionId`. */
function groupMemberConnectionIds(groupId: string, selfConnectionId?: string | null): string[] {
  let pools: ReturnType<typeof getPoolsByGroup>;
  try {
    pools = getPoolsByGroup(groupId);
  } catch {
    return [];
  }
  const ids = new Set<string>();
  for (const pool of pools) {
    const poolConnectionIds =
      Array.isArray(pool.connectionIds) && pool.connectionIds.length > 0
        ? pool.connectionIds
        : [pool.connectionId];
    for (const connectionId of poolConnectionIds) {
      if (!connectionId || connectionId === selfConnectionId) continue;
      ids.add(connectionId);
    }
  }
  return [...ids];
}

/**
 * Convert a cached quota entry into the structural window map the evaluator
 * consumes. Windows whose fraction upstream never reported (#10095) are skipped
 * — a defaulted 0% must not be read as genuine exhaustion.
 */
function cachedWindowsForConnection(connectionId: string): Record<string, QuotaCutoffWindow> {
  const entry = getQuotaCache(connectionId);
  if (!entry?.quotas) return {};
  const windows: Record<string, QuotaCutoffWindow> = {};
  for (const [windowName, quota] of Object.entries(entry.quotas)) {
    if (!quota || quota.fractionReported === false) continue;
    const remainingPercentage = Number(quota.remainingPercentage);
    if (!Number.isFinite(remainingPercentage)) continue;
    windows[windowName] = {
      percentUsed: Math.max(0, Math.min(1, (100 - remainingPercentage) / 100)),
      resetAt: quota.resetAt ?? null,
    };
  }
  return windows;
}

/**
 * Build the group/family cutoff scope for one (provider, connection, model)
 * request. Returns `undefined` when the request maps to neither a quota group
 * nor a provider family — callers then keep the raw per-window comparison.
 *
 * `groupSlugHint` lets a caller supply an identity it already resolved from
 * something other than the model name (the combo path passes the combo name,
 * which for quota-share combos IS the `qtSd/...` virtual model name).
 */
export async function buildQuotaCutoffScope(
  provider: string,
  requestedModel: string | null | undefined,
  selfConnectionId?: string | null,
  groupSlugHint?: string | null
): Promise<QuotaCutoffScope | undefined> {
  const identity = resolveQuotaCutoffIdentity({
    provider,
    requestedModel,
    groupSlug: groupSlugHint,
  });
  const hasFamily = isAntigravityLikeProvider(identity.provider);
  if (!identity.groupSlug && !hasFamily) return undefined;

  const scope: QuotaCutoffScope = {
    provider: identity.provider || provider,
    requestedModel: identity.model,
    groupSlug: identity.groupSlug,
  };
  if (!identity.groupSlug) return scope;

  const groupId = findGroupIdBySlug(identity.groupSlug);
  if (!groupId) return scope;

  const memberWindows: Array<Record<string, QuotaCutoffWindow>> = [];
  for (const memberId of groupMemberConnectionIds(groupId, selfConnectionId)) {
    let memberProvider: string | undefined;
    try {
      const connection = (await getCachedProviderConnectionById(memberId)) as
        Record<string, unknown> | undefined;
      memberProvider = typeof connection?.provider === "string" ? connection.provider : undefined;
    } catch {
      continue;
    }
    // Different provider in the same group → unrelated upstream quota, skip.
    if (!memberProvider || memberProvider !== scope.provider) continue;
    const windows = cachedWindowsForConnection(memberId);
    if (Object.keys(windows).length > 0) memberWindows.push(windows);
  }

  return memberWindows.length > 0 ? { ...scope, memberWindows } : scope;
}
