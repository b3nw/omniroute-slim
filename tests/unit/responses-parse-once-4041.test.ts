import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-responses-parse-once-"));
process.env.DATA_DIR = dataDir;
after(() => fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));

// #4041: AI routes must parse each JSON body at most once and thread the parsed value
// through model resolution and handleChat. /v1/responses now parses after raw-body admission;
// withInjectionGuard retains the same preParsedBody contract for routes that still wrap it.

// ─── Part A: withInjectionGuard threads the parsed body ──────────────────────

// ─── Part B: withCodexPreferredModel reuses pre-parsed body ──────────────────

test("#4041 withCodexPreferredModel accepts a pre-parsed body and avoids re-cloning the request", async () => {
  const { withCodexPreferredModel } = await import("../../src/app/api/v1/responses/route.ts");
  const body = { model: "openai/gpt-4o", input: "hello" };
  const request = new Request("http://localhost/v1/responses", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  let cloneCount = 0;
  const originalClone = request.clone.bind(request);
  Object.defineProperty(request, "clone", {
    value: () => {
      cloneCount += 1;
      return originalClone();
    },
  });

  const result = await withCodexPreferredModel(request, body);

  assert.equal(cloneCount, 0);
  assert.equal(result.body, body);
});

// ─── Part C: wrapped routes parse once before invoking their handler ─────────

