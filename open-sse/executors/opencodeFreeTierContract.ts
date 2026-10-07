/**
 * opencodeFreeTierContract.ts — the request contract OpenCode Zen's free tier enforces.
 *
 * Measured against the live endpoint on 2026-09-17, on three models and both the Chat
 * Completions and Responses surfaces: the upstream answers 403 FreeTierError unless the
 * request carries all four of
 *
 *   1. `stream: true` in the body,
 *   2. a non-empty `tools` array carrying the lowercase quartet `bash`, `glob`, `grep`, `read`,
 *   3. a session header shaped `ses_` + 12 hex + 14 base62 (the shape is checked, the
 *      value is not — 12 arbitrary hex digits pass),
 *   4. a `User-Agent` carrying `opencode/<version>` with version >= 1.17 (an older
 *      version answers 426 UpgradeRequired rather than 403).
 *
 * Removing any single one of the four turns a 200 into a 403. Paid models on the same
 * host are not gated (a paid model without tools answers 401 CreditsError), which is why
 * `requiresFreeTierRequestContract` narrows the contract to free-tier models.
 *
 * The module also owns the free-model catalog — the catalog is what decides whether the
 * contract applies, so the two belong together and the executor imports them from here —
 * and the way back: the forced stream is rebuilt into a JSON body for a caller that asked
 * for JSON, reusing the shared event-stream parsers.
 */
import { parseSSEToOpenAIResponse, parseSSEToResponsesOutput } from "../handlers/sseParser.ts";
import {
  OPENCODE_FINGERPRINT_TOOLS,
  concealFingerprintToolNames,
  fingerprintPlaceholderTool,
  recordRenamedToolNames,
  renamedToolNamesFor,
  retargetToolChoice,
} from "../utils/opencodeFingerprint.ts";

export interface FreeTierContractAttempt {
  readonly provider: string;
  readonly model: string;
  readonly session: string | undefined;
  readonly borrowed: boolean;
  readonly clientToolNames: readonly string[];
  readonly probe?: boolean;
  readonly injectedPlaceholders?: boolean;
}

const OPENCODE_FREE_MODELS = new Set([
  "big-pickle",
  "deepseek-v4-flash-free",
  "mimo-v2.5-free",
  "hy3-free",
  "nemotron-3-ultra-free",
  "north-mini-code-free",
]);

/**
 * Determine whether a model requires an API key on the given opencode provider.
 *
 * - `opencode-go`: ALL models require a key (no free tier).
 * - `opencode` / `opencode-zen`: premium = any model NOT in the free set (known
 *   free models OR ending in `-free`).
 * - Unknown models are assumed premium (fail-safe).
 */
export function isPremiumOpencodeModel(model: string, provider: string): boolean {
  if (provider === "opencode-go") return true;
  if (model.endsWith("-free")) return false;
  return !OPENCODE_FREE_MODELS.has(model);
}

export type OpencodeSurface = "zen" | "go" | "other";

const ZEN_SURFACE_BASE_URL = "https://opencode.ai/zen/v1";
const GO_SURFACE_BASE_URL = "https://opencode.ai/zen/go/v1";

/** Tell the surfaces apart by registry `baseUrl`, so provider ids and aliases stay out. */
export function surfaceFromBaseUrl(baseUrl: string | null | undefined): OpencodeSurface {
  if (baseUrl === ZEN_SURFACE_BASE_URL) return "zen";
  if (baseUrl === GO_SURFACE_BASE_URL) return "go";
  return "other";
}

function isBodyContractEnabled(): boolean {
  return (process.env.OPENCODE_FREE_TIER_REQUEST_CONTRACT || "").trim().toLowerCase() !== "off";
}

export function isGatedFreeTierRequest(
  surface: OpencodeSurface,
  provider: string,
  model: string
): boolean {
  if (surface !== "zen") return false;
  return !isPremiumOpencodeModel(model, provider);
}

export function requiresFreeTierRequestContract(
  surface: OpencodeSurface,
  provider: string,
  model: string
): boolean {
  return isGatedFreeTierRequest(surface, provider, model) && isBodyContractEnabled();
}

const PLACEHOLDER_TOOL_NAMES: readonly string[] = OPENCODE_FINGERPRINT_TOOLS;
export const DEFAULT_PLACEHOLDER_TOOL_NAME = PLACEHOLDER_TOOL_NAMES[0];

export function configuredPlaceholderToolNames(): string[] {
  const raw = process.env.OPENCODE_FREE_TIER_PLACEHOLDER_TOOLS || "";
  const kept: string[] = [];
  for (const part of raw.split(",")) {
    const name = part.trim();
    if (kept.length >= 32) break;
    if (!/^[A-Za-z_][A-Za-z0-9_-]{0,63}$/.test(name)) continue;
    if (!kept.includes(name)) kept.push(name);
  }
  return kept;
}

function clientToolNamesOf(body: unknown): string[] {
  if (!body || typeof body !== "object" || Array.isArray(body)) return [];
  const tools = (body as Record<string, unknown>).tools;
  if (!Array.isArray(tools)) return [];
  const names: string[] = [];
  for (const tool of tools) {
    if (!tool || typeof tool !== "object") continue;
    const entry = tool as { name?: unknown; function?: { name?: unknown } };
    const name = typeof entry.name === "string" ? entry.name : entry.function?.name;
    if (typeof name === "string") names.push(name);
  }
  return names;
}

