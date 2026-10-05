/**
 * Proxy Health Check Scheduler
 *
 * Periodically tests all proxy registry entries and automatically
 * removes (or soft-disables) proxies that have been failing consecutively.
 *
 * Config via environment:
 *   PROXY_HEALTH_INTERVAL_MS  — sweep interval (default: 600000 = 10min)
 *   PROXY_HEALTH_ENABLED      — set "false" to disable
 *   PROXY_AUTO_REMOVE         — set "true" to auto-remove dead proxies (destructive)
 *   PROXY_AUTO_DISABLE        — set "true" to auto-disable dead proxies instead of
 *                               deleting them (status → "dead", already excluded from
 *                               pool/rotation resolution by PROXY_ALIVE_PREDICATE). The
 *                               row is never deleted, and the same recovery check that
 *                               re-activates proxies for PROXY_AUTO_REMOVE flips it back
 *                               to "active" once it starts answering probes again — no
 *                               manual re-add needed. If both flags are set, auto-remove
 *                               wins (see decision.ts).
 *   PROXY_AUTO_REMOVE_AFTER   — consecutive failures before the action above fires
 *                               (default: 3). Shared by both PROXY_AUTO_REMOVE and
 *                               PROXY_AUTO_DISABLE — they are alternative actions at the
 *                               same threshold, not independently tunable.
 */

import { deleteProxyById, listProxies, updateProxy } from "@/lib/db/proxies";
import { isProxyLogIncludeIps } from "@/lib/proxyLogger";
import {
  getRecentEgressSharingSummary,
  type EgressSharingSummary,
  type EgressSharingWarning,
} from "@/lib/proxyEgress";
import {
  createProxyDispatcher,
  clearDispatcherCache,
  proxyConfigToUrl,
} from "@omniroute/open-sse/utils/proxyDispatcher";
import { fetch as undiciFetch } from "undici";
import {
  applyCrossProbeEvidence,
  buildTargetEvidenceMap,
  classifyProbeStatus,
  decideProxyHealthAction,
  type ProxyProbeOutcome,
} from "./decision.ts";
import {
  resolveProbeConcurrency,
  resolveProbeStaggerMs,
  resolveProbeTarget,
  waitForProbeSlot,
} from "./probeTarget.ts";
import { resolveProviderProbeTarget } from "./providerProbeTarget.ts";

// #6246: a HEAD to the public probe target through a legit (often loaded) proxy
// can exceed a few seconds; the old 5s ceiling produced false negatives that
// flipped healthy proxies to inactive. Raise it and treat our own timeout as
// inconclusive (see testOneProxy) rather than a proxy failure.
const TEST_TIMEOUT_MS = 15000;
// Probe target, batch size and intra-batch spacing come from probeTarget.ts, which the
// auto-test endpoint reads too — one surface to tune instead of two that can drift apart.
// Resolved at module load, as these constants always were.
const TEST_URL = resolveProbeTarget();
const CONCURRENCY = resolveProbeConcurrency();
const STAGGER_MS = resolveProbeStaggerMs();
const INITIAL_DELAY_MS = 60_000;
const DEFAULT_INTERVAL_MS = 600_000;
const DEFAULT_REMOVE_AFTER = 3;
const LOG_PREFIX = "[ProxyHealth]";

declare global {
  var __proxyHealthInterval: ReturnType<typeof setInterval> | undefined;
  var __proxyHealthConsecutiveFailures: Map<string, number> | undefined;
}

function getFailureMap(): Map<string, number> {
  if (!globalThis.__proxyHealthConsecutiveFailures) {
    globalThis.__proxyHealthConsecutiveFailures = new Map();
  }
  return globalThis.__proxyHealthConsecutiveFailures;
}

/**
 * PURE: one-line anonymous egress-sharing summary for the sweep log (#10677).
 * Counts only by default; raw shared IPs only when PROXY_LOG_INCLUDE_IPS=true
 * (the redaction decision from #10348 — never leak IPs or account labels).
 */
export function formatEgressSharingSummaryLine(
  summary: EgressSharingSummary,
  warnings: EgressSharingWarning[],
  includeDetails: boolean
): string {
  const base =
    `${LOG_PREFIX} egress: ${summary.sharingByRotationGroup.length} rotation group(s) share an ` +
    `egress IP (max ${summary.maxAccountsSharingOneIp} accounts)`;
  if (!includeDetails) return base;
  const detail = warnings
    .map((w) => `${w.rotationGroup}: ${w.egressIp} (${w.connections.length} accounts)`)
    .join(", ");
  return detail ? `${base} — ${detail}` : base;
}

