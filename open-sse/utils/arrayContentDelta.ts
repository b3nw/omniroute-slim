type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function partsText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value.map((part) => (isRecord(part) && typeof part.text === "string" ? part.text : "")).join("");
}

export function normalizeArrayContentDelta(delta: JsonRecord): boolean {
  if (!Array.isArray(delta.content)) return false;
  let text = "";
  let thinking = "";
  for (const part of delta.content) {
    if (!isRecord(part)) continue;
    if (part.type === "text" && typeof part.text === "string") text += part.text;
    else if (part.type === "thinking") thinking += partsText(part.thinking);
  }
  if (text) delta.content = text;
  else delete delta.content;
  if (thinking) delta.reasoning_content = (typeof delta.reasoning_content === "string" ? delta.reasoning_content : "") + thinking;
  return true;
}

export function normalizeArrayContentChunk(chunk: unknown): boolean {
  if (!isRecord(chunk) || !Array.isArray(chunk.choices)) return false;
  let changed = false;
  for (const choice of chunk.choices) {
    if (isRecord(choice) && isRecord(choice.delta)) {
      changed = normalizeArrayContentDelta(choice.delta) || changed;
    }
  }
  return changed;
}