/**
 * Bring a free-tier request up to the upstream contract, ensuring the lowercase
 * quartet (`bash`, `glob`, `grep`, `read`) is present.
 */
export function applyFreeTierRequestContract<T>(
  body: T,
  requestFormat: string | null,
  placeholderNames: readonly string[] = PLACEHOLDER_TOOL_NAMES
): T {
  if (!body || typeof body !== "object" || Array.isArray(body)) return body;
  const record = body as Record<string, unknown>;
  const next: Record<string, unknown> = { ...record, stream: true };

  const { tools: concealed, map: renamed } = concealFingerprintToolNames(next.tools);
  if (next.tools !== concealed) next.tools = concealed;
  if (renamed.size > 0) {
    recordRenamedToolNames(next, renamed);
    retargetToolChoice(next, renamed);
  }

  const existingNames = new Set(clientToolNamesOf(next));
  const baseNames: string[] = [...OPENCODE_FINGERPRINT_TOOLS];
  for (const name of placeholderNames.length > 0 ? placeholderNames : PLACEHOLDER_TOOL_NAMES) {
    if (!baseNames.includes(name)) baseNames.push(name);
  }
  const namesToAdd = baseNames.filter((name) => !existingNames.has(name));

  if (namesToAdd.length === 0) return next as T;

  const existingTools = Array.isArray(next.tools) ? next.tools : [];
  const inject = (name: string, flat: boolean): Record<string, unknown> =>
    fingerprintPlaceholderTool(name, flat);

  if (requestFormat === "openai-responses") {
    next.tools = [...existingTools, ...namesToAdd.map((name) => inject(name, true))];
    return next as T;
  }

  if (requestFormat === "openai" || requestFormat === null) {
    next.tools = [...existingTools, ...namesToAdd.map((name) => inject(name, false))];
    return next as T;
  }

  return next as T;
}

const attemptsByOrigin = new WeakMap<object, FreeTierContractAttempt>();

export function attemptFor(origin: unknown): FreeTierContractAttempt | null {
  if (!origin || typeof origin !== "object") return null;
  return attemptsByOrigin.get(origin) ?? null;
}

function isTrackable(value: unknown): value is object {
  return typeof value === "object" && value !== null;
}

export function prepareFreeTierRequest<T>(
  body: T,
  requestFormat: string | null,
  surface: OpencodeSurface,
  provider: string,
  model: string,
  session?: string,
  origin?: object
): { body: T; attempt: FreeTierContractAttempt | null } {
  const clientToolNames = clientToolNamesOf(body);
  if (!requiresFreeTierRequestContract(surface, provider, model)) {
    if (isTrackable(origin)) attemptsByOrigin.delete(origin);
    return { body, attempt: null };
  }

  const names = configuredPlaceholderToolNames();
  const attempt: FreeTierContractAttempt = {
    provider,
    model,
    session,
    borrowed: false,
    clientToolNames,
    probe: false,
  };

  if (isTrackable(origin)) {
    attemptsByOrigin.set(origin, attempt);
  }

  const preparedBody = applyFreeTierRequestContract(body, requestFormat, names);
  if (isTrackable(origin)) {
    const renames = renamedToolNamesFor(preparedBody);
    if (renames && renames.size > 0) recordRenamedToolNames(origin, renames);
  }

  return { body: preparedBody, attempt };
}

export function fingerprintRenamesFor(body: unknown): ReadonlyMap<string, string> | null {
  return renamedToolNamesFor(body);
}

export function noteFreeTierOutcome(attempt: FreeTierContractAttempt | null, ok: boolean): void {
  void attempt;
  void ok;
}

/**
 * Rebuild a JSON body from the event stream the contract forced.
 */
export function rebuildJsonFromForcedStream(
  response: Response,
  requestFormat: string | null,
  model: string
): Response {
  if (!response.ok || !response.body) return response;
  if (!(response.headers.get("content-type") || "").includes("text/event-stream")) {
    return response;
  }
  const upstream = response;
  let drained = false;
  const body = new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        if (drained) {
          controller.close();
          return;
        }
        drained = true;
        try {
          const rawSse = await upstream.text();
          const parsed =
            requestFormat === "openai-responses"
              ? parseSSEToResponsesOutput(rawSse, model)
              : parseSSEToOpenAIResponse(rawSse, model);
          const out = parsed && typeof parsed === "object" ? JSON.stringify(parsed) : rawSse;
          controller.enqueue(new TextEncoder().encode(out));
        } catch (err) {
          controller.error(err);
          return;
        }
        controller.close();
      },
      cancel(reason) {
        if (!drained && !upstream.bodyUsed && upstream.body && !upstream.body.locked) {
          void upstream.body.cancel(reason);
        }
      },
    },
    { highWaterMark: 0 }
  );
  const headers = new Headers(response.headers);
  headers.set("content-type", "application/json");
  headers.delete("content-length");
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
