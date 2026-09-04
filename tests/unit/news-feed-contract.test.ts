import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const root = new URL("../../", import.meta.url);

test("news.json ships Radar inactive in the localized v2 feed without commercial details", async () => {
  const source = await readFile(new URL("news.json", root), "utf8");
  const payload = JSON.parse(source);
  const radar = payload.items.find((item: { id?: string }) => item.id === "radar-launch-2026-08");

  assert.equal(payload.schemaVersion, 2);
  assert.equal(radar.active, false);
  assert.equal(radar.link, "https://radar.omniroute.online/planos");
  assert.match(radar.text.en.message, /opt-in/i);
  assert.match(radar.text.en.message, /GET-only/i);
  assert.match(radar.text.en.message, /no telemetry/i);
  assert.doesNotMatch(source, /R\$|US\$|coupon|cupom|discount|desconto/i);
});
