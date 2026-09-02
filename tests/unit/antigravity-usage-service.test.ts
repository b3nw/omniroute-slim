/**
 * Tests for open-sse/services/usage.ts — Antigravity model family quota parsing.
 *
 * Verifies that Antigravity quotas are grouped strictly by model family:
 * - Gemini Models (5h & Weekly)
 * - Claude and GPT models (5h & Weekly)
 * - No per-model quota keys are emitted.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

const usageModule = await import("../../open-sse/services/usage.ts");
const { getUsageForProvider } = usageModule;

describe("getUsageForProvider (antigravity model family quotas)", () => {
  const connectionBase = {
    id: "test-conn",
    provider: "antigravity",
    accessToken: "fake-token",
    providerSpecificData: { projectId: "test-proj-123" },
    projectId: "test-proj-123",
  };

  it("extracts dual-window family quotas from retrieveUserQuotaSummary and omits per-model quotas", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url: any) => {
      const urlStr = String(url);
      if (urlStr.includes("retrieveUserQuotaSummary")) {
        return {
          ok: true,
          json: async () => ({
            groups: [
              {
                displayName: "Gemini Models",
                buckets: [
                  {
                    displayName: "5 Hours",
                    remainingFraction: 1.0,
                    resetTime: "2026-05-26T05:00:00Z",
                  },
                  {
                    displayName: "Weekly",
                    remainingFraction: 0.85,
                    resetTime: "2026-05-30T00:00:00Z",
                  },
                ],
              },
              {
                displayName: "Claude and GPT models",
                buckets: [
                  {
                    displayName: "5 Hours",
                    remainingFraction: 0.5,
                    resetTime: "2026-05-26T05:00:00Z",
                  },
                  {
                    displayName: "Weekly",
                    remainingFraction: 0.98,
                    resetTime: "2026-05-30T00:00:00Z",
                  },
                ],
              },
            ],
          }),
        } as Response;
      }
      return {
        ok: true,
        json: async () => ({}),
      } as Response;
    };

    try {
      const result = await getUsageForProvider(connectionBase, { forceRefresh: true });
      assert.ok(result, "should return a result");
      assert.ok("quotas" in result, "should have quotas");

      if ("quotas" in result && result.quotas) {
        const quotas = result.quotas as Record<string, any>;
        assert.ok(quotas["gemini_5h"], "should have gemini_5h");
        assert.equal(quotas["gemini_5h"].remainingPercentage, 100);
        assert.equal(quotas["gemini_5h"].displayName, "Gemini Models (5h)");

        assert.ok(quotas["gemini_weekly"], "should have gemini_weekly");
        assert.equal(quotas["gemini_weekly"].remainingPercentage, 85);
        assert.equal(quotas["gemini_weekly"].displayName, "Gemini Models (Weekly)");

        assert.ok(quotas["claude_gpt_5h"], "should have claude_gpt_5h");
        assert.equal(quotas["claude_gpt_5h"].remainingPercentage, 50);
        assert.equal(quotas["claude_gpt_5h"].displayName, "Claude and GPT models (5h)");

        assert.ok(quotas["claude_gpt_weekly"], "should have claude_gpt_weekly");
        assert.equal(quotas["claude_gpt_weekly"].remainingPercentage, 98);
        assert.equal(quotas["claude_gpt_weekly"].displayName, "Claude and GPT models (Weekly)");

        // Assert that per-model quota keys do NOT exist
        assert.equal(quotas["gemini-3.7-flash-high"], undefined);
        assert.equal(quotas["claude-opus-4-6-thinking"], undefined);
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("falls back to gemini_5h from retrieveUserQuota when retrieveUserQuotaSummary is empty", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url: any) => {
      const urlStr = String(url);
      if (urlStr.includes("retrieveUserQuotaSummary")) {
        return {
          ok: true,
          json: async () => ({ groups: [] }),
        } as Response;
      }
      if (urlStr.includes("retrieveUserQuota")) {
        return {
          ok: true,
          json: async () => ({
            buckets: [
              {
                modelId: "gemini-2.5-pro",
                remainingFraction: 0.6,
                resetTime: "2026-05-26T05:00:00Z",
              },
            ],
          }),
        } as Response;
      }
      return {
        ok: true,
        json: async () => ({}),
      } as Response;
    };

    try {
      const result = await getUsageForProvider(connectionBase, { forceRefresh: true });
      assert.ok(result, "should return a result");
      if ("quotas" in result && result.quotas) {
        const quotas = result.quotas as Record<string, any>;
        assert.ok(quotas["gemini_5h"], "should have fallback gemini_5h");
        assert.equal(quotas["gemini_5h"].remainingPercentage, 60);
        assert.equal(quotas["gemini-2.5-pro"], undefined, "should not have per-model entry");
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
