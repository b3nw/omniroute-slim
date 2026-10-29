import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";

import { MAX_CALL_LOG_ARTIFACT_BYTES } from "./callLogArtifacts.ts";
import type { CallLogArtifact, CallLogArtifactWriteResult } from "./callLogArtifacts.ts";

const MAX_QUEUED_JOBS = 128;
/** Upper bound on the estimated bytes held by queued + in-flight artifacts. */
export const MAX_QUEUED_ARTIFACT_BYTES = 32 * 1024 * 1024;
const ARTIFACT_ESTIMATE_CAP_BYTES = MAX_CALL_LOG_ARTIFACT_BYTES * 2;
const IDLE_TIMEOUT_MS = 30_000;
const CLOSE_TIMEOUT_MS = 2_000;
const WARNING_INTERVAL_MS = 30_000;

type WorkerReply = {
  id: number;
  result: CallLogArtifactWriteResult | null;
};

type QueueItem = {
  id: number;
  artifact: CallLogArtifact;
  environment: {
    pipelineMaxSizeKb?: string;
    chatDebugFile?: string;
    appLogLevel?: string;
  };
  estimatedBytes: number;
  resolve: (result: CallLogArtifactWriteResult | null) => void;
};

let worker: Worker | null = null;
let active: QueueItem | null = null;
const queue: QueueItem[] = [];
let nextId = 1;
let idleTimer: NodeJS.Timeout | null = null;
let closing = false;
let closeWaiters: Array<() => void> = [];
let lastWarningAt = 0;
let queuedBytes = 0;

/**
 * Cheap, bounded size estimate of an artifact (no JSON.stringify). Walks the
 * value recursively and short-circuits once the running total exceeds `cap`.
 */
export function estimateArtifactBytes(value: unknown, cap = ARTIFACT_ESTIMATE_CAP_BYTES): number {
  let total = 0;
  const stack: unknown[] = [value];
  const seen = new Set<object>();
  while (stack.length > 0 && total <= cap) {
    const current = stack.pop();
    if (typeof current === "string") {
      total += current.length;
    } else if (typeof current === "number" || typeof current === "bigint") {
      total += 8;
    } else if (typeof current === "boolean") {
      total += 4;
    } else if (current && typeof current === "object") {
      if (seen.has(current)) continue;
      seen.add(current);
      if (Array.isArray(current)) {
        total += 2;
        for (let i = 0; i < current.length; i++) stack.push(current[i]);
      } else {
        total += 2;
        for (const key of Object.keys(current)) {
          total += key.length + 4;
          stack.push((current as Record<string, unknown>)[key]);
        }
      }
    } else {
      total += 4;
    }
  }
  return Math.min(total, cap + 1);
}

/** Test hook: estimated bytes currently held by queued + active artifacts. */
export function getQueuedArtifactBytesForTests(): number {
  return queuedBytes;
}

function releaseItemBytes(item: QueueItem): void {
  queuedBytes = Math.max(0, queuedBytes - item.estimatedBytes);
}

function fileExistsAtRuntime(candidate: string): boolean {
  // The worker is copied explicitly by the standalone/npm packaging policies.
  // Keep this runtime probe opaque to Next's build tracer so it does not expand
  // a variable filesystem expression into a repository-wide glob.
  return Reflect.apply(fs.existsSync, fs, [candidate]) as boolean;
}

type WorkerResolutionContext = {
  moduleDir?: string;
  cwd?: string;
  entryFile?: string | null;
  fileExists?: (candidate: string) => boolean;
};

export function resolveCallLogArtifactWorker(context: WorkerResolutionContext = {}): {
  workerFile: string;
  execArgv: string[];
} {
  const moduleDir = context.moduleDir ?? path.dirname(fileURLToPath(import.meta.url));
  const cwd = context.cwd ?? process.cwd();
  const entryFile = context.entryFile === undefined ? process.argv[1] : context.entryFile;
  const exists = context.fileExists ?? fileExistsAtRuntime;

  const moduleJs = path.join(moduleDir, "callLogArtifactWorker.js");
  if (exists(moduleJs)) return { workerFile: moduleJs, execArgv: [] };

  const entryJs = entryFile
    ? path.join(path.dirname(path.resolve(entryFile)), "src/lib/usage/callLogArtifactWorker.js")
    : null;
  if (entryJs && exists(entryJs)) return { workerFile: entryJs, execArgv: [] };

  const cwdJs = path.resolve(cwd, "src/lib/usage/callLogArtifactWorker.js");
  if (exists(cwdJs)) return { workerFile: cwdJs, execArgv: [] };

  const moduleTs = path.join(moduleDir, "callLogArtifactWorker.ts");
  if (exists(moduleTs)) {
    return { workerFile: moduleTs, execArgv: ["--import", "tsx/esm"] };
  }

  const cwdTs = path.resolve(cwd, "src/lib/usage/callLogArtifactWorker.ts");
  if (exists(cwdTs)) {
    return { workerFile: cwdTs, execArgv: ["--import", "tsx/esm"] };
  }

  return { workerFile: entryJs ?? cwdJs, execArgv: [] };
}

