import { test } from "node:test";
import assert from "node:assert/strict";
import {
  moduleFragment,
  testImportsModule,
  findCoverageDrift,
} from "../../../scripts/check/check-mutation-test-coverage.mjs";

test("moduleFragment returns the 3-segment suffix without extension", () => {
  assert.equal(
    moduleFragment("open-sse/handlers/chatCore/headers.ts"),
    "handlers/chatCore/headers"
  );
  assert.equal(moduleFragment("src/sse/services/auth.ts"), "sse/services/auth");
  // shallow paths just use what is available
  assert.equal(moduleFragment("a/b.ts"), "a/b");
});

