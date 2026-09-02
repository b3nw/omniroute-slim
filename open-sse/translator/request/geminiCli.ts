import { createHash, randomBytes, randomUUID } from "crypto";
import { getGeminiThoughtSignature } from "../../services/geminiThoughtSignatureStore.ts";

export const CCPA_AI_MODEL_MAPPINGS: Record<string, string> = {
  "gemini-3.5-flash": "gemini-3-flash",
};

export const GEMINI3_TOOL_PREFIX = "gemini3_";

export const GEMINI3_TOOL_RENAMES: Record<string, string> = {
  // Problematic tool names can be mapped here if needed
};

export const GEMINI3_TOOL_RENAMES_REVERSE: Record<string, string> = Object.fromEntries(
  Object.entries(GEMINI3_TOOL_RENAMES).map(([k, v]) => [v, k])
);

export const DEFAULT_GEMINI3_SYSTEM_INSTRUCTION = `<CRITICAL_TOOL_USAGE_INSTRUCTIONS>
You are operating in a CUSTOM ENVIRONMENT where tool definitions COMPLETELY DIFFER from your training data.
VIOLATION OF THESE RULES WILL CAUSE IMMEDIATE SYSTEM FAILURE.

## ABSOLUTE RULES - NO EXCEPTIONS

1. **SCHEMA IS LAW**: The JSON schema in each tool definition is the ONLY source of truth.
   - Your pre-trained knowledge about tools like 'read_file', 'apply_diff', 'write_to_file', 'bash', etc. is INVALID here.
   - Every tool has been REDEFINED with different parameters than what you learned during training.

2. **PARAMETER NAMES ARE EXACT**: Use ONLY the parameter names from the schema.
   - WRONG: 'suggested_answers', 'file_path', 'files_to_read', 'command_to_run'
   - RIGHT: Check the 'properties' field in the schema for the exact names
   - The schema's 'required' array tells you which parameters are mandatory

3. **ARRAY PARAMETERS**: When a parameter has "type": "array", check the 'items' field:
   - If items.type is "object", you MUST provide an array of objects with the EXACT properties listed
   - If items.type is "string", you MUST provide an array of strings
   - NEVER provide a single object when an array is expected
   - NEVER provide an array when a single value is expected

4. **NESTED OBJECTS**: When items.type is "object":
   - Check items.properties for the EXACT field names required
   - Check items.required for which nested fields are mandatory
   - Include ALL required nested fields in EVERY array element

5. **STRICT PARAMETERS HINT**: Tool descriptions contain "STRICT PARAMETERS: ..." which lists:
   - Parameter name, type, and whether REQUIRED
   - For arrays of objects: the nested structure in brackets like [field: type REQUIRED, ...]
   - USE THIS as your quick reference, but the JSON schema is authoritative

6. **BEFORE EVERY TOOL CALL**:
   a. Read the tool's 'parametersJsonSchema' or 'parameters' field completely
   b. Identify ALL required parameters
   c. Verify your parameter names match EXACTLY (case-sensitive)
   d. For arrays, verify you're providing the correct item structure
   e. Do NOT add parameters that don't exist in the schema

## COMMON FAILURE PATTERNS TO AVOID

- Using 'path' when schema says 'filePath' (or vice versa)
- Using 'content' when schema says 'text' (or vice versa)  
- Providing {"file": "..."} when schema wants [{"path": "...", "line_ranges": [...]}]
- Omitting required nested fields in array items
- Adding 'additionalProperties' that the schema doesn't define
- Guessing parameter names from similar tools you know from training

## REMEMBER
Your training data about function calling is OUTDATED for this environment.
The tool names may look familiar, but the schemas are DIFFERENT.
When in doubt, RE-READ THE SCHEMA before making the call.
</CRITICAL_TOOL_USAGE_INSTRUCTIONS>`;

export const DEFAULT_GEMINI3_DESCRIPTION_PROMPT =
  "\n\n⚠️ STRICT PARAMETERS (use EXACTLY as shown): {params}. Do NOT use parameters from your training data - use ONLY these parameter names.";

export const DEFAULT_SAFETY_SETTINGS = [
  { category: "HARM_CATEGORY_HARASSMENT", threshold: "OFF" },
  { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "OFF" },
  { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "OFF" },
  { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "OFF" },
];

export function mapModelToGeminiCliWire(model: string): string {
  if (!model || typeof model !== "string") return "gemini-3-flash";
  const rawModel = model.includes("/") ? (model.split("/").pop() ?? model) : model;
  const baseModel = rawModel.replace(/:thinking$/, "");
  return CCPA_AI_MODEL_MAPPINGS[baseModel] || baseModel;
}

export function isGemini3(model: string): boolean {
  if (!model || typeof model !== "string") return false;
  const rawModel = model.includes("/") ? (model.split("/").pop() ?? model) : model;
  const baseModel = rawModel.replace(/:thinking$/, "");
  return baseModel.startsWith("gemini-3-") || baseModel.startsWith("gemini-3.");
}

