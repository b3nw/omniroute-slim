import { test } from "node:test";
import assert from "node:assert/strict";

import {
  lookupCcAliasCombo,
  resolveCcDiscoveryAliasStripWith,
} from "../../src/lib/ccDiscoveryAliasResolve.ts";

/**
 * These tests exercise the async request-path resolver by injecting all of its
 * DB/registry lookups, so no SQLite handle is opened (pure logic, no resetDb).
 * The branch matrix of the underlying pure `stripCcDiscoveryAlias` already has
 * its own suite (cc-discovery-alias-strip.test.ts); here we focus on the wiring
 * the resolver adds on top: custom-node prefixes (Gap 1) and the gate snapshot.
 */

const baseDeps = {
  claudeModelIds: new Set<string>(["claude-fable-5", "claude-opus-5"]),
  isRegistryProvider: (prefix: string) => prefix === "kimi" || prefix === "openai",
  customProviderPrefixes: new Set<string>(),
  getCombo: async (_name: string) => null as { models?: unknown[] } | null,
  gateGlobal: () => true,
  gateProvider: (_providerId: string) => null as "on" | "off" | null,
  gateModel: (_providerId: string, _modelId: string) => null as "on" | "off" | null,
};

test("non-'claude/' id is a no-op without any DB lookup", async () => {
  const result = await resolveCcDiscoveryAliasStripWith("kimi/kimi-k2.6", baseDeps);
  assert.deepEqual(result, { model: "kimi/kimi-k2.6", stripped: false });
});

test("legitimate claude provider model is left intact", async () => {
  const result = await resolveCcDiscoveryAliasStripWith("claude/claude-fable-5", baseDeps);
  assert.deepEqual(result, { model: "claude/claude-fable-5", stripped: false });
});

test("registry provider prefix strips when the gate is globally on", async () => {
  const result = await resolveCcDiscoveryAliasStripWith("claude/kimi/kimi-k2.6", baseDeps);
  assert.deepEqual(result, { model: "kimi/kimi-k2.6", stripped: true });
});

test("Gap 1: a custom DB-node provider prefix is recognized and strips", async () => {
  const result = await resolveCcDiscoveryAliasStripWith("claude/mycustom/model-x", {
    ...baseDeps,
    isRegistryProvider: () => false,
    customProviderPrefixes: new Set<string>(["mycustom"]),
  });
  assert.deepEqual(result, { model: "mycustom/model-x", stripped: true });
});

test("unknown provider prefix (neither registry nor custom) is left intact", async () => {
  const result = await resolveCcDiscoveryAliasStripWith("claude/desconhecido/x", {
    ...baseDeps,
    isRegistryProvider: () => false,
  });
  assert.deepEqual(result, { model: "claude/desconhecido/x", stripped: false });
});

test("combo alias strips when the combo exists (non-empty models) and gate on", async () => {
  const result = await resolveCcDiscoveryAliasStripWith("claude/combo/custo-otimizado", {
    ...baseDeps,
    getCombo: async (name) => (name === "custo-otimizado" ? { models: [{ id: "a" }] } : null),
  });
  assert.deepEqual(result, { model: "custo-otimizado", stripped: true });
});

test("built-in auto combo alias strips when the auto combo resolver returns a combo", async () => {
  const result = await resolveCcDiscoveryAliasStripWith("claude/combo/auto/coding", {
    ...baseDeps,
    getCombo: async (name) => (name === "auto/coding" ? { models: [{ id: "auto/coding" }] } : null),
  });
  assert.deepEqual(result, { model: "auto/coding", stripped: true });
});

test("combo lookup: persisted auto/ combo takes precedence over the built-in", async () => {
  const persisted = { models: [{ id: "persisted" }] };
  let builtinCalls = 0;
  const combo = await lookupCcAliasCombo("auto/coding", {
    getPersistedCombo: async (name) => (name === "auto/coding" ? persisted : null),
    createBuiltinCombo: async () => {
      builtinCalls++;
      return { models: [{ id: "builtin" }] };
    },
  });
  assert.equal(combo, persisted);
  assert.equal(builtinCalls, 0);
});

test("combo lookup: persisted fuzzy auto/best-<suffix> beats the built-in", async () => {
  const fuzzy = { models: [{ id: "best-fast" }] };
  let builtinCalls = 0;
  const combo = await lookupCcAliasCombo("auto/fast", {
    getPersistedCombo: async (name) => (name === "auto/best-fast" ? fuzzy : null),
    createBuiltinCombo: async () => {
      builtinCalls++;
      return { models: [{ id: "builtin" }] };
    },
  });
  assert.equal(combo, fuzzy);
  assert.equal(builtinCalls, 0);
});

test("combo lookup: falls back to the built-in when no persisted auto/ combo exists", async () => {
  const builtin = { models: [{ id: "builtin" }] };
  const seen: string[] = [];
  const combo = await lookupCcAliasCombo("auto/coding", {
    getPersistedCombo: async (name) => {
      seen.push(name);
      return null;
    },
    createBuiltinCombo: async (name, suffix) =>
      name === "auto/coding" && suffix === "coding" ? builtin : null,
  });
  assert.equal(combo, builtin);
  assert.deepEqual(seen, ["auto/coding", "auto/best-coding"]);
});

