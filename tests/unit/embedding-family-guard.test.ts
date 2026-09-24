import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// familyGuard imports combo.ts which transitively touches DB modules at load;
// give it a throwaway DATA_DIR so it uses defaults instead of the real store.
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "omniroute-embed-family-"));

const { getEmbeddingDimension, detectEmbeddingDimensionConflict } = await import(
  "../../open-sse/config/embeddingRegistry.ts"
);

test("getEmbeddingDimension resolves known dimensions from the registry", () => {
  assert.equal(getEmbeddingDimension("openai/text-embedding-3-small"), 1536);
  assert.equal(getEmbeddingDimension("openai/text-embedding-3-large"), 3072);
  assert.equal(getEmbeddingDimension("nebius/Qwen/Qwen3-Embedding-8B"), 4096);
  assert.equal(getEmbeddingDimension("gemini/gemini-embedding-001"), 768);
  assert.equal(getEmbeddingDimension("gemini/gemini-embedding-2"), 3072);
  assert.equal(getEmbeddingDimension("google/gemini-embedding-2"), 3072);
  // OpenRouter re-exports OpenAI ids under its own prefix at the same dimension.
  assert.equal(getEmbeddingDimension("openrouter/openai/text-embedding-3-small"), 1536);
});

test("getEmbeddingDimension returns undefined for unknown/local models", () => {
  assert.equal(getEmbeddingDimension("localembed/my-model"), undefined);
  assert.equal(getEmbeddingDimension("mystery/whatever"), undefined);
});

test("detectEmbeddingDimensionConflict flags mixed vector spaces", () => {
  const res = detectEmbeddingDimensionConflict([
    "openai/text-embedding-3-small", // 1536
    "nebius/Qwen/Qwen3-Embedding-8B", // 4096
  ]);
  assert.equal(res.conflict, true);
  assert.deepEqual(res.distinct, [1536, 4096]);
});

test("detectEmbeddingDimensionConflict accepts a uniform dimension", () => {
  const res = detectEmbeddingDimensionConflict([
    "openai/text-embedding-3-small", // 1536
    "openrouter/openai/text-embedding-3-small", // 1536
  ]);
  assert.equal(res.conflict, false);
  assert.deepEqual(res.distinct, [1536]);
});

test("detectEmbeddingDimensionConflict ignores unknown dimensions (no false positive)", () => {
  const res = detectEmbeddingDimensionConflict([
    "openai/text-embedding-3-small", // 1536 (known)
    "localembed/unknown", // undefined (ignored)
  ]);
  assert.equal(res.conflict, false);
  assert.deepEqual(res.distinct, [1536]);
});

test("detectEmbeddingDimensionConflict is a no-op for empty / all-unknown lists", () => {
  assert.equal(detectEmbeddingDimensionConflict([]).conflict, false);
  assert.equal(
    detectEmbeddingDimensionConflict(["localembed/a", "localembed/b"]).conflict,
    false
  );
});