export function needsThoughtSignature(model: string): boolean {
  if (!model || typeof model !== "string") return false;
  const rawModel = model.includes("/") ? (model.split("/").pop() ?? model) : model;
  const baseModel = rawModel.replace(/:thinking$/, "");
  return (
    baseModel.startsWith("gemini-3-") ||
    baseModel.startsWith("gemini-3.") ||
    baseModel.startsWith("gemini-2.5-")
  );
}

export function buildGeminiCliClientMetadata(projectId?: string): Record<string, string> {
  return {
    ideType: "IDE_UNSPECIFIED",
    platform: "PLATFORM_UNSPECIFIED",
    pluginType: "GEMINI",
    duetProject: projectId || "",
  };
}

export function generateUserPromptId(): string {
  return randomBytes(7).toString("hex");
}

export function generateStableSessionId(
  contents: Array<{ role?: string; parts?: Array<Record<string, unknown>> }>
): string {
  const anchors: string[] = [];

  for (const content of contents) {
    const role = content.role || "";
    const parts = Array.isArray(content.parts) ? content.parts : [];
    for (const part of parts) {
      if (!part || typeof part !== "object") continue;

      const text = typeof part.text === "string" ? part.text.trim() : "";
      if (text.length >= 24 && text.split(/\s+/).filter(Boolean).length >= 4) {
        const hash = createHash("sha256").update(text, "utf8").digest("hex");
        anchors.push(`text:${role}:${hash}`);
      }

      const functionCall = (part.functionCall || part.function_call) as
        Record<string, unknown> | undefined;
      if (functionCall && typeof functionCall === "object") {
        const name = (functionCall.name as string) || "";
        const callId = (functionCall.id || functionCall.call_id || "") as string;
        anchors.push(`function_call:${name}:${callId}`);
      }

      const functionResponse = (part.functionResponse || part.function_response) as
        Record<string, unknown> | undefined;
      if (functionResponse && typeof functionResponse === "object") {
        const name = (functionResponse.name as string) || "";
        const responseId = (functionResponse.id || functionResponse.call_id || "") as string;
        anchors.push(`function_response:${name}:${responseId}`);
      }
    }
  }

  const uniqueAnchors = Array.from(new Set(anchors)).sort();

  if (uniqueAnchors.length >= 2 || uniqueAnchors.some((a) => a.startsWith("function_"))) {
    const digest = createHash("sha256")
      .update(JSON.stringify(uniqueAnchors.slice(0, 16)), "utf8")
      .digest();
    return `${digest.subarray(0, 4).toString("hex")}-${digest.subarray(4, 6).toString("hex")}-${digest.subarray(6, 8).toString("hex")}-${digest.subarray(8, 10).toString("hex")}-${digest.subarray(10, 16).toString("hex")}`;
  }

  return randomUUID();
}

export function inlineSchemaRefs(schema: unknown): unknown {
  if (!schema || typeof schema !== "object") return schema;
  if (Array.isArray(schema)) {
    return schema.map((item) => inlineSchemaRefs(item));
  }

  const rec = schema as Record<string, unknown>;
  const defs = (rec.$defs || rec.definitions) as Record<string, unknown> | undefined;

  function resolve(node: unknown, seen: Set<string>): unknown {
    if (Array.isArray(node)) {
      return node.map((item) => resolve(item, seen));
    }
    if (!node || typeof node !== "object") {
      return node;
    }

    const nodeObj = { ...(node as Record<string, unknown>) };
    if (typeof nodeObj.$ref === "string") {
      const ref = nodeObj.$ref;
      if (seen.has(ref)) {
        delete nodeObj.$ref;
        return Object.fromEntries(Object.entries(nodeObj).map(([k, v]) => [k, resolve(v, seen)]));
      }

      let refName: string | null = null;
      for (const prefix of ["#/$defs/", "#/definitions/"]) {
        if (ref.startsWith(prefix)) {
          refName = ref.slice(prefix.length);
          break;
        }
      }

      if (refName && defs && refName in defs) {
        const target = defs[refName];
        const newSeen = new Set(seen);
        newSeen.add(ref);
        delete nodeObj.$ref;
        const resolvedTarget = resolve(JSON.parse(JSON.stringify(target)), newSeen);
        if (
          resolvedTarget &&
          typeof resolvedTarget === "object" &&
          !Array.isArray(resolvedTarget)
        ) {
          return resolve({ ...(resolvedTarget as Record<string, unknown>), ...nodeObj }, newSeen);
        }
      }

      delete nodeObj.$ref;
      return Object.fromEntries(Object.entries(nodeObj).map(([k, v]) => [k, resolve(v, seen)]));
    }

    return Object.fromEntries(Object.entries(nodeObj).map(([k, v]) => [k, resolve(v, seen)]));
  }

  return resolve(schema, new Set<string>());
}

