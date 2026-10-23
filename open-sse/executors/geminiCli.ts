import {
  BaseExecutor,
  type ExecuteInput,
  type CountTokensInput,
  type ExecutorExecuteResult,
  type ProviderCredentials,
  type ExecutorLog,
} from "./base.ts";
import { buildErrorBody, sanitizeErrorMessage } from "../utils/error.ts";
import {
  getGeminiCliCapacityFallbackModel,
  mapModelToGeminiCliWire,
  sanitizeGeminiCliProjectId,
  translateChatRequestToGeminiCli,
  type OpenAIChatRequest,
} from "../translator/request/geminiCli.ts";
import {
  translateGeminiCliChunkToOpenAI,
  reassembleGeminiCliChunks,
  type GeminiCliResponseAccumulator,
} from "../translator/response/geminiCli.ts";
import {
  applyFingerprint,
  isCliCompatEnabled,
  stripInternalBodyFields,
} from "../config/cliFingerprints.ts";
import { scrubProxyAndFingerprintHeaders } from "../services/antigravityHeaderScrub.ts";
import { getActiveClientVersion } from "@/lib/client-versions/registry";

import {
  GEMINI_CLI_ENDPOINT_FALLBACKS,
  GEMINI_CLI_GL_NODE_VERSION,
  GEMINI_CLI_NODE_CLIENT_VERSION,
  GEMINI_CLI_PLATFORM_ARCH,
  GEMINI_CLI_SURFACE,
  GEMINI_CLI_UA_VERSION,
  withGeminiCliSurface,
} from "../config/providers/registry/gemini-cli/index.ts";

export {
  GEMINI_CLI_ENDPOINT_FALLBACKS,
  GEMINI_CLI_GL_NODE_VERSION,
  GEMINI_CLI_NODE_CLIENT_VERSION,
  GEMINI_CLI_PLATFORM_ARCH,
  GEMINI_CLI_SURFACE,
  GEMINI_CLI_UA_VERSION,
  withGeminiCliSurface,
};

/**
 * Returns true when a 429 body signals server-side capacity exhaustion for the model
 * (as opposed to a per-user quota/rate limit).
 */
export function isGeminiCliCapacityExhausted(errText: string | null | undefined): boolean {
  if (!errText) return false;
  return (
    errText.includes("MODEL_CAPACITY_EXHAUSTED") || /No capacity available for model/i.test(errText)
  );
}

/**
 * Scrubs proxy tracing headers, foreign SDK headers (Stainless), browser headers (Sec-Ch-*),
 * Connection: close, and x-goog-user-project (unless explicitly configured for ADC).
 */
export function scrubGeminiCliHeaders(
  headers: Record<string, string>,
  options: { isAdc?: boolean; quotaProjectId?: string } = {}
): Record<string, string> {
  const acceptEncodingOverride = process.env.GEMINI_CLI_ACCEPT_ENCODING;
  const baseScrubbed = scrubProxyAndFingerprintHeaders(headers);
  const cleaned: Record<string, string> = {};
  let authorizationValue: string | undefined;
  const hasExplicitQuotaProjectOption = "quotaProjectId" in options;
  const trustedQuotaProjectId =
    options.isAdc && typeof options.quotaProjectId === "string" && options.quotaProjectId.trim()
      ? options.quotaProjectId.trim()
      : undefined;

  for (const [key, value] of Object.entries(baseScrubbed)) {
    const lowerKey = key.toLowerCase();
    if (
      lowerKey.startsWith("cf-") ||
      lowerKey.startsWith("x-forwarded-") ||
      lowerKey.startsWith("x-stainless-") ||
      lowerKey.startsWith("sec-ch-ua") ||
      lowerKey.startsWith("sec-fetch-") ||
      lowerKey === "connection" ||
      (!options.isAdc && lowerKey === "x-goog-user-project") ||
      (hasExplicitQuotaProjectOption && lowerKey === "x-goog-user-project")
    ) {
      continue;
    }
    if (lowerKey === "authorization") {
      authorizationValue = value;
      continue;
    }
    cleaned[key] = value;
  }

  if (acceptEncodingOverride) {
    cleaned["Accept-Encoding"] = acceptEncodingOverride;
  }
  if (trustedQuotaProjectId) {
    cleaned["x-goog-user-project"] = trustedQuotaProjectId;
  }
  if (authorizationValue !== undefined) {
    cleaned["Authorization"] = authorizationValue;
  }
  return cleaned;
}

