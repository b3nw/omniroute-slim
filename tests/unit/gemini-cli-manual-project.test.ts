/**
 * Gemini CLI manual GCP project support & discovery safeguard.
 *
 * Production bug: discovery fell back to the FIRST active GCP project on the
 * account (e.g. "credit-exp-aipro") even though cloudaicompanion.googleapis.com
 * was not enabled there, so every chat request failed with
 * 403 "Gemini for Google Cloud API has not been used in project ...".
 *
 * Contract pinned here:
 *   1. Discovery only accepts GCP projects whose cloudaicompanion service is
 *      verified ENABLED (and probes OK); otherwise it throws instead of
 *      attaching an arbitrary project.
 *   2. gemini-cli postExchange/mapTokens surface projectDiscoveryOutcome so the
 *      OAuth route saves the connection as degraded with a BYOP warning.
 *   3. The OAuth project gate covers gemini-cli and gemini_cli.
 *
 * Run: node --import tsx/esm --test tests/unit/gemini-cli-manual-project.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  clearGeminiCliProjectCache,
  discoverGeminiCliProjectAndTier,
} from "../../open-sse/services/geminiCliDiscovery.ts";
import { geminiCli } from "../../src/lib/oauth/providers/gemini-cli.ts";
import { antigravityDegradedProjectState } from "../../src/lib/oauth/antigravityProjectGate.ts";

const originalFetch = globalThis.fetch;
const originalEnvProject = process.env.GEMINI_CLI_PROJECT_ID;

function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

test.beforeEach(() => {
  clearGeminiCliProjectCache();
  delete process.env.GEMINI_CLI_PROJECT_ID;
});

test.afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalEnvProject === undefined) delete process.env.GEMINI_CLI_PROJECT_ID;
  else process.env.GEMINI_CLI_PROJECT_ID = originalEnvProject;
});

/**
 * Account with one active GCP project that does NOT have Code Assist enabled,
 * and an onboardUser that completes without assigning a project.
 */
function unprovisionedAccountFetch(
  calls: string[],
  opts: { loadCodeAssistStatus?: number; serviceUsageStatus?: number } = {}
) {
  return (async (url: unknown, init?: RequestInit) => {
    const u = String(url);
    calls.push(u);
    if (u.includes("userinfo")) return jsonRes({ email: "byop@example.com" });
    if (u.includes(":loadCodeAssist")) {
      if (opts.loadCodeAssistStatus && opts.loadCodeAssistStatus !== 200) {
        return new Response("boom", { status: opts.loadCodeAssistStatus });
      }
      return jsonRes({ currentTier: { id: "free-tier" } });
    }
    if (u.includes(":onboardUser")) {
      return jsonRes({ done: true, response: { currentTier: { id: "free-tier" } } });
    }
    if (u.includes("cloudresourcemanager.googleapis.com/v1/projects")) {
      return jsonRes({ projects: [{ projectId: "credit-exp-aipro", lifecycleState: "ACTIVE" }] });
    }
    if (u.includes("services/cloudaicompanion.googleapis.com")) {
      if (opts.serviceUsageStatus && opts.serviceUsageStatus !== 200) {
        return new Response("forbidden", { status: opts.serviceUsageStatus });
      }
      return jsonRes({ state: "DISABLED" });
    }
    void init;
    return new Response("Not Found", { status: 404 });
  }) as typeof fetch;
}

test("discovery never attaches an active GCP project whose Code Assist API is disabled", async () => {
  const calls: string[] = [];
  await assert.rejects(
    discoverGeminiCliProjectAndTier("tok-disabled-service", {
      fetchImpl: unprovisionedAccountFetch(calls),
    }),
    /cloudaicompanion\.googleapis\.com/
  );
  // The service state was checked, and the CRM listing is only consulted once
  // (no blind "first active project" fallback after the verified scan).
  assert.ok(calls.some((u) => u.includes("projects/credit-exp-aipro/services/cloudaicompanion")));
  assert.equal(calls.filter((u) => u.includes("cloudresourcemanager")).length, 1);
});

test("discovery rejects projects whose service state cannot be verified", async () => {
  const calls: string[] = [];
  await assert.rejects(
    discoverGeminiCliProjectAndTier("tok-unverifiable-service", {
      fetchImpl: unprovisionedAccountFetch(calls, { serviceUsageStatus: 403 }),
    }),
    /Could not auto-discover/
  );
});