export function cleanGeminiCliSchema(schema: unknown): unknown {
  if (!schema || typeof schema !== "object") return schema;
  if (Array.isArray(schema)) {
    return schema.map((item) => cleanGeminiCliSchema(item));
  }

  const rec = { ...(schema as Record<string, unknown>) };

  if (Array.isArray(rec.type)) {
    const types = rec.type as string[];
    if (types.includes("null")) {
      rec.nullable = true;
      const remaining = types.filter((t) => t !== "null");
      if (remaining.length === 1) {
        rec.type = remaining[0];
      } else if (remaining.length > 1) {
        rec.type = remaining;
      } else {
        delete rec.type;
      }
    } else if (types.length === 1) {
      rec.type = types[0];
    }
  }

  if (rec.properties && typeof rec.properties === "object" && !Array.isArray(rec.properties)) {
    const props = rec.properties as Record<string, unknown>;
    const cleanedProps: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(props)) {
      cleanedProps[key] = cleanGeminiCliSchema(value);
    }
    rec.properties = cleanedProps;
  }

  if (rec.items && typeof rec.items === "object") {
    rec.items = cleanGeminiCliSchema(rec.items);
  }

  delete rec.strict;
  delete rec.$schema;
  delete rec.$id;
  delete rec.$defs;
  delete rec.definitions;

  return rec;
}

export function enforceStrictSchema(schema: unknown): unknown {
  if (!schema || typeof schema !== "object") return schema;
  if (Array.isArray(schema)) {
    return schema.map((item) => enforceStrictSchema(item));
  }

  const rec = schema as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  let preservedAdditionalProps: unknown = undefined;

  for (const [key, value] of Object.entries(rec)) {
    if (key === "additionalProperties") {
      if (value !== false) {
        preservedAdditionalProps = value;
      }
      continue;
    }
    if (value && typeof value === "object") {
      result[key] = enforceStrictSchema(value);
    } else {
      result[key] = value;
    }
  }

  const schemaType = typeof result.type === "string" ? result.type.toLowerCase() : "";
  if ((schemaType === "object" || result.properties) && result.properties) {
    if (preservedAdditionalProps !== undefined) {
      result.additionalProperties = preservedAdditionalProps;
    } else {
      result.additionalProperties = false;
    }
  }

  return result;
}

export function formatTypeHint(propData: unknown, depth = 0): string {
  if (!propData || typeof propData !== "object") return "unknown";
  const prop = propData as Record<string, unknown>;
  const typeHint = (prop.type as string) || "unknown";

  if (Array.isArray(prop.enum)) {
    if (prop.enum.length <= 5) {
      return `string ENUM[${prop.enum.map((v) => JSON.stringify(v)).join(", ")}]`;
    }
    return `string ENUM[${prop.enum.length} options]`;
  }

  if (prop.const !== undefined) {
    return `string CONST=${JSON.stringify(prop.const)}`;
  }

  if (typeHint === "array" || typeHint === "ARRAY") {
    const items = prop.items as Record<string, unknown> | undefined;
    if (items && typeof items === "object") {
      const itemType = (items.type as string) || "unknown";
      if (itemType === "object" || itemType === "OBJECT") {
        const nestedProps = (items.properties || {}) as Record<string, unknown>;
        const nestedReq = Array.isArray(items.required) ? (items.required as string[]) : [];
        if (Object.keys(nestedProps).length > 0) {
          const nestedList: string[] = [];
          for (const [n, d] of Object.entries(nestedProps)) {
            const t =
              depth < 1
                ? formatTypeHint(d, depth + 1)
                : (d as Record<string, unknown>)?.type || "unknown";
            const req = nestedReq.includes(n) ? " REQUIRED" : "";
            nestedList.push(`${n}: ${t}${req}`);
          }
          return `ARRAY_OF_OBJECTS[${nestedList.join(", ")}]`;
        }
        return "ARRAY_OF_OBJECTS";
      }
      return `ARRAY_OF_${String(itemType).toUpperCase()}`;
    }
    return "ARRAY";
  }

  if (typeHint === "object" || typeHint === "OBJECT") {
    const nestedProps = (prop.properties || {}) as Record<string, unknown>;
    const nestedReq = Array.isArray(prop.required) ? (prop.required as string[]) : [];
    if (Object.keys(nestedProps).length > 0 && depth < 1) {
      const nestedList: string[] = [];
      for (const [n, d] of Object.entries(nestedProps)) {
        const t = (d as Record<string, unknown>)?.type || "unknown";
        const req = nestedReq.includes(n) ? " REQUIRED" : "";
        nestedList.push(`${n}: ${t}${req}`);
      }
      return `object{${nestedList.join(", ")}}`;
    }
  }

  return typeHint;
}

