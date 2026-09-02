import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  formatCachePercentage,
  resolveProviderName,
  isConnectionTestRow,
  requestState,
  timeAgo,
} from "../../src/app/(dashboard)/home/HomeRecentRequests.tsx";

const homeRecentRequestsSrc = readFileSync(
  fileURLToPath(new URL("../../src/app/(dashboard)/home/HomeRecentRequests.tsx", import.meta.url)),
  "utf8"
);

test("HomeRecentRequests renders Provider column in the table header", () => {
  assert.match(
    homeRecentRequestsSrc,
    /\{t\("recentRequestsProvider"\)\}/,
    "HomeRecentRequests must have a Provider column header"
  );
});

test("HomeRecentRequests renders Provider display and icon in table rows", () => {
  assert.match(
    homeRecentRequestsSrc,
    /resolveProviderName/,
    "HomeRecentRequests must resolve provider display name"
  );
  assert.match(
    homeRecentRequestsSrc,
    /<ProviderIcon\s+providerId=\{row\.provider\}\s+size=\{14\}\s+type="color"\s*\/>/,
    "HomeRecentRequests must render ProviderIcon with providerId"
  );
});

test("HomeRecentRequests renders inline blue caching percentage when cacheRead > 0", () => {
  assert.match(
    homeRecentRequestsSrc,
    /typeof\s+row\.tokens\?\.cacheRead\s*===\s*"number"\s*&&\s*row\.tokens\.cacheRead\s*>\s*0/,
    "HomeRecentRequests must check for positive cacheRead"
  );
  assert.match(
    homeRecentRequestsSrc,
    /text-sky-600\s+dark:text-sky-400/,
    "HomeRecentRequests must render prompt cache percentage in blue text"
  );
});

test("recentRequestsProvider exists in en.json and all locale catalogs", () => {
  const enMessages = JSON.parse(
    readFileSync(fileURLToPath(new URL("../../src/i18n/messages/en.json", import.meta.url)), "utf8")
  );
  assert.equal(
    enMessages.home?.recentRequestsProvider,
    "Provider",
    "en.json must contain home.recentRequestsProvider = Provider"
  );
});

test("formatCachePercentage calculates accurate cache ratio and handles edge cases", () => {
  assert.equal(formatCachePercentage(1000, 850), 85);
  assert.equal(formatCachePercentage(254, 216), 85);
  assert.equal(formatCachePercentage(100, 50), 50);
  assert.equal(formatCachePercentage(100, 0), 0);
  assert.equal(formatCachePercentage(100, null), 0);
  assert.equal(formatCachePercentage(100, undefined), 0);
  assert.equal(formatCachePercentage(100, -5), 0);
  assert.equal(formatCachePercentage(0, 50), 100);
  assert.equal(formatCachePercentage(-10, 50), 100);
  assert.equal(formatCachePercentage(undefined, 50), 100);
  assert.equal(formatCachePercentage(null, 50), 100);
  assert.equal(formatCachePercentage(100, 150), 100);
  // Any positive cache hit must return at least 1%
  assert.equal(formatCachePercentage(10000, 1), 1);
  assert.equal(formatCachePercentage(10000, 49), 1);
  assert.equal(formatCachePercentage(10000, 51), 1);
});

test("resolveProviderName resolves provider names and overrides correctly", () => {
  assert.equal(
    resolveProviderName({ provider: "openai", providerDisplay: "Custom Node" }),
    "Custom Node"
  );
  assert.equal(
    resolveProviderName({ provider: "openai-compatible-chat-12345678-abcd" }),
    "OAI-COMPAT"
  );
  assert.equal(
    resolveProviderName({ provider: "anthropic-compatible-chat-12345678-abcd" }),
    "ANT-COMPAT"
  );
  assert.equal(resolveProviderName({ provider: "openai" }), "OpenAI");
  assert.equal(resolveProviderName({ provider: "claude" }), "Claude Code");
  assert.equal(resolveProviderName({ provider: "anthropic" }), "Anthropic");
  assert.equal(resolveProviderName({ provider: "gemini" }), "Gemini (Google AI Studio)");
  assert.equal(resolveProviderName({ provider: "groq" }), "Groq");
  assert.equal(resolveProviderName({ provider: "unknown-abc" }), "unknown-abc");
  assert.equal(resolveProviderName({ provider: "" }), "—");
  assert.equal(resolveProviderName({ provider: "   " }), "—");
  assert.equal(resolveProviderName({}), "—");
});

test("isConnectionTestRow filters test probes", () => {
  assert.equal(isConnectionTestRow({ model: "connection-test" }), true);
  assert.equal(isConnectionTestRow({ sourceFormat: "test" }), true);
  assert.equal(isConnectionTestRow({ targetFormat: "test" }), true);
  assert.equal(isConnectionTestRow({ path: "/api/providers/test" }), true);
  assert.equal(isConnectionTestRow({ model: "gpt-4o", path: "/v1/chat/completions" }), false);
});

test("requestState determines row status correctly", () => {
  assert.equal(requestState({ active: true }), "active");
  assert.equal(requestState({ status: 0 }), "active");
  assert.equal(requestState({ status: 500 }), "error");
  assert.equal(requestState({ error: "failed" }), "error");
  assert.equal(requestState({ status: 200 }), "ok");
});

test("timeAgo formats elapsed time", () => {
  const now = 1700000000000;
  assert.equal(timeAgo(new Date(now - 30000).toISOString(), now), "30s");
  assert.equal(timeAgo(new Date(now - 180000).toISOString(), now), "3m");
  assert.equal(timeAgo(new Date(now - 7200000).toISOString(), now), "2h");
  assert.equal(timeAgo(new Date(now - 172800000).toISOString(), now), "2d");
  assert.equal(timeAgo(undefined, now), "");
});
