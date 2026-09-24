import test from "node:test";
import assert from "node:assert/strict";

import {
  QdrantSettingsSchema,
  QdrantSettingsUpdateSchema,
  QdrantSearchSchema,
  QdrantHealthResultSchema,
} from "../../src/shared/schemas/qdrant.ts";

// ---------------------------------------------------------------------------
// 1. MemorySettingsExtendedSchema
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 2. MemoryUpdatePutSchema
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 3. RetrievePreviewSchema
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 4. MemoryReindexSchema
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 5. MemorySummarizeSchema
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 6. EmbeddingProviderListingSchema
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 7. MemoryEngineStatusSchema
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 8. RetrievePreviewResultSchema
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 9. QdrantSettingsSchema
// ---------------------------------------------------------------------------

test("QdrantSettingsSchema: accepts valid settings with defaults applied", () => {
  const result = QdrantSettingsSchema.safeParse({
    enabled: true,
    host: "localhost",
  });
  assert.equal(result.success, true, "Should accept minimal settings with defaults");
  if (result.success) {
    assert.equal(result.data.port, 6333, "Default port should be 6333");
    assert.equal(result.data.collection, "omniroute_memory", "Default collection");
    assert.equal(result.data.quantization, "none", "Default quantization should be none");
    assert.equal(result.data.hasApiKey, false, "Default hasApiKey should be false");
    assert.equal(result.data.apiKeyMasked, null, "Default apiKeyMasked should be null");
  }
});

test("QdrantSettingsSchema: rejects port above 65535", () => {
  const result = QdrantSettingsSchema.safeParse({
    enabled: false,
    host: "",
    port: 99999,
  });
  assert.equal(result.success, false, "Port 99999 must be rejected");
});

// ---------------------------------------------------------------------------
// 10. QdrantSettingsUpdateSchema
// ---------------------------------------------------------------------------

test("QdrantSettingsUpdateSchema: accepts valid partial update", () => {
  const result = QdrantSettingsUpdateSchema.safeParse({
    enabled: true,
    host: "qdrant.example.com",
    port: 6334,
  });
  assert.equal(result.success, true, "Should accept partial update");
});

test("QdrantSettingsUpdateSchema: rejects extra field (strict)", () => {
  const result = QdrantSettingsUpdateSchema.safeParse({
    enabled: true,
    unknownField: "not allowed",
  });
  assert.equal(result.success, false, "Strict schema must reject unknown keys");
});

test("QdrantSettingsUpdateSchema: rejects empty collection string", () => {
  const result = QdrantSettingsUpdateSchema.safeParse({ collection: "" });
  assert.equal(result.success, false, "collection min(1) must reject empty string");
});

// ---------------------------------------------------------------------------
// 11. QdrantSearchSchema
// ---------------------------------------------------------------------------

test("QdrantSearchSchema: accepts valid search payload with default topK", () => {
  const result = QdrantSearchSchema.safeParse({ query: "semantic search test" });
  assert.equal(result.success, true, "Should accept query with default topK");
  if (result.success) {
    assert.equal(result.data.topK, 5, "Default topK should be 5");
  }
});

test("QdrantSearchSchema: rejects topK above 50", () => {
  const result = QdrantSearchSchema.safeParse({ query: "test", topK: 51 });
  assert.equal(result.success, false, "topK > 50 must be rejected");
});

test("QdrantSearchSchema: rejects empty query string", () => {
  const result = QdrantSearchSchema.safeParse({ query: "" });
  assert.equal(result.success, false, "Empty query must be rejected");
});

// ---------------------------------------------------------------------------
// 12. QdrantHealthResultSchema (bonus — extra coverage)
// ---------------------------------------------------------------------------

test("QdrantHealthResultSchema: accepts healthy result without error field", () => {
  const result = QdrantHealthResultSchema.safeParse({ ok: true, latencyMs: 12 });
  assert.equal(result.success, true, "Healthy result must be accepted");
});

test("QdrantHealthResultSchema: accepts unhealthy result with error field", () => {
  const result = QdrantHealthResultSchema.safeParse({
    ok: false,
    latencyMs: 0,
    error: "connection refused",
  });
  assert.equal(result.success, true, "Unhealthy result with error string must be accepted");
});

test("QdrantHealthResultSchema: rejects non-boolean ok field", () => {
  const result = QdrantHealthResultSchema.safeParse({ ok: "yes", latencyMs: 10 });
  assert.equal(result.success, false, "ok must be boolean");
});