function getGeminiCliCredentialHeaderOptions(credentials?: ProviderCredentials | null): {
  isAdc: boolean;
  quotaProjectId?: string;
  customUserAgent?: string;
  platformArch?: string;
} {
  const credRecord = credentials as Record<string, unknown> | null | undefined;
  const psd = credentials?.providerSpecificData;
  const rawQuotaProjectId =
    typeof psd?.quotaProjectId === "string" && psd.quotaProjectId.trim()
      ? psd.quotaProjectId.trim()
      : typeof credRecord?.quotaProjectId === "string" && credRecord.quotaProjectId.trim()
        ? credRecord.quotaProjectId.trim()
        : undefined;
  const isAdc = Boolean(
    psd?.isAdc === true ||
      credRecord?.isAdc === true ||
      psd?.authType === "adc" ||
      credRecord?.authType === "adc" ||
      rawQuotaProjectId
  );
  const customUserAgent =
    typeof psd?.customUserAgent === "string" && psd.customUserAgent.trim()
      ? psd.customUserAgent.trim()
      : undefined;
  const platformArch =
    typeof psd?.platformArch === "string" && psd.platformArch.trim()
      ? psd.platformArch.trim()
      : undefined;
  return {
    isAdc,
    quotaProjectId: isAdc ? rawQuotaProjectId : undefined,
    customUserAgent,
    platformArch,
  };
}

function finalizeGeminiCliWirePayload(
  headers: Record<string, string>,
  body: Record<string, unknown>
): { headers: Record<string, string>; bodyString: string } {
  if (isCliCompatEnabled("gemini-cli")) {
    return applyFingerprint("gemini-cli", headers, body);
  }
  const cloned: Record<string, unknown> = { ...body };
  stripInternalBodyFields(cloned);
  if (cloned.request && typeof cloned.request === "object" && !Array.isArray(cloned.request)) {
    const inner = { ...(cloned.request as Record<string, unknown>) };
    stripInternalBodyFields(inner);
    cloned.request = inner;
  }
  return {
    headers,
    bodyString: JSON.stringify(cloned),
  };
}

/**
 * Builds standard client emulation wire headers matching Gemini CLI.
 */
export function buildGeminiCliHeaders(
  accessToken: string,
  model?: string,
  env: {
    uaVersion?: string;
    nodeClientVersion?: string;
    glNodeVersion?: string;
    platformArch?: string;
    surface?: string;
    customUserAgent?: string;
  } = {}
): Record<string, string> {
  const uaVer =
    env.uaVersion ||
    getActiveClientVersion("gemini-cli") ||
    process.env.GEMINI_CLI_UA_VERSION ||
    process.env.GEMINI_CLI_CLIENT_VERSION ||
    GEMINI_CLI_UA_VERSION;
  const nodeVer =
    env.nodeClientVersion ||
    process.env.GEMINI_CLI_NODE_CLIENT_VERSION ||
    GEMINI_CLI_NODE_CLIENT_VERSION;
  const glVer =
    env.glNodeVersion || process.env.GEMINI_CLI_GL_NODE_VERSION || GEMINI_CLI_GL_NODE_VERSION;
  const surface = env.surface ?? process.env.GEMINI_CLI_SURFACE ?? GEMINI_CLI_SURFACE;
  const arch = withGeminiCliSurface(
    env.platformArch ||
      process.env.GEMINI_CLI_PLATFORM_ARCH ||
      `${process.platform}; ${process.arch}`,
    surface
  );

  const wireModel = model ? mapModelToGeminiCliWire(model) : "";
  const defaultUserAgent = wireModel
    ? `GeminiCLI/${uaVer}/${wireModel} (${arch}) google-api-nodejs-client/${nodeVer}`
    : `GeminiCLI/${uaVer} (${arch}) google-api-nodejs-client/${nodeVer}`;
  const userAgent =
    typeof env.customUserAgent === "string" && env.customUserAgent.trim()
      ? env.customUserAgent.trim()
      : defaultUserAgent;

  return {
    "Content-Type": "application/json",
    "User-Agent": userAgent,
    "X-Goog-Api-Client": `gl-node/${glVer}`,
    Accept: "*/*",
    "Accept-Encoding": process.env.GEMINI_CLI_ACCEPT_ENCODING || "gzip, deflate, br",
    Authorization: `Bearer ${accessToken}`,
  };
}

