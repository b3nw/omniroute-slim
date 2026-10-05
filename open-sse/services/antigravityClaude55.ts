// Claude 5.5 on Antigravity / agy (Cloud Code `v1internal:streamGenerateContent`).
//
// Claude 5.5 is served on the same Cloud Code hosts as Gemini, but differs from the
// Claude 4.x generation in three ways that the shared Antigravity path must honor:
//
// 1. Tiered model ids. The upstream only accepts explicit `-low` / `-medium` / `-high`
//    ids; the bare id is a client convenience that resolves to a tier.
// 2. Thinking is steered by `generationConfig.thinkingConfig.thinkingLevel` (1/2/3),
//    not the Gemini-style `thinkingBudget`, and must NOT be stripped.
// 3. Thinking blocks replayed in history must carry the Claude 5.5 protobuf signature
//    (base64 `CAQS…`, or double-wrapped `Q0FR…`). An unsigned `thought: true` part is
//    forwarded to Anthropic as a `thinking` block without a signature and rejected with
//    400 `messages.N.content.0.thinking.signature: Field required` (Antigravity-Manager
//    #3587 / #3593).

export const ANTIGRAVITY_CLAUDE_55_MAX_OUTPUT_TOKENS = 128_000;
export const ANTIGRAVITY_CLAUDE_55_CONTEXT_LENGTH = 1_000_000;
/** Model-scoped cooldown for an account that lacks the paid Claude 5.5 entitlement. */
export const ANTIGRAVITY_CLAUDE_55_ENTITLEMENT_COOLDOWN_MS = 900_000;

export type Claude55Tier = "low" | "medium" | "high";
export type Claude55ThinkingLevel = 1 | 2 | 3;

const TIER_TO_LEVEL: Record<Claude55Tier, Claude55ThinkingLevel> = {
  low: 1,
  medium: 2,
  high: 3,
};
const LEVEL_TO_TIER: Record<Claude55ThinkingLevel, Claude55Tier> = {
  1: "low",
  2: "medium",
  3: "high",
};

/**
 * Upstream metadata for the tiered ids, from the Antigravity Hub traffic captures.
 * Kept out of the public catalog so the registry model shape stays uniform.
 */
export const ANTIGRAVITY_CLAUDE_55_MODEL_METADATA: Readonly<
  Record<string, { internalModelId: string; vertexModelId: string }>
> = Object.freeze({
  "claude-opus-5-5-low": {
    internalModelId: "MODEL_PLACEHOLDER_M400",
    vertexModelId: "claude-opus-5-5@default",
  },
  "claude-opus-5-5-medium": {
    internalModelId: "MODEL_PLACEHOLDER_M401",
    vertexModelId: "claude-opus-5-5@default",
  },
  "claude-opus-5-5-high": {
    internalModelId: "MODEL_PLACEHOLDER_M402",
    vertexModelId: "claude-opus-5-5@default",
  },
  "claude-sonnet-5-5-low": {
    internalModelId: "MODEL_PLACEHOLDER_M403",
    vertexModelId: "claude-sonnet-5-5@default",
  },
  "claude-sonnet-5-5-medium": {
    internalModelId: "MODEL_PLACEHOLDER_M404",
    vertexModelId: "claude-sonnet-5-5@default",
  },
  "claude-sonnet-5-5-high": {
    internalModelId: "MODEL_PLACEHOLDER_M405",
    vertexModelId: "claude-sonnet-5-5@default",
  },
});

// `-thinking` is a legacy client alias for the Medium tier (see ANTIGRAVITY_MODEL_ALIASES).
const CLAUDE_55_MODEL_RE = /^claude-(opus|sonnet)-5[-.]5(?:-(low|medium|high|thinking))?$/i;
const PROVIDER_PREFIX_RE = /^(?:models\/|antigravity\/|agy\/)+/i;

function normalizeModelId(model: unknown): string {
  if (typeof model !== "string") return "";
  const trimmed = model.trim().replace(PROVIDER_PREFIX_RE, "");
  return trimmed.includes("/") ? trimmed.split("/").pop() || "" : trimmed;
}