function clearIdleTimer(): void {
  if (!idleTimer) return;
  clearTimeout(idleTimer);
  idleTimer = null;
}

function terminateWorker(): void {
  const current = worker;
  worker = null;
  clearIdleTimer();
  if (current) void current.terminate().catch(() => {});
}

function notifyCloseWaiters(): void {
  if (active || queue.length > 0) return;
  const waiters = closeWaiters;
  closeWaiters = [];
  for (const resolve of waiters) resolve();
}

function scheduleIdleTermination(): void {
  clearIdleTimer();
  if (!worker || active || queue.length > 0) return;
  idleTimer = setTimeout(terminateWorker, IDLE_TIMEOUT_MS);
  idleTimer.unref?.();
}

function warnRateLimited(message: string): void {
  const now = Date.now();
  if (now - lastWarningAt < WARNING_INTERVAL_MS) return;
  lastWarningAt = now;
  console.warn(message);
}

function failOpen(warn = false): void {
  if (warn) warnRateLimited("[callLogs] Call-log artifact worker failed; detail omitted.");
  const failed = active ? [active, ...queue] : [...queue];
  active = null;
  queue.length = 0;
  terminateWorker();
  for (const item of failed) {
    releaseItemBytes(item);
    item.resolve(null);
  }
  notifyCloseWaiters();
}

function ensureWorker(): Worker {
  if (worker) return worker;

  const { workerFile, execArgv } = resolveCallLogArtifactWorker();
  // Reflect.construct keeps Next/Turbopack from interpreting the runtime-selected
  // worker path as a build-time glob and tracing tens of thousands of unrelated files.
  const created = Reflect.construct(Worker, [pathToFileURL(workerFile), { execArgv }]) as Worker;
  worker = created;
  created.on("message", (reply: WorkerReply) => {
    if (!active || reply.id !== active.id) return;
    const completed = active;
    active = null;
    releaseItemBytes(completed);
    completed.resolve(reply.result);
    pump();
  });
  created.on("error", () => failOpen(true));
  created.on("messageerror", () => failOpen(true));
  created.on("exit", (code) => {
    if (worker !== created) return;
    worker = null;
    if (code !== 0 || active) failOpen(true);
  });
  return created;
}

function pump(): void {
  if (active) return;
  const next = queue.shift();
  if (!next) {
    notifyCloseWaiters();
    scheduleIdleTermination();
    return;
  }

  active = next;
  clearIdleTimer();
  try {
    ensureWorker().postMessage({
      id: next.id,
      artifact: next.artifact,
      environment: next.environment,
    });
  } catch {
    failOpen(true);
  }
}

export function writeCallArtifactAsync(
  artifact: CallLogArtifact
): Promise<CallLogArtifactWriteResult | null> {
  if (closing || queue.length >= MAX_QUEUED_JOBS) {
    warnRateLimited("[callLogs] Call-log artifact queue unavailable; detail omitted.");
    return Promise.resolve(null);
  }

  const estimatedBytes = estimateArtifactBytes(artifact);
  const idle = queue.length === 0 && !active;
  if (!idle && queuedBytes >= MAX_QUEUED_ARTIFACT_BYTES) {
    warnRateLimited("[callLogs] Call-log artifact queue byte budget exhausted; detail omitted.");
    return Promise.resolve(null);
  }

  return new Promise((resolve) => {
    const item: QueueItem = {
      id: nextId++,
      artifact,
      estimatedBytes,
      environment: {
        pipelineMaxSizeKb: process.env.CALL_LOG_PIPELINE_MAX_SIZE_KB,
        chatDebugFile: process.env.CHAT_DEBUG_FILE,
        appLogLevel: process.env.APP_LOG_LEVEL,
      },
      resolve,
    };
    queuedBytes += estimatedBytes;
    queue.push(item);
    pump();
  });
}

export async function closeCallLogArtifactWriter(timeoutMs = CLOSE_TIMEOUT_MS): Promise<void> {
  closing = true;
  if (!active && queue.length === 0) {
    terminateWorker();
    return;
  }

  if (timeoutMs <= 0) {
    failOpen();
    terminateWorker();
    return;
  }

  let timeout: NodeJS.Timeout | undefined;
  await Promise.race([
    new Promise<void>((resolve) => closeWaiters.push(resolve)),
    new Promise<void>((resolve) => {
      timeout = setTimeout(resolve, timeoutMs);
      timeout.unref?.();
    }),
  ]);
  if (timeout) clearTimeout(timeout);
  if (active || queue.length > 0) failOpen();
  terminateWorker();
}
