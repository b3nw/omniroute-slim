import test from "node:test";
import assert from "node:assert/strict";

// #3318: the /api/tools/agent-bridge/state route returns `{ server, agents }`,
// but the page/components read `{ serverState, agentStates, bypassPatterns,
// mappings }`. The page replaced its well-shaped default with the raw response,
// so `serverState` became undefined → `serverState.running` crashed the page
// with the full "Internal Server Error" boundary. The normalizer must always
// return a well-shaped object (never an undefined serverState), mapping the
// known server fields through.

test("the raw /state route shape lacks the keys the page reads (documents the bug)", () => {
  const routeShape = {
    server: { running: true, pid: 123, dnsConfigured: true, certExists: true },
    agents: [{ id: "claude-code", name: "Claude Code", hosts: [], viability: "ok" }],
  };
  // This is exactly what the old code assigned straight into initialData.
  assert.equal(routeShape.serverState, undefined);
});