/**
 * True for any Claude 5.5 id (bare, dotted, tiered, or `-thinking`), with or without a
 * provider prefix.
 */
export function isAntigravityClaude55Model(model: unknown): boolean {
  return CLAUDE_55_MODEL_RE.test(normalizeModelId(model));
}

/**
 * The explicit tier suffix of a Claude 5.5 id (`-thinking` → medium), or null for a bare
 * id / non-5.5 model.
 */
export function getClaude55TierFromModel(model: unknown): Claude55Tier | null {
  const match = CLAUDE_55_MODEL_RE.exec(normalizeModelId(model));
  if (!match?.[2]) return null;
  const suffix = match[2].toLowerCase();
  return suffix === "thinking" ? "medium" : (suffix as Claude55Tier);
}

/** OpenAI `reasoning_effort` → tier. Unknown / "none" efforts return null. */
export function getClaude55TierFromEffort(effort: unknown): Claude55Tier | null {
  if (typeof effort !== "string") return null;
  switch (effort.trim().toLowerCase()) {
    case "minimal":
    case "low":
      return "low";
    case "medium":
      return "medium";
    case "high":
    case "xhigh":
    case "max":
    case "auto":
      return "high";
    default:
      return null;
  }
}

export function claude55TierToThinkingLevel(tier: Claude55Tier): Claude55ThinkingLevel {
  return TIER_TO_LEVEL[tier];
}

export function claude55ThinkingLevelToTier(level: unknown): Claude55Tier | null {
  const n = Number(level);
  return n === 1 || n === 2 || n === 3 ? LEVEL_TO_TIER[n] : null;
}

/**
 * Resolve the tier for a Claude 5.5 request. An explicit model suffix always wins (the
 * upstream id and thinkingLevel must agree); a bare id falls back to `reasoning_effort`,
 * then to medium.
 */
export function resolveClaude55Tier(model: unknown, reasoningEffort?: unknown): Claude55Tier {
  return getClaude55TierFromModel(model) ?? getClaude55TierFromEffort(reasoningEffort) ?? "medium";
}

/** The tiered upstream id for a Claude 5.5 model, e.g. `claude-opus-5-5` + high → `-high`. */
export function toClaude55TieredModelId(model: unknown, tier: Claude55Tier): string {
  const match = CLAUDE_55_MODEL_RE.exec(normalizeModelId(model));
  if (!match) return normalizeModelId(model);
  return `claude-${match[1].toLowerCase()}-5-5-${tier}`;
}

/**
 * The tier a Claude 5.5 request is actually dispatched at: the requested id's explicit
 * suffix, then the body's `thinkingLevel` (already chosen by the translator), then
 * `reasoning_effort`, then the aliased id's suffix, then medium. Shared by the executor
 * and chatCore's entitlement lockout so the locked id is the one the upstream denied.
 */
export function resolveClaude55DispatchTier(
  model: unknown,
  body: unknown,
  aliasedModel?: unknown
): Claude55Tier {
  const bodyRecord = asRecord(body);
  const thinkingConfig = asRecord(
    asRecord(asRecord(bodyRecord?.request)?.generationConfig)?.thinkingConfig
  );
  return (
    getClaude55TierFromModel(model) ??
    claude55ThinkingLevelToTier(thinkingConfig?.thinkingLevel) ??
    getClaude55TierFromEffort(bodyRecord?.reasoning_effort) ??
    getClaude55TierFromModel(aliasedModel) ??
    "medium"
  );
}

/**
 * Canonical model-lock id for a Claude 5.5 model: bare, dotted and `-thinking` aliases
 * collapse to the tier they alias to (`-medium`, as in ANTIGRAVITY_MODEL_ALIASES) and
 * provider prefixes are dropped, so a lock recorded or queried under any spelling hits
 * the same key. Non-5.5 models are returned unchanged.
 */
