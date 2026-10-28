import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { useDecollidedMigrationsDir } from "./helpers/decollidedMigrationsDir.ts";

useDecollidedMigrationsDir();
const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-call-log-preview-"));
process.env.DATA_DIR = TEST_DATA_DIR;
// The debug bypass writes full payloads; these tests cover the size-limited path.
delete process.env.CHAT_DEBUG_FILE;
delete process.env.APP_LOG_LEVEL;

const { writeCallArtifact, readCallArtifact, truncateBodyForPreview } = await import(
  "../../src/lib/usage/callLogArtifacts.ts"
);

const OMITTED = "[omitted: call log artifact size limit exceeded]";
const TRUNCATED = "[truncated: call log artifact size limit exceeded]";
const DEFAULT_PREVIEW_BYTES = 8 * 1024;
const HUGE_BODY = "x".repeat(900 * 1024);
const REAL_ERROR = "[504]: Fetch timeout after 110000ms on https://provider.example/v1/messages";
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

function withEnv(vars: Record<string, string | undefined>, fn: () => void) {
  const previous = Object.fromEntries(Object.keys(vars).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(vars)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    fn();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function artifact(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 5 as const,
    summary: {
      id: `preview-${Math.random().toString(16).slice(2)}`,
      timestamp: new Date().toISOString(),
      method: "POST",
      path: "/v1/messages",
      status: 504,
      model: "inferx/deepseek-v4-flash-0731",
      requestedModel: null,
    },
    requestBody: HUGE_BODY,
    responseBody: null,
    error: REAL_ERROR,
    ...overrides,
  } as never;
}

function roundTrip(input: ReturnType<typeof artifact>) {
  const relativePath = `preview/${(input as { summary: { id: string } }).summary.id}.json`;
  const written = writeCallArtifact(input, relativePath);
  assert.ok(written, "artifact should be written");
  const { artifact: stored, state } = readCallArtifact(relativePath);
  assert.equal(state, "ready");
  assert.ok(stored, "artifact should be readable");
  return { stored: stored as unknown as Record<string, unknown>, sizeBytes: written.sizeBytes };
}

function splitPreview(value: unknown) {
  assert.equal(typeof value, "string", "a string body preview stays a string");
  const text = value as string;
  assert.ok(text.endsWith(` ${TRUNCATED}`), "the preview says it was cut");
  return text.slice(0, -(TRUNCATED.length + 1));
}

test("an oversized string body keeps a preview and the real error verbatim", () => {
  withEnv({ CALL_LOG_ARTIFACT_PREVIEW_KB: undefined }, () => {
    const { stored, sizeBytes } = roundTrip(artifact());

    const prefix = splitPreview(stored.requestBody);
    assert.equal(prefix, HUGE_BODY.slice(0, DEFAULT_PREVIEW_BYTES));
    assert.equal(stored.error, REAL_ERROR);
    assert.equal(stored.responseBody, null);
    assert.ok(sizeBytes <= 512 * 1024);
  });
});

test("CALL_LOG_ARTIFACT_PREVIEW_KB sets the per-body preview budget", () => {
  withEnv({ CALL_LOG_ARTIFACT_PREVIEW_KB: "4" }, () => {
    const { stored } = roundTrip(artifact());
    assert.equal(splitPreview(stored.requestBody), HUGE_BODY.slice(0, 4 * 1024));
  });
});

test("a preview that overflows the cap degrades to a smaller budget before omitting", () => {
  // 8 KiB request + 8 KiB response previews cannot fit a 12 KiB cap; 2 KiB each can.
  withEnv({ CALL_LOG_PIPELINE_MAX_SIZE_KB: "12", CALL_LOG_ARTIFACT_PREVIEW_KB: undefined }, () => {
    const { stored, sizeBytes } = roundTrip(
      artifact({
        responseBody: "r".repeat(64 * 1024),
        pipeline: { providerRequest: { body: "p".repeat(64 * 1024) } },
      })
    );

    assert.equal(splitPreview(stored.requestBody), HUGE_BODY.slice(0, 2 * 1024));
    assert.equal(splitPreview(stored.responseBody), "r".repeat(2 * 1024));
    assert.equal(stored.error, REAL_ERROR);
    assert.deepEqual(stored.pipeline, {
      error: { _omniroute_truncated: true, reason: "call_log_artifact_size_limit_exceeded" },
    });
    assert.ok(sizeBytes <= 12 * 1024);
  });
});

test("a multi-byte body preview is not split mid-codepoint", () => {
  // 3-byte CJK and 4-byte emoji (a surrogate pair) interleaved with 1-byte ASCII, so the
  // byte budget lands inside a sequence for both widths.
  for (const unit of ["验", "a😀", "😀"]) {
    const body = unit.repeat(400 * 1024);
    const { stored } = roundTrip(artifact({ requestBody: body, error: "😀".repeat(4 * 1024) }));

    const prefix = splitPreview(stored.requestBody);
    assert.ok(!prefix.includes("�"), `no replacement character for ${unit}`);
    assert.ok(!LONE_SURROGATE.test(prefix), `no lone surrogate for ${unit}`);
    assert.ok(body.startsWith(prefix), `the preview is a clean prefix for ${unit}`);
    const prefixBytes = Buffer.byteLength(prefix, "utf8");
    assert.ok(prefixBytes <= DEFAULT_PREVIEW_BYTES, `${unit}: ${prefixBytes} bytes`);
    assert.ok(prefixBytes > DEFAULT_PREVIEW_BYTES - 4, `${unit}: the budget is nearly used`);

    const errorPrefix = splitPreview(stored.error);
    assert.ok(!errorPrefix.includes("�"));
    assert.ok(!LONE_SURROGATE.test(errorPrefix));
  }
});

test("a non-string body yields a structured preview carrying its original size", () => {
  const requestBody = {
    model: "inferx/deepseek-v4-flash-0731",
    messages: [{ role: "user", content: "y".repeat(900 * 1024) }],
  };
  const { stored } = roundTrip(artifact({ requestBody }));

  const preview = stored.requestBody as Record<string, unknown>;
  assert.equal(preview._omniroute_truncated, true);
  assert.equal(preview._originalBytes, Buffer.byteLength(JSON.stringify(requestBody), "utf8"));
  const text = splitPreview(preview.preview);
  assert.ok(JSON.stringify(requestBody).startsWith(text));
  assert.equal(Buffer.byteLength(text, "utf8"), DEFAULT_PREVIEW_BYTES);
  assert.equal(stored.error, REAL_ERROR);
});

test("truncateBodyForPreview leaves bodies within the budget untouched", () => {
  const small = { messages: [{ role: "user", content: "hello" }] };
  assert.equal(truncateBodyForPreview(small, 1024), small);
  assert.equal(truncateBodyForPreview("hello", 1024), "hello");
  assert.equal(truncateBodyForPreview(null, 1024), null);
  assert.equal(truncateBodyForPreview(undefined, 1024), undefined);
  assert.equal(truncateBodyForPreview("abcdef", 3), `abc ${TRUNCATED}`);
});

test("fails closed to the omitted shape when even the degraded preview overflows the cap", () => {
  withEnv({ CALL_LOG_PIPELINE_MAX_SIZE_KB: "1" }, () => {
    const { stored, sizeBytes } = roundTrip(
      artifact({ pipeline: { providerRequest: { body: "p".repeat(32 * 1024) } } })
    );

    assert.ok(sizeBytes <= 1024, `artifact must stay under the cap, got ${sizeBytes}`);
    assert.equal(stored.requestBody, OMITTED);
    assert.equal(stored.responseBody, OMITTED);
    assert.equal(stored.error, REAL_ERROR);
    assert.deepEqual(stored.pipeline, {
      error: { _omniroute_truncated: true, reason: "call_log_artifact_size_limit_exceeded" },
    });
  });
});

test("falls back to the last-resort sentinel when the summary alone overflows the cap", () => {
  withEnv({ CALL_LOG_PIPELINE_MAX_SIZE_KB: "1" }, () => {
    const input = artifact({ pipeline: { providerRequest: { body: "p".repeat(32 * 1024) } } });
    (input as { summary: { model: string } }).summary.model = `inferx/${"m".repeat(2048)}`;
    const { stored, sizeBytes } = roundTrip(input);

    assert.ok(sizeBytes <= 1024, `artifact must stay under the cap, got ${sizeBytes}`);
    assert.deepEqual(stored, {
      schemaVersion: 5,
      _omniroute_truncated: true,
      reason: "call_log_artifact_size_limit_exceeded",
    });
  });
});
