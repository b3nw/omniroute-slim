type EvalRoutingLogger = {
  info?: (...args: unknown[]) => void;
  warn?: (...args: unknown[]) => void;
  debug?: (...args: unknown[]) => void;
};

type EvalRoutingTarget = {
  modelStr: string;
};

type EvalRoutingConfig = {
  enabled?: boolean;
  suiteIds?: string[];
  maxAgeHours?: number;
  minCases?: number;
  qualityWeight?: number;
  latencyWeight?: number;
  cacheTtlMs?: number;
};

export function orderTargetsByEvalScores<T extends EvalRoutingTarget>(
  targets: T[],
  _config?: EvalRoutingConfig | null,
  _log?: EvalRoutingLogger
): T[] {
  return targets;
}

export function resetEvalRoutingCache(): void {
  // no-op: evals subsystem excised in OmniRoute-Slim
}