export function injectSignatureIntoDescription(
  funcDecl: Record<string, unknown>,
  descriptionPrompt: string = DEFAULT_GEMINI3_DESCRIPTION_PROMPT
): Record<string, unknown> {
  const schema = (funcDecl.parametersJsonSchema || funcDecl.parameters) as
    Record<string, unknown> | undefined;
  if (!schema || typeof schema !== "object") return funcDecl;

  const properties = (schema.properties || {}) as Record<string, unknown>;
  const required = Array.isArray(schema.required) ? (schema.required as string[]) : [];

  if (Object.keys(properties).length === 0) return funcDecl;

  const paramList: string[] = [];
  for (const [propName, propData] of Object.entries(properties)) {
    if (!propData || typeof propData !== "object") continue;
    const typeHint = formatTypeHint(propData);
    const isRequired = required.includes(propName);
    paramList.push(`${propName} (${typeHint}${isRequired ? ", REQUIRED" : ""})`);
  }

  if (paramList.length > 0) {
    const sigStr = descriptionPrompt.replace("{params}", paramList.join(", "));
    funcDecl.description = `${(funcDecl.description as string) || ""}${sigStr}`;
  }

  return funcDecl;
}

export function transformToolSchemas(tools: unknown[], model = ""): Array<Record<string, unknown>> {
  const transformedDeclarations: Array<Record<string, unknown>> = [];
  const isGem3 = isGemini3(model);

  for (const tool of tools) {
    if (!tool || typeof tool !== "object") continue;
    const toolObj = tool as Record<string, unknown>;

    let funcDef: Record<string, unknown> | null = null;
    if (toolObj.type === "function" && toolObj.function && typeof toolObj.function === "object") {
      funcDef = JSON.parse(JSON.stringify(toolObj.function));
    } else if (typeof toolObj.name === "string") {
      funcDef = JSON.parse(JSON.stringify(toolObj));
    }

    if (!funcDef) continue;

    delete funcDef.strict;

    let schema: Record<string, unknown> | null = null;
    if (funcDef.parameters && typeof funcDef.parameters === "object") {
      schema = funcDef.parameters as Record<string, unknown>;
    } else if (funcDef.parametersJsonSchema && typeof funcDef.parametersJsonSchema === "object") {
      schema = funcDef.parametersJsonSchema as Record<string, unknown>;
    }

    if (schema) {
      schema = inlineSchemaRefs(schema) as Record<string, unknown>;
      schema = cleanGeminiCliSchema(schema) as Record<string, unknown>;

      const props = schema.properties as Record<string, unknown> | undefined;
      if (!props || Object.keys(props).length === 0) {
        schema.type = "OBJECT";
        schema.properties = {
          _confirm: {
            type: "BOOLEAN",
            description: "Confirmation flag",
          },
        };
        schema.required = ["_confirm"];
      }
      funcDef.parametersJsonSchema = schema;
      delete funcDef.parameters;
    } else {
      funcDef.parametersJsonSchema = {
        type: "OBJECT",
        properties: {
          _confirm: {
            type: "BOOLEAN",
            description: "Confirmation flag",
          },
        },
        required: ["_confirm"],
      };
      delete funcDef.parameters;
    }

    if (isGem3) {
      let name = (funcDef.name as string) || "";
      if (name) {
        name = GEMINI3_TOOL_RENAMES[name] || name;
        funcDef.name = `${GEMINI3_TOOL_PREFIX}${name}`;
      }

      if (funcDef.parametersJsonSchema) {
        funcDef.parametersJsonSchema = enforceStrictSchema(funcDef.parametersJsonSchema) as Record<
          string,
          unknown
        >;
      }

      funcDef = injectSignatureIntoDescription(funcDef);
    }

    transformedDeclarations.push(funcDef);
  }

  return transformedDeclarations;
}

export function parseContentParts(content: unknown): Array<Record<string, unknown>> {
  const parts: Array<Record<string, unknown>> = [];
  if (typeof content === "string") {
    if (content) {
      parts.push({ text: content });
    }
    return parts;
  }

  if (!Array.isArray(content)) return parts;

  for (const item of content) {
    if (!item || typeof item !== "object") continue;
    const itemObj = item as Record<string, unknown>;

    if (itemObj.type === "text" || typeof itemObj.text === "string") {
      const text = typeof itemObj.text === "string" ? itemObj.text : "";
      if (text) {
        parts.push({ text });
      }
      continue;
    }

    if (itemObj.type === "image_url") {
      const img = (itemObj.image_url || {}) as Record<string, unknown>;
      const url = typeof img.url === "string" ? img.url : "";
      if (url.startsWith("data:")) {
        const commaIdx = url.indexOf(",");
        if (commaIdx !== -1) {
          const mimePart = url.slice(5, commaIdx);
          const data = url.slice(commaIdx + 1);
          const mimeType = mimePart.split(";")[0] || "image/png";
          parts.push({
            inlineData: {
              mimeType,
              data,
            },
          });
        }
      }
    }
  }

  return parts;
}

