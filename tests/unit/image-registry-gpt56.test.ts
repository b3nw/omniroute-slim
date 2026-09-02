import test from "node:test";
import assert from "node:assert/strict";

import { IMAGE_PROVIDERS, parseImageModel } from "../../open-sse/config/imageRegistry.ts";

test("retired common ChatGPT Web models stay absent from the image catalog and bare scan", () => {
  assert.equal(IMAGE_PROVIDERS["chatgpt-web"], undefined);
  assert.deepEqual(parseImageModel("cgpt-web/gpt-5.5"), {
    provider: null,
    model: "cgpt-web/gpt-5.5",
  });
  assert.deepEqual(parseImageModel("gpt-5.5"), {
    provider: null,
    model: "gpt-5.5",
  });
});

test("Codex image catalog exposes only the GPT-5.6 Sol, Terra, and Luna models", () => {
  assert.deepEqual(IMAGE_PROVIDERS.codex.models, [
    { id: "gpt-5.6-sol", name: "GPT 5.6 Sol (Codex Image)" },
    { id: "gpt-5.6-terra", name: "GPT 5.6 Terra (Codex Image)" },
    { id: "gpt-5.6-luna", name: "GPT 5.6 Luna (Codex Image)" },
  ]);

  for (const model of ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"]) {
    assert.deepEqual(parseImageModel(`cx/${model}`), { provider: "codex", model });
  }
});
