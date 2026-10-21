import { createHash } from "node:crypto";

import type { ResolvedComboTarget } from "./types.ts";

type NativeTurnPin = {
  comboName: string;
  modelStr: string;
  provider: string;
  connectionId: string;
  createdAt: number;
  expiresAt: number;
};

const TTL_MS = 45 * 60_000;
const MAX_PINS = 1_000;
const pins = new Map<string, NativeTurnPin>();

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function turnMetadata(body: Record<string, unknown>): Record<string, unknown> | undefined {
  const metadata = record(body.client_metadata);
  const raw = metadata?.["x-codex-turn-metadata"];
  if (typeof raw === "string") {
    try {
      return record(JSON.parse(raw));
    } catch {
      return undefined;
    }
  }
  return record(raw);
}

export function nativeCodexTurnKey(
  body: Record<string, unknown>,
  comboName: string
): string | null {
  const metadata = turnMetadata(body);
  const threadId = typeof metadata?.thread_id === "string" ? metadata.thread_id : "";
  const turnId = typeof metadata?.turn_id === "string" ? metadata.turn_id : "";
  if (!threadId || !turnId) return null;
  return createHash("sha256").update(JSON.stringify({ comboName, threadId, turnId })).digest("hex");
}

function prune(now = Date.now()): void {
  for (const [key, pin] of pins) if (pin.expiresAt <= now) pins.delete(key);
  while (pins.size > MAX_PINS) {
    const oldest = pins.keys().next().value as string | undefined;
    if (!oldest) break;
    pins.delete(oldest);
  }
}

export function getNativeCodexTurnPin(
  body: Record<string, unknown>,
  comboName: string
): NativeTurnPin | null {
  prune();
  const key = nativeCodexTurnKey(body, comboName);
  return key ? (pins.get(key) ?? null) : null;
}

export function pinNativeCodexTurn(args: {
  body: Record<string, unknown>;
  comboName: string;
  target: ResolvedComboTarget;
  connectionId: string;
}): void {
  const key = nativeCodexTurnKey(args.body, args.comboName);
  if (!key || !args.connectionId) return;
  const existing = pins.get(key);
  if (
    existing &&
    (existing.modelStr !== args.target.modelStr || existing.provider !== args.target.provider)
  ) {
    throw new Error("Native Codex turn target changed after output was emitted");
  }
  // ConnectionId changes are allowed (failover to sibling connection)
  // as long as provider + model stay the same.
  const now = Date.now();
  pins.set(key, {
    comboName: args.comboName,
    modelStr: args.target.modelStr,
    provider: args.target.provider,
    connectionId: args.connectionId,
    createdAt: existing?.createdAt ?? now,
    expiresAt: now + TTL_MS,
  });
  prune(now);
}

/**
 * Apply a native Codex turn pin to the target list.
 *
 * Returns all compatible targets (same provider + model) with the pinned
 * connection preferred first. This allows fill-first failover: if the
 * pinned connection is rejected by a pre-dispatch gate, the combo engine
 * tries the next compatible connection instead of returning 503.
 *
 * Provider + model remain locked for the turn — only the connection
 * can fall over.
 */
export function applyNativeCodexTurnPin(
  targets: ResolvedComboTarget[],
  pin: NativeTurnPin,
  activeConnectionIds?: string[]
): ResolvedComboTarget[] {
  const compatible = targets
    .filter(
      (candidate) => candidate.modelStr === pin.modelStr && candidate.provider === pin.provider
    )
    .flatMap((target) => {
      if (target.connectionId || !activeConnectionIds?.length) return [target];
      const eligible = activeConnectionIds.filter(
        (id) => !target.allowedConnectionIds?.length || target.allowedConnectionIds.includes(id)
      );
      return eligible.length
        ? eligible.map((connectionId) => ({
            ...target,
            connectionId,
            executionKey: `${target.executionKey}@${connectionId}`,
          }))
        : [target];
    });
  if (compatible.length === 0) return [];

  // Affinity only reorders the CURRENT eligible pool. Replacing its first
  // candidate with a missing pin resurrects a disabled/removed account and
  // discards a healthy sibling. Dynamic targets expand from the current active
  // pool so per-account model locks and same-model fallback remain visible.
  const pinnedIndex = compatible.findIndex((t) => t.connectionId === pin.connectionId);
  const allowedConnectionIds = compatible
    .map((t) => t.connectionId)
    .filter((id): id is string => id !== null);

  // Pinned connection first, then same-provider/model siblings as fallback
  const ordered =
    pinnedIndex < 0
      ? compatible
      : [compatible[pinnedIndex], ...compatible.filter((_, i) => i !== pinnedIndex)];

  return ordered.map((target) =>
    target.connectionId && !target.allowedConnectionIds?.length
      ? { ...target, allowedConnectionIds }
      : target
  );
}

export function revokeNativeCodexTurnPinsForConnection(connectionId: string): number {
  let revoked = 0;
  for (const [key, pin] of pins) {
    if (pin.connectionId !== connectionId) continue;
    pins.delete(key);
    revoked += 1;
  }
  return revoked;
}

export function clearNativeCodexTurnPinsForTests(): void {
  pins.clear();
}