export function fixToolResponseGrouping(
  contents: Array<{ role: string; parts: Array<Record<string, unknown>> }>
): Array<{ role: string; parts: Array<Record<string, unknown>> }> {
  const newContents: Array<{ role: string; parts: Array<Record<string, unknown>> }> = [];
  type PendingGroup = {
    ids: string[];
    func_names: string[];
    insert_after_idx: number;
  };
  const pendingGroups: PendingGroup[] = [];
  const collectedResponses = new Map<string, Record<string, unknown>>();

  for (const content of contents) {
    const role = content.role;
    const parts = content.parts || [];

    const responseParts = parts.filter((p) => p && typeof p === "object" && p.functionResponse);

    if (responseParts.length > 0) {
      for (const resp of responseParts) {
        const fr = resp.functionResponse as Record<string, unknown> | undefined;
        const respId = (fr?.id as string) || "";
        if (respId && !collectedResponses.has(respId)) {
          collectedResponses.set(respId, resp);
        }
      }

      for (let i = pendingGroups.length - 1; i >= 0; i--) {
        const group = pendingGroups[i];
        const groupIds = group.ids;

        if (groupIds.every((gid) => collectedResponses.has(gid))) {
          const groupResponses = groupIds.map((gid) => {
            const res = collectedResponses.get(gid)!;
            collectedResponses.delete(gid);
            return res;
          });
          newContents.push({ role: "user", parts: groupResponses });
          pendingGroups.splice(i, 1);
          break;
        }
      }
      continue;
    }

    if (role === "model") {
      const funcCalls = parts.filter((p) => p && typeof p === "object" && p.functionCall);
      newContents.push(content);
      if (funcCalls.length > 0) {
        const callIds = funcCalls
          .map((fc) => ((fc.functionCall as Record<string, unknown>)?.id as string) || "")
          .filter(Boolean);
        const funcNames = funcCalls.map(
          (fc) => ((fc.functionCall as Record<string, unknown>)?.name as string) || ""
        );

        if (callIds.length > 0) {
          pendingGroups.push({
            ids: callIds,
            func_names: funcNames,
            insert_after_idx: newContents.length - 1,
          });
        }
      }
    } else {
      newContents.push(content);
    }
  }

  pendingGroups.sort((a, b) => b.insert_after_idx - a.insert_after_idx);

  for (const group of pendingGroups) {
    const groupIds = group.ids;
    const groupFuncNames = group.func_names;
    const insertIdx = group.insert_after_idx + 1;
    const groupResponses: Array<Record<string, unknown>> = [];

    for (let i = 0; i < groupIds.length; i++) {
      const expectedId = groupIds[i];
      const expectedName = i < groupFuncNames.length ? groupFuncNames[i] : "";

      if (collectedResponses.has(expectedId)) {
        groupResponses.push(collectedResponses.get(expectedId)!);
        collectedResponses.delete(expectedId);
      } else if (collectedResponses.size > 0) {
        let matchedOrphanId: string | null = null;

        for (const [orphanId, orphanResp] of collectedResponses.entries()) {
          const fr = orphanResp.functionResponse as Record<string, unknown> | undefined;
          if (fr?.name === expectedName) {
            matchedOrphanId = orphanId;
            break;
          }
        }

        if (!matchedOrphanId) {
          for (const [orphanId, orphanResp] of collectedResponses.entries()) {
            const fr = orphanResp.functionResponse as Record<string, unknown> | undefined;
            if (fr?.name === "unknown_function") {
              matchedOrphanId = orphanId;
              break;
            }
          }
        }

        if (!matchedOrphanId) {
          matchedOrphanId = collectedResponses.keys().next().value || null;
        }

        if (matchedOrphanId) {
          const orphanResp = collectedResponses.get(matchedOrphanId)!;
          collectedResponses.delete(matchedOrphanId);

          const fr = orphanResp.functionResponse as Record<string, unknown>;
          fr.id = expectedId;
          if (fr.name === "unknown_function" && expectedName) {
            fr.name = expectedName;
          }
          groupResponses.push(orphanResp);
        }
      } else {
        groupResponses.push({
          functionResponse: {
            name: expectedName || "unknown_function",
            response: {
              result: {
                error:
                  "Tool response was lost during context processing. This is a recovered placeholder.",
                recovered: true,
              },
            },
            id: expectedId,
          },
        });
      }
    }

    if (groupResponses.length > 0) {
      newContents.splice(insertIdx, 0, { role: "user", parts: groupResponses });
    }
  }

  return newContents;
}

export const _fix_tool_response_grouping = fixToolResponseGrouping;

