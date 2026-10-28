import fs from "node:fs";
import path from "node:path";
import type { RequestPipelinePayloads } from "@omniroute/open-sse/utils/requestLogger.ts";
import { resolveDataDir } from "../dataPaths";
import {
  getCallLogArtifactPreviewBytes,
  getCallLogPipelineMaxSizeBytes,
  isChatDebugFileEnabled,
} from "../logEnv";

const isCloud = typeof globalThis.caches === "object" && globalThis.caches !== null;
const isBuildPhase =
  process.env.NEXT_PHASE === "phase-production-build" || process.env.OMNIROUTE_BUILDING === "1";
const DATA_DIR = resolveDataDir({ isCloud });

export const CALL_LOGS_DIR = isCloud ? null : path.join(DATA_DIR, "call_logs");
export const MAX_CALL_LOG_ARTIFACT_BYTES = 512 * 1024;

const SIZE_LIMIT_EXCEEDED_REASON = "call_log_artifact_size_limit_exceeded";
const OMITTED_FOR_SIZE_LIMIT = "[omitted: call log artifact size limit exceeded]";
const STREAM_CHUNKS_OMITTED_FOR_SIZE_LIMIT =
  "[stream chunks omitted: call log artifact size limit exceeded]";
const TRUNCATED_FOR_SIZE_LIMIT = "[truncated: call log artifact size limit exceeded]";
// The error is usually the only field that says why a request failed, and it is tiny next
// to the bodies that trip the cap — keep it verbatim up to this budget.
const MAX_PRESERVED_ERROR_BYTES = 4 * 1024;
// Fallback per-body preview budget tried when the configured one still overflows the cap.
const DEGRADED_PREVIEW_BYTES = 2 * 1024;

export type CallLogDetailState = "none" | "ready" | "missing" | "corrupt" | "legacy-inline";

export type CallLogArtifact = {
  schemaVersion: 5;
  summary: {
    id: string;
    timestamp: string;
    method: string;
    path: string;
    status: number;
    model: string;
    requestedModel: string | null;
    provider: string;
    account: string;
    connectionId: string | null;
    duration: number;
    tokens: {
      in: number;
      out: number;
      cacheRead: number | null;
      cacheWrite: number | null;
      reasoning: number | null;
      compressed: number | null;
    };
    requestType: string | null;
    sourceFormat: string | null;
    targetFormat: string | null;
    apiKeyId: string | null;
    apiKeyName: string | null;
    comboName: string | null;
    comboStepId: string | null;
    comboExecutionKey: string | null;
  };
  requestBody: unknown;
  responseBody: unknown;
  error: unknown;
  pipeline?: RequestPipelinePayloads;
};

export type CallLogArtifactWriteResult = {
  relPath: string;
  sizeBytes: number;
  sha256: string;
};

export type PurgeCallLogArtifactDirectoryResult = {
  deletedArtifacts: number;
  errors: number;
};

export function buildArtifactRelativePath(timestamp: string, id: string) {
  const parsed = new Date(timestamp);
  const safeTimestamp = (
    Number.isNaN(parsed.getTime()) ? new Date().toISOString() : parsed.toISOString()
  ).replace(/[:]/g, "-");
  const dateFolder = safeTimestamp.slice(0, 10);
  return path.posix.join(dateFolder, `${safeTimestamp}_${id}.json`);
}

