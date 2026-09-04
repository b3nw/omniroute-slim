import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

function readSource(relativePath: string) {
  return readFileSync(new URL("../../" + relativePath, import.meta.url), "utf8");
}

test("analytics page exposes the restored analytics tab shell", () => {
  const source = readSource("src/app/(dashboard)/dashboard/analytics/page.tsx");

  assert.ok(source.includes('role="tablist"'));
  assert.ok(source.includes('aria-label={t("sectionsAria")}'));
  for (const [labelKey, label] of [
    ["overview", "Overview"],
    ["evals", "Evals"],
    ["search", "Search"],
    ["utilization", "Utilization"],
    ["comboHealth", "Combo Health"],
    ["routeTrace", "Route Trace"],
  ]) {
    assert.ok(source.includes('labelKey: "' + labelKey + '"'));
    assert.ok(source.includes('label: "' + label + '"'));
  }
  for (const tabId of [
    "overview",
    "evals",
    "search",
    "utilization",
    "combo-health",
    "route-trace",
  ]) {
    assert.ok(source.includes('id: "' + tabId + '"'));
  }
});

test("settings root redirects to section pages instead of rendering a tab shell", () => {
  const pageSource = readSource("src/app/(dashboard)/dashboard/settings/page.tsx");

  assert.ok(pageSource.includes('import { redirect } from "next/navigation"'));
  assert.ok(pageSource.includes('general: "/dashboard/settings/general"'));
  assert.ok(pageSource.includes('resilience: "/dashboard/settings/resilience"'));
  assert.ok(pageSource.includes("redirect(resolveSettingsRoute(tab))"));
});

test("provider limit status chips use English fallback labels", () => {
  const source = readSource(
    "src/app/(dashboard)/dashboard/usage/components/ProviderLimits/index.tsx"
  );

  assert.ok(source.includes('critical: tr("statCritical", "Critical")'));
  assert.ok(source.includes('alert: tr("statAlert", "Alert")'));
  assert.ok(source.includes('ok: tr("statHealthy", "Healthy")'));
  assert.doesNotMatch(source, /Crítico|Alerta|Saudável/);
});

test("provider limits collapsed rows show quota resets and progress bars inline", () => {
  const source = readSource(
    "src/app/(dashboard)/dashboard/usage/components/ProviderLimits/index.tsx"
  );

  assert.ok(source.includes("const renderInlineQuotaSummary = (quotas: any[]) =>"));
  assert.ok(source.includes("const cd = formatCountdown(q.resetAt)"));
  assert.ok(source.includes("`⏱ ${cd}`"));
  assert.ok(source.includes("h-1 w-14 rounded-sm"));
  assert.ok(source.includes("getQuotaBarWidthClass(pct)"));
  assert.ok(source.includes("getQuotaToneClasses(pct)"));
  assert.ok(source.includes("renderInlineQuotaSummary(quota.quotas)"));
});
