import test from "node:test";
import assert from "node:assert/strict";

const WEBHOOK = {
  id: "wh-001",
  url: "https://example.com/hook",
  events: ["request.completed", "request.failed"],
  enabled: true,
  secret: "s3cr3t",
  lastDelivery: "2026-05-14T10:00:00Z",
  lastStatus: 200,
};

const WEBHOOKS = [
  WEBHOOK,
  { ...WEBHOOK, id: "wh-002", url: "https://other.io/hook", enabled: false },
];

function makeResp(data: unknown, status = 200) {
  const obj = {
    ok: status < 400,
    status,
    exitCode: status < 400 ? 0 : 1,
    json: () => Promise.resolve(data),
    text: () => Promise.resolve(JSON.stringify(data)),
    headers: new Headers(),
  };
  obj.json = obj.json.bind(obj);
  obj.text = obj.text.bind(obj);
  return obj;
}

async function captureStdout(fn: () => Promise<void>): Promise<string> {
  const chunks: string[] = [];
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = (c: string | Uint8Array) => {
    if (typeof c === "string") chunks.push(c);
    return true;
  };
  try {
    await fn();
  } finally {
    process.stdout.write = orig;
  }
  return chunks.join("");
}

function makeCmd(output = "json") {
  return { optsWithGlobals: () => ({ output, quiet: output !== "table" }) };
}

test("webhooks events lista todos tipos de evento conhecidos", async () => {
  const EVENT_TYPES = [
    "request.completed",
    "request.failed",
    "rate_limit.exceeded",
    "budget.exceeded",
    "quota.reset",
    "provider.down",
    "provider.up",
    "combo.switched",
    "circuit.opened",
    "circuit.closed",
    "skill.executed",
    "memory.added",
    "audit.created",
  ];

  const out = await captureStdout(async () => {
    const cmd = makeCmd();
    const { emit } = await import("../../bin/cli/output.mjs");
    emit(
      EVENT_TYPES.map((e) => ({ event: e })),
      cmd.optsWithGlobals()
    );
  });

  const parsed = JSON.parse(out);
  assert.ok(Array.isArray(parsed));
  assert.ok(parsed.length >= 13);
  assert.ok(parsed.some((e: any) => e.event === "request.completed"));
  assert.ok(parsed.some((e: any) => e.event === "budget.exceeded"));
});
