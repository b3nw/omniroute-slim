import test from "node:test";
import assert from "node:assert/strict";

import {
  getCodexClientSessionId,
  hasCodexIdentityHeaders,
} from "../../open-sse/config/codexIdentity.ts";

test("Codex client session extraction prefers Codex headers before client affinity headers", () => {
  assert.equal(
    getCodexClientSessionId({
      "x-opencode-session-id": "opencode-session",
      "x-session-affinity": "session-affinity",
      "x-session-id": "session-id",
      "session-id": "codex-session",
    }),
    "codex-session"
  );
  assert.equal(
    getCodexClientSessionId({
      "x-session-affinity": "session-affinity",
      "x-session-id": "session-id",
    }),
    "session-affinity"
  );
  assert.equal(getCodexClientSessionId({ "x-session-id": "session-id" }), "session-id");
  assert.equal(getCodexClientSessionId({ "session-id": "codex-session" }), "codex-session");
});

test("Codex client session extraction accepts Headers and rejects unsafe values", () => {
  assert.equal(
    getCodexClientSessionId(new Headers({ "X-Session-Affinity": "  affinity-session  " })),
    "affinity-session"
  );
  assert.equal(getCodexClientSessionId({ "x-opencode-session-id": "bad\\r\\nheader" }), null);
});

test("hasCodexIdentityHeaders detects supported Codex client identity headers", () => {
  assert.equal(hasCodexIdentityHeaders(null), false);
  assert.equal(hasCodexIdentityHeaders({}), false);
  assert.equal(hasCodexIdentityHeaders({ "x-session-affinity": "affinity-session" }), true);
  assert.equal(hasCodexIdentityHeaders({ "X-Codex-Window-Id": "thread:0" }), true);
  assert.equal(hasCodexIdentityHeaders(new Headers({ "x-session-id": "session" })), true);
});
