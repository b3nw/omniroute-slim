// tests/unit/build/check-api-typecheck.test.ts
// Hermetic tests for the API typecheck gate's parsing and baseline-diff logic.

import test from "node:test";
import assert from "node:assert/strict";
import {
  parseTscOutput,
  diffAgainstBaseline,
} from "../../../scripts/check/check-api-typecheck.mjs";

test("parseTscOutput: parses an API-route TS2554 regression", () => {
  const raw =
    `src/app/api/v1/models/route.ts(42,7): error TS2554: Expected 2 arguments, but got 3.\n` +
    `src/app/api/v1/models/route.ts(52,7): error TS2554: Expected 2 arguments, but got 3.\n`;

  assert.deepEqual(parseTscOutput(raw), {
    "src/app/api/v1/models/route.ts": { TS2554: 2 },
  });
});

test("parseTscOutput: ignores non-error lines", () => {
  const raw =
    `src/app/api/foo/route.ts(1,1): error TS2339: Property 'bar' does not exist.\n` +
    `Found 1 error in 1 file.\n`;

  assert.deepEqual(parseTscOutput(raw), {
    "src/app/api/foo/route.ts": { TS2339: 1 },
  });
});

test("parseTscOutput: returns an empty map for clean output", () => {
  assert.deepEqual(parseTscOutput("Found 0 errors.\n"), {});
});

test("diffAgainstBaseline: flags a new API diagnostic", () => {
  const live = { "src/app/api/v1/models/route.ts": { TS2554: 1 } };
  const { regressions, improvements } = diffAgainstBaseline(live, {});

  assert.deepEqual(regressions, [
    {
      file: "src/app/api/v1/models/route.ts",
      code: "TS2554",
      liveCount: 1,
      baselineCount: 0,
    },
  ]);
  assert.equal(improvements.length, 0);
});

test("diffAgainstBaseline: accepts an unchanged frozen diagnostic count", () => {
  const baseline = { "src/app/api/foo/route.ts": { TS2339: 2 } };
  const live = { "src/app/api/foo/route.ts": { TS2339: 2 } };
  const { regressions, improvements } = diffAgainstBaseline(live, baseline);

  assert.equal(regressions.length, 0);
  assert.equal(improvements.length, 0);
});

test("diffAgainstBaseline: fails a count increase", () => {
  const baseline = { "src/app/api/foo/route.ts": { TS2339: 1 } };
  const live = { "src/app/api/foo/route.ts": { TS2339: 2 } };
  const { regressions } = diffAgainstBaseline(live, baseline);

  assert.equal(regressions.length, 1);
  assert.equal(regressions[0].baselineCount, 1);
  assert.equal(regressions[0].liveCount, 2);
});

test("diffAgainstBaseline: reports a count decrease as an improvement", () => {
  const baseline = { "src/app/api/foo/route.ts": { TS2339: 2 } };
  const live = { "src/app/api/foo/route.ts": { TS2339: 1 } };
  const { regressions, improvements } = diffAgainstBaseline(live, baseline);

  assert.equal(regressions.length, 0);
  assert.equal(improvements.length, 1);
  assert.equal(improvements[0].liveCount, 1);
});

test("diffAgainstBaseline: reports a disappeared diagnostic as an improvement", () => {
  const baseline = { "src/app/api/foo/route.ts": { TS2339: 2 } };
  const { regressions, improvements } = diffAgainstBaseline({}, baseline);

  assert.equal(regressions.length, 0);
  assert.equal(improvements.length, 1);
  assert.equal(improvements[0].liveCount, 0);
  assert.equal(improvements[0].baselineCount, 2);
});
