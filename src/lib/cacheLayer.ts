/**
 * LRU Cache Layer — FASE-08 LLM Proxy Advanced
 *
 * In-memory LRU cache for LLM prompt/response pairs.
 * Uses content hashing for cache keys to handle semantic deduplication.
 * Memory-optimized with byte-based limits.
 *
 * @module lib/cacheLayer
 */

import crypto from "crypto";
import { registerMemoryPressureEvictor } from "@omniroute/open-sse/utils/heapPressure.ts";

/**
 * @typedef {Object} CacheEntry
 * @property {string} key - Cache key (hash)
 * @property {*} value - Cached value
 * @property {number} createdAt - Timestamp
 * @property {number} ttl - TTL in ms
 * @property {number} size - Approximate size in bytes
 * @property {number} hits - Number of times this entry was accessed
 */

const DEFAULT_MAX_ENTRIES = 50;
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
const DEFAULT_TTL = 300000;

export class LRUCache {
  /** @type {Map<string, CacheEntry>} */
  #cache = new Map();
  #maxSize;
  #maxBytes;
  #defaultTTL;
  #currentSize = 0;
  #currentBytes = 0;
  #stats = { hits: 0, misses: 0, evictions: 0 };

  /**
   * @param {Object} options
   * @param {number} [options.maxSize=50] - Max number of entries (reduced for memory)
   * @param {number} [options.maxBytes=2097152] - Max bytes (default: 2MB)
   * @param {number} [options.defaultTTL=300000] - Default TTL in ms (5 min)
   */
  constructor(options: { maxSize?: number; maxBytes?: number; defaultTTL?: number } = {}) {
    this.#maxSize = options.maxSize ?? DEFAULT_MAX_ENTRIES;
    this.#maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    this.#defaultTTL = options.defaultTTL ?? DEFAULT_TTL;
  }

  /**
   * Generate a cache key from input.
   * @param {Object} params - Parameters to hash
   * @returns {string} Cache key
   */
  static generateKey(params: Record<string, unknown>) {
    const normalized = JSON.stringify(params, Object.keys(params).sort());
    return crypto.createHash("sha256").update(normalized).digest("hex").slice(0, 16);
  }

  /**
   * Get a value from the cache.
   * @param {string} key
   * @returns {*|undefined}
   */
  get(key: string) {
    const entry = this.#cache.get(key);

    if (!entry) {
      this.#stats.misses++;
      return undefined;
    }

    if (Date.now() - entry.createdAt > entry.ttl) {
      this.#deleteEntry(key, entry);
      this.#stats.misses++;
      return undefined;
    }

    this.#cache.delete(key);
    entry.hits++;
    this.#cache.set(key, entry);

    this.#stats.hits++;
    return entry.value;
  }

  /**
   * Set a value in the cache.
   * @param {string} key
   * @param {*} value
   * @param {number} [ttl] - Override default TTL
   */
  set(key: string, value: unknown, ttl?: number) {
    const entrySize = this.#estimateSize(value);

    if (this.#cache.has(key)) {
      const oldEntry = this.#cache.get(key)!;
      this.#currentBytes -= oldEntry.size || 0;
      this.#currentSize--;
      this.#cache.delete(key);
    }

    while (
      (this.#currentSize >= this.#maxSize || this.#currentBytes + entrySize > this.#maxBytes) &&
      this.#cache.size > 0
    ) {
      const oldestKey = this.#cache.keys().next().value;
      const oldestEntry = this.#cache.get(oldestKey);
      if (oldestEntry) {
        this.#deleteEntry(oldestKey, oldestEntry);
      }
      this.#stats.evictions++;
    }

    const entry = {
      key,
      value,
      createdAt: Date.now(),
      ttl: ttl ?? this.#defaultTTL,
      size: entrySize,
      hits: 0,
    };

    this.#cache.set(key, entry);
    this.#currentSize++;
    this.#currentBytes += entrySize;
  }

  /**
   * Estimate size of a value in bytes.
   */
  #estimateSize(value: unknown): number {
    try {
      return JSON.stringify(value).length * 2;
    } catch {
      return 1024;
    }
  }

