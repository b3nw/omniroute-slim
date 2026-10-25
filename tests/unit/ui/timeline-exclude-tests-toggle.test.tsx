// @vitest-environment jsdom
/**
 * #10897 — the request timeline's live feed must be able to hide synthetic rows
 * (connection tests, model sync, and every other non-inference backend job).
 *
 * Before this, the timeline ALWAYS fetched `/api/usage/call-logs?limit=200`
 * with no filter, so a burst of "Test connection" probes filled the waterfall
 * and pushed real provider traffic out of the visible window. The fix adds a
 * toolbar toggle that appends `excludeTests=1` to the query, which makes the
 * server apply the allowlist (`/v1/*` and `/api/v1/*`) at the SQL layer — before
 * LIMIT, so probes can never crowd out real rows.
 *
 * The preference is persisted in localStorage so it survives a reload.
 */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    replace: vi.fn(),
    push: vi.fn(),
    prefetch: vi.fn(),
    refresh: vi.fn(),
  }),
}));

const { default: RequestTimeline } = await import("../../../src/shared/components/RequestTimeline");
const {
  TIMELINE_EXCLUDE_TESTS_STORAGE_KEY,
  buildTimelineCallLogsUrl,
} = await import("../../../src/shared/components/RequestTimeline.utils");

class FakeResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

// This jsdom setup ships no localStorage, and the toggle persists its
// preference there — stub a minimal in-memory implementation.
const storage = new Map<string, string>();
const localStorageMock = {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => {
    storage.set(key, value);
  },
  removeItem: (key: string) => {
    storage.delete(key);
  },
  clear: () => {
    storage.clear();
  },
  key: (index: number) => Array.from(storage.keys())[index] ?? null,
  get length() {
    return storage.size;
  },
};
Object.defineProperty(globalThis, "localStorage", {
  value: localStorageMock,
  configurable: true,
  writable: true,
});

let container: HTMLElement;
let root: Root;
let fetchMock: ReturnType<typeof vi.fn>;

async function settle() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(50);
  });
}

function callLogUrls(): string[] {
  return fetchMock.mock.calls
    .map((call) => String(call[0]))
    .filter((url) => url.startsWith("/api/usage/call-logs"));
}

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
  fetchMock = vi.fn(async () => Response.json([]));
  vi.stubGlobal("fetch", fetchMock);
  vi.useFakeTimers();
  localStorage.clear();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe("buildTimelineCallLogsUrl", () => {
  it("adds excludeTests=1 only when the toggle is on", () => {
    expect(buildTimelineCallLogsUrl(200, false)).toBe("/api/usage/call-logs?limit=200");
    expect(buildTimelineCallLogsUrl(200, true)).toBe("/api/usage/call-logs?limit=200&excludeTests=1");
  });
});

describe("Timeline excludeTests toggle", () => {
  it("fetches without the filter by default", async () => {
    await act(async () => {
      root.render(<RequestTimeline />);
    });
    await settle();

    const urls = callLogUrls();
    expect(urls.length).toBeGreaterThan(0);
    expect(urls.every((url) => !url.includes("excludeTests"))).toBe(true);
  });

  it("adds excludeTests=1 to the query once the toggle is checked", async () => {
    await act(async () => {
      root.render(<RequestTimeline />);
    });
    await settle();

    const toggle = container.querySelector(
      '[data-testid="timeline-exclude-tests"]'
    ) as HTMLInputElement;
    expect(toggle).toBeTruthy();
    expect(toggle.checked).toBe(false);

    await act(async () => {
      toggle.click();
    });
    await settle();

    const urls = callLogUrls();
    expect(urls.length).toBeGreaterThan(0);
    expect(urls[urls.length - 1]).toContain("excludeTests=1");
  });

  it("removes the filter again when the toggle is unchecked", async () => {
    await act(async () => {
      root.render(<RequestTimeline />);
    });
    await settle();

    const toggle = container.querySelector(
      '[data-testid="timeline-exclude-tests"]'
    ) as HTMLInputElement;

    await act(async () => {
      toggle.click();
    });
    await settle();
    expect(callLogUrls().at(-1)).toContain("excludeTests=1");

    await act(async () => {
      toggle.click();
    });
    await settle();
    expect(callLogUrls().at(-1)).not.toContain("excludeTests");
  });

  it("persists the preference and restores it on the next mount", async () => {
    await act(async () => {
      root.render(<RequestTimeline />);
    });
    await settle();

    const toggle = container.querySelector(
      '[data-testid="timeline-exclude-tests"]'
    ) as HTMLInputElement;
    await act(async () => {
      toggle.click();
    });
    await settle();

    expect(localStorage.getItem(TIMELINE_EXCLUDE_TESTS_STORAGE_KEY)).toBe("1");

    // Remount — the stored preference must come back and the query must carry it.
    await act(async () => {
      root.unmount();
    });
    root = createRoot(container);
    await act(async () => {
      root.render(<RequestTimeline />);
    });
    await settle();

    const remounted = container.querySelector(
      '[data-testid="timeline-exclude-tests"]'
    ) as HTMLInputElement;
    expect(remounted.checked).toBe(true);
    expect(callLogUrls().at(-1)).toContain("excludeTests=1");
  });
});
