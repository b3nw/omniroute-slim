/**
 * Circuit-breaker pre-dispatch helpers shared by the combo gate and the
 * terminal "every target is cooling down" response (#14530, #14949).
 *
 * Upstream keeps these in its split `combo/executeTargetGates.ts`; Slim's combo
 * dispatcher is still the single `combo.ts`, so they live in this leaf.
 */
import {
  getCircuitBreaker,
  type CircuitBreakerStatus,
} from "../../../src/shared/utils/circuitBreaker";
import { connectionCircuitBreakerName } from "../connectionCircuitBreaker.ts";
import { parseModel } from "../model.ts";
import type { PreDispatchExclusion } from "./pinRecovery.ts";
import type { ResolvedComboTarget } from "./types.ts";

/**
 * The breaker that keeps a target from being dispatched: the provider-wide one
 * first, then the connection-scoped one. Null when neither is OPEN. Shared by the
 * pre-dispatch gate and by the terminal response, so both read the same rule.
 */
export function findOpenCircuitBreaker(
  provider: string,
  connectionId?: string | null
): { scope: "provider" | "connection"; status: CircuitBreakerStatus } | null {
  const providerStatus = getCircuitBreaker(provider).getStatus();
  if (providerStatus.state === "OPEN") return { scope: "provider", status: providerStatus };
  if (!connectionId) return null;
  const connectionStatus = getCircuitBreaker(
    connectionCircuitBreakerName(provider, connectionId)
  ).getStatus();
  return connectionStatus.state === "OPEN"
    ? { scope: "connection", status: connectionStatus }
    : null;
}

/**
 * When every target was skipped because its breaker is OPEN, describe each one
 * (provider, model, time until the next probe) so the terminal response can say
 * so instead of a generic pre-dispatch skip. Null as soon as one target is not
 * behind an open breaker: a mixed pool keeps the generic response.
 */
export function collectCircuitOpenExclusions(
  targets: readonly ResolvedComboTarget[]
): PreDispatchExclusion[] | null {
  if (targets.length === 0) return null;
  const exclusions: PreDispatchExclusion[] = [];
  for (const target of targets) {
    if (!target.provider) return null;
    const open = findOpenCircuitBreaker(target.provider, target.connectionId);
    if (!open) return null;
    exclusions.push({
      provider: target.provider,
      model: parseModel(target.modelStr).model || target.modelStr,
      reason: "circuit_open",
      retryAfterMs: open.status.retryAfterMs > 0 ? open.status.retryAfterMs : null,
    });
  }
  return exclusions;
}
