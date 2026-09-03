/**
 * Provider-neutral conversation projection types.
 *
 * Shared by the request-log and conversation viewers. Previously these lived
 * in the traffic-inspector module; only the normalization-facing shapes are
 * kept here, so the log viewers no longer depend on capture-specific types.
 */

export type NormalizedBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; tool_use_id: string; content: unknown };

export interface NormalizedTurn {
  role: "system" | "user" | "assistant" | "tool";
  blocks: NormalizedBlock[];
  /** call_logs.id that produced this turn, when a caller has one to attach
   * (e.g. linking a turn back to its source request) — absent for a plain
   * single-request normalization. */
  sourceCallLogId?: string;
  /** ISO timestamp of the call_logs row that produced this turn — same
   * scoping as sourceCallLogId. */
  timestamp?: string;
}

/**
 * Minimal response shape `buildResponseTurns` needs. Any record carrying a
 * response body plus its headers satisfies it.
 */
export interface ConversationResponsePayload {
  responseHeaders: Record<string, string>;
  responseBody: string | null;
}
