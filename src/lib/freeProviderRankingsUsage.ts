/**
 * freeProviderRankingsUsage.ts — Pure presentation helper for the usage
 * reliability shown on the Free Provider Rankings page.
 *
 * Split out of `freeProviderRankings.ts` for the same reason as
 * `freeProviderRankingsAuthType.ts`: that module imports DB-touching code at
 * module scope, so a client component can only take types from it. This
 * module has zero imports beyond a shared type.
 *
 * The helper stays locale-free on purpose — it decides *what* is honest to
 * show, the component decides how to word it.
 */

import type { ProviderUsage } from "./freeProviderRankings";

export type UsageTone = "good" | "fair" | "poor" | "unknown";

export interface UsageDisplay {
  /**
   * `none`      — the provider served nothing in the window, or usage was not requested.
   * `insufficient` — it served too few calls for a rate to mean anything.
   * `rate`      — a success rate can be stated.
   */
  kind: "none" | "insufficient" | "rate";
  /** Success rate in percent, rounded; `null` for every kind but `rate`. */
  percent: number | null;
  requests: number;
  successes: number;
  windowHours: number;
  tone: UsageTone;
}

const EMPTY: UsageDisplay = {
  kind: "none",
  percent: null,
  requests: 0,
  successes: 0,
  windowHours: 0,
  tone: "unknown",
};

/**
 * A provider that answers every call with an error must not read as healthy,
 * and a provider nobody called must not read as broken. Anything the sample is
 * too small to support comes back as `insufficient`, never as a rate — the API
 * already refuses to compute one below its own threshold (`successRate: null`).
 */
export function formatUsageReliability(usage?: ProviderUsage): UsageDisplay {
  if (!usage) return EMPTY;

  const { requests, successes, windowHours, successRate } = usage;

  if (successRate === null) {
    return {
      kind: requests > 0 ? "insufficient" : "none",
      percent: null,
      requests,
      successes,
      windowHours,
      tone: "unknown",
    };
  }

  const percent = Math.round(successRate * 100);
  return {
    kind: "rate",
    percent,
    requests,
    successes,
    windowHours,
    tone: successRate >= 0.95 ? "good" : successRate >= 0.8 ? "fair" : "poor",
  };
}

/** Tailwind text colour per tone, mirroring the score colours already on the page. */
export function usageToneClass(tone: UsageTone): string {
  switch (tone) {
    case "good":
      return "text-green-400";
    case "fair":
      return "text-yellow-400";
    case "poor":
      return "text-orange-400";
    default:
      return "text-text-muted";
  }
}