/**
 * Compound Reset Duration Parser.
 * Handles pure seconds ("2s", "515092.73s"), compound durations ("156h14m36.73s"),
 * and embedded reset strings ("quota will reset after 2s").
 */
export function parseGeminiCliResetDuration(
  errorMessageOrMetadata: string | null | undefined
): number | null {
  if (!errorMessageOrMetadata) return null;
  const str = String(errorMessageOrMetadata);

  // Direct metadata format like "2s" or "515092.73s"
  const pureSecMatch = str.trim().match(/^([\d.]+)s$/i);
  if (pureSecMatch) {
    const sec = parseFloat(pureSecMatch[1]);
    return Number.isFinite(sec) ? Math.round(sec * 1000) : null;
  }

  // Embedded in human-readable text (e.g. "quota will reset after 156h14m36.73s" or "reset after 2s")
  const textMatch = str.match(/reset after (?:(\d+)h)?(?:(\d+)m)?(?:([\d.]+)s)?/i);
  if (textMatch && (textMatch[1] || textMatch[2] || textMatch[3])) {
    const hours = parseInt(textMatch[1] || "0", 10);
    const minutes = parseInt(textMatch[2] || "0", 10);
    const seconds = parseFloat(textMatch[3] || "0");
    const totalSeconds = hours * 3600 + minutes * 60 + seconds;
    return Math.round(totalSeconds * 1000);
  }

  // Bare compound duration (e.g. "156h14m36s", "42m10s", "15s")
  const compoundMatch = str.trim().match(/^(?:(\d+)h)?(?:(\d+)m)?(?:([\d.]+)s)?$/i);
  if (compoundMatch && (compoundMatch[1] || compoundMatch[2] || compoundMatch[3])) {
    const hours = parseInt(compoundMatch[1] || "0", 10);
    const minutes = parseInt(compoundMatch[2] || "0", 10);
    const seconds = parseFloat(compoundMatch[3] || "0");
    const totalSeconds = hours * 3600 + minutes * 60 + seconds;
    return Math.round(totalSeconds * 1000);
  }

  return null;
}

/**
 * Error Sanitizer adhering to CWE-209 & ERROR_SANITIZATION.md.
 * Drops stack traces, replaces file paths with <path>, and redacts secrets/tokens.
 */
export function sanitizeGeminiCliError(errMessage: string): string {
  if (!errMessage) return "Internal Server Error";

  // Take only first line to drop stack traces
  let cleaned = errMessage.split("\n")[0];

  // Strip POSIX and Windows file paths
  cleaned = cleaned.replace(/(?:\/[a-zA-Z0-9._-]+)+/g, "<path>");
  cleaned = cleaned.replace(/[a-zA-Z]:\\[a-zA-Z0-9._\-\\]+/g, "<path>");

  // Redact Bearer tokens & Google OAuth credentials
  cleaned = cleaned.replace(/Bearer\s+[a-zA-Z0-9._~+/-]+/gi, "Bearer [REDACTED]");
  cleaned = cleaned.replace(/ya29\.[a-zA-Z0-9_-]+/gi, "[REDACTED_TOKEN]");
  cleaned = cleaned.replace(/GOCSPX-[a-zA-Z0-9_-]+/gi, "[REDACTED_SECRET]");

  return cleaned;
}