  /**
   * Delete an entry and update counters.
   */
  #deleteEntry(key: string, entry: { size?: number }) {
    this.#cache.delete(key);
    this.#currentSize--;
    this.#currentBytes -= entry.size || 0;
    if (this.#currentBytes < 0) this.#currentBytes = 0;
  }

  /**
   * Check if a key exists (without promoting it).
   * @param {string} key
   * @returns {boolean}
   */
  has(key: string) {
    const entry = this.#cache.get(key);
    if (!entry) return false;
    if (Date.now() - entry.createdAt > entry.ttl) {
      this.#deleteEntry(key, entry);
      return false;
    }
    return true;
  }

  /**
   * Delete a specific key.
   * @param {string} key
   * @returns {boolean}
   */
  delete(key: string) {
    const entry = this.#cache.get(key);
    if (entry) {
      this.#deleteEntry(key, entry);
      return true;
    }
    return false;
  }

  /** Drop every expired entry. Returns the number removed. */
  pruneExpired(now = Date.now()) {
    let removed = 0;
    for (const [key, entry] of this.#cache) {
      if (now - entry.createdAt > entry.ttl) {
        this.#deleteEntry(key, entry);
        removed++;
      }
    }
    return removed;
  }

  /** Clear the entire cache. */
  clear() {
    this.#cache.clear();
    this.#currentSize = 0;
    this.#currentBytes = 0;
  }

  /** @returns {{ size: number, maxSize: number, bytes: number, maxBytes: number, hits: number, misses: number, evictions: number, hitRate: number }} */
  getStats() {
    const total = this.#stats.hits + this.#stats.misses;
    return {
      size: this.#currentSize,
      maxSize: this.#maxSize,
      bytes: this.#currentBytes,
      maxBytes: this.#maxBytes,
      ...this.#stats,
      hitRate: total > 0 ? (this.#stats.hits / total) * 100 : 0,
    };
  }
}

// ─── Prompt Cache Singleton ─────────────────

const PROMPT_CACHE_SWEEP_INTERVAL_MS = 60_000;

type PromptCacheState = {
  promptCache: LRUCache | null;
  sweepTimer: ReturnType<typeof setInterval> | null;
};

// Anchored on globalThis so every Next.js route chunk shares one prompt cache.
const PROMPT_CACHE_KEY = Symbol.for("omniroute.cacheLayer.promptCache");
const promptCacheState: PromptCacheState = ((globalThis as Record<symbol, unknown>)[
  PROMPT_CACHE_KEY
] ??= { promptCache: null, sweepTimer: null } satisfies PromptCacheState) as PromptCacheState;

function stopPromptCacheSweep() {
  if (promptCacheState.sweepTimer) {
    clearInterval(promptCacheState.sweepTimer);
    promptCacheState.sweepTimer = null;
  }
}

/** Self-stopping expiry sweep; stops once the prompt cache is empty. */
function ensurePromptCacheSweep() {
  if (promptCacheState.sweepTimer) return;
  promptCacheState.sweepTimer = setInterval(() => {
    const cache = promptCacheState.promptCache;
    cache?.pruneExpired();
    if (!cache || cache.getStats().size === 0) stopPromptCacheSweep();
  }, PROMPT_CACHE_SWEEP_INTERVAL_MS);
  promptCacheState.sweepTimer.unref?.();
}

registerMemoryPressureEvictor("cacheLayer.promptCache", () => {
  promptCacheState.promptCache?.clear();
  stopPromptCacheSweep();
});

/**
 * Get the global prompt cache instance.
 * @param {Object} [options]
 * @returns {LRUCache}
 */
export function getPromptCache(
  options?: { maxSize?: number; maxBytes?: number; defaultTTL?: number } & Record<string, unknown>
) {
  if (!promptCacheState.promptCache) {
    promptCacheState.promptCache = new LRUCache({
      maxSize: parseInt(process.env.PROMPT_CACHE_MAX_SIZE || "50", 10),
      maxBytes: parseInt(process.env.PROMPT_CACHE_MAX_BYTES || String(2 * 1024 * 1024), 10),
      defaultTTL: parseInt(process.env.PROMPT_CACHE_TTL_MS || "300000", 10),
      ...options,
    });
  }
  ensurePromptCacheSweep();
  return promptCacheState.promptCache;
}