/**
 * Answered-target evidence of the immediately previous sweep generation:
 * URL → true when at least one probe received any HTTP status. Replaced
 * wholesale at the end of every sweep (never merged) so a silent generation
 * drops stale proof — an absent URL is no proof (no ghost evidence, no clock).
 */
const priorAnsweredTargetEvidence = new Map<string, boolean>();
const MAX_TARGET_EVIDENCE_ENTRIES = 100;

/** Test-only: forget the previous-generation target evidence. */
export function __resetTargetEvidenceForTesting(): void {
  priorAnsweredTargetEvidence.clear();
}

interface CollectedProbe {
  id: string;
  proxy: { id: string };
  outcome: ProxyProbeOutcome;
  status: number | null;
  target: string | null;
}

interface DecisionContext {
  failureMap: Map<string, number>;
  removeAfter: number;
  autoRemove: boolean;
  autoDisable: boolean;
}

/** Phase 1 of the sweep: probe every proxy in batches, decide nothing yet. */
async function collectProbeResults<P extends { id: string }>(
  proxies: P[],
  probe: (proxy: P) => Promise<CollectedProbe>
): Promise<CollectedProbe[]> {
  const collected: CollectedProbe[] = [];
  for (let i = 0; i < proxies.length; i += CONCURRENCY) {
    const batch = proxies.slice(i, i + CONCURRENCY);
    const results = await Promise.allSettled(
      batch.map(async (proxy, indexInBatch) => {
        // Spread the departures: without this the whole batch leaves at the same tick and a
        // shared egress IP hits the target with CONCURRENCY simultaneous requests.
        await waitForProbeSlot(indexInBatch, STAGGER_MS);
        return probe(proxy);
      })
    );
    for (const result of results) {
      if (result.status !== "fulfilled") continue;
      collected.push(result.value);
    }
  }
  return collected;
}

/** Refresh the previous-generation evidence wholesale (never merged). */
function refreshTargetEvidence(collected: CollectedProbe[]): void {
  priorAnsweredTargetEvidence.clear();
  for (const [target, answered] of buildTargetEvidenceMap(collected)) {
    if (priorAnsweredTargetEvidence.size >= MAX_TARGET_EVIDENCE_ENTRIES) break;
    priorAnsweredTargetEvidence.set(target, answered);
  }
}

export interface SweepTally {
  tested: number;
  alive: number;
  inconclusive: number;
  blocked: number;
  removed: number;
  disabled: number;
  promoted: number;
}

/** Phase 2 of the sweep: apply cross-proxy evidence, then decide per proxy. */
async function decideCollectedResults(
  collected: CollectedProbe[],
  ctx: DecisionContext
): Promise<SweepTally> {
  const tally: SweepTally = {
    tested: 0,
    alive: 0,
    inconclusive: 0,
    blocked: 0,
    removed: 0,
    disabled: 0,
    promoted: 0,
  };
  const evidenced = applyCrossProbeEvidence(collected, priorAnsweredTargetEvidence);
  for (let i = 0; i < collected.length; i++) {
    const wasPromoted = evidenced[i].outcome !== collected[i].outcome;
    if (wasPromoted) tally.promoted++;
    await decideOneResult(
      collected[i],
      { ...collected[i], ...evidenced[i] },
      wasPromoted,
      ctx,
      tally
    );
  }
  return tally;
}

export type CollectedProbeForTesting = CollectedProbe;

/** Test-only: run one per-proxy decision with injected raw/final verdicts. */
export async function __decideOneResultForTesting(
  raw: CollectedProbeForTesting,
  final: CollectedProbeForTesting,
  wasPromoted: boolean,
  ctx: DecisionContext,
  tally: SweepTally
): Promise<void> {
  return decideOneResult(raw, final, wasPromoted, ctx, tally);
}