test("discovery runs the verified scan when loadCodeAssist fails outright, and still refuses unverified projects", async () => {
  const calls: string[] = [];
  await assert.rejects(
    discoverGeminiCliProjectAndTier("tok-lca-down", {
      fetchImpl: unprovisionedAccountFetch(calls, { loadCodeAssistStatus: 500 }),
    }),
    /Could not auto-discover/
  );
  assert.ok(calls.some((u) => u.includes("projects/credit-exp-aipro/services/cloudaicompanion")));
});

test("last-resort scan accepts a project once Code Assist is verified enabled", async () => {
  const fetchImpl = (async (url: unknown, init?: RequestInit) => {
    const u = String(url);
    const body = String(init?.body || "");
    if (u.includes(":loadCodeAssist")) {
      // Only the verification probe against the enabled project succeeds.
      if (body.includes("enabled-proj")) {
        return jsonRes({
          cloudaicompanionProject: "enabled-proj",
          paidTier: { id: "g1-pro-tier" },
        });
      }
      return new Response("unavailable", { status: 503 });
    }
    if (u.includes(":onboardUser")) return jsonRes({ done: true });
    if (u.includes("cloudresourcemanager.googleapis.com/v1/projects")) {
      return jsonRes({
        projects: [
          { projectId: "credit-exp-aipro", lifecycleState: "ACTIVE" },
          { projectId: "enabled-proj", lifecycleState: "ACTIVE" },
        ],
      });
    }
    if (u.includes("projects/credit-exp-aipro/services/cloudaicompanion.googleapis.com")) {
      return jsonRes({ state: "DISABLED" });
    }
    if (u.includes("projects/enabled-proj/services/cloudaicompanion.googleapis.com")) {
      return jsonRes({ state: "ENABLED" });
    }
    return new Response("Not Found", { status: 404 });
  }) as typeof fetch;

  const result = await discoverGeminiCliProjectAndTier("tok-verified-fallback", { fetchImpl });
  assert.equal(result.projectId, "enabled-proj");
  assert.equal(result.tierCanonical, "PRO");
});

test("gemini-cli postExchange reports requires_manual_project when no Code Assist project exists", async () => {
  globalThis.fetch = unprovisionedAccountFetch([]);
  const extra = await geminiCli.postExchange({ access_token: "tok-oauth-byop" });
  assert.equal(extra.projectId, "");
  assert.equal(extra.projectDiscoveryOutcome, "requires_manual_project");

  const mapped = geminiCli.mapTokens({ access_token: "tok-oauth-byop" }, extra);
  assert.equal(mapped.projectDiscoveryOutcome, "requires_manual_project");
  assert.equal(mapped.providerSpecificData.projectId, "");
});

test("gemini-cli postExchange omits projectDiscoveryOutcome when a project is discovered", async () => {
  globalThis.fetch = (async (url: unknown) => {
    const u = String(url);
    if (u.includes("userinfo")) return jsonRes({ email: "ok@example.com" });
    if (u.includes(":loadCodeAssist")) {
      return jsonRes({
        cloudaicompanionProject: "assigned-proj",
        currentTier: { id: "free-tier" },
      });
    }
    return new Response("Not Found", { status: 404 });
  }) as typeof fetch;

  const extra = await geminiCli.postExchange({ access_token: "tok-oauth-ok" });
  assert.equal(extra.projectId, "assigned-proj");
  assert.equal(extra.projectDiscoveryOutcome, undefined);
  assert.equal(
    geminiCli.mapTokens({ access_token: "tok-oauth-ok" }, extra).projectDiscoveryOutcome,
    undefined
  );
});

for (const provider of ["gemini-cli", "gemini_cli"]) {
  test(`OAuth project gate marks ${provider} degraded with a manual-project warning`, () => {
    const state = antigravityDegradedProjectState(provider, {
      projectDiscoveryOutcome: "requires_manual_project",
    });
    assert.ok(state);
    assert.equal(state.testStatus, "degraded");
    assert.equal(state.errorCode, "missing_project_id");
    assert.match(state.warning, /cloudaicompanion\.googleapis\.com/);
    assert.match(state.warning, /Project ID/);
    assert.equal(state.lastError, state.warning);

    assert.equal(antigravityDegradedProjectState(provider, { projectId: "p" }), null);
  });
}

test("OAuth project gate keeps the Antigravity BYOP warning unchanged", () => {
  const state = antigravityDegradedProjectState("antigravity", {
    projectDiscoveryOutcome: "requires_manual_project",
  });
  assert.ok(state);
  assert.match(state.warning, /Gemini Code Assist onboarding/);
  assert.equal(antigravityDegradedProjectState("gemini", { projectDiscoveryOutcome: "x" }), null);
});
