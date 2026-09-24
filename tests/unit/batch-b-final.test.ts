/**
 * Batch B — Final Tasks Tests
 *
 * Tests for: a11yAudit, responsiveSpecs, noLog + retention windows
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";

// ──────────────── T-35: a11y Audit ────────────────

import { auditHTML, generateReport, WCAG_RULES } from "../../src/shared/utils/a11yAudit.ts";

describe("a11yAudit", () => {
  it("should pass for compliant HTML", () => {
    const html = '<button aria-label="Close">X</button><img alt="Logo" src="logo.png" />';
    const violations = auditHTML(html);
    assert.equal(violations.length, 0);
  });

  it("should detect images without alt text", () => {
    const html = '<img src="photo.jpg" />';
    const violations = auditHTML(html);
    assert.ok(violations.some((v) => v.id === WCAG_RULES.IMAGE_ALT));
  });

  it("should detect dialogs without role", () => {
    const html = '<div class="modal"><p>Content</p></div>';
    const violations = auditHTML(html);
    assert.ok(violations.some((v) => v.id === WCAG_RULES.DIALOG_ROLE));
  });

  it("should generate report summary", () => {
    const violations = [
      { id: "test", description: "test", impact: "critical", help: "fix", nodes: [] },
      { id: "test2", description: "test", impact: "serious", help: "fix", nodes: [] },
    ];
    const report = generateReport(violations);
    assert.equal(report.total, 2);
    assert.equal(report.critical, 1);
    assert.equal(report.serious, 1);
    assert.equal(report.passed, false);
  });

  it("should report passed for no violations", () => {
    const report = generateReport([]);
    assert.equal(report.passed, true);
    assert.equal(report.total, 0);
  });

  it("should not export the removed contrast compliance wrapper", async () => {
    const audit = await import("../../src/shared/utils/a11yAudit.ts");
    assert.equal("checkContrast" in audit, false);
    assert.equal(typeof audit.getContrastRatio, "function");
    assert.equal(typeof audit.auditHTML, "function");
    assert.equal(typeof audit.generateReport, "function");
  });

  it("should export WCAG rules", () => {
    assert.ok(WCAG_RULES.ARIA_LABEL);
    assert.ok(WCAG_RULES.COLOR_CONTRAST);
    assert.ok(WCAG_RULES.FOCUS_TRAP);
  });
});

// ──────────────── T-39: Responsive Specs ────────────────

import {
  A11Y_CHECKS,
  VIEWPORTS,
  PAGES,
  generateTestMatrix,
  getViewportNames,
} from "../../tests/e2e/responsiveSpecs.ts";

describe("responsiveSpecs", () => {
  it("should define mobile, tablet, desktop viewports", () => {
    assert.ok(VIEWPORTS.mobile);
    assert.ok(VIEWPORTS.tablet);
    assert.ok(VIEWPORTS.desktop);
    assert.equal(VIEWPORTS.mobile.width, 375);
    assert.equal(VIEWPORTS.tablet.width, 768);
  });

  it("should define pages to test", () => {
    assert.ok(PAGES.length >= 4);
    assert.ok(PAGES.some((p) => p.path === "/login"));
    assert.ok(PAGES.some((p) => p.path === "/dashboard"));
  });

  it("should generate test matrix", () => {
    const matrix = generateTestMatrix();
    assert.equal(matrix.length, 3 * PAGES.length); // 3 viewports × n pages
    assert.ok(matrix[0].testName);
    assert.ok(matrix[0].viewport);
    assert.ok(matrix[0].page);
  });

  it("should get viewport names", () => {
    const names = getViewportNames();
    assert.deepEqual(names, ["mobile", "tablet", "desktop"]);
  });

  it("should separate executable and manual accessibility checks", () => {
    assert.ok(A11Y_CHECKS.some((check) => check.kind === "evaluate"));
    assert.ok(A11Y_CHECKS.some((check) => check.kind === "manual"));
    assert.ok(A11Y_CHECKS.every((check) => typeof check.criteria === "string"));
  });
});

// ──────────────── T-43: Compliance (noLog) ────────────────

import { setNoLog, isNoLog } from "../../src/lib/db/noLog.ts";
import { getRetentionDays } from "../../src/lib/db/logRetention.ts";

describe("noLog + retention windows", () => {
  it("should default to logging enabled", () => {
    assert.equal(isNoLog("key-1"), false);
  });

  it("should set noLog opt-out", () => {
    setNoLog("key-1", true);
    assert.equal(isNoLog("key-1"), true);
  });

  it("should clear noLog opt-out", () => {
    setNoLog("key-1", false);
    assert.equal(isNoLog("key-1"), false);
  });

  it("should expose split default retention windows", () => {
    assert.deepEqual(getRetentionDays(), { app: 7, call: 7 });
  });
});
