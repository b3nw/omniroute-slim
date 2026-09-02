import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { normalizeComplianceEventTypes } from "../../src/i18n/request";

const root = join(import.meta.dirname, "../..");
const read = (p: string) => readFileSync(join(root, p), "utf8");
const rawEn = JSON.parse(read("src/i18n/messages/en.json"));
const en = normalizeComplianceEventTypes(rawEn);

function getNestedValue(record: Record<string, unknown>, dottedKey: string): unknown {
  return dottedKey.split(".").reduce<unknown>((cursor, segment) => {
    if (!cursor || typeof cursor !== "object" || Array.isArray(cursor)) return undefined;
    return (cursor as Record<string, unknown>)[segment];
  }, record);
}

test("audit: compliance.eventTypes exists with key coverage", () => {
  const rawEnKeys = Object.keys(rawEn.compliance?.eventTypes ?? {});
  assert.ok(rawEnKeys.length >= 30, `expected >=30 event-type labels, got ${rawEnKeys.length}`);
  for (const k of [
    "provider.credentials.created",
    "auth.login.success",
    "quota.pool.created",
    "sync.token.revoked",
  ]) {
    assert.ok(
      getNestedValue(en.compliance.eventTypes as Record<string, unknown>, k),
      `en missing eventTypes.${k}`
    );
  }
});

test("audit: ComplianceTab translates action and A2aAuditTab translates task state", () => {
  const ct = read("src/app/(dashboard)/dashboard/audit/ComplianceTab.tsx");
  const a2a = read("src/app/(dashboard)/dashboard/audit/A2aAuditTab.tsx");
  assert.ok(ct.includes("eventTypes.${entry.action}"), "ComplianceTab uses eventTypes i18n lookup");
  assert.ok(a2a.includes("a2aState${task.state"), "A2aAuditTab uses a2aState i18n lookup");
});
