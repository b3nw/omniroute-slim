import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { DEFAULT_UPSTREAM_BASE, getBuildInfo } from "@/lib/system/buildInfo";

test("getBuildInfo falls back to unknown / default upstream base / seq 0 with an empty env", () => {
  assert.deepEqual(getBuildInfo({}), {
    sha: "unknown",
    ref: "unknown",
    tier: "unknown",
    upstreamBase: DEFAULT_UPSTREAM_BASE,
    seq: 0,
    builtAt: "unknown",
  });
  assert.equal(DEFAULT_UPSTREAM_BASE, "3.8.51");
});

test("getBuildInfo reads the build-time env injected by the Dockerfile", () => {
  assert.deepEqual(
    getBuildInfo({
      OMNIROUTE_BUILD_SHA: "8087fd68615cf3a661e0fddf49ce3743810ba22b",
      OMNIROUTE_BUILD_REF: "feat/dev-superset",
      OMNIROUTE_BUILD_TIER: "dev",
      OMNIROUTE_UPSTREAM_BASE: "3.8.52",
      OMNIROUTE_BUILD_SEQ: "9",
      OMNIROUTE_BUILD_DATE: "2026-10-18T03:41:00Z",
    }),
    {
      sha: "8087fd68615cf3a661e0fddf49ce3743810ba22b",
      ref: "feat/dev-superset",
      tier: "dev",
      upstreamBase: "3.8.52",
      seq: 9,
      builtAt: "2026-10-18T03:41:00Z",
    }
  );
});

test("getBuildInfo treats blank values as unset", () => {
  const info = getBuildInfo({ OMNIROUTE_BUILD_SHA: "  ", OMNIROUTE_UPSTREAM_BASE: "" });
  assert.equal(info.sha, "unknown");
  assert.equal(info.upstreamBase, DEFAULT_UPSTREAM_BASE);
});

test("getBuildInfo coerces an invalid build seq to 0 instead of NaN", () => {
  for (const seq of ["abc", "-3", "1.5", "NaN", "Infinity", ""]) {
    assert.equal(getBuildInfo({ OMNIROUTE_BUILD_SEQ: seq }).seq, 0, `seq=${JSON.stringify(seq)}`);
  }
});

test("getBuildInfo defaults to process.env", () => {
  const previous = process.env.OMNIROUTE_BUILD_TIER;
  process.env.OMNIROUTE_BUILD_TIER = "prod";
  try {
    assert.equal(getBuildInfo().tier, "prod");
  } finally {
    if (previous === undefined) delete process.env.OMNIROUTE_BUILD_TIER;
    else process.env.OMNIROUTE_BUILD_TIER = previous;
  }
});

test("GET /api/system/version includes the build identity alongside the existing fields", () => {
  // The GET handler needs admin auth plus a live npm/GitHub lookup, so assert on the
  // response body construction rather than invoking it.
  const routeSrc = fs.readFileSync(
    new URL("../../src/app/api/system/version/route.ts", import.meta.url),
    "utf-8"
  );
  assert.match(routeSrc, /import \{ getBuildInfo \} from "@\/lib\/system\/buildInfo";/);
  const body = routeSrc.match(/const body = \{([\s\S]*?)\n  \};/);
  assert.ok(body, "GET response body literal not found");
  for (const field of [
    "current,",
    "latest:",
    "updateAvailable:",
    "channel:",
    "autoUpdateSupported:",
    "autoUpdateError:",
    "news,",
    "build: getBuildInfo(),",
  ]) {
    assert.ok(body[1].includes(field), `missing ${field}`);
  }
});