async function decideOneResult(
  raw: CollectedProbe,
  _final: CollectedProbe,
  _wasPromoted: boolean,
  ctx: DecisionContext,
  tally: SweepTally
): Promise<void> {
  const { id, outcome: rawOutcome } = raw;
  tally.tested++;
  if (rawOutcome === "ok") tally.alive++;
  else if (rawOutcome === "inconclusive") tally.inconclusive++;
  else if (rawOutcome === "blocked") tally.blocked++;

  // The status/removal decision and the tally follow the RAW verdict: a promoted
  // fail never counts toward the removal streak. Upstream feeds a promoted fail
  // (`_final`/`_wasPromoted`) into the proxy set-aside memory, a subsystem Slim
  // does not carry, so promotion is observational here (sweep log only).
  const decision = decideProxyHealthAction({
    outcome: rawOutcome,
    priorFailures: ctx.failureMap.get(id) ?? 0,
    autoRemove: ctx.autoRemove,
    autoDisable: ctx.autoDisable,
    removeAfter: ctx.removeAfter,
  });

  if (decision.clearFailures) ctx.failureMap.delete(id);
  else ctx.failureMap.set(id, decision.failures);

  // #6246 (policy C) / auto-disable (policy D): only mutate the operator-owned
  // status when the decision explicitly asks for it. With both flags off,
  // setStatus is null, so a transient probe failure never flips a healthy
  // proxy's status.
  if (decision.setStatus) {
    await updateProxy(id, { status: decision.setStatus }).catch(() => {});
    if (decision.setStatus === "dead") tally.disabled++;
  }

  if (decision.remove) {
    if (await deleteProxyById(id, { force: true }).catch(() => false)) {
      ctx.failureMap.delete(id);
      tally.removed++;
      try {
        clearDispatcherCache();
      } catch {
        /* non-critical */
      }
    }
  }
}

function isEnabled(): boolean {
  return process.env.PROXY_HEALTH_ENABLED !== "false";
}

function getIntervalMs(): number {
  const raw = parseInt(process.env.PROXY_HEALTH_INTERVAL_MS ?? "", 10);
  return Number.isFinite(raw) && raw >= 60_000 ? raw : DEFAULT_INTERVAL_MS;
}

function isAutoRemoveEnabled(): boolean {
  return process.env.PROXY_AUTO_REMOVE === "true";
}

function isAutoDisableEnabled(): boolean {
  return process.env.PROXY_AUTO_DISABLE === "true";
}

function getRemoveAfter(): number {
  const raw = parseInt(process.env.PROXY_AUTO_REMOVE_AFTER ?? "", 10);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_REMOVE_AFTER;
}

function isBuildProcess(): boolean {
  return typeof process !== "undefined" && process.env.NEXT_PHASE === "phase-production-build";
}

function isBackgroundServicesDisabled(): boolean {
  const raw = process.env.OMNIROUTE_DISABLE_BACKGROUND_SERVICES;
  if (!raw) return false;
  return ["1", "true", "yes", "on"].includes(raw.trim().toLowerCase());
}

/**
 * Reachability probe for one proxy, classified so the pure
 * decision layer can apply the #6246 policy:
 *   - "ok"           — the proxy relayed and the target served the request.
 *   - "blocked"      — the proxy relayed, but the TARGET refused this egress IP
 *                      (401/403/429). Neutral like "inconclusive": the proxy is
 *                      not at fault, yet it is not serving that destination.
 *   - "inconclusive" — NOT the proxy's fault: our own timeout/abort, or the probe
 *                      TARGET returned a 5xx (the proxy connected fine). Never
 *                      penalizes the proxy.
 *   - "fail"         — a proxy-level connection error (refused/unreachable/TLS).
 */
export interface ProxyProbeResult {
  outcome: ProxyProbeOutcome;
  /** HTTP status when the target answered; null on connection-level errors. */
  status: number | null;
  /** URL actually probed (generic or provider-resolved); null when config invalid. */
  target: string | null;
}

