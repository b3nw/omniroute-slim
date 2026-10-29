import { getServerLifecyclePhase } from "@/lib/serverLifecycle";
import { observeHealthzEventLoopLag } from "@/lib/healthzLag";
import {
  checkResourcePressureGuard,
  getResourcePressureObservation,
} from "@omniroute/open-sse/utils/resourcePressure.ts";

export const dynamic = "force-dynamic";

const HEALTH_BODIES = {
  ready: "ok\n",
  starting: "starting\n",
  stopping: "stopping\n",
} as const;

const UNHEALTHY_PRESSURE_BODY = "unhealthy: resource_pressure\n";

/**
 * Pure in-memory resource-pressure probe (no DB / network, #10311). Only consults
 * the guard when the cached observation is already critical; the guard itself
 * attempts a debounced emergency GC + cache evictors and re-measures the live heap,
 * so a recoverable spike reports healthy instead of tripping a container restart.
 */
function isUnderCriticalResourcePressure(): boolean {
  try {
    if (getResourcePressureObservation().state.severity !== "critical") return false;
    return checkResourcePressureGuard() !== null;
  } catch {
    return false;
  }
}

function createHealthResponse(method: "GET" | "HEAD"): Response {
  const phase = getServerLifecyclePhase();
  const unhealthy = phase === "ready" && isUnderCriticalResourcePressure();
  const body = unhealthy ? UNHEALTHY_PRESSURE_BODY : HEALTH_BODIES[phase];

  return new Response(method === "HEAD" ? null : body, {
    status: phase === "ready" && !unhealthy ? 200 : 503,
    headers: {
      "Cache-Control": "no-store",
      "Content-Length": String(body.length),
      "Content-Type": "text/plain; charset=utf-8",
    },
  });
}

export function GET(): Response {
  observeHealthzEventLoopLag();
  return createHealthResponse("GET");
}

export function HEAD(): Response {
  return createHealthResponse("HEAD");
}
