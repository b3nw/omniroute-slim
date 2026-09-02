import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const messagesDirectory = path.resolve("src/i18n/messages");
const requiredKeys = [
  "modalityBridgeVideoTitle",
  "modalityBridgeVideoDesc",
  "modalityBridgeVideoRuntimeReady",
  "modalityBridgeVideoRuntimeUnavailable",
  "modalityBridgeVideoRuntimeInstall",
  "modalityBridgeVideoEnabled",
  "modalityBridgeVideoEnabledDesc",
  "modalityBridgeVideoModel",
  "modalityBridgeVideoModelInherited",
  "modalityBridgeVideoFrameCount",
  "modalityBridgeVideoMaxVideos",
] as const;

test("every shipped UI locale catalog contains non-placeholder Video Bridge settings", () => {
  const catalogs = readdirSync(messagesDirectory)
    .filter((file) => file.endsWith(".json"))
    .sort();
  const english = JSON.parse(readFileSync(path.join(messagesDirectory, "en.json"), "utf8")) as {
    settings: Record<string, string>;
  };
  for (const file of catalogs) {
    const catalog = JSON.parse(readFileSync(path.join(messagesDirectory, file), "utf8")) as {
      settings?: Record<string, unknown>;
    };
    for (const key of requiredKeys) {
      const value = catalog.settings?.[key];
      assert.equal(typeof value, "string", `${file}: settings.${key} missing`);
      assert.ok(String(value).trim().length > 0, `${file}: settings.${key} empty`);
      assert.equal(String(value).startsWith("__MISSING__:"), false, `${file}: ${key} placeholder`);
      if (file !== "en.json" && key !== "modalityBridgeVideoTitle") {
        assert.notEqual(
          value,
          english.settings[key],
          `${file}: settings.${key} copied from English instead of translated`
        );
      }
    }
  }
});

test("no locale catalog carries the stale Video Bridge backlog key", () => {
  for (const file of readdirSync(messagesDirectory).filter((entry) => entry.endsWith(".json"))) {
    const catalog = JSON.parse(readFileSync(path.join(messagesDirectory, file), "utf8")) as {
      settings: Record<string, unknown>;
    };
    assert.equal(
      Object.hasOwn(catalog.settings, "modalityBridgeVideoComingSoon"),
      false,
      `${file}: stale Video Bridge backlog key`
    );
  }
});
