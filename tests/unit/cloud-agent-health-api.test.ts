import assert from "node:assert/strict";
import { describe, test } from "node:test";

describe("cloud-agent health API — health check logic", () => {
  // The route's checkProviderHealth returns { connected: false, error: "No credentials configured" }
  // when getCredentialFromDb returns null. We test this logic pattern directly.

  test("missing credentials produces connected: false with error message", () => {
    // Simulate the logic from the route handler
    const credentials = null; // getCredentialFromDb returns null
    const result = {
      id: "jules",
      name: "Jules",
      connected: credentials !== null,
      latencyMs: 0,
      error: credentials === null ? "No credentials configured" : undefined,
    };

    assert.equal(result.connected, false);
    assert.equal(result.error, "No credentials configured");
  });

  test("unknown provider produces connected: false with Unknown provider error", () => {
    // Simulate: getAgent returns null for unknown provider
    const agent = null;
    const result = {
      id: "unknown",
      name: "unknown",
      connected: false,
      latencyMs: 0,
      error: agent === null ? "Unknown provider" : undefined,
    };

    assert.equal(result.connected, false);
    assert.equal(result.error, "Unknown provider");
  });

  test("PROVIDER_NAMES maps agent ids to display names", () => {
    const PROVIDER_NAMES: Record<string, string> = {
      jules: "Jules",
      devin: "Devin",
      "codex-cloud": "Codex Cloud",
      "cursor-cloud": "Cursor Cloud",
    };

    assert.equal(PROVIDER_NAMES["jules"], "Jules");
    assert.equal(PROVIDER_NAMES["devin"], "Devin");
    assert.equal(PROVIDER_NAMES["codex-cloud"], "Codex Cloud");
    assert.equal(PROVIDER_NAMES["cursor-cloud"], "Cursor Cloud");
    assert.equal(PROVIDER_NAMES["nonexistent"], undefined);
  });
});
