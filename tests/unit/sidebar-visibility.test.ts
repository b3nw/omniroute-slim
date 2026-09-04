import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const sidebarVisibility = await import("../../src/shared/constants/sidebarVisibility.ts");
const repoRoot = join(import.meta.dirname, "../..");

function sectionItems(sectionId: string) {
  const section = sidebarVisibility.SIDEBAR_SECTIONS.find(
    (candidate) => candidate.id === sectionId
  );
  assert.ok(section, `expected ${sectionId} sidebar section to exist`);
  return sidebarVisibility.getSectionItems(section);
}

test("system sidebar items: monitoring has activity at top then logs/audit/system groups", () => {
  const items = sectionItems("monitoring");
  assert.deepEqual(
    items.map((item) => item.id),
    [
      "activity",
      "logs",
      "logs-proxy",
      "logs-console",
      "logs-timeline",
      "conversations",
      "audit",
      "audit-mcp",
      "audit-a2a",
      "health",
      "runtime",
      "resilience-connections",
    ]
  );
});

test("primary sidebar items place limits after cache", () => {
  const items = sectionItems("omni-proxy");
  assert.deepEqual(
    items.map((item) => item.id),
    [
      "endpoints",
      "api-manager",
      "providers",
      "embedded-services",
      "combos",
      "combos-live",
      "quota",
      "costs-quota-share",
      "context-settings",
      "context-combos",
      "context-caveman",
      "context-rtk",
      "context-headroom",
      "context-session-dedup",
      "context-ccr",
      "context-llmlingua",
      "context-lite",
      "context-aggressive",
      "context-ultra",
      "context-omniglyph",
      "compression-studio",
      "compression-exclusions",
      "cli-code",
      "cli-agents",
      "acp-agents",
      "cloud-agents",
      "conductor",
      "agent-bridge",
      "traffic-inspector",
      "discovery",
      "api-endpoints",
      "webhooks",
      "proxy",
    ]
  );
});

test("context sidebar section sits between primary and cli", () => {
  const sectionIds = sidebarVisibility.SIDEBAR_SECTIONS.map((section) => section.id);
  assert.deepEqual(sectionIds.slice(0, 4), ["home", "omni-proxy", "analytics", "costs"]);

  const items = sectionItems("omni-proxy");
  assert.deepEqual(
    items
      .filter((item) => item.id.startsWith("context-"))
      .map((item) => ({ id: item.id, href: item.href })),
    [
      { id: "context-settings", href: "/dashboard/context/settings" },
      { id: "context-combos", href: "/dashboard/context/combos" },
      { id: "context-caveman", href: "/dashboard/context/caveman" },
      { id: "context-rtk", href: "/dashboard/context/rtk" },
      { id: "context-headroom", href: "/dashboard/context/headroom" },
      { id: "context-session-dedup", href: "/dashboard/context/session-dedup" },
      { id: "context-ccr", href: "/dashboard/context/ccr" },
      { id: "context-llmlingua", href: "/dashboard/context/llmlingua" },
      { id: "context-lite", href: "/dashboard/context/lite" },
      { id: "context-aggressive", href: "/dashboard/context/aggressive" },
      { id: "context-ultra", href: "/dashboard/context/ultra" },
      { id: "context-omniglyph", href: "/dashboard/context/omniglyph" },
    ]
  );
});

test("sidebar visibility drops stale entries from saved settings", () => {
  const allSidebarItemIds = sidebarVisibility.SIDEBAR_SECTIONS.flatMap((section) =>
    sidebarVisibility.getSectionItems(section).map((item) => item.id)
  );

  assert.equal(
    (sidebarVisibility.HIDEABLE_SIDEBAR_ITEM_IDS as readonly string[]).includes("auto-combo"),
    false
  );
  assert.equal((allSidebarItemIds as string[]).includes("auto-combo"), false);
  assert.equal(
    (sidebarVisibility.HIDEABLE_SIDEBAR_ITEM_IDS as readonly string[]).includes("settings"),
    false
  );
  assert.equal((allSidebarItemIds as string[]).includes("settings"), false);
  assert.deepEqual(sidebarVisibility.normalizeHiddenSidebarItems(["auto-combo" as any, "logs"]), [
    "logs",
  ]);
});

test("help sidebar exposes docs and issues", () => {
  const items = sectionItems("help");
  assert.deepEqual(
    items.map((item) => ({
      id: item.id,
      href: item.href,
      i18nKey: item.i18nKey,
    })),
    [
      { id: "docs", href: "/docs", i18nKey: "docs" },
      {
        id: "issues",
        href: "https://github.com/diegosouzapw/OmniRoute/issues",
        i18nKey: "issues",
      },
    ]
  );
});

test("legacy dashboard routes redirect to their consolidated surfaces", async () => {
  const usagePage = await readFile(
    join(repoRoot, "src/app/(dashboard)/dashboard/usage/page.tsx"),
    "utf8"
  );
  const settingsPage = await readFile(
    join(repoRoot, "src/app/(dashboard)/dashboard/settings/page.tsx"),
    "utf8"
  );

  assert.match(usagePage, /redirect\("\/dashboard\/logs"\)/);
  assert.match(settingsPage, /redirect\(resolveSettingsRoute\(tab\)\)/);
  assert.match(settingsPage, /\/dashboard\/settings\/general/);

  const compressionPage = await readFile(
    join(repoRoot, "src/app/(dashboard)/dashboard/compression/page.tsx"),
    "utf8"
  );
  assert.match(compressionPage, /redirect\("\/dashboard\/context\/caveman"\)/);
});
