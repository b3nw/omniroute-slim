import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-combo-pressure-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = process.env.API_KEY_SECRET || "combo-pressure-test-secret";

const { handleComboChat } = await import("../../open-sse/services/combo.ts");
const { isLocalResourcePressureErrorBody } =
  await import("../../open-sse/services/combo/comboPredicates.ts");

const noop = () => {};
const log = { info: noop, warn: noop, debug: noop, error: noop };

function makeCombo(strategy: string) {
  return {
    name: "test-combo-pressure",
    strategy,
    models: [
      { model: "gemini-cli/gemini-pro" },
      { model: "antigravity/claude" },
      { model: "deepseek/v3" },
    ],
  };
}

function pressureResponse(): Response {
  return new Response(
    JSON.stringify({
      error: { message: "Local resource pressure", type: "server_error", code: "resource_pressure" },
    }),
    { status: 503, headers: { "content-type": "application/json" } }
  );
}

test("isLocalResourcePressureErrorBody matches only local pressure codes", () => {
  assert.equal(isLocalResourcePressureErrorBody({ error: { code: "resource_pressure" } }), true);
  assert.equal(isLocalResourcePressureErrorBody({ error: { code: "heap_pressure" } }), true);
  assert.equal(isLocalResourcePressureErrorBody({ error: { code: "upstream_503" } }), false);
  assert.equal(isLocalResourcePressureErrorBody(null), false);
});

for (const strategy of ["priority", "round-robin"]) {
  test(`${strategy} combo short-circuits on local resource_pressure 503 without trying other targets`, async () => {
    const modelsCalled: string[] = [];
    const handleSingleModel = async (_body: unknown, modelStr: string) => {
      modelsCalled.push(modelStr);
      return pressureResponse();
    };

    const result = await handleComboChat({
      body: { model: "test", messages: [{ role: "user", content: "hi" }] },
      combo: makeCombo(strategy),
      handleSingleModel,
      log,
      settings: {},
      allCombos: [],
    } as any);

    assert.equal(modelsCalled.length, 1, "must not cascade into antigravity or deepseek");
    assert.ok(modelsCalled[0].includes("gemini-pro"));
    assert.equal(result.status, 503);
    const body = await result.json();
    assert.equal(body?.error?.code, "resource_pressure");
  });
}
