import { storeGeminiThoughtSignature } from "../geminiThoughtSignatureStore.ts";
import {
  GEMINI3_TOOL_PREFIX,
  GEMINI3_TOOL_RENAMES_REVERSE,
  isGemini3,
  needsThoughtSignature,
} from "../request/geminiCli.ts";

export const FINISH_REASON_MAP: Record<string, string> = {
  STOP: "stop",
  MAX_TOKENS: "length",
  SAFETY: "content_filter",
  RECITATION: "content_filter",
  MALFORMED_FUNCTION_CALL: "tool_calls",
  UNEXPECTED_TOOL_CALL: "tool_calls",
  OTHER: "stop",
};

export type GeminiCliResponseAccumulator = {
  tool_idx?: number;
  has_tool_calls?: boolean;
  is_complete?: boolean;
};

export function stripGemini3Prefix(name: string): string {
  if (name && name.startsWith(GEMINI3_TOOL_PREFIX)) {
    const stripped = name.slice(GEMINI3_TOOL_PREFIX.length);
    return GEMINI3_TOOL_RENAMES_REVERSE[stripped] || stripped;
  }
  return name;
}

export function buildUsageBlock(
  usageMeta: Record<string, unknown>
): Record<string, unknown> | undefined {
  if (!usageMeta || typeof usageMeta !== "object") return undefined;

  const promptTokens =
    typeof usageMeta.promptTokenCount === "number" ? usageMeta.promptTokenCount : 0;
  const thoughtsTokens =
    typeof usageMeta.thoughtsTokenCount === "number" ? usageMeta.thoughtsTokenCount : 0;
  const candidateTokens =
    typeof usageMeta.candidatesTokenCount === "number" ? usageMeta.candidatesTokenCount : 0;
  const cachedTokens =
    typeof usageMeta.cachedContentTokenCount === "number" ? usageMeta.cachedContentTokenCount : 0;
  const totalTokens =
    typeof usageMeta.totalTokenCount === "number"
      ? usageMeta.totalTokenCount
      : promptTokens + candidateTokens + thoughtsTokens;

  const usage: Record<string, unknown> = {
    prompt_tokens: promptTokens,
    completion_tokens: candidateTokens + thoughtsTokens,
    total_tokens: totalTokens,
  };

  if (cachedTokens > 0) {
    usage.prompt_tokens_details = {
      cached_tokens: cachedTokens,
    };
  }

  if (thoughtsTokens > 0) {
    usage.completion_tokens_details = {
      reasoning_tokens: thoughtsTokens,
    };
  }

  return usage;
}

