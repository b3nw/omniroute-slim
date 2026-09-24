#!/usr/bin/env node
// scripts/check/check-model-lifecycle.mjs
// Anti-drift gate (#11503): the two hand-maintained tables that decide routing —
// FITNESS_TABLE (open-sse/services/autoCombo/taskFitness.ts, layer 4 of task fitness) and
// BUILT_IN_ALIASES (open-sse/services/modelDeprecation.ts, rewrites `body.model` on every
// request) — rot silently when a vendor retires a model. In release/v3.8.51 the result was
// a ranking inversion (dead model 0.98 vs live flagship 0.50) and aliases that guaranteed a
// 404. This gate compares both against the lifecycle snapshot in
// config/quality/model-lifecycle.json (no network; regenerate with
// `npm run quality:refresh-model-lifecycle`).
//
// Three checks, all summed before exiting — none aborts the others:
//   (a) no FITNESS_TABLE pattern scores a retired id that the catalog routes;
//   (b) no BUILT_IN_ALIASES target is retired or missing from the catalog;
//   (c) every retired id still present in the REGISTRY has a forward in
//       BUILT_IN_ALIASES or is listed in `allowedRetiredInCatalog` (the ratchet to burn down).
//
// (a) is deliberately restricted to ROUTABLE ids: legitimate versioned lines such as
// `gpt-4o` also match retired ids the catalog never served (`gpt-4o-audio-preview`), and
// those cannot invert any routing decision.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = process.cwd();
const SNAPSHOT_PATH = path.join(ROOT, "config/quality/model-lifecycle.json");
const TASK_TYPES = ["coding", "review", "planning", "analysis", "debugging", "documentation"];

/** Model ids the catalog can route (id + aliases of each model). */
export function collectCatalogIds(registry) {
  const ids = new Set();
  for (const entry of Object.values(registry ?? {})) {
    for (const model of entry?.models ?? []) {
      if (typeof model?.id === "string") ids.add(model.id);
      for (const alias of model?.aliases ?? []) {
        if (typeof alias === "string") ids.add(alias);
      }
    }
  }
  return [...ids];
}

/** A catalog id is retired when its bare form (without the `vendor/` prefix) is. */
export function isRetiredId(id, retiredIds) {
  const lower = String(id).toLowerCase();
  if (retiredIds.has(lower)) return true;
  const slash = lower.lastIndexOf("/");
  return slash !== -1 && retiredIds.has(lower.slice(slash + 1));
}

/** (a) FITNESS_TABLE rows that still score a retired, routable model. */
export function findRetiredFitnessRows(routableRetiredIds, scoreFor, taskTypes = TASK_TYPES) {
  const violations = [];
  for (const id of routableRetiredIds) {
    for (const task of taskTypes) {
      const score = scoreFor(id, task);
      if (score !== null && score !== undefined) {
        violations.push(
          `${id} scores ${score} for "${task}" via FITNESS_TABLE (vendor retired it)`
        );
      }
    }
  }
  return violations;
}

/** (b) Alias targets that are retired or absent from the catalog. */
export function findBadAliasTargets(aliases, catalogIds, retiredIds) {
  const catalog = new Set([...catalogIds].map((id) => id.toLowerCase()));
  const violations = [];
  for (const [source, target] of Object.entries(aliases)) {
    const lower = String(target).toLowerCase();
    if (!catalog.has(lower)) {
      violations.push(`${source} → ${target} (no provider in REGISTRY serves this id)`);
    } else if (retiredIds.has(lower)) {
      violations.push(`${source} → ${target} (the vendor has retired this id)`);
    }
  }
  return violations;
}

/** (c) Retired ids the catalog still routes with neither a forward nor an allowlist entry. */
export function findUnforwardedRetiredIds(routableRetiredIds, aliases, allowlist) {
  const allowed = new Set((allowlist ?? []).map((id) => String(id).toLowerCase()));
  return routableRetiredIds
    .filter((id) => !(id in aliases) && !allowed.has(String(id).toLowerCase()))
    .map((id) => `${id} is retired but still routable with no BUILT_IN_ALIASES forward`);
}

export function readSnapshot(snapshotPath = SNAPSHOT_PATH) {
  const snapshot = JSON.parse(fs.readFileSync(snapshotPath, "utf8"));
  const retiredIds = new Set(
    Object.entries(snapshot.retired ?? {})
      .filter(([, entry]) => entry?.status === "retired")
      .map(([id]) => id.toLowerCase())
  );
  return { snapshot, retiredIds };
}

async function loadProductionTables() {
  // No gate may migrate the operator's database: taskFitness.ts imports src/lib/db/core.ts,
  // so DATA_DIR points at a throwaway directory BEFORE the dynamic import.
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-lifecycle-gate-"));
  const [{ REGISTRY }, { getStaticFitnessTableScore }, { getBuiltInAliases }] = await Promise.all([
    import(pathToFileURL(path.join(ROOT, "open-sse/config/providers/index.ts")).href),
    import(pathToFileURL(path.join(ROOT, "open-sse/services/autoCombo/taskFitness.ts")).href),
    import(pathToFileURL(path.join(ROOT, "open-sse/services/modelDeprecation.ts")).href),
  ]);
  return { REGISTRY, getStaticFitnessTableScore, getBuiltInAliases };
}

function report(label, violations, hint) {
  if (!violations.length) {
    console.log(`[model-lifecycle] OK — ${label}`);
    return 0;
  }
  console.error(
    `[model-lifecycle] ${violations.length} violation(s) — ${label}:\n` +
      violations.map((v) => "  ✗ " + v).join("\n") +
      `\n  → ${hint}`
  );
  return violations.length;
}

async function main() {
  const { snapshot, retiredIds } = readSnapshot();
  const { REGISTRY, getStaticFitnessTableScore, getBuiltInAliases } = await loadProductionTables();

  const catalogIds = collectCatalogIds(REGISTRY);
  const routableRetired = catalogIds.filter((id) => isRetiredId(id, retiredIds)).sort();
  const aliases = getBuiltInAliases();

  let failures = 0;
  failures += report(
    `FITNESS_TABLE scores none of the ${routableRetired.length} routable retired id(s)`,
    findRetiredFitnessRows(routableRetired, getStaticFitnessTableScore),
    "drop the row from FITNESS_TABLE in open-sse/services/autoCombo/taskFitness.ts, or replace it with the versioned id of the live successor."
  );
  failures += report(
    `all ${Object.keys(aliases).length} BUILT_IN_ALIASES targets are live catalog models`,
    findBadAliasTargets(aliases, catalogIds, retiredIds),
    "point the alias at the replacement the vendor publishes (see `sources` in config/quality/model-lifecycle.json). Never invent a target."
  );
  failures += report(
    "every routable retired id is forwarded or allowlisted",
    findUnforwardedRetiredIds(routableRetired, aliases, snapshot.allowedRetiredInCatalog),
    "add a BUILT_IN_ALIASES forward to the vendor's replacement, remove the model from the provider catalog, or (last resort) add the id to `allowedRetiredInCatalog` in config/quality/model-lifecycle.json with a tracking issue."
  );

  if (failures) {
    console.error(`[model-lifecycle] FAIL — ${failures} violation(s) across 3 check(s).`);
    process.exit(1);
  }
  console.log(
    `[model-lifecycle] PASS — snapshot ${snapshot.generatedAt}, ${retiredIds.size} retired id(s), ${catalogIds.length} catalog id(s).`
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  main().catch((err) => {
    console.error(`[model-lifecycle] ERROR — ${err?.message ?? err}`);
    process.exit(1);
  });
}