test("combo lookup: built-in failure resolves to null", async () => {
  const combo = await lookupCcAliasCombo("auto/coding", {
    getPersistedCombo: async () => null,
    createBuiltinCombo: async () => {
      throw new Error("no providers");
    },
  });
  assert.equal(combo, null);
});

test("combo lookup: non-auto names never consult the built-in catalog", async () => {
  let builtinCalls = 0;
  const combo = await lookupCcAliasCombo("custo-otimizado", {
    getPersistedCombo: async () => null,
    createBuiltinCombo: async () => {
      builtinCalls++;
      return { models: [{ id: "x" }] };
    },
  });
  assert.equal(combo, null);
  assert.equal(builtinCalls, 0);
});

test("combo lookup: empty exact persisted auto/ combo falls through to fuzzy", async () => {
  const fuzzy = { models: [{ id: "best-coding" }] };
  let builtinCalls = 0;
  const combo = await lookupCcAliasCombo("auto/coding", {
    getPersistedCombo: async (name) => {
      if (name === "auto/coding") return { models: [] };
      if (name === "auto/best-coding") return fuzzy;
      return null;
    },
    createBuiltinCombo: async () => {
      builtinCalls++;
      return { models: [{ id: "builtin" }] };
    },
  });
  assert.equal(combo, fuzzy);
  assert.equal(builtinCalls, 0);
});

test("combo lookup: empty exact and fuzzy persisted auto/ combos fall through to the built-in", async () => {
  const builtin = { models: [{ id: "builtin" }] };
  const seen: string[] = [];
  const combo = await lookupCcAliasCombo("auto/coding", {
    getPersistedCombo: async (name) => {
      seen.push(name);
      if (name === "auto/coding") return { models: [] };
      if (name === "auto/best-coding") return {};
      return null;
    },
    createBuiltinCombo: async (name, suffix) =>
      name === "auto/coding" && suffix === "coding" ? builtin : null,
  });
  assert.equal(combo, builtin);
  assert.deepEqual(seen, ["auto/coding", "auto/best-coding"]);
});

test("combo lookup: empty persisted non-auto combo resolves to null", async () => {
  let builtinCalls = 0;
  const combo = await lookupCcAliasCombo("custo-otimizado", {
    getPersistedCombo: async () => ({ models: [] }),
    createBuiltinCombo: async () => {
      builtinCalls++;
      return { models: [{ id: "x" }] };
    },
  });
  assert.equal(combo, null);
  assert.equal(builtinCalls, 0);
});

test("empty persisted auto/ combo alias still strips via the built-in fallback", async () => {
  const result = await resolveCcDiscoveryAliasStripWith("claude/combo/auto/coding", {
    ...baseDeps,
    getCombo: (name) =>
      lookupCcAliasCombo(name, {
        getPersistedCombo: async (n) => (n === "auto/coding" ? { models: [] } : null),
        createBuiltinCombo: async () => ({ models: [{ id: "builtin" }] }),
      }),
  });
  assert.deepEqual(result, { model: "auto/coding", stripped: true });
});

test("persisted auto/ combo alias strips via the precedence-aware lookup", async () => {
  const result = await resolveCcDiscoveryAliasStripWith("claude/combo/auto/coding", {
    ...baseDeps,
    getCombo: (name) =>
      lookupCcAliasCombo(name, {
        getPersistedCombo: async (n) => (n === "auto/coding" ? { models: [{ id: "p" }] } : null),
        createBuiltinCombo: async () => ({ models: [] }),
      }),
  });
  assert.deepEqual(result, { model: "auto/coding", stripped: true });
});

test("combo alias is left intact when the combo has no models", async () => {
  const result = await resolveCcDiscoveryAliasStripWith("claude/combo/empty", {
    ...baseDeps,
    getCombo: async () => ({ models: [] }),
  });
  assert.deepEqual(result, { model: "claude/combo/empty", stripped: false });
});

test("gate precedence: model 'off' beats provider/global on", async () => {
  const result = await resolveCcDiscoveryAliasStripWith("claude/kimi/kimi-k2.6", {
    ...baseDeps,
    gateModel: (providerId, modelId) =>
      providerId === "kimi" && modelId === "kimi-k2.6" ? "off" : null,
  });
  assert.deepEqual(result, { model: "claude/kimi/kimi-k2.6", stripped: false });
});

test("gate precedence: provider 'on' strips even when global is off", async () => {
  const result = await resolveCcDiscoveryAliasStripWith("claude/kimi/kimi-k2.6", {
    ...baseDeps,
    gateGlobal: () => false,
    gateProvider: (providerId) => (providerId === "kimi" ? "on" : null),
  });
  assert.deepEqual(result, { model: "kimi/kimi-k2.6", stripped: true });
});

test("combo gate uses the virtual 'combo' provider key", async () => {
  const result = await resolveCcDiscoveryAliasStripWith("claude/combo/x", {
    ...baseDeps,
    gateGlobal: () => false,
    getCombo: async () => ({ models: [{ id: "a" }] }),
    gateProvider: (providerId) => (providerId === "combo" ? "on" : null),
  });
  assert.deepEqual(result, { model: "x", stripped: true });
});
