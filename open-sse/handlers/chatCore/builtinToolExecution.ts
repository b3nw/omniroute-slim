/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Executes the synthetic builtin tool calls that the web-search / web-fetch
 * fallback services emit, and splices their results back into the provider
 * response.
 *
 * `prepareWebSearchFallbackBody` / `prepareWebFetchFallbackBody` rewrite a
 * client's native `web_search` / `web_fetch` tool into an OmniRoute-owned tool
 * name for providers that cannot serve it themselves. This module closes that
 * loop: without it the model emits a tool call nobody answers.
 *
 * Only the two fallback builtins are handled — every other tool call (including
 * client-native tools such as Bash or Read) is forwarded untouched, so no
 * response is rewritten on its behalf (#2815).
 */

import { executeWebSearch, type ExecuteWebSearchInput } from "@/lib/search/executeWebSearch";
import { executeWebFetch } from "@/lib/search/executeWebFetch";
import { OMNIROUTE_WEB_SEARCH_FALLBACK_TOOL_NAME } from "../../services/webSearchFallback.ts";
import { OMNIROUTE_WEB_FETCH_FALLBACK_TOOL_NAME } from "../../services/webFetchInterception.ts";
import { logger } from "../../utils/logger.ts";

const log = logger("builtinToolExecution");

const BUILTIN_TOOL_ALIASES: Record<string, string> = {
  [OMNIROUTE_WEB_SEARCH_FALLBACK_TOOL_NAME]: "web_search",
  [OMNIROUTE_WEB_FETCH_FALLBACK_TOOL_NAME]: "web_fetch",
};

export interface BuiltinToolContext {
  apiKeyId: string;
  sessionId?: string;
  requestId?: string;
  /** Tool names this request is allowed to execute (the enabled fallback plans). */
  builtinToolNames: string[];
  provider?: string;
  model?: string;
}

interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

function detectProvider(modelId: string): "openai" | "anthropic" | "google" | "other" {
  const lower = modelId.toLowerCase();
  if (lower.includes("gpt") || lower.includes("openai")) return "openai";
  if (lower.includes("claude") || lower.includes("anthropic")) return "anthropic";
  if (lower.includes("gemini") || lower.includes("google")) return "google";
  return "other";
}

function resolveBuiltinName(toolName: string, context: BuiltinToolContext): string | null {
  const [rawName] = toolName.includes("@") ? toolName.split("@") : [toolName];
  const canonicalName = BUILTIN_TOOL_ALIASES[rawName] || rawName;
  const allowed = new Set(
    (context.builtinToolNames || []).map((name) => BUILTIN_TOOL_ALIASES[name] || name)
  );
  if (!allowed.has(canonicalName)) return null;
  return canonicalName === "web_search" || canonicalName === "web_fetch" ? canonicalName : null;
}

function parseArguments(args: string | Record<string, unknown>): Record<string, unknown> {
  if (typeof args === "object" && args !== null) return args;
  try {
    return JSON.parse(args as string);
  } catch {
    return {};
  }
}

function getResponsesOutputContainer(response: Record<string, unknown> | null | undefined): {
  root: Record<string, unknown>;
  responseRoot: Record<string, unknown>;
  output: unknown[];
} | null {
  if (!response || typeof response !== "object") return null;

  if (Array.isArray(response.output)) {
    return { root: response, responseRoot: response, output: response.output };
  }

  if (
    response.response &&
    typeof response.response === "object" &&
    !Array.isArray(response.response) &&
    Array.isArray((response.response as Record<string, unknown>).output)
  ) {
    return {
      root: response,
      responseRoot: response.response as Record<string, unknown>,
      output: (response.response as Record<string, unknown>).output as unknown[],
    };
  }

  return null;
}

export function extractToolCalls(response: any, modelId: string): ToolCall[] {
  switch (detectProvider(modelId)) {
    case "openai": {
      const rootToolCalls = Array.isArray(response?.tool_calls) ? response.tool_calls : [];
      const choiceToolCalls = Array.isArray(response?.choices)
        ? response.choices.flatMap((choice: any) =>
            Array.isArray(choice?.message?.tool_calls) ? choice.message.tool_calls : []
          )
        : [];
      const responsesOutput = getResponsesOutputContainer(response);
      const responsesToolCalls = responsesOutput
        ? responsesOutput.output
            .map((item: unknown) => (item && typeof item === "object" ? (item as any) : null))
            .filter((item: any) => item?.type === "function_call")
        : [];
      const toolCalls =
        rootToolCalls.length > 0
          ? rootToolCalls
          : choiceToolCalls.length > 0
            ? choiceToolCalls
            : responsesToolCalls;

      return toolCalls.map((tc: any) => ({
        id: tc.call_id || tc.id || `call_${Date.now()}`,
        name: tc.function?.name || tc.name || "",
        arguments: parseArguments(tc.function?.arguments || tc.arguments || "{}"),
      }));
    }

    case "anthropic":
      return (response?.content || [])
        .filter((c: any) => c.type === "tool_use")
        .map((tc: any) => ({ id: tc.id, name: tc.name, arguments: tc.input || {} }));

    case "google":
      return (response?.functionCalls || []).map((fc: any) => ({
        id: `call_${Date.now()}_${Math.random().toString(36).slice(2)}`,
        name: fc.name,
        arguments: fc.args || {},
      }));

    default:
      return [];
  }
}

async function runBuiltin(
  builtinName: string,
  input: Record<string, unknown>,
  context: BuiltinToolContext
): Promise<unknown> {
  if (builtinName === "web_search") {
    const {
      query,
      limit,
      max_results,
      search_type,
      provider,
      country,
      language,
      time_range,
      offset,
      filters,
      content,
      provider_options,
      strict_filters,
    } = input as ExecuteWebSearchInput;
    if (!query) throw new Error("Missing required field: query");
    const search = await executeWebSearch({
      query,
      provider,
      limit,
      max_results,
      search_type,
      country,
      language,
      time_range,
      offset,
      filters,
      content,
      provider_options,
      strict_filters,
      apiKeyId: context.apiKeyId || null,
    });
    return {
      success: true,
      provider: search.data.provider,
      query: search.data.query,
      results: search.data.results,
      answer: search.data.answer,
      usage: search.cached ? { queries_used: 0, search_cost_usd: 0 } : search.data.usage,
      metrics: search.data.metrics,
      cached: search.cached,
      context: context.apiKeyId,
    };
  }

  const { url, format, depth, wait_for_selector, include_metadata, provider } = input as {
    url?: string;
    format?: "markdown" | "html" | "links" | "screenshot";
    depth?: 0 | 1 | 2;
    wait_for_selector?: string;
    include_metadata?: boolean;
    provider?: string;
  };
  if (!url || typeof url !== "string") throw new Error("Missing required field: url");
  const fetched = await executeWebFetch({
    url,
    format,
    depth,
    wait_for_selector,
    include_metadata,
    provider,
    ruleProvider: context.provider ?? null,
    ruleModel: context.model ?? null,
  });
  return {
    success: true,
    provider: fetched.provider,
    url: fetched.url,
    content: fetched.content,
    links: fetched.links,
    metadata: fetched.metadata,
    screenshot_url: fetched.screenshot_url,
    context: context.apiKeyId,
  };
}

async function executeCalls(
  toolCalls: ToolCall[],
  context: BuiltinToolContext
): Promise<{ id: string; result: unknown }[]> {
  return Promise.all(
    toolCalls.map(async (call) => {
      const builtinName = resolveBuiltinName(call.name, context);
      try {
        const result = await runBuiltin(builtinName as string, call.arguments, context);
        log.info("builtin_tool.execution_complete", { toolName: call.name, callId: call.id });
        return { id: call.id, result };
      } catch (err) {
        log.error("builtin_tool.execution_failed", {
          toolName: call.name,
          callId: call.id,
          err: err instanceof Error ? err.message : String(err),
        });
        return { id: call.id, result: { error: err instanceof Error ? err.message : String(err) } };
      }
    })
  );
}

/**
 * Run any allowed builtin tool calls present in `response` and splice their
 * results back in. Returns `response` untouched when there is nothing to run.
 */
export async function handleBuiltinToolExecution(
  response: any,
  modelId: string,
  context: BuiltinToolContext
): Promise<any> {
  const toolCalls = extractToolCalls(response, modelId).filter(
    (call) => typeof call?.name === "string" && call.name && resolveBuiltinName(call.name, context)
  );

  if (toolCalls.length === 0) return response;

  const results = await executeCalls(toolCalls, context);

  switch (detectProvider(modelId)) {
    case "openai": {
      const responsesOutput = getResponsesOutputContainer(response);
      if (responsesOutput) {
        const functionOutputs = results.map((result) => ({
          type: "function_call_output",
          call_id: result.id,
          output: JSON.stringify(result.result),
        }));

        if (responsesOutput.root === responsesOutput.responseRoot) {
          return { ...response, output: [...responsesOutput.output, ...functionOutputs] };
        }

        return {
          ...response,
          response: {
            ...responsesOutput.responseRoot,
            output: [...responsesOutput.output, ...functionOutputs],
          },
        };
      }

      return {
        ...response,
        tool_results: results.map((r) => ({
          tool_call_id: r.id,
          output: JSON.stringify(r.result),
        })),
      };
    }

    case "anthropic": {
      // Anthropic only permits tool_result blocks in user messages, and this
      // helper returns a single assistant response — so the handled tool_use
      // blocks are dropped and their results surface as assistant text instead
      // of corrupting history with assistant-side tool_result blocks (#2815).
      //
      // When no client-native tool_use blocks remain, the upstream stop_reason
      // "tool_use" is stale and would make clients wait for blocks that no
      // longer exist, so it is normalized to "end_turn".
      const handledToolCallIds = new Set(results.map((r) => r.id));
      const toolNamesById = new Map(toolCalls.map((call) => [call.id, call.name]));
      const remainingContent = (Array.isArray(response.content) ? response.content : []).filter(
        (block: any) => !(block?.type === "tool_use" && handledToolCallIds.has(block.id))
      );
      const resultTextBlocks = results.map((r) => ({
        type: "text",
        text: `[Tool result: ${toolNamesById.get(r.id) || r.id}]\n${JSON.stringify(r.result)}`,
      }));
      const firstRemainingToolUseIndex = remainingContent.findIndex(
        (block: any) => block?.type === "tool_use"
      );

      if (firstRemainingToolUseIndex === -1) {
        return {
          ...response,
          content: [...remainingContent, ...resultTextBlocks],
          stop_reason: "end_turn",
          stop_sequence: null,
        };
      }

      return {
        ...response,
        content: [
          ...remainingContent.slice(0, firstRemainingToolUseIndex),
          ...resultTextBlocks,
          ...remainingContent.slice(firstRemainingToolUseIndex),
        ],
      };
    }

    default:
      return response;
  }
}
