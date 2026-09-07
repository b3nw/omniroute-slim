import test from "node:test";
import assert from "node:assert/strict";

// ═════════════════════════════════════════════════════
//  FASE-01: Security Unit Tests
//  Tests for secretsValidator.ts
// ═════════════════════════════════════════════════════

// ─── Secrets Validator Tests ──────────────────────────

// Helper to run with temporary env vars
async function withEnv(overrides, fn) {
  const originals = {};
  for (const [key, value] of Object.entries(overrides)) {
    originals[key] = process.env[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(originals)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

test("secretsValidator: validateSecrets accepts missing JWT_SECRET (optional, auto-generated)", async () => {
  await withEnv({ JWT_SECRET: undefined, API_KEY_SECRET: "a".repeat(16) }, async () => {
    const { validateSecrets } = await import("../../src/shared/utils/secretsValidator.ts");
    // JWT_SECRET is required: false — missing is OK (auto-generated at startup)
    const result = validateSecrets();
    assert.equal(result.valid, true);
    assert.ok(!result.errors.some((e) => e.name === "JWT_SECRET"));
  });
});

test("secretsValidator: validateSecrets rejects missing API_KEY_SECRET", async () => {
  await withEnv({ JWT_SECRET: "a".repeat(32), API_KEY_SECRET: undefined }, async () => {
    const { validateSecrets } = await import("../../src/shared/utils/secretsValidator.ts");
    const result = validateSecrets();
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.name === "API_KEY_SECRET"));
  });
});

test("secretsValidator: validateSecrets rejects too-short JWT_SECRET", async () => {
  await withEnv({ JWT_SECRET: "short", API_KEY_SECRET: "a".repeat(16) }, async () => {
    const { validateSecrets } = await import("../../src/shared/utils/secretsValidator.ts");
    const result = validateSecrets();
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.name === "JWT_SECRET" && e.issue.includes("too short")));
  });
});

test("secretsValidator: validateSecrets warns on known weak secrets", async () => {
  await withEnv(
    {
      JWT_SECRET: "omniroute-default-secret-change-me",
      API_KEY_SECRET: "endpoint-proxy-api-key-secret",
    },
    async () => {
      const { validateSecrets } = await import("../../src/shared/utils/secretsValidator.ts");
      const result = validateSecrets();
      assert.ok(result.warnings.length >= 1, "Should have at least one warning for weak secrets");
    }
  );
});

test("secretsValidator: validateSecrets passes with strong secrets", async () => {
  await withEnv(
    {
      JWT_SECRET: "qLk9f7xHm2pWzR4vN8tB3yE6uJ0aSdFgHjKlPmOn",
      API_KEY_SECRET: "xK9mR3vN7tB2yE5u",
    },
    async () => {
      const { validateSecrets } = await import("../../src/shared/utils/secretsValidator.ts");
      const result = validateSecrets();
      assert.equal(result.valid, true);
      assert.equal(result.errors.length, 0);
    }
  );
});

// ─── Input Sanitizer Tests ────────────────────────────
// Excised: `src/shared/utils/inputSanitizer.ts` was removed in Phase 2 along with
// the PII/compliance subsystem. The detectInjection / processPII / sanitizeRequest /
// extractMessageContents suites that lived here have no module left to exercise.
