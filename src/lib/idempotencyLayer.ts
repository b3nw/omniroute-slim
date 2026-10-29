/**
 * Idempotency Layer — Phase 9.2
 *
 * In-memory deduplication of requests with the same idempotency key.
 * If a request with the same key arrives within 5 seconds, returns
 * the cached response instead of making a new API call.
 *
 * Headers: X-Request-Id or Idempotency-Key
 *
 * @module lib/idempotencyLayer
 */

import { getSettings } from "@/lib/db/settings";

const DEFAULT_WINDOW_MS = 5000;
export const MAX_IDEMPOTENCY_ENTRIES = 500;

type IdempotencyEntry = { response: unknown; status: number; expiresAt: number };
type IdempotencyState = {
  idempotencyStore: Map<string, IdempotencyEntry>;
  cleanupInterval: ReturnType<typeof setInterval> | null;
};

// Anchored on globalThis so every Next.js route chunk shares one dedup store.
const IDEMPOTENCY_STATE_KEY = Symbol.for("omniroute.idempotency.store");
const idempotencyState: IdempotencyState = ((globalThis as Record<symbol, unknown>)[
  IDEMPOTENCY_STATE_KEY
] ??= {
  idempotencyStore: new Map<string, IdempotencyEntry>(),
  cleanupInterval: null,
} satisfies IdempotencyState) as IdempotencyState;
const idempotencyStore = idempotencyState.idempotencyStore;

function pruneExpiredIdempotency(now = Date.now()) {
  for (const [key, entry] of idempotencyStore) {
    if (now >= entry.expiresAt) {
      idempotencyStore.delete(key);
    }
  }
}

function stopCleanup() {
  if (idempotencyState.cleanupInterval) {
    clearInterval(idempotencyState.cleanupInterval);
    idempotencyState.cleanupInterval = null;
  }
}

// Periodic cleanup every 30s; stops itself once the store drains.
function ensureCleanup() {
  if (idempotencyState.cleanupInterval) return;
  const interval = setInterval(() => {
    pruneExpiredIdempotency();
    if (idempotencyStore.size === 0) stopCleanup();
  }, 30000);
  // Don't prevent process exit
  if (interval.unref) interval.unref();
  idempotencyState.cleanupInterval = interval;
}

/**
 * Extract idempotency key from request headers.
 * @param {Headers|object} headers
 * @returns {string|null}
 */
export function getIdempotencyKey(headers) {
  if (!headers) return null;
  const get = typeof headers.get === "function" ? (k) => headers.get(k) : (k) => headers[k];
  return get("idempotency-key") || get("x-request-id") || null;
}

/**
 * Check if a response exists for the given idempotency key.
 * @param {string} key
 * @returns {{ response: object, status: number }|null}
 */
export function checkIdempotency(key) {
  if (!key) return null;
  const entry = idempotencyStore.get(key);
  if (!entry) return null;
  if (Date.now() >= entry.expiresAt) {
    idempotencyStore.delete(key);
    return null;
  }
  return { response: entry.response, status: entry.status };
}

/**
 * Save a response for idempotency dedup.
 * @param {string} key
 * @param {object} response - Response body to cache
 * @param {number} status - HTTP status code
 * @param {number} [windowMs=5000] - Dedup window in ms
 */
export function saveIdempotency(key, response, status, windowMs = DEFAULT_WINDOW_MS) {
  if (!key) return;
  if (!idempotencyStore.has(key) && idempotencyStore.size >= MAX_IDEMPOTENCY_ENTRIES) {
    pruneExpiredIdempotency();
    while (idempotencyStore.size >= MAX_IDEMPOTENCY_ENTRIES) {
      const oldest = idempotencyStore.keys().next().value;
      if (oldest === undefined) break;
      idempotencyStore.delete(oldest);
    }
  }
  idempotencyStore.set(key, {
    response,
    status,
    expiresAt: Date.now() + windowMs,
  });
  ensureCleanup();
}

/**
 * Get current idempotency store stats.
 */
export async function getIdempotencyStats() {
  let windowMs = DEFAULT_WINDOW_MS;
  try {
    const settings = await getSettings();
    if (typeof settings.idempotencyWindowMs === "number" && settings.idempotencyWindowMs > 0) {
      windowMs = settings.idempotencyWindowMs;
    }
  } catch {
    // Fallback to default if settings unavailable
  }
  return {
    activeKeys: idempotencyStore.size,
    windowMs,
  };
}

/**
 * Clear all idempotency entries (for testing).
 */
export function clearIdempotency() {
  idempotencyStore.clear();
  stopCleanup();
}