export function handleReasoningParameters(
  payload: Record<string, unknown>,
  model: string
): Record<string, unknown> | null {
  const genConfig = (payload.generationConfig || {}) as Record<string, unknown>;
  const thinkingConfig = payload.thinkingConfig || genConfig.thinkingConfig;
  if (thinkingConfig && typeof thinkingConfig === "object") {
    return thinkingConfig as Record<string, unknown>;
  }

  const rawModel = model.includes("/") ? (model.split("/").pop() ?? model) : model;
  const hasThinkingSuffix = rawModel.endsWith(":thinking");
  const baseModel = rawModel.replace(/:thinking$/, "");
  const isGem25 = baseModel.includes("gemini-2.5");
  const isGem3 = isGemini3(baseModel);
  const isGem3Flash =
    baseModel.includes("gemini-3-flash") || baseModel.includes("gemini-3.5-flash");

  if (!isGem25 && !isGem3) return null;

  // 1. Check OpenAI reasoning_effort / reasoningEffort / reasoning
  const reasoningEffort =
    payload.reasoning_effort ??
    payload.reasoningEffort ??
    payload.reasoning ??
    genConfig.reasoning_effort;

  // 2. Check Claude / Anthropic thinking parameter: { type: "enabled" | "adaptive" | "disabled", budget_tokens?: number }
  const claudeThinking = (payload.thinking ?? genConfig.thinking) as
    | { type?: string; budget_tokens?: number; budgetTokens?: number }
    | undefined;

  let effort = "auto";
  let explicitDisabled = false;
  let customBudget: number | null = null;

  if (claudeThinking && typeof claudeThinking === "object") {
    if (
      claudeThinking.type === "disabled" ||
      claudeThinking.budget_tokens === 0 ||
      claudeThinking.budgetTokens === 0
    ) {
      explicitDisabled = true;
      effort = "disable";
    } else if (typeof claudeThinking.budget_tokens === "number" && claudeThinking.budget_tokens > 0) {
      customBudget = claudeThinking.budget_tokens;
      effort = customBudget <= 4096 ? "low" : customBudget <= 16384 ? "medium" : "high";
    } else if (typeof claudeThinking.budgetTokens === "number" && claudeThinking.budgetTokens > 0) {
      customBudget = claudeThinking.budgetTokens;
      effort = customBudget <= 4096 ? "low" : customBudget <= 16384 ? "medium" : "high";
    }
  }

  if (typeof reasoningEffort === "string") {
    const trimmed = reasoningEffort.trim().toLowerCase();
    if (["disable", "off", "none", "0"].includes(trimmed)) {
      explicitDisabled = true;
      effort = "disable";
    } else if (trimmed) {
      effort = trimmed;
    }
  } else if (reasoningEffort === false || reasoningEffort === 0) {
    explicitDisabled = true;
    effort = "disable";
  }

  // Handle explicit disable
  if (explicitDisabled) {
    if (isGem3Flash) {
      return {
        thinkingLevel: "minimal",
        includeThoughts: false,
        include_thoughts: false,
      };
    }
    if (isGem3) {
      return {
        thinkingLevel: "low",
        includeThoughts: false,
        include_thoughts: false,
      };
    }
    return {
      thinkingBudget: 0,
      includeThoughts: false,
      include_thoughts: false,
    };
  }

  // If Gemini 3 Flash / 3.5 Flash
  if (isGem3Flash) {
    let thinkingLevel = "high";
    if (effort === "minimal" || effort === "low") {
      thinkingLevel = "low";
    } else if (effort === "low_medium" || effort === "medium") {
      thinkingLevel = "medium";
    } else {
      thinkingLevel = "high";
    }
    return {
      thinkingLevel,
      includeThoughts: true,
      include_thoughts: true,
    };
  }

  // If Gemini 3 Pro / 3.1 Pro / Preview
  if (isGem3) {
    let thinkingLevel = "high";
    if (["minimal", "low", "low_medium"].includes(effort)) {
      thinkingLevel = "low";
    } else {
      thinkingLevel = "high";
    }
    return {
      thinkingLevel,
      includeThoughts: true,
      include_thoughts: true,
    };
  }

  // Gemini 2.5 (Flash / Pro)
  if (customBudget !== null && customBudget > 0) {
    return {
      thinkingBudget: customBudget,
      includeThoughts: true,
      include_thoughts: true,
    };
  }

  if (effort === "auto" || (reasoningEffort === undefined && !claudeThinking && !hasThinkingSuffix)) {
    return {
      thinkingBudget: -1,
      includeThoughts: true,
      include_thoughts: true,
    };
  }

  if (baseModel.includes("gemini-2.5-flash")) {
    const budgets: Record<string, number> = {
      minimal: 3072,
      low: 6144,
      low_medium: 9216,
      medium: 12288,
      medium_high: 18432,
      high: 24576,
      max: 24576,
      xhigh: 24576,
    };
    return {
      thinkingBudget: budgets[effort] || 12288,
      includeThoughts: true,
      include_thoughts: true,
    };
  } else {
    const budgets: Record<string, number> = {
      minimal: 4096,
      low: 8192,
      low_medium: 12288,
      medium: 16384,
      medium_high: 24576,
      high: 32768,
      max: 32768,
      xhigh: 32768,
    };
    return {
      thinkingBudget: budgets[effort] || 16384,
      includeThoughts: true,
      include_thoughts: true,
    };
  }
}

