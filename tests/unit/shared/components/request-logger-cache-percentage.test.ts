import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { formatCachePercentage } from "../../../../src/shared/components/RequestLoggerV2";

describe("RequestLoggerV2 - formatCachePercentage", () => {
  it("calculates correct cache percentage under normal conditions", () => {
    assert.equal(formatCachePercentage(100, 50), 50);
    assert.equal(formatCachePercentage(1000, 250), 25);
    assert.equal(formatCachePercentage(300, 100), 33);
  });

  it("clamps cache percentage at 100% when cacheRead exceeds tokensIn", () => {
    assert.equal(formatCachePercentage(100, 150), 100);
    assert.equal(formatCachePercentage(50, 500), 100);
  });

  it("returns 0 for zero or non-positive token counts", () => {
    assert.equal(formatCachePercentage(0, 50), 0);
    assert.equal(formatCachePercentage(-10, 50), 0);
    assert.equal(formatCachePercentage(100, 0), 0);
    assert.equal(formatCachePercentage(100, -20), 0);
  });

  it("returns 0 for null or undefined token counts", () => {
    assert.equal(formatCachePercentage(null, 50), 0);
    assert.equal(formatCachePercentage(100, null), 0);
    assert.equal(formatCachePercentage(undefined, undefined), 0);
  });
});