function computeArtifactChecksum(serialized: string): string {
  const bytes = Buffer.from(serialized);
  let hash = 0x811c9dc5;
  for (const byte of bytes) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

function truncateArtifactForStorage(artifact: CallLogArtifact): CallLogArtifact {
  const pipeline = artifact.pipeline;
  if (!pipeline?.streamChunks) return artifact;

  return {
    ...artifact,
    pipeline: {
      ...pipeline,
      streamChunks: {
        provider: pipeline.streamChunks.provider?.length
          ? [STREAM_CHUNKS_OMITTED_FOR_SIZE_LIMIT]
          : undefined,
        openai: pipeline.streamChunks.openai?.length
          ? [STREAM_CHUNKS_OMITTED_FOR_SIZE_LIMIT]
          : undefined,
        client: pipeline.streamChunks.client?.length
          ? [STREAM_CHUNKS_OMITTED_FOR_SIZE_LIMIT]
          : undefined,
      },
    },
  };
}

function omitOversizedPipeline(artifact: CallLogArtifact): CallLogArtifact {
  if (!artifact.pipeline) return artifact;

  return {
    ...artifact,
    pipeline: {
      error: {
        _omniroute_truncated: true,
        reason: SIZE_LIMIT_EXCEEDED_REASON,
      },
    },
  };
}

function getArtifactMaxBytes(artifact: CallLogArtifact): number {
  return artifact.pipeline ? getCallLogPipelineMaxSizeBytes() : MAX_CALL_LOG_ARTIFACT_BYTES;
}

/**
 * Cuts `text` to at most `maxBytes` of UTF-8 without splitting a multi-byte sequence, so the
 * result never decodes to a U+FFFD replacement character.
 */
function truncateUtf8(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  // Every UTF-16 code unit encodes to at least one byte, so the first `maxBytes` code units
  // already cover the byte budget — only that prefix ever needs encoding.
  let prefix = text.length > maxBytes ? text.slice(0, maxBytes) : text;
  // Drop a high surrogate orphaned by the slice; it would encode as a replacement character.
  const lastCode = prefix.charCodeAt(prefix.length - 1);
  if (prefix !== text && lastCode >= 0xd800 && lastCode <= 0xdbff) {
    prefix = prefix.slice(0, -1);
  }

  const bytes = Buffer.from(prefix, "utf8");
  if (bytes.length <= maxBytes) return prefix;

  // bytes[end] is the first byte cut off; while it is a continuation byte (10xxxxxx) the cut
  // lands inside a sequence, so back up to that sequence's lead byte.
  let end = maxBytes;
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
  return bytes.subarray(0, end).toString("utf8");
}

function preserveErrorForSizeLimit(error: unknown): unknown {
  if (error === null || error === undefined) return null;

  let text: string;
  if (typeof error === "string") {
    text = error;
  } else {
    try {
      text = JSON.stringify(error) ?? String(error);
    } catch {
      text = String(error);
    }
  }

  if (Buffer.byteLength(text, "utf8") <= MAX_PRESERVED_ERROR_BYTES) return error;
  return `${truncateUtf8(text, MAX_PRESERVED_ERROR_BYTES)} ${TRUNCATED_FOR_SIZE_LIMIT}`;
}

type PreviewSource = {
  body: unknown;
  // UTF-8 text the preview is cut from: the string body itself, or the object body's JSON.
  // null when there is nothing to preview (absent body, or one that cannot be serialized).
  text: string | null;
  bytes: number;
};

// Serializes a body once so every preview budget attempt can reuse the result.
function preparePreviewSource(body: unknown): PreviewSource {
  if (body === null || body === undefined) return { body, text: null, bytes: 0 };

  let text: string | undefined;
  if (typeof body === "string") {
    text = body;
  } else {
    try {
      text = JSON.stringify(body);
    } catch {
      return { body: OMITTED_FOR_SIZE_LIMIT, text: null, bytes: 0 };
    }
  }
  if (text === undefined) return { body, text: null, bytes: 0 };
  return { body, text, bytes: Buffer.byteLength(text, "utf8") };
}

function previewFromSource(source: PreviewSource, budgetBytes: number): unknown {
  if (source.text === null || source.bytes <= budgetBytes) return source.body;

  const preview = `${truncateUtf8(source.text, budgetBytes)} ${TRUNCATED_FOR_SIZE_LIMIT}`;
  if (typeof source.body === "string") return preview;
  return {
    _omniroute_truncated: true,
    _originalBytes: source.bytes,
    preview,
  };
}

export function truncateBodyForPreview(body: unknown, budgetBytes: number): unknown {
  return previewFromSource(preparePreviewSource(body), budgetBytes);
}

/**
 * Keeps the head of each oversized body instead of dropping it wholesale, so a size-limited
 * row still shows what the prompt was. Tries the configured per-body budget, then a smaller
 * one; returns null when neither fits so the caller falls through to the omitted shape.
 */
function serializePreviewForSizeLimit(artifact: CallLogArtifact, maxBytes: number): string | null {
  const configuredBudget = getCallLogArtifactPreviewBytes();
  const budgets =
    configuredBudget > DEGRADED_PREVIEW_BYTES
      ? [configuredBudget, DEGRADED_PREVIEW_BYTES]
      : [configuredBudget];

  const base = omitOversizedPipeline(artifact);
  const error = preserveErrorForSizeLimit(artifact.error);
  const requestSource = preparePreviewSource(artifact.requestBody);
  const responseSource = preparePreviewSource(artifact.responseBody);

  for (const budget of budgets) {
    const candidate = JSON.stringify({
      ...base,
      requestBody: previewFromSource(requestSource, budget),
      responseBody: previewFromSource(responseSource, budget),
      error,
    });
    if (Buffer.byteLength(candidate) <= maxBytes) {
      return candidate;
    }
  }

  return null;
}

function buildMinimalArtifactForSizeLimit(artifact: CallLogArtifact) {
  return {
    schemaVersion: artifact.schemaVersion,
    summary: artifact.summary,
    requestBody: OMITTED_FOR_SIZE_LIMIT,
    responseBody: OMITTED_FOR_SIZE_LIMIT,
    error: preserveErrorForSizeLimit(artifact.error),
    pipeline: {
      error: {
        _omniroute_truncated: true,
        reason: SIZE_LIMIT_EXCEEDED_REASON,
      },
    },
  };
}

function serializeFinalSizeLimitFallback(artifact: CallLogArtifact, maxBytes: number): string {
  const withSummary = JSON.stringify(buildMinimalArtifactForSizeLimit(artifact));
  if (Buffer.byteLength(withSummary) <= maxBytes) {
    return withSummary;
  }

  return JSON.stringify({
    schemaVersion: artifact.schemaVersion,
    _omniroute_truncated: true,
    reason: SIZE_LIMIT_EXCEEDED_REASON,
  });
}

function serializeArtifactForStorage(artifact: CallLogArtifact): string {
  // Debug mode: write full untruncated payload
  if (isChatDebugFileEnabled()) {
    return JSON.stringify(artifact, null, 2);
  }

  const maxBytes = getArtifactMaxBytes(artifact);
  // Single-pass, non-pretty serialization on the hot path. Artifacts are machine-read via
  // JSON.parse (readCallArtifact), so pretty-printing only doubled the bytes and CPU of
  // serializing large request/response bodies on every request — a contributor to the
  // CPU-runaway. The debug path above keeps pretty output for human inspection.
  const serialized = JSON.stringify(artifact);
  if (Buffer.byteLength(serialized) <= maxBytes) {
    return serialized;
  }

  const truncated = JSON.stringify(truncateArtifactForStorage(artifact));
  if (Buffer.byteLength(truncated) <= maxBytes) {
    return truncated;
  }

  const withoutPipeline = JSON.stringify(omitOversizedPipeline(artifact));
  if (Buffer.byteLength(withoutPipeline) <= maxBytes) {
    return withoutPipeline;
  }

  const preview = serializePreviewForSizeLimit(artifact, maxBytes);
  if (preview !== null) {
    return preview;
  }

  const minimal = JSON.stringify({
    ...omitOversizedPipeline(artifact),
    requestBody: OMITTED_FOR_SIZE_LIMIT,
    responseBody: OMITTED_FOR_SIZE_LIMIT,
    error: preserveErrorForSizeLimit(artifact.error),
  });
  if (Buffer.byteLength(minimal) <= maxBytes) {
    return minimal;
  }

  return serializeFinalSizeLimitFallback(artifact, maxBytes);
}

export function writeCallArtifact(
  artifact: CallLogArtifact,
  relativePath = buildArtifactRelativePath(artifact.summary.timestamp, artifact.summary.id)
): CallLogArtifactWriteResult | null {
  if (!CALL_LOGS_DIR || isBuildPhase) return null;

  const absPath = path.join(CALL_LOGS_DIR, relativePath);
  const tmpPath = `${absPath}.${process.pid}.${Date.now()}.tmp`;

  try {
    const serialized = serializeArtifactForStorage(artifact);
    const sizeBytes = Buffer.byteLength(serialized);
    // Keep the legacy field name for storage compatibility, but use a non-cryptographic checksum
    // so artifact bookkeeping is not treated as password hashing by static analysis.
    const fileChecksum = computeArtifactChecksum(serialized);

    fs.mkdirSync(path.dirname(absPath), { recursive: true });
    fs.writeFileSync(tmpPath, serialized);
    fs.renameSync(tmpPath, absPath);

    return {
      relPath: relativePath,
      sizeBytes,
      sha256: fileChecksum,
    };
  } catch (error) {
    try {
      fs.rmSync(tmpPath, { force: true });
    } catch {
      // Best effort cleanup only.
    }
    console.error("[callLogs] Failed to write request artifact:", (error as Error).message);
    return null;
  }
}

export function readCallArtifact(relativePath: string | null): {
  artifact: CallLogArtifact | null;
  state: "ready" | "missing" | "corrupt";
} {
  if (!CALL_LOGS_DIR || !relativePath) {
    return { artifact: null, state: "missing" };
  }

  try {
    const absPath = path.join(CALL_LOGS_DIR, relativePath);
    if (!fs.existsSync(absPath)) {
      return { artifact: null, state: "missing" };
    }
    return {
      artifact: JSON.parse(fs.readFileSync(absPath, "utf8")) as CallLogArtifact,
      state: "ready",
    };
  } catch (error) {
    console.error("[callLogs] Failed to read request artifact:", (error as Error).message);
    return { artifact: null, state: "corrupt" };
  }
}

export function deleteCallArtifact(relativePath: string | null, baseDir = CALL_LOGS_DIR): boolean {
  if (!baseDir || !relativePath) return false;

  try {
    const resolvedBaseDir = path.resolve(baseDir);
    const absPath = path.join(resolvedBaseDir, relativePath);
    if (!fs.existsSync(absPath)) return false;
    fs.rmSync(absPath, { force: true });
    const parentDir = path.dirname(absPath);
    if (parentDir !== resolvedBaseDir) {
      try {
        fs.rmdirSync(parentDir);
      } catch {
        // Directory is non-empty or already gone.
      }
    }
    return true;
  } catch {
    return false;
  }
}

export function cleanupEmptyCallLogDirs(baseDir = CALL_LOGS_DIR) {
  if (!baseDir || !fs.existsSync(baseDir)) return;

  try {
    for (const entry of fs.readdirSync(baseDir)) {
      const entryPath = path.join(baseDir, entry);
      const stat = fs.statSync(entryPath);
      if (!stat.isDirectory()) continue;
      if (fs.readdirSync(entryPath).length === 0) {
        fs.rmSync(entryPath, { recursive: true, force: true });
      }
    }
  } catch {
    // Best effort only.
  }
}

export function listCallLogArtifactFiles(baseDir = CALL_LOGS_DIR) {
  if (!baseDir || !fs.existsSync(baseDir)) return [];

  return fs
    .readdirSync(baseDir)
    .flatMap((entry) => {
      const entryPath = path.join(baseDir, entry);
      try {
        const stat = fs.statSync(entryPath);
        if (!stat.isDirectory()) return [];

        return fs
          .readdirSync(entryPath)
          .filter((file) => file.endsWith(".json"))
          .map((file) => {
            const absPath = path.join(entryPath, file);
            const fileStat = fs.statSync(absPath);
            return {
              relativePath: path.posix.join(entry, file),
              absPath,
              mtimeMs: fileStat.mtimeMs,
            };
          });
      } catch {
        return [];
      }
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
}

export function purgeCallLogArtifactDirectory(
  baseDir = CALL_LOGS_DIR
): PurgeCallLogArtifactDirectoryResult {
  const result = { deletedArtifacts: 0, errors: 0 };
  if (!baseDir || !fs.existsSync(baseDir)) return result;

  try {
    result.deletedArtifacts = listCallLogArtifactFiles(baseDir).length;
  } catch {
    result.deletedArtifacts = 0;
  }

  try {
    fs.rmSync(baseDir, { recursive: true, force: true });
  } catch (error) {
    console.error("[callLogArtifacts] Failed to purge call log artifacts:", error);
    result.deletedArtifacts = 0;
    result.errors++;
  }

  return result;
}