export function translateToolChoice(
  toolChoice: unknown,
  model = ""
): Record<string, unknown> | null {
  if (!toolChoice) return null;
  const isGem3 = isGemini3(model);

  if (typeof toolChoice === "string") {
    if (toolChoice === "auto") return { functionCallingConfig: { mode: "AUTO" } };
    if (toolChoice === "none") return { functionCallingConfig: { mode: "NONE" } };
    if (toolChoice === "required" || toolChoice === "any")
      return { functionCallingConfig: { mode: "ANY" } };
    return { functionCallingConfig: { mode: "AUTO" } };
  }

  if (typeof toolChoice === "object") {
    const tc = toolChoice as Record<string, unknown>;
    if (tc.type === "function" && tc.function && typeof tc.function === "object") {
      let name = ((tc.function as Record<string, unknown>).name as string) || "";
      if (name) {
        if (isGem3) {
          name = GEMINI3_TOOL_RENAMES[name] || name;
          name = `${GEMINI3_TOOL_PREFIX}${name}`;
        }
        return {
          functionCallingConfig: {
            mode: "ANY",
            allowedFunctionNames: [name],
          },
        };
      }
    }
    if (tc.type === "none") return { functionCallingConfig: { mode: "NONE" } };
    if (tc.type === "required" || tc.type === "any")
      return { functionCallingConfig: { mode: "ANY" } };
  }

  return { functionCallingConfig: { mode: "AUTO" } };
}

export function transformMessages(
  messages: Array<Record<string, unknown>>,
  model = ""
): {
  systemInstruction?: { role: string; parts: Array<{ text: string }> };
  contents: Array<{ role: string; parts: Array<Record<string, unknown>> }>;
} {
  const isGem3 = isGemini3(model);
  const needsSig = needsThoughtSignature(model);
  const contents: Array<{ role: string; parts: Array<Record<string, unknown>> }> = [];
  let systemText = "";

  const toolCallIdToName = new Map<string, string>();
  for (const msg of messages) {
    if (msg.role === "assistant" && Array.isArray(msg.tool_calls)) {
      for (const tc of msg.tool_calls) {
        if (tc && typeof tc === "object" && tc.type === "function" && tc.function) {
          const fn = tc.function as Record<string, unknown>;
          if (typeof tc.id === "string" && typeof fn.name === "string") {
            toolCallIdToName.set(tc.id, fn.name);
          }
        }
      }
    }
  }

  let pendingToolParts: Array<Record<string, unknown>> = [];

  for (const msg of messages) {
    const role = (msg.role as string) || "user";
    const content = msg.content;

    if (role === "system") {
      let extracted = "";
      if (typeof content === "string") {
        extracted = content;
      } else if (Array.isArray(content)) {
        extracted = content
          .map((c) => (typeof c === "string" ? c : (c as Record<string, unknown>)?.text || ""))
          .join("\n");
      }
      if (extracted) {
        systemText = systemText ? `${systemText}\n\n${extracted}` : extracted;
      }
      continue;
    }

    if (pendingToolParts.length > 0 && role !== "tool") {
      contents.push({ role: "user", parts: pendingToolParts });
      pendingToolParts = [];
    }

    if (role === "user") {
      const parts = parseContentParts(content);
      if (parts.length > 0) {
        contents.push({ role: "user", parts });
      }
    } else if (role === "assistant") {
      const parts = parseContentParts(content);
      if (Array.isArray(msg.tool_calls)) {
        let firstFuncInMsg = true;
        for (const tc of msg.tool_calls) {
          if (tc && typeof tc === "object" && tc.type === "function" && tc.function) {
            const fn = tc.function as Record<string, unknown>;
            let funcName = (fn.name as string) || "unknown";
            let argsObj: Record<string, unknown> = {};

            if (typeof fn.arguments === "string") {
              try {
                argsObj = JSON.parse(fn.arguments);
              } catch {
                argsObj = {};
              }
            } else if (fn.arguments && typeof fn.arguments === "object") {
              argsObj = fn.arguments as Record<string, unknown>;
            }

            if (isGem3) {
              funcName = GEMINI3_TOOL_RENAMES[funcName] || funcName;
              funcName = `${GEMINI3_TOOL_PREFIX}${funcName}`;
            }

            const toolId = (tc.id as string) || "";
            const funcPart: Record<string, unknown> = {
              functionCall: {
                name: funcName,
                args: argsObj,
                id: toolId,
              },
            };

            if (needsSig) {
              if (firstFuncInMsg) {
                let sig =
                  (tc.thought_signature as string) ||
                  (tc.thoughtSignature as string) ||
                  (toolId ? getGeminiThoughtSignature(toolId) : null);

                funcPart.thoughtSignature = sig || "skip_thought_signature_validator";
                firstFuncInMsg = false;
              }
            }

            parts.push(funcPart);
          }
        }
      }
      if (parts.length > 0) {
        contents.push({ role: "model", parts });
      }
    } else if (role === "tool") {
      const toolCallId = (msg.tool_call_id as string) || "";
      let funcName = toolCallIdToName.get(toolCallId) || "unknown_function";

      if (isGem3) {
        funcName = GEMINI3_TOOL_RENAMES[funcName] || funcName;
        funcName = `${GEMINI3_TOOL_PREFIX}${funcName}`;
      }

      let parsedContent: unknown = content;
      if (typeof content === "string") {
        try {
          parsedContent = JSON.parse(content);
        } catch {
          parsedContent = content;
        }
      }

      pendingToolParts.push({
        functionResponse: {
          name: funcName,
          response: {
            result: parsedContent,
          },
          id: toolCallId,
        },
      });
    }
  }

  if (pendingToolParts.length > 0) {
    contents.push({ role: "user", parts: pendingToolParts });
  }

  if (contents.length === 0 || contents[0].role !== "user") {
    contents.unshift({ role: "user", parts: [{ text: "" }] });
  }

  return {
    systemInstruction: systemText
      ? {
          role: "user",
          parts: [{ text: systemText }],
        }
      : undefined,
    contents,
  };
}

