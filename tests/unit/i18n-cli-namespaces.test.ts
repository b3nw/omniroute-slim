import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const en = require("../../src/i18n/messages/en.json");

// ─── EN namespace presence ────────────────────────────────────────────────────

test("en has cliCommon namespace", () => {
  assert.ok(en.cliCommon, "expected en.json to have 'cliCommon' namespace");
});

test("en has cliCode namespace", () => {
  assert.ok(en.cliCode, "expected en.json to have 'cliCode' namespace");
});

test("en has cliAgents namespace", () => {
  assert.ok(en.cliAgents, "expected en.json to have 'cliAgents' namespace");
});

test("en has acpAgents namespace", () => {
  assert.ok(en.acpAgents, "expected en.json to have 'acpAgents' namespace");
});

// ─── EN page titles ───────────────────────────────────────────────────────────

test("en cliCode.pageTitle is 'CLI Code's'", () => {
  assert.equal(en.cliCode.pageTitle, "CLI Code's");
});

test("en cliAgents.pageTitle is 'CLI Agents'", () => {
  assert.equal(en.cliAgents.pageTitle, "CLI Agents");
});

test("en cliAgents.pageTitle is 'ACP Agents'", () => {
  assert.equal(en.acpAgents.pageTitle, "ACP Agents");
});

// ─── EN cliCommon content ─────────────────────────────────────────────────────

test("en cliCommon.concept.code.phrase is a non-empty string", () => {
  assert.ok(
    typeof en.cliCommon.concept?.code?.phrase === "string" &&
      en.cliCommon.concept.code.phrase.length > 0
  );
});

// ─── EN sidebar keys ──────────────────────────────────────────────────────────

test("en sidebar has cliCode key", () => {
  assert.ok(en.sidebar?.cliCode, "expected en sidebar to have 'cliCode' key");
});

test("en sidebar has cliAgents key", () => {
  assert.ok(en.sidebar?.cliAgents, "expected en sidebar to have 'cliAgents' key");
});

test("en sidebar has acpAgents key", () => {
  assert.ok(en.sidebar?.acpAgents, "expected en sidebar to have 'acpAgents' key");
});