export function toClaude55LockModelId(model: string): string {
  if (!isAntigravityClaude55Model(model)) return model;
  return toClaude55TieredModelId(model, getClaude55TierFromModel(model) ?? "medium");
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

// ── Signature recognition ────────────────────────────────────────────────────

const BASE64_RE = /^[A-Za-z0-9+/_-]+={0,2}$/;
const MAX_SIGNATURE_DECODE_DEPTH = 4;
// Shortest plausible signature: the 3 tag bytes plus at least a 3-byte payload.
const MIN_SIGNATURE_LENGTH = 8;

/**
 * Recognize a Claude 5.5 thinking signature. The native form is a protobuf message whose
 * wire bytes open with `0x08 0x04 0x12` (field 1 varint = 4, field 2 length-delimited),
 * which base64-encodes to the `CAQS` prefix. Some clients wrap it in one or more extra
 * base64 layers; one layer surfaces as a `Q0FR` prefix (base64 of the ASCII text `CAQ`).
 */
export function isClaude55Signature(sig: unknown): boolean {
  if (typeof sig !== "string") return false;
  let current = sig.trim();
  for (let depth = 0; depth < MAX_SIGNATURE_DECODE_DEPTH; depth++) {
    if (current.length < MIN_SIGNATURE_LENGTH || !BASE64_RE.test(current)) return false;
    if (current.startsWith("CAQS")) {
      const bytes = Buffer.from(current, "base64");
      return bytes.length > 3 && bytes[0] === 0x08 && bytes[1] === 0x04 && bytes[2] === 0x12;
    }
    // `Q0FR` is the one-layer wrap; deeper wraps change the prefix (`UTBG…`), so peel
    // any layer whose decoded content is itself base64 text and test again.
    const decoded = Buffer.from(current, "base64").toString("latin1").trim();
    if (decoded === current || !BASE64_RE.test(decoded)) return false;
    current = decoded;
  }
  return false;
}

/** Wrap unsigned reasoning as plain text so it is never forwarded as a `thinking` block. */
export function wrapUnsignedThinkingAsText(text: string): string {
  return `<think>\n${text}\n</think>`;
}

const SIGNATURE_400_PATTERNS: RegExp[] = [
  /thinking\.signature/i,
  /invalid\s+[`'"]?signature[`'"]?\s+in\s+[`'"]?thinking[`'"]?\s+block/i,
];

/** True when an upstream 400 body is the Anthropic missing/invalid thinking-signature error. */
export function isThinkingSignature400(status: number, errorText: unknown): boolean {
  if (status !== 400 || typeof errorText !== "string" || !errorText) return false;
  return SIGNATURE_400_PATTERNS.some((pattern) => pattern.test(errorText));
}

type CloudCodePart = Record<string, unknown>;

const SIGNATURE_BYPASS_SENTINEL = "skip_thought_signature_validator";

/**
 * Normalize one Cloud Code content's parts for a Claude 5.5 request:
 *  - thought parts carrying a valid Claude 5.5 signature are kept verbatim;
 *  - unsigned / foreign-signed thought parts are downgraded to `<think>` text;
 *  - a foreign signature on a plain text part is dropped (the text is kept);
 *  - functionCall parts are left untouched (bypass sentinel / real signatures).
 *
 * With `forceDowngrade` (the 400 circuit-breaker retry) every thought part becomes
 * text and every non-functionCall signature is removed, regardless of validity.
 */
export function guardClaude55ThinkingParts(
  parts: CloudCodePart[],
  options: { forceDowngrade?: boolean } = {}
): CloudCodePart[] {
  const out: CloudCodePart[] = [];
  for (const part of parts) {
    if (!part || typeof part !== "object") continue;
    if (part.functionCall) {
      if (options.forceDowngrade && part.thoughtSignature !== undefined) {
        const { thoughtSignature: _sig, ...rest } = part;
        out.push(
          process.env.ANTIGRAVITY_ALLOW_SIGNATURE_BYPASS === "0"
            ? rest
            : { ...rest, thoughtSignature: SIGNATURE_BYPASS_SENTINEL }
        );
      } else {
        out.push(part);
      }
      continue;
    }

    const signature = part.thoughtSignature ?? part.thought_signature;
    const signed = !options.forceDowngrade && isClaude55Signature(signature);

    if (part.thought === true) {
      if (signed) {
        out.push(part);
        continue;
      }
      const {
        thought: _thought,
        thoughtSignature: _sig,
        thought_signature: _sigSnake,
        ...rest
      } = part;
      if (typeof part.text === "string" && part.text.trim()) {
        out.push({ ...rest, text: wrapUnsignedThinkingAsText(part.text) });
      }
      continue;
    }

    if (signature !== undefined && !signed) {
      const { thoughtSignature: _sig, thought_signature: _sigSnake, ...rest } = part;
      if (Object.keys(rest).length > 0) out.push(rest);
      continue;
    }
    out.push(part);
  }
  return out;
}

/** Apply {@link guardClaude55ThinkingParts} across a Cloud Code `contents` array. */
export function guardClaude55Contents<T extends { parts?: unknown }>(
  contents: T[],
  options: { forceDowngrade?: boolean } = {}
): T[] {
  return contents
    .map((content) => {
      if (!Array.isArray(content?.parts)) return content;
      return {
        ...content,
        parts: guardClaude55ThinkingParts(content.parts as CloudCodePart[], options),
      };
    })
    .filter((content) => !Array.isArray(content?.parts) || content.parts.length > 0);
}

/**
 * Build the Claude 5.5 thinking config. `thinkingBudget` is intentionally absent —
 * the Cloud Code Claude 5.5 endpoint is steered only by `thinkingLevel`.
 */
export function buildClaude55ThinkingConfig(tier: Claude55Tier): {
  thinkingLevel: Claude55ThinkingLevel;
  includeThoughts: boolean;
} {
  return { thinkingLevel: claude55TierToThinkingLevel(tier), includeThoughts: true };
}

/** Extract a client-replayed thinking signature from an OpenAI-format assistant message. */
export function extractAssistantReasoningSignature(msg: Record<string, unknown>): string | null {
  const direct = [
    msg.reasoning_signature,
    msg.thinking_signature,
    msg.thought_signature,
    msg.thoughtSignature,
  ].find((value) => typeof value === "string" && value.length > 0);
  if (typeof direct === "string") return direct;

  const candidates: unknown[] = [];
  if (Array.isArray(msg.reasoning_details)) candidates.push(...msg.reasoning_details);
  if (Array.isArray(msg.content)) candidates.push(...msg.content);
  for (const item of candidates) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const type = typeof record.type === "string" ? record.type : "";
    if (type && !/thinking|reasoning/i.test(type)) continue;
    const sig = record.signature ?? record.thoughtSignature ?? record.thought_signature;
    if (typeof sig === "string" && sig.length > 0) return sig;
  }
  return null;
}

/**
 * functionCall ids in `contents` that carry a real thoughtSignature (anything but the bypass
 * sentinel). Used after an upstream thinking-signature 400: the rejection says the attached
 * signatures are invalid or stale for this session, so a well-formed Claude 5.5 (`CAQS…`)
 * signature is just as suspect as a foreign one and must be purged from the cache too.
 */
export function collectSignedFunctionCallIds(contents: unknown): string[] {
  if (!Array.isArray(contents)) return [];
  const ids: string[] = [];
  for (const content of contents) {
    const parts = (content as { parts?: unknown })?.parts;
    if (!Array.isArray(parts)) continue;
    for (const part of parts) {
      const record = part as Record<string, unknown> | null;
      const call = record?.functionCall as Record<string, unknown> | undefined;
      if (!call || typeof call.id !== "string" || !call.id) continue;
      const sig = record?.thoughtSignature;
      if (typeof sig !== "string" || !sig) continue;
      if (sig === SIGNATURE_BYPASS_SENTINEL) continue;
      ids.push(call.id);
    }
  }
  return ids;
}