/**
 * Transform upstream SSE stream to OpenAI-compatible SSE chunks.
 */
function transformUpstreamSseToOpenAi(
  upstreamBody: ReadableStream<Uint8Array>,
  model: string
): ReadableStream<Uint8Array> {
  const reader = upstreamBody.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";
  const accumulator: GeminiCliResponseAccumulator = { tool_idx: 0 };
  let doneEmitted = false;

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed.startsWith("data:")) continue;
            const dataStr = trimmed.slice(5).trim();
            if (!dataStr) continue;
            if (dataStr === "[DONE]") {
              controller.enqueue(encoder.encode("data: [DONE]\n\n"));
              doneEmitted = true;
              break;
            }

            try {
              const json = JSON.parse(dataStr);
              const chunks = translateGeminiCliChunkToOpenAI(json, model, accumulator);
              if (Array.isArray(chunks)) {
                for (const chunk of chunks) {
                  controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
                }
              }
            } catch {
              // ignore non-json SSE lines
            }
          }
        }

        // Flush leftover buffer if any
        if (buffer.trim()) {
          const trimmed = buffer.trim();
          if (trimmed.startsWith("data:")) {
            const dataStr = trimmed.slice(5).trim();
            if (dataStr && dataStr !== "[DONE]") {
              try {
                const json = JSON.parse(dataStr);
                const chunks = translateGeminiCliChunkToOpenAI(json, model, accumulator);
                if (Array.isArray(chunks)) {
                  for (const chunk of chunks) {
                    controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
                  }
                }
              } catch {}
            }
          }
        }

        if (!doneEmitted) {
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        }
        controller.close();
      } catch (err) {
        controller.error(err);
      }
    },
    cancel(reason) {
      reader.cancel(reason);
    },
  });
}

/**
 * Collect upstream SSE stream and reassemble into a complete OpenAI ChatCompletion response.
 */