export function translateChatRequestToGeminiCli(
  request: Record<string, unknown>,
  connection?: { projectId?: string; tier?: string } | null
): {
  urlAction: string;
  body: Record<string, unknown>;
  wireModel: string;
} {
  const model = String(request.model || "gemini-3-flash");
  const wireModel = mapModelToGeminiCliWire(model);
  const isGem3 = isGemini3(model);
  const projectId = connection?.projectId || "";

  const genConfig: Record<string, unknown> = {
    maxOutputTokens: typeof request.max_tokens === "number" ? request.max_tokens : 64000,
    temperature: typeof request.temperature === "number" ? request.temperature : 1.0,
  };

  if (typeof request.top_p === "number") {
    genConfig.topP = request.top_p;
  }
  if (typeof request.top_k === "number") {
    genConfig.topK = request.top_k;
  }

  const thinkingConfig = handleReasoningParameters(request, model);
  if (thinkingConfig) {
    genConfig.thinkingConfig = thinkingConfig;
  }

  const rawMessages = Array.isArray(request.messages)
    ? (request.messages as Array<Record<string, unknown>>)
    : [];
  const { systemInstruction, contents } = transformMessages(rawMessages, model);

  const groupedContents = fixToolResponseGrouping(contents);

  let finalSystemInstruction = systemInstruction;

  let toolsList: Array<{ functionDeclarations: Array<Record<string, unknown>> }> | undefined;
  if (Array.isArray(request.tools) && request.tools.length > 0) {
    const decls = transformToolSchemas(request.tools, model);
    if (decls.length > 0) {
      toolsList = [{ functionDeclarations: decls }];

      if (isGem3) {
        if (finalSystemInstruction && finalSystemInstruction.parts.length > 0) {
          const currentText = finalSystemInstruction.parts[0].text;
          finalSystemInstruction = {
            role: "user",
            parts: [{ text: `${DEFAULT_GEMINI3_SYSTEM_INSTRUCTION}\n\n${currentText}` }],
          };
        } else {
          finalSystemInstruction = {
            role: "user",
            parts: [{ text: DEFAULT_GEMINI3_SYSTEM_INSTRUCTION }],
          };
        }
      }
    }
  }

  const toolConfig = translateToolChoice(request.tool_choice, model);

  const userPromptId = generateUserPromptId();
  const sessionId = generateStableSessionId(groupedContents);

  const requestPayload: Record<string, unknown> = {
    contents: groupedContents,
    generationConfig: genConfig,
    session_id: sessionId,
    safetySettings: Array.isArray(request.safetySettings)
      ? request.safetySettings
      : DEFAULT_SAFETY_SETTINGS,
  };

  if (finalSystemInstruction) {
    requestPayload.systemInstruction = finalSystemInstruction;
  }

  if (toolsList && toolsList.length > 0) {
    requestPayload.tools = toolsList;
  }

  if (toolConfig) {
    requestPayload.toolConfig = toolConfig;
  }

  const body: Record<string, unknown> = {
    model: wireModel,
    project: projectId,
    user_prompt_id: userPromptId,
    request: requestPayload,
  };

  return {
    urlAction: ":streamGenerateContent?alt=sse",
    body,
    wireModel,
  };
}