export function translateGeminiCliChunkToOpenAI(
  chunk: Record<string, unknown>,
  model: string,
  accumulator?: GeminiCliResponseAccumulator
): Array<Record<string, unknown>> | null {
  if (!chunk || typeof chunk !== "object") return null;

  const responseData = (
    chunk.response && typeof chunk.response === "object" ? chunk.response : chunk
  ) as Record<string, unknown>;

  const candidates = Array.isArray(responseData.candidates)
    ? (responseData.candidates as Array<Record<string, unknown>>)
    : [];

  const responseId =
    (chunk.responseId as string) ||
    (responseData.responseId as string) ||
    (chunk.id as string) ||
    `chatcmpl-geminicli-${Date.now()}`;
  const created = Math.floor(Date.now() / 1000);

  const usageMeta = responseData.usageMetadata as Record<string, unknown> | undefined;
  const usageBlock = usageMeta ? buildUsageBlock(usageMeta) : undefined;

  const results: Array<Record<string, unknown>> = [];

  if (candidates.length > 0) {
    const candidate = candidates[0];
    const content = (candidate.content || {}) as Record<string, unknown>;
    const parts = Array.isArray(content.parts)
      ? (content.parts as Array<Record<string, unknown>>)
      : [];
    const isGem3 = isGemini3(model);
    const needsSig = needsThoughtSignature(model);

    for (const part of parts) {
      if (!part || typeof part !== "object") continue;

      const delta: Record<string, unknown> = {};
      const hasFunc = Boolean(part.functionCall && typeof part.functionCall === "object");
      const hasText = typeof part.text === "string" && part.text.length > 0;
      const hasSig = Boolean(part.thoughtSignature);
      const isThought =
        part.thought === true ||
        (typeof part.thought === "string" && part.thought.toLowerCase() === "true");

      if (hasSig && !hasFunc && (!hasText || !part.text)) {
        continue;
      }

      if (hasFunc) {
        const fc = part.functionCall as Record<string, unknown>;
        let funcName = (fc.name as string) || "unknown";
        if (isGem3) {
          funcName = stripGemini3Prefix(funcName);
        }

        const toolCallId =
          (fc.id as string) || `call_${funcName}_${Date.now()}_${accumulator?.tool_idx ?? 0}`;
        const currentToolIdx = accumulator?.tool_idx ?? 0;

        let rawArgs: Record<string, unknown> = {};
        if (typeof fc.args === "string") {
          try {
            rawArgs = JSON.parse(fc.args);
          } catch {
            rawArgs = {};
          }
        } else if (fc.args && typeof fc.args === "object") {
          rawArgs = { ...(fc.args as Record<string, unknown>) };
        }

        if ("_confirm" in rawArgs && Object.keys(rawArgs).length === 1) {
          delete rawArgs._confirm;
        }

        if (needsSig && hasSig) {
          const sig = part.thoughtSignature as string;
          storeGeminiThoughtSignature(toolCallId, sig);
        }

        const toolCall: Record<string, unknown> = {
          index: currentToolIdx,
          id: toolCallId,
          type: "function",
          function: {
            name: funcName,
            arguments: JSON.stringify(rawArgs),
          },
        };

        if (needsSig && hasSig) {
          toolCall.thought_signature = part.thoughtSignature;
        }

        delta.tool_calls = [toolCall];

        if (accumulator) {
          accumulator.has_tool_calls = true;
          accumulator.tool_idx = currentToolIdx + 1;
        }
      } else if (hasText) {
        if (isThought || (hasSig && !hasFunc)) {
          delta.reasoning_content = part.text;
        } else {
          delta.content = part.text;
        }
      }

      if (Object.keys(delta).length > 0) {
        const chunkObj: Record<string, unknown> = {
          id: responseId,
          object: "chat.completion.chunk",
          created,
          model,
          choices: [
            {
              index: 0,
              delta,
              finish_reason: null,
            },
          ],
        };

        if (usageBlock) {
          chunkObj.usage = usageBlock;
        }

        results.push(chunkObj);
      }
    }

    if (candidate.finishReason) {
      const rawFinish = candidate.finishReason as string;
      let finishReason = FINISH_REASON_MAP[rawFinish] || rawFinish.toLowerCase();
      if (accumulator?.has_tool_calls) {
        finishReason = "tool_calls";
      }

      const finalChunk: Record<string, unknown> = {
        id: responseId,
        object: "chat.completion.chunk",
        created,
        model,
        choices: [
          {
            index: 0,
            delta: {},
            finish_reason: finishReason,
          },
        ],
      };

      if (usageBlock) {
        finalChunk.usage = usageBlock;
      }

      if (accumulator) {
        accumulator.is_complete = true;
      }

      results.push(finalChunk);
    }
  }

  if (results.length === 0 && usageBlock) {
    if (accumulator) {
      accumulator.is_complete = true;
    }
    results.push({
      id: responseId,
      object: "chat.completion.chunk",
      created,
      model,
      choices: [
        {
          index: 0,
          delta: {},
          finish_reason: null,
        },
      ],
      usage: usageBlock,
    });
  }

  return results.length > 0 ? results : null;
}

export function translateGeminiCliResponseToOpenAI(
  response: Record<string, unknown>,
  model: string
): Record<string, unknown> {
  if (!response || typeof response !== "object") {
    throw new Error("Invalid response provided for translation");
  }

  const responseData = (
    response.response && typeof response.response === "object" ? response.response : response
  ) as Record<string, unknown>;

  const responseId =
    (response.responseId as string) ||
    (responseData.responseId as string) ||
    (response.id as string) ||
    `chatcmpl-geminicli-${Date.now()}`;
  const created = Math.floor(Date.now() / 1000);

  const candidates = Array.isArray(responseData.candidates)
    ? (responseData.candidates as Array<Record<string, unknown>>)
    : [];

  let contentText = "";
  let reasoningContent = "";
  const toolCalls: Array<Record<string, unknown>> = [];
  let chunkFinishReason: string | null = null;
  const isGem3 = isGemini3(model);
  const needsSig = needsThoughtSignature(model);

  if (candidates.length > 0) {
    const candidate = candidates[0];
    const contentObj = (candidate.content || {}) as Record<string, unknown>;
    const parts = Array.isArray(contentObj.parts)
      ? (contentObj.parts as Array<Record<string, unknown>>)
      : [];

    for (const part of parts) {
      if (!part || typeof part !== "object") continue;

      const isThought =
        part.thought === true ||
        (typeof part.thought === "string" && part.thought.toLowerCase() === "true");

      if (part.functionCall && typeof part.functionCall === "object") {
        const fc = part.functionCall as Record<string, unknown>;
        let funcName = (fc.name as string) || "unknown";
        if (isGem3) {
          funcName = stripGemini3Prefix(funcName);
        }

        const toolCallId =
          (fc.id as string) || `call_${funcName}_${Date.now()}_${toolCalls.length}`;

        let rawArgs: Record<string, unknown> = {};
        if (typeof fc.args === "string") {
          try {
            rawArgs = JSON.parse(fc.args);
          } catch {
            rawArgs = {};
          }
        } else if (fc.args && typeof fc.args === "object") {
          rawArgs = { ...(fc.args as Record<string, unknown>) };
        }

        if ("_confirm" in rawArgs && Object.keys(rawArgs).length === 1) {
          delete rawArgs._confirm;
        }

        if (needsSig && part.thoughtSignature) {
          storeGeminiThoughtSignature(toolCallId, part.thoughtSignature as string);
        }

        const toolCall: Record<string, unknown> = {
          id: toolCallId,
          type: "function",
          function: {
            name: funcName,
            arguments: JSON.stringify(rawArgs),
          },
        };

        if (needsSig && part.thoughtSignature) {
          toolCall.thought_signature = part.thoughtSignature;
        }

        toolCalls.push(toolCall);
      } else if (typeof part.text === "string") {
        if (isThought || (needsSig && part.thoughtSignature && !part.functionCall)) {
          reasoningContent += part.text;
        } else {
          contentText += part.text;
        }
      }
    }

    if (candidate.finishReason) {
      chunkFinishReason = candidate.finishReason as string;
    }
  }

  let finishReason = "stop";
  if (toolCalls.length > 0) {
    finishReason = "tool_calls";
  } else if (chunkFinishReason) {
    finishReason = FINISH_REASON_MAP[chunkFinishReason] || chunkFinishReason.toLowerCase();
  }

  const usageMeta = responseData.usageMetadata as Record<string, unknown> | undefined;
  const usage = usageMeta ? buildUsageBlock(usageMeta) : undefined;

  const finalMessage: Record<string, unknown> = {
    role: "assistant",
    content: contentText || null,
  };

  if (reasoningContent) {
    finalMessage.reasoning_content = reasoningContent;
  }

  if (toolCalls.length > 0) {
    finalMessage.tool_calls = toolCalls;
  }

  return {
    id: responseId,
    object: "chat.completion",
    created,
    model,
    choices: [
      {
        index: 0,
        message: finalMessage,
        finish_reason: finishReason,
      },
    ],
    ...(usage ? { usage } : {}),
  };
}

