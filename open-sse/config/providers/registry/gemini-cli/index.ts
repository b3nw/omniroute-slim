import type { RegistryEntry, RegistryModel } from "../../shared.ts";
import { resolvePublicCred } from "../../shared.ts";

export const GEMINI_CLI_ENDPOINT_FALLBACKS = [
  "https://cloudcode-pa.googleapis.com/v1internal",
];

// gemini-3.8-flash is only entitled for GeminiCLI >= 0.61.0 (upstream 62364cb20).
export const GEMINI_CLI_UA_VERSION = "0.66.0";
export const GEMINI_CLI_NODE_CLIENT_VERSION = "10.9.0";
export const GEMINI_CLI_GL_NODE_VERSION = "22.17.1";
export const GEMINI_CLI_PLATFORM_ARCH = `${process.platform}; ${process.arch}`;
export const GEMINI_CLI_SURFACE = "terminal";

/**
 * Appends the surface tag to a "platform; arch" string, matching upstream's
 * `(${platform}; ${arch}; ${surface})`. Values that already carry a surface are kept.
 */
export function withGeminiCliSurface(platformArch: string, surface = GEMINI_CLI_SURFACE): string {
  const parts = platformArch
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean);
  if (surface && parts.length < 3 && !parts.includes(surface)) {
    parts.push(surface);
  }
  return parts.join("; ");
}

export const GEMINI_CLI_MODELS: readonly RegistryModel[] = Object.freeze([
  {
    id: "gemini-2.5-pro",
    name: "Gemini 2.5 Pro",
    contextLength: 1048576,
    maxOutputTokens: 65536,
    supportsReasoning: true,
    supportsVision: true,
    supportsAudio: true,
    supportsVideo: true,
    toolCalling: true,
  },
  {
    id: "gemini-2.5-flash",
    name: "Gemini 2.5 Flash",
    contextLength: 1048576,
    maxOutputTokens: 65536,
    supportsReasoning: true,
    supportsVision: true,
    supportsAudio: true,
    supportsVideo: true,
    toolCalling: true,
  },
  {
    id: "gemini-2.5-flash-lite",
    name: "Gemini 2.5 Flash Lite",
    contextLength: 1048576,
    maxOutputTokens: 65536,
    supportsReasoning: true,
    supportsVision: true,
    supportsAudio: true,
    supportsVideo: true,
    toolCalling: true,
  },
  {
    id: "gemini-3-pro-preview",
    name: "Gemini 3 Pro Preview",
    contextLength: 1048576,
    maxOutputTokens: 65536,
    supportsReasoning: true,
    supportsVision: true,
    supportsAudio: true,
    supportsVideo: true,
    toolCalling: true,
  },
  {
    id: "gemini-3.1-pro-preview",
    name: "Gemini 3.1 Pro Preview",
    contextLength: 1048576,
    maxOutputTokens: 65536,
    supportsReasoning: true,
    supportsVision: true,
    supportsAudio: true,
    supportsVideo: true,
    toolCalling: true,
  },
  {
    id: "gemini-3-flash-preview",
    name: "Gemini 3 Flash Preview",
    contextLength: 1048576,
    maxOutputTokens: 65536,
    supportsReasoning: true,
    supportsVision: true,
    supportsAudio: true,
    supportsVideo: true,
    toolCalling: true,
  },
  {
    id: "gemini-3-flash",
    name: "Gemini 3 Flash",
    contextLength: 1048576,
    maxOutputTokens: 65536,
    supportsReasoning: true,
    supportsVision: true,
    supportsAudio: true,
    supportsVideo: true,
    toolCalling: true,
  },
  {
    id: "gemini-3.5-flash",
    name: "Gemini 3.5 Flash",
    contextLength: 1048576,
    maxOutputTokens: 65536,
    supportsReasoning: true,
    supportsVision: true,
    supportsAudio: true,
    supportsVideo: true,
    toolCalling: true,
  },
  {
    id: "gemini-3.1-flash-lite",
    name: "Gemini 3.1 Flash Lite",
    contextLength: 1048576,
    maxOutputTokens: 65536,
    supportsReasoning: true,
    supportsVision: true,
    supportsAudio: true,
    supportsVideo: true,
    toolCalling: true,
  },
  {
    id: "gemini-3.1-flash-lite-preview",
    name: "Gemini 3.1 Flash Lite Preview",
    contextLength: 1048576,
    maxOutputTokens: 65536,
    supportsReasoning: true,
    supportsVision: true,
    supportsAudio: true,
    supportsVideo: true,
    toolCalling: true,
  },
]);

export const geminiCliProvider: RegistryEntry = {
  id: "gemini-cli",
  alias: "gemini_cli",
  format: "gemini-cli",
  executor: "gemini-cli",
  baseUrls: [...GEMINI_CLI_ENDPOINT_FALLBACKS],
  authType: "oauth",
  authHeader: "bearer",
  headers: {
    "User-Agent": `GeminiCLI/${GEMINI_CLI_UA_VERSION} (${withGeminiCliSurface(GEMINI_CLI_PLATFORM_ARCH)}) google-api-nodejs-client/${GEMINI_CLI_NODE_CLIENT_VERSION}`,
    "X-Goog-Api-Client": `gl-node/${GEMINI_CLI_GL_NODE_VERSION}`,
    Accept: "*/*",
    "Accept-Encoding": "gzip, deflate, br",
  },
  oauth: {
    clientIdEnv: "GEMINI_CLI_OAUTH_CLIENT_ID",
    clientIdDefault: resolvePublicCred("gemini_id"),
    clientSecretEnv: "GEMINI_CLI_OAUTH_CLIENT_SECRET",
    clientSecretDefault: resolvePublicCred("gemini_alt"),
  },
  models: [...GEMINI_CLI_MODELS],
  passthroughModels: true,
  liveCatalogAuthoritative: false,
};

export const gemini_cliProvider = geminiCliProvider;
