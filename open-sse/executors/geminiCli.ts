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
  mapModelToGeminiCliWire,
  translateChatRequestToGeminiCli,
  type OpenAIChatRequest,
} from "../translator/request/geminiCli.ts";
import {
  translateGeminiCliChunkToOpenAI,
  reassembleGeminiCliChunks,
  type GeminiCliResponseAccumulator,
} from "../translator/response/geminiCli.ts";

export const GEMINI_CLI_ENDPOINT_FALLBACKS = [
  "https://cloudcode-pa.googleapis.com/v1internal",
  "https://daily-cloudcode-pa.googleapis.com/v1internal",
  "https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal",
];

export const GEMINI_CLI_UA_VERSION = "0.31.0";
export const GEMINI_CLI_NODE_CLIENT_VERSION = "10.6.1";
export const GEMINI_CLI_GL_NODE_VERSION = "22.17.1";
export const GEMINI_CLI_PLATFORM_ARCH = "win32; x64";

/**
 * Builds standard client emulation wire headers matching Gemini CLI v0.31.x.
 */
export function buildGeminiCliHeaders(
  accessToken: string,
  model?: string,
  env: {
    uaVersion?: string;
    nodeClientVersion?: string;
    glNodeVersion?: string;
    platformArch?: string;
  } = {}
): Record<string, string> {
  const uaVer = env.uaVersion || process.env.GEMINI_CLI_UA_VERSION || GEMINI_CLI_UA_VERSION;
  const nodeVer =
    env.nodeClientVersion ||
    process.env.GEMINI_CLI_NODE_CLIENT_VERSION ||
    GEMINI_CLI_NODE_CLIENT_VERSION;
  const glVer =
    env.glNodeVersion || process.env.GEMINI_CLI_GL_NODE_VERSION || GEMINI_CLI_GL_NODE_VERSION;
  const arch = env.platformArch || process.env.GEMINI_CLI_PLATFORM_ARCH || GEMINI_CLI_PLATFORM_ARCH;

  const wireModel = model ? mapModelToGeminiCliWire(model) : "";
  const userAgent = wireModel
    ? `GeminiCLI/${uaVer}/${wireModel} (${arch}) google-api-nodejs-client/${nodeVer}`
    : `GeminiCLI/${uaVer} (${arch}) google-api-nodejs-client/${nodeVer}`;

  return {
    Authorization: `Bearer ${accessToken}`,
    "Content-Type": "application/json",
    "User-Agent": userAgent,
    "X-Goog-Api-Client": `gl-node/${glVer}`,
    Accept: "*/*",
    "Accept-Encoding": process.env.GEMINI_CLI_ACCEPT_ENCODING || "gzip, deflate, br",
    Connection: "close",
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
    model: string,
    stream: boolean,
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
    stream = true,
    clientHeaders?: Record<string, string> | null,
    model?: string
  ): Record<string, string> {
    const accessToken = credentials.accessToken || credentials.apiKey || "";
    const wireModel = model ? mapModelToGeminiCliWire(model) : "gemini-3-flash";
    return buildGeminiCliHeaders(accessToken, wireModel);
  }

  override async transformRequest(
    model: string,
    body: unknown,
    stream: boolean,
    credentials: ProviderCredentials
  ): Promise<unknown> {
    const projectId =
      credentials.projectId ||
      (credentials.providerSpecificData?.projectId as string | undefined) ||
      "default";
    const tier = (credentials.providerSpecificData?.tier as string | undefined) || "FREE";

    if (body && typeof body === "object" && "request" in (body as Record<string, unknown>)) {
      return body;
    }

    const translated = translateChatRequestToGeminiCli(body as OpenAIChatRequest, {
      projectId,
      tier,
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
    const headers = buildGeminiCliHeaders(accessToken, wireModel);

    let requestBody: Record<string, unknown>;
    if (body && typeof body === "object" && "request" in body) {
      requestBody = body as Record<string, unknown>;
    } else {
      const contents = Array.isArray((body as Record<string, unknown>)?.contents)
        ? (body as Record<string, unknown>).contents
        : Array.isArray((body as Record<string, unknown>)?.messages)
          ? (body as Record<string, unknown>).messages
          : [{ role: "user", parts: [{ text: typeof body === "string" ? body : "" }] }];
      requestBody = {
        request: {
          contents,
        },
      };
    }

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
          body: JSON.stringify(requestBody),
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
      activeCredentials.projectId ||
      (activeCredentials.providerSpecificData?.projectId as string | undefined) ||
      "default";
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
      const translated = translateChatRequestToGeminiCli(rawBody as OpenAIChatRequest, {
        projectId,
        tier,
      });
      requestPayload = translated.body;
      wireModel = translated.wireModel;
    }

    const headers = buildGeminiCliHeaders(accessToken, wireModel);
    if (upstreamExtraHeaders) {
      Object.assign(headers, upstreamExtraHeaders);
    }

    const baseUrls = this.getBaseUrls();
    const fallbackCount = this.getFallbackCount();
    let lastError: unknown = null;

    for (let urlIndex = 0; urlIndex < fallbackCount; urlIndex++) {
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
          body: JSON.stringify(requestPayload),
          signal: signal || undefined,
        });

        // 429: Halt endpoint cycling immediately
        if (response.status === 429) {
          const errText = await response.text();
          let errJson: unknown = null;
          try {
            errJson = JSON.parse(errText);
          } catch {}

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

          if ((response.status >= 500 || response.status === 408 || response.status === 400) && urlIndex + 1 < fallbackCount) {
            log?.debug?.("RETRY", `HTTP ${response.status} on ${url}, failing over to fallback endpoint`);
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