async function testOneProxy(proxy: {
  id: string;
  type: string;
  host: string;
  port: number;
  username?: string;
  password?: string;
  family?: string;
}): Promise<ProxyProbeResult> {
  let proxyUrl: string | null;
  try {
    proxyUrl = proxyConfigToUrl(proxy);
  } catch {
    proxyUrl = null;
  }
  if (!proxyUrl) return { outcome: "fail", status: null, target: null };
  // A provider's models endpoint is a real GET-only API surface, unlike httpbin.org/ip: many
  // reject HEAD outright. HEAD stays the default for the generic target — this changes nothing
  // for a proxy with no eligible provider assignment.
  const providerTarget = await resolveProviderProbeTarget(proxy.id);
  const target = providerTarget ?? TEST_URL;
  const method = providerTarget ? "GET" : "HEAD";
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TEST_TIMEOUT_MS);
  try {
    const dispatcher = createProxyDispatcher(proxyUrl);
    const resp = await undiciFetch(target, {
      method,
      signal: controller.signal,
      dispatcher,
      headers: { "User-Agent": "OmniRoute/1.0" },
    });
    return { outcome: classifyProbeStatus(resp.status), status: resp.status, target };
  } catch {
    // Our own deadline elapsed → inconclusive (slow, not necessarily dead).
    if (controller.signal.aborted) return { outcome: "inconclusive", status: null, target };
    // A provider-resolved target's connection health is not proven the way the
    // operator-configured generic target is: a registry baseUrl can be a placeholder that
    // never resolves for anyone (e.g. databricks's default azuredatabricks.net host is
    // literally 16 zeros). A connection failure there says nothing about this proxy —
    // same principle as the 5xx case above, extended to connection-level errors.
    return providerTarget
      ? { outcome: "inconclusive", status: null, target }
      : { outcome: "fail", status: null, target };
  } finally {
    clearTimeout(timeout);
  }
}

async function sweep(): Promise<void> {
  // #10677: anonymous egress-sharing signal from persisted proxy_logs (no live
  // probes). Logged only when sharing exists — the sweep line is a warning
  // signal, not a heartbeat. Runs before the empty-registry early return so
  // sharing from direct connections is still reported when no proxies are
  // configured. Never let a DB hiccup suppress the completion line or fail the
  // sweep itself.
  try {
    const { summary, warnings } = await getRecentEgressSharingSummary();
    if (summary.sharingByRotationGroup.length > 0) {
      console.log(formatEgressSharingSummaryLine(summary, warnings, isProxyLogIncludeIps()));
    }
  } catch (error) {
    console.error(`${LOG_PREFIX} Egress summary skipped:`, error);
  }

  const { items: proxies } = await listProxies({ includeSecrets: true });
  if (proxies.length === 0) return;

  const failureMap = getFailureMap();
  const removeAfter = getRemoveAfter();
  const autoRemove = isAutoRemoveEnabled();
  const autoDisable = isAutoDisableEnabled();

  // Phase 1 — collect raw probe results across all batches WITHOUT deciding
  // (cross-proxy evidence requires every response of the target first).
  const collected = await collectProbeResults(proxies, async (proxy) => {
    const { outcome, status, target } = await testOneProxy(proxy);
    return { id: proxy.id, proxy, outcome, status, target };
  });

  // Phase 2 — lift the abstention only where proof exists (same sweep or the
  // immediately previous generation), then decide per proxy. Received HTTP
  // statuses are never reclassified — only status-less `inconclusive` probes
  // can become `fail`. The current sweep's answered targets then replace the
  // previous generation wholesale (never merged).
  const { tested, alive, inconclusive, blocked, removed, disabled, promoted } =
    await decideCollectedResults(collected, { failureMap, removeAfter, autoRemove, autoDisable });
  refreshTargetEvidence(collected);

  console.log(
    `${LOG_PREFIX} Sweep complete: ${tested} tested, ${alive} alive, ` +
      `${blocked} blocked by target, ${inconclusive} inconclusive, ${promoted} promoted, ` +
      `${removed} auto-removed, ${disabled} auto-disabled`
  );
}

function scheduleSweep(): void {
  const interval = getIntervalMs();
  globalThis.__proxyHealthInterval = setInterval(() => {
    void sweep().catch((err) => {
      console.error(`${LOG_PREFIX} Sweep error:`, err);
    });
  }, interval);
}

export function initProxyHealthCheck(): void {
  if (!isEnabled() || isBuildProcess() || isBackgroundServicesDisabled()) return;
  if (globalThis.__proxyHealthInterval) return;

  setTimeout(() => {
    console.log(`${LOG_PREFIX} Starting proxy health scheduler (interval: ${getIntervalMs()}ms)`);
    void sweep().catch(() => {});
    scheduleSweep();
  }, INITIAL_DELAY_MS);
}

export function stopProxyHealthCheck(): void {
  if (globalThis.__proxyHealthInterval) {
    clearInterval(globalThis.__proxyHealthInterval);
    globalThis.__proxyHealthInterval = undefined;
  }
}

export async function forceProxyHealthSweep(): Promise<void> {
  await sweep();
}

// Auto-initialize on first import
initProxyHealthCheck();