export function reassembleGeminiCliChunks(
  chunks: Array<Record<string, unknown>>,
  model: string
): Record<string, unknown> {
  if (!chunks || chunks.length === 0) {
    throw new Error("No chunks provided for reassembly");
  }

  const firstChunk = chunks[0];
  const responseId =
    (firstChunk.id as string) ||
    (firstChunk.responseId as string) ||
    `chatcmpl-geminicli-${Date.now()}`;
  const created = (firstChunk.created as number) || Math.floor(Date.now() / 1000);

  let content = "";
  let reasoningContent = "";
  const aggregatedToolCalls = new Map<
    number,
    { id: string; type: string; function: { name: string; arguments: string } }
  >();
  let lastUsage: Record<string, unknown> | undefined = undefined;
  let chunkFinishReason: string | null = null;

  for (const chunk of chunks) {
    if (chunk.usage && typeof chunk.usage === "object") {
      lastUsage = chunk.usage as Record<string, unknown>;
    }

    const choices = Array.isArray(chunk.choices)
      ? (chunk.choices as Array<Record<string, unknown>>)
      : [];
    if (choices.length === 0) continue;

    const choice = choices[0];
    const delta = (choice.delta || {}) as Record<string, unknown>;

    if (typeof delta.content === "string") {
      content += delta.content;
    }
    if (typeof delta.reasoning_content === "string") {
      reasoningContent += delta.reasoning_content;
    }

    if (Array.isArray(delta.tool_calls)) {
      for (const tc of delta.tool_calls) {
        if (!tc || typeof tc !== "object") continue;
        const tcObj = tc as Record<string, unknown>;
        const index = typeof tcObj.index === "number" ? tcObj.index : 0;

        if (!aggregatedToolCalls.has(index)) {
          aggregatedToolCalls.set(index, {
            id: (tcObj.id as string) || "",
            type: "function",
            function: { name: "", arguments: "" },
          });
        }

        const current = aggregatedToolCalls.get(index)!;
        if (tcObj.id) {
          current.id = tcObj.id as string;
        }

        const fn = (tcObj.function || {}) as Record<string, unknown>;
        if (typeof fn.name === "string") {
          current.function.name += fn.name;
        }
        if (typeof fn.arguments === "string") {
          current.function.arguments += fn.arguments;
        }
      }
    }

    if (choice.finish_reason && typeof choice.finish_reason === "string") {
      chunkFinishReason = choice.finish_reason;
    }
  }

  const toolCallsList = Array.from(aggregatedToolCalls.values());

  let finishReason = "stop";
  if (toolCallsList.length > 0) {
    finishReason = "tool_calls";
  } else if (chunkFinishReason) {
    finishReason = chunkFinishReason;
  }

  const message: Record<string, unknown> = {
    role: "assistant",
    content: content || null,
  };

  if (reasoningContent) {
    message.reasoning_content = reasoningContent;
  }

  if (toolCallsList.length > 0) {
    message.tool_calls = toolCallsList;
  }

  return {
    id: responseId,
    object: "chat.completion",
    created,
    model,
    choices: [
      {
        index: 0,
        message,
        finish_reason: finishReason,
      },
    ],
    ...(lastUsage ? { usage: lastUsage } : {}),
  };
}