async function collectUpstreamSseToCompletion(
  upstreamBody: ReadableStream<Uint8Array>,
  model: string
): Promise<Record<string, unknown>> {
  const reader = upstreamBody.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const accumulator: GeminiCliResponseAccumulator = { tool_idx: 0 };
  const openAiChunks: Array<Record<string, unknown>> = [];

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const dataStr = trimmed.slice(5).trim();
      if (!dataStr || dataStr === "[DONE]") continue;

      try {
        const json = JSON.parse(dataStr);
        const chunks = translateGeminiCliChunkToOpenAI(json, model, accumulator);
        if (Array.isArray(chunks)) {
          for (const chunk of chunks) {
            openAiChunks.push(chunk);
          }
        }
      } catch {}
    }
  }

  if (buffer.trim()) {
    const trimmed = buffer.trim();
    if (trimmed.startsWith("data:")) {
      const dataStr = trimmed.slice(5).trim();
      if (dataStr && dataStr !== "[DONE]") {
        try {
          const json = JSON.parse(dataStr);
          const chunks = translateGeminiCliChunkToOpenAI(json, model, accumulator);
          if (Array.isArray(chunks)) {
            for (const chunk of chunks) openAiChunks.push(chunk);
          }
        } catch {}
      }
    }
  }

  if (openAiChunks.length > 0) {
    return reassembleGeminiCliChunks(openAiChunks, model);
  }

  return {
    id: `chatcmpl-geminicli-${Date.now()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: "" },
        finish_reason: "stop",
      },
    ],
  };
}

export class GeminiCliExecutor extends BaseExecutor {
  constructor() {
    super("gemini-cli", {
      id: "gemini-cli",
      baseUrl: GEMINI_CLI_ENDPOINT_FALLBACKS[0],
      baseUrls: GEMINI_CLI_ENDPOINT_FALLBACKS,
    });
  }

  override buildUrl(
    _model: string,
    _stream: boolean,
    urlIndex = 0,
    credentials: ProviderCredentials | null = null
  ): string {
    const baseUrls = this.getBaseUrls();
    const rawBaseUrl =
      typeof credentials?.providerSpecificData?.baseUrl === "string" &&
      credentials.providerSpecificData.baseUrl
        ? credentials.providerSpecificData.baseUrl
        : baseUrls[urlIndex] || baseUrls[0] || GEMINI_CLI_ENDPOINT_FALLBACKS[0];

    const baseUrl = rawBaseUrl.replace(/\/$/, "");
    return `${baseUrl}:streamGenerateContent?alt=sse`;
  }

  override buildHeaders(
    credentials: ProviderCredentials,
    _stream = true,
    _clientHeaders?: Record<string, string> | null,
    model?: string
  ): Record<string, string> {
    const accessToken = credentials.accessToken || credentials.apiKey || "";
    const wireModel = model ? mapModelToGeminiCliWire(model) : "gemini-3-flash";
    const { isAdc, quotaProjectId, customUserAgent, platformArch } =
      getGeminiCliCredentialHeaderOptions(credentials);
    const built = buildGeminiCliHeaders(accessToken, wireModel, {
      customUserAgent,
      platformArch,
    });
    const scrubbed = scrubGeminiCliHeaders(built, { isAdc, quotaProjectId });
    return isCliCompatEnabled("gemini-cli")
      ? applyFingerprint("gemini-cli", scrubbed, {}).headers
      : scrubbed;
  }

  override async transformRequest(
    _model: string,
    body: unknown,
    _stream: boolean,
    credentials: ProviderCredentials
  ): Promise<unknown> {
    const projectId =
      sanitizeGeminiCliProjectId(credentials.projectId) ??
      sanitizeGeminiCliProjectId(credentials.providerSpecificData?.projectId as string | undefined);
    const tier = (credentials.providerSpecificData?.tier as string | undefined) || "FREE";

    if (body && typeof body === "object" && "request" in (body as Record<string, unknown>)) {
      return body;
    }

    const credRecord = credentials as Record<string, unknown>;
    const translated = translateChatRequestToGeminiCli(body as OpenAIChatRequest, {
      projectId,
      tier,
      providerSpecificData: credentials?.providerSpecificData,
      enabledCreditTypes: credRecord?.enabledCreditTypes as string[] | undefined,
      enabled_credit_types: credRecord?.enabled_credit_types as string[] | undefined,
      sessionId: credRecord?.sessionId as string | undefined,
      session_id: credRecord?.session_id as string | undefined,
      userPromptId: credRecord?.userPromptId as string | undefined,
      user_prompt_id: credRecord?.user_prompt_id as string | undefined,
    });
    return translated.body;
  }

  override async refreshCredentials(
    credentials: ProviderCredentials,
    log: ExecutorLog | null
  ): Promise<Partial<ProviderCredentials> | null> {
    const { getAccessToken } = await import("../services/tokenRefresh.ts");
    return getAccessToken("gemini-cli", credentials, log);
  }

  override async countTokens({ model, body, credentials, signal, log }: CountTokensInput): Promise<{
    input_tokens: number;
    provider: string;
    source: "provider";
  } | null> {
    const accessToken = credentials.accessToken || credentials.apiKey || "";
    const wireModel = mapModelToGeminiCliWire(model);
    const { isAdc, quotaProjectId, customUserAgent, platformArch } =
      getGeminiCliCredentialHeaderOptions(credentials);
    const rawHeaders = scrubGeminiCliHeaders(
      buildGeminiCliHeaders(accessToken, wireModel, { customUserAgent, platformArch }),
      { isAdc, quotaProjectId }
    );

    let requestBody: Record<string, unknown>;
    if (body && typeof body === "object" && "request" in body) {
      const existingReq = (body as Record<string, unknown>).request;
      if (existingReq && typeof existingReq === "object" && !Array.isArray(existingReq)) {
        const existingReqRecord = existingReq as Record<string, unknown>;
        const existingModel =
          typeof existingReqRecord.model === "string" && existingReqRecord.model.trim().length > 0
            ? existingReqRecord.model.trim()
            : `models/${wireModel}`;
        requestBody = {
          ...(body as Record<string, unknown>),
          request: {
            ...existingReqRecord,
            model: existingModel,
          },
        };
      } else {
        requestBody = { ...(body as Record<string, unknown>) };
      }
    } else {
      const contents = Array.isArray((body as Record<string, unknown>)?.contents)
        ? (body as Record<string, unknown>).contents
        : Array.isArray((body as Record<string, unknown>)?.messages)
          ? (body as Record<string, unknown>).messages
          : [{ role: "user", parts: [{ text: typeof body === "string" ? body : "" }] }];
      requestBody = {
        request: {
          model: `models/${wireModel}`,
          contents,
        },
      };
    }

    const { headers, bodyString } = finalizeGeminiCliWirePayload(rawHeaders, requestBody);

    const fallbackCount = this.getFallbackCount();
    const baseUrls = this.getBaseUrls();

    for (let i = 0; i < fallbackCount; i++) {
      const baseUrl = (baseUrls[i] || GEMINI_CLI_ENDPOINT_FALLBACKS[i]).replace(/\/$/, "");
      const url = `${baseUrl}:countTokens`;
      this.assertOutboundUrlAllowed(url);

      try {
        const response = await fetch(url, {
          method: "POST",
          headers,
          body: bodyString,
          signal: signal || undefined,
        });

        if (response.status === 429) {
          const errText = await response.text();
          log?.debug?.("COUNT_TOKENS", `Gemini CLI countTokens rate limited: ${errText}`);
          return null;
        }

        if (!response.ok) {
          if (response.status >= 500 && i + 1 < fallbackCount) {
            continue;
          }
          const errText = await response.text();
          throw new Error(`HTTP ${response.status}: ${errText}`);
        }

        const data = (await response.json()) as Record<string, unknown>;
        const totalTokens = Number(data.totalTokens ?? data.total_tokens ?? data.input_tokens);
        if (Number.isFinite(totalTokens)) {
          return { input_tokens: totalTokens, provider: this.provider, source: "provider" };
        }
        return null;
      } catch (err) {
        if (i + 1 < fallbackCount) continue;
        log?.debug?.(
          "COUNT_TOKENS",
          `Gemini CLI countTokens failed: ${err instanceof Error ? err.message : String(err)}`
        );
        return null;
      }
    }
    return null;
  }

  override async execute(input: ExecuteInput): Promise<ExecutorExecuteResult> {
    const {
      model,
      body,
      stream,
      credentials,
      signal,
      log,
      upstreamExtraHeaders,
      onCredentialsRefreshed,
    } = input;

    let activeCredentials = credentials;
    if (this.needsRefresh(credentials)) {
      try {
        const refreshed = await this.refreshCredentials(credentials, log || null);
        if (refreshed) {
          activeCredentials = { ...credentials, ...refreshed };
          if (onCredentialsRefreshed) {
            await onCredentialsRefreshed(refreshed);
          }
        }
      } catch (err) {
        log?.error?.("TOKEN", `Credential refresh failed: ${sanitizeErrorMessage(err)}`);
      }
    }

    const accessToken = activeCredentials.accessToken || activeCredentials.apiKey || "";
    const projectId =
      sanitizeGeminiCliProjectId(activeCredentials.projectId) ??
      sanitizeGeminiCliProjectId(
        activeCredentials.providerSpecificData?.projectId as string | undefined
      );
    const tier = (activeCredentials.providerSpecificData?.tier as string | undefined) || "FREE";

    let wireModel = mapModelToGeminiCliWire(model);
    let requestPayload: Record<string, unknown>;

    const rawBody =
      typeof body === "string"
        ? (() => {
            try {
              return JSON.parse(body);
            } catch {
              return body;
            }
          })()
        : body;

    if (
      rawBody &&
      typeof rawBody === "object" &&
      "request" in (rawBody as Record<string, unknown>) &&
      "user_prompt_id" in (rawBody as Record<string, unknown>)
    ) {
      requestPayload = rawBody as Record<string, unknown>;
      if (typeof requestPayload.model === "string") {
        wireModel = mapModelToGeminiCliWire(requestPayload.model);
      }
    } else {
      const activeCredRecord = activeCredentials as Record<string, unknown>;
      const translated = translateChatRequestToGeminiCli(rawBody as OpenAIChatRequest, {
        projectId,
        tier,
        providerSpecificData: activeCredentials?.providerSpecificData,
        enabledCreditTypes: activeCredRecord?.enabledCreditTypes as string[] | undefined,
        enabled_credit_types: activeCredRecord?.enabled_credit_types as string[] | undefined,
        sessionId: activeCredRecord?.sessionId as string | undefined,
        session_id: activeCredRecord?.session_id as string | undefined,
        userPromptId: activeCredRecord?.userPromptId as string | undefined,
        user_prompt_id: activeCredRecord?.user_prompt_id as string | undefined,
      });
      requestPayload = translated.body;
      wireModel = translated.wireModel;
    }

    const { isAdc, quotaProjectId, customUserAgent, platformArch } =
      getGeminiCliCredentialHeaderOptions(activeCredentials);
    const buildHeaders = (forModel: string) => {
      const built = buildGeminiCliHeaders(accessToken, forModel, {
        customUserAgent,
        platformArch,
      });
      const merged: Record<string, string> = { ...built };
      if (upstreamExtraHeaders) {
        const scrubbedExtra = scrubGeminiCliHeaders(upstreamExtraHeaders, {
          isAdc,
          quotaProjectId,
        });
        const canonicalKeys = new Map<string, string>();
        for (const key of Object.keys(merged)) {
          canonicalKeys.set(key.toLowerCase(), key);
        }
        for (const [key, value] of Object.entries(scrubbedExtra)) {
          const lowerKey = key.toLowerCase();
          if (lowerKey === "authorization" || lowerKey === "x-goog-user-project") {
            continue;
          }
          if (lowerKey === "user-agent" && customUserAgent) {
            continue;
          }
          const targetKey = canonicalKeys.get(lowerKey) ?? key;
          merged[targetKey] = value;
          canonicalKeys.set(lowerKey, targetKey);
        }
      }
      if (customUserAgent) {
        merged["User-Agent"] = customUserAgent;
      }
      return scrubGeminiCliHeaders(merged, { isAdc, quotaProjectId });
    };
    let headers = buildHeaders(wireModel);

    const baseUrls = this.getBaseUrls();
    const fallbackCount = this.getFallbackCount();
    let lastError: unknown = null;
    let capacityFallbackUsed = false;

    for (let urlIndex = 0; urlIndex < fallbackCount; urlIndex++) {
      const finalized = finalizeGeminiCliWirePayload(headers, requestPayload);
      headers = finalized.headers;
      const bodyString = finalized.bodyString;
      requestPayload = JSON.parse(bodyString) as Record<string, unknown>;

      const rawBaseUrl =
        typeof activeCredentials?.providerSpecificData?.baseUrl === "string" &&
        activeCredentials.providerSpecificData.baseUrl
          ? activeCredentials.providerSpecificData.baseUrl
          : baseUrls[urlIndex] ||
            baseUrls[0] ||
            GEMINI_CLI_ENDPOINT_FALLBACKS[urlIndex] ||
            GEMINI_CLI_ENDPOINT_FALLBACKS[0];

      const baseUrl = rawBaseUrl.replace(/\/$/, "");
      const url = `${baseUrl}:streamGenerateContent?alt=sse`;
      this.assertOutboundUrlAllowed(url);

      try {
        const response = await fetch(url, {
          method: "POST",
          headers,
          body: bodyString,
          signal: signal || undefined,
        });

        // 429: Halt endpoint cycling immediately
        if (response.status === 429) {
          const errText = await response.text();
          let errJson: unknown = null;
          try {
            errJson = JSON.parse(errText);
          } catch {}

          // Server capacity exhausted for this model: retry once on the same endpoint
          // with the upstream gemini-cli fallback model. Quota/rate limits still halt.
          const capacityFallback =
            !capacityFallbackUsed && isGeminiCliCapacityExhausted(errText)
              ? getGeminiCliCapacityFallbackModel(wireModel)
              : null;
          if (capacityFallback) {
            log?.warn?.(
              "GEMINI_CLI_CAPACITY_FALLBACK",
              `No capacity for ${wireModel} on ${url}, retrying with ${capacityFallback}`
            );
            capacityFallbackUsed = true;
            wireModel = capacityFallback;
            requestPayload = { ...requestPayload, model: capacityFallback };
            headers = buildHeaders(capacityFallback);
            urlIndex--;
            continue;
          }

          const resetMs = parseGeminiCliResetDuration(errText);
          const errorBody = buildErrorBody(429, errText, errJson);
          const resHeaders = new Headers(response.headers);
          resHeaders.set("Content-Type", "application/json");
          if (resetMs) {
            resHeaders.set("Retry-After", String(Math.ceil(resetMs / 1000)));
          }

          const errResponse = new Response(JSON.stringify(errorBody), {
            status: 429,
            headers: resHeaders,
          });

          return {
            response: errResponse,
            url,
            headers,
            transformedBody: requestPayload,
          };
        }

        // Non-ok responses (400, 401, 403, 404, 5xx, etc.)
        if (!response.ok) {
          const errText = await response.text();
          let errJson: unknown = null;
          try {
            errJson = JSON.parse(errText);
          } catch {}

          log?.debug?.(
            "GEMINI_CLI_UPSTREAM_ERROR",
            `HTTP ${response.status} from ${url}: ${sanitizeErrorMessage(errText)}`
          );

          if (
            (response.status >= 500 || response.status === 408 || response.status === 400) &&
            urlIndex + 1 < fallbackCount
          ) {
            log?.debug?.(
              "RETRY",
              `HTTP ${response.status} on ${url}, failing over to fallback endpoint`
            );
            continue;
          }

          const errorBody = buildErrorBody(response.status, errText, errJson);
          const errResponse = new Response(JSON.stringify(errorBody), {
            status: response.status,
            headers: { "Content-Type": "application/json" },
          });
          return {
            response: errResponse,
            url,
            headers,
            transformedBody: requestPayload,
          };
        }

        if (capacityFallbackUsed) {
          log?.info?.(
            "GEMINI_CLI_CAPACITY_FALLBACK",
            `Serving ${model} via capacity fallback model ${wireModel}`
          );
        }

        // 200 OK: Handle streaming vs non-streaming
        if (stream) {
          if (!response.body) {
            throw new Error("Upstream response has no body");
          }
          const transformedStream = transformUpstreamSseToOpenAi(response.body, model);
          const streamResponse = new Response(transformedStream, {
            status: 200,
            headers: {
              "Content-Type": "text/event-stream",
              "Cache-Control": "no-cache",
              Connection: "keep-alive",
            },
          });
          return {
            response: streamResponse,
            url,
            headers,
            transformedBody: requestPayload,
          };
        } else {
          if (!response.body) {
            throw new Error("Upstream response has no body");
          }
          const completion = await collectUpstreamSseToCompletion(response.body, model);
          const jsonResponse = new Response(JSON.stringify(completion), {
            status: 200,
            headers: {
              "Content-Type": "application/json",
            },
          });
          return {
            response: jsonResponse,
            url,
            headers,
            transformedBody: requestPayload,
          };
        }
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        lastError = error;
        if (urlIndex + 1 < fallbackCount) {
          log?.debug?.(
            "RETRY",
            `Network error on ${url}, failing over to fallback endpoint: ${sanitizeErrorMessage(error)}`
          );
          continue;
        }
        throw error;
      }
    }

    throw lastError || new Error("All endpoints in fallback chain failed");
  }
}
