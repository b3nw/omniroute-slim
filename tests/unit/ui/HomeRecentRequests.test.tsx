// @vitest-environment jsdom
import React from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => {
    const messages: Record<string, string> = {
      recentRequests: "Recent Requests",
      recentRequestsEmpty: "No requests yet.",
      recentRequestsModel: "Model",
      recentRequestsProvider: "Provider",
      recentRequestsTokens: "In / Out",
      recentRequestsWhen: "When",
    };
    return messages[key] || key;
  },
}));

vi.mock("next/image", () => ({
  default: (props: Record<string, unknown>) => {
    const { alt, ...rest } = props as { alt?: string } & Record<string, unknown>;
    // eslint-disable-next-line @next/next/no-img-element
    return <img data-testid="next-image" alt={alt || ""} {...rest} />;
  },
}));

const {
  default: HomeRecentRequests,
  resolveProviderName,
  formatCachePercentage,
  isConnectionTestRow,
  requestState,
  timeAgo,
} = await import("../../../src/app/(dashboard)/home/HomeRecentRequests");

// ── Test Setup ─────────────────────────────────────────────────────────────────

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

function jsonResponse(body: unknown) {
  return {
    ok: true,
    json: async () => body,
  } as Response;
}

beforeEach(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;

  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

// ── Helper Unit Tests ──────────────────────────────────────────────────────────

describe("HomeRecentRequests — helper functions", () => {
  describe("formatCachePercentage", () => {
    it("returns 0 when cacheRead is 0 or not provided", () => {
      expect(formatCachePercentage(1000, 0)).toBe(0);
      expect(formatCachePercentage(1000, undefined)).toBe(0);
      expect(formatCachePercentage(1000, null)).toBe(0);
      expect(formatCachePercentage(1000, -50)).toBe(0);
    });

    it("calculates correct percentage of cacheRead relative to tokensIn", () => {
      expect(formatCachePercentage(1000, 850)).toBe(85);
      expect(formatCachePercentage(254, 216)).toBe(85);
      expect(formatCachePercentage(200, 50)).toBe(25);
      expect(formatCachePercentage(100, 100)).toBe(100);
    });

    it("clamps percentage to at most 100", () => {
      expect(formatCachePercentage(100, 150)).toBe(100);
    });

    it("handles zero or missing tokensIn with positive cacheRead safely", () => {
      expect(formatCachePercentage(0, 50)).toBe(100);
      expect(formatCachePercentage(-10, 50)).toBe(100);
      expect(formatCachePercentage(undefined, 50)).toBe(100);
      expect(formatCachePercentage(null, 50)).toBe(100);
    });

    it("ensures any positive cache hit displays at least 1%", () => {
      expect(formatCachePercentage(10000, 1)).toBe(1);
      expect(formatCachePercentage(10000, 49)).toBe(1);
      expect(formatCachePercentage(10000, 51)).toBe(1);
    });
  });

  describe("resolveProviderName", () => {
    it("prefers providerDisplay if present", () => {
      expect(
        resolveProviderName({
          provider: "openai",
          providerDisplay: "Custom OpenAI Node",
        })
      ).toBe("Custom OpenAI Node");
    });

    it("resolves compatible provider labels", () => {
      expect(
        resolveProviderName({
          provider: "openai-compatible-chat-12345678-abcd",
        })
      ).toBe("OAI-COMPAT");

      expect(
        resolveProviderName({
          provider: "anthropic-compatible-chat-12345678-abcd",
        })
      ).toBe("ANT-COMPAT");
    });

    it("resolves built-in provider names", () => {
      expect(resolveProviderName({ provider: "openai" })).toBe("OpenAI");
      expect(resolveProviderName({ provider: "claude" })).toBe("Claude Code");
      expect(resolveProviderName({ provider: "anthropic" })).toBe("Anthropic");
      expect(resolveProviderName({ provider: "gemini" })).toBe("Gemini (Google AI Studio)");
      expect(resolveProviderName({ provider: "groq" })).toBe("Groq");
    });

    it("falls back gracefully for unknown or missing provider", () => {
      expect(resolveProviderName({ provider: "custom-unknown-provider" })).toBe(
        "custom-unknown-provider"
      );
      expect(resolveProviderName({})).toBe("—");
      expect(resolveProviderName({ provider: "" })).toBe("—");
    });
  });

  describe("isConnectionTestRow", () => {
    it("identifies connection test rows", () => {
      expect(isConnectionTestRow({ model: "connection-test" })).toBe(true);
      expect(isConnectionTestRow({ sourceFormat: "test" })).toBe(true);
      expect(isConnectionTestRow({ targetFormat: "test" })).toBe(true);
      expect(isConnectionTestRow({ path: "/api/providers/test" })).toBe(true);
      expect(isConnectionTestRow({ model: "gpt-4o", path: "/v1/chat/completions" })).toBe(false);
    });
  });

  describe("requestState", () => {
    it("returns active for active or status 0 requests", () => {
      expect(requestState({ active: true })).toBe("active");
      expect(requestState({ status: 0 })).toBe("active");
    });

    it("returns error for status >= 400 or error presence", () => {
      expect(requestState({ status: 500 })).toBe("error");
      expect(requestState({ status: 404 })).toBe("error");
      expect(requestState({ error: "timeout" })).toBe("error");
    });

    it("returns ok for 200 responses", () => {
      expect(requestState({ status: 200 })).toBe("ok");
    });
  });

  describe("timeAgo", () => {
    it("formats relative timestamps correctly", () => {
      const now = 1000000000;
      expect(timeAgo(new Date(now - 15000).toISOString(), now)).toBe("15s");
      expect(timeAgo(new Date(now - 120000).toISOString(), now)).toBe("2m");
      expect(timeAgo(new Date(now - 7200000).toISOString(), now)).toBe("2h");
      expect(timeAgo(new Date(now - 172800000).toISOString(), now)).toBe("2d");
      expect(timeAgo(undefined, now)).toBe("");
    });
  });
});

// ── Component Rendering Tests ──────────────────────────────────────────────────

describe("HomeRecentRequests Component", () => {
  it("renders table headers including Provider, Model, In / Out, and When", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(jsonResponse([])))
    );

    await act(async () => {
      root.render(<HomeRecentRequests enabled={true} />);
    });

    expect(container.textContent).toContain("Recent Requests");
    expect(container.textContent).toContain("No requests yet.");
  });

  it("renders rows with Provider column and standard tokens when no cache", async () => {
    const mockLogs = [
      {
        id: "req-1",
        timestamp: new Date().toISOString(),
        status: 200,
        provider: "openai",
        model: "gpt-4o",
        tokens: { in: 500, out: 120 },
      },
    ];

    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(jsonResponse(mockLogs)))
    );

    await act(async () => {
      root.render(<HomeRecentRequests enabled={true} />);
    });

    // Check table headers
    const ths = Array.from(container.querySelectorAll("th")).map((th) => th.textContent?.trim());
    expect(ths).toContain("Provider");
    expect(ths).toContain("Model");
    expect(ths).toContain("In / Out");
    expect(ths).toContain("When");

    // Check row content
    expect(container.textContent).toContain("OpenAI");
    expect(container.textContent).toContain("gpt-4o");
    expect(container.textContent).toContain("500↑");
    expect(container.textContent).toContain("120↓");
  });

  it("renders inline blue prompt cache percentage when tokens.cacheRead > 0", async () => {
    const mockLogs = [
      {
        id: "req-cache-hit",
        timestamp: new Date().toISOString(),
        status: 200,
        provider: "claude",
        model: "claude-3-7-sonnet",
        tokens: { in: 1000, out: 350, cacheRead: 850 },
      },
    ];

    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(jsonResponse(mockLogs)))
    );

    await act(async () => {
      root.render(<HomeRecentRequests enabled={true} />);
    });

    // Check Provider and Model
    expect(container.textContent).toContain("Claude Code");
    expect(container.textContent).toContain("claude-3-7-sonnet");

    // Check tokens column has In, Out, and Cache %
    expect(container.textContent).toContain("1.0K↑");
    expect(container.textContent).toContain("85%");
    expect(container.textContent).toContain("350↓");

    // Check that the cache percentage element has the blue text styling
    const blueBadge = container.querySelector(".text-sky-600, .text-sky-400");
    expect(blueBadge).not.toBeNull();
    expect(blueBadge?.textContent?.trim()).toBe("85%");
  });

  it("renders providerDisplay override and active in-flight request correctly", async () => {
    const mockLogs = [
      {
        id: "req-active",
        timestamp: new Date().toISOString(),
        status: 0,
        active: true,
        provider: "gemini",
        providerDisplay: "Gemini Pro Direct",
        model: "gemini-2.5-pro",
        tokens: { in: 254, out: 0, cacheRead: 216 },
      },
    ];

    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(jsonResponse(mockLogs)))
    );

    await act(async () => {
      root.render(<HomeRecentRequests enabled={true} />);
    });

    // Custom providerDisplay used
    expect(container.textContent).toContain("Gemini Pro Direct");
    expect(container.textContent).toContain("gemini-2.5-pro");
    // Active request displays 3-dot indicator
    expect(container.textContent).toContain("•••");
    // Cache percentage is 85% (216 / 254 = 85%)
    expect(container.textContent).toContain("85%");
  });

  it("filters out connection test rows from display", async () => {
    const mockLogs = [
      {
        id: "req-test",
        timestamp: new Date().toISOString(),
        status: 200,
        provider: "openai",
        model: "connection-test",
        tokens: { in: 10, out: 10 },
      },
      {
        id: "req-real",
        timestamp: new Date().toISOString(),
        status: 200,
        provider: "groq",
        model: "llama-3.3-70b",
        tokens: { in: 150, out: 80 },
      },
    ];

    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(jsonResponse(mockLogs)))
    );

    await act(async () => {
      root.render(<HomeRecentRequests enabled={true} />);
    });

    expect(container.textContent).not.toContain("connection-test");
    expect(container.textContent).toContain("Groq");
    expect(container.textContent).toContain("llama-3.3-70b");
  });

  it("handles long provider and model strings with truncation and title attributes", async () => {
    const mockLogs = [
      {
        id: "req-long",
        timestamp: new Date().toISOString(),
        status: 200,
        provider: "openai-compatible-chat-very-long-unique-identifier-for-custom-model-server-endpoint",
        providerDisplay: "Ultra Super Long Custom Compatible Provider Node Name 2026",
        model: "deepseek-ai/DeepSeek-R1-Distill-Llama-70B-Specialized-Instruction-Tuned",
        tokens: { in: 12000, out: 450, cacheRead: 10200 },
      },
    ];

    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(jsonResponse(mockLogs)))
    );

    await act(async () => {
      root.render(<HomeRecentRequests enabled={true} />);
    });

    const providerCell = container.querySelector("td[title*='Ultra Super Long']");
    expect(providerCell).not.toBeNull();
    expect(providerCell?.getAttribute("title")).toBe(
      "Ultra Super Long Custom Compatible Provider Node Name 2026"
    );
    expect(providerCell?.className).toContain("truncate");

    const modelCell = container.querySelector("td[title*='DeepSeek-R1-Distill']");
    expect(modelCell).not.toBeNull();
    expect(modelCell?.getAttribute("title")).toBe(
      "deepseek-ai/DeepSeek-R1-Distill-Llama-70B-Specialized-Instruction-Tuned"
    );
    expect(modelCell?.className).toContain("truncate");

    // Cache %: 10200 / 12000 = 85%
    expect(container.textContent).toContain("85%");
  });
});
