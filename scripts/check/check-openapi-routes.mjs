#!/usr/bin/env node
// scripts/check/check-openapi-routes.mjs
// Anti-hallucination gate (docs): every `path` documented in docs/openapi.yaml
// must resolve to a real route.ts under src/app/api/. Catches INVENTED/obsolete
// endpoints in the spec (docs describing a route that does not exist). Complements
// check-openapi-coverage.mjs (which measures the inverse direction: % of routes documented).
// Stale-enforcement (6A.3): an entry in KNOWN_STALE_SPEC that suppresses no real
// orphan path → the gate fails with a removal instruction (prevents silent regression gaps).
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import * as yaml from "js-yaml";
import { reportStaleEntries } from "./lib/allowlist.mjs";
import { apiRoot, collectApiRouteUrlPaths } from "./lib/apiRoutes.mjs";

const ROOT = process.cwd();
const OPENAPI_PATH = path.join(ROOT, "docs", "openapi.yaml");

// Spec entries without a real route, frozen for triage (ratchet: blocks NEW ones).
export const KNOWN_STALE_SPEC = new Set([]);

/** Normalizes any {param} to {} so matching is independent of the parameter name. */
export function normalizeParams(p) {
  return p.replace(/\{[^}]+\}/g, "{}");
}

/** Spec paths that match no implemented route (param-insensitive). */
export function findSpecPathsWithoutRoute(specPaths, implPaths) {
  const impl = new Set(implPaths.map(normalizeParams));
  return specPaths.filter((p) => !impl.has(normalizeParams(p)));
}

/**
 * @param {{ root?: string, openapiPath?: string, implPaths?: string[] }} [opts]
 * @returns {{ ok: boolean, exitCode: number, message: string }}
 */
export function runOpenapiRoutesCheck(opts = {}) {
  const root = opts.root || ROOT;
  const openapiPath = opts.openapiPath || path.join(root, "docs", "openapi.yaml");
  if (!fs.existsSync(openapiPath)) {
    return {
      ok: false,
      exitCode: 1,
      message: `[openapi-routes] FAIL — openapi.yaml not found: ${openapiPath}`,
    };
  }
  if (!fs.existsSync(apiRoot(root))) {
    return {
      ok: false,
      exitCode: 1,
      message: `[openapi-routes] FAIL — API root not found: ${apiRoot(root)}`,
    };
  }

  const raw = yaml.load(fs.readFileSync(openapiPath, "utf-8"));
  const specPaths = Object.keys(raw.paths || {}).filter((p) => p.startsWith("/api"));
  const implPaths = opts.implPaths || collectApiRouteUrlPaths(root);

  const liveOrphans = findSpecPathsWithoutRoute(specPaths, implPaths);
  const stale = reportStaleEntries(KNOWN_STALE_SPEC, liveOrphans, "openapi-routes");
  const orphans = liveOrphans.filter((p) => !KNOWN_STALE_SPEC.has(p));

  const parts = [];
  if (stale.length) {
    parts.push(
      `[openapi-routes] ${stale.length} obsolete allowlist entry(ies) ` +
        `— the violation was fixed; REMOVE the entry to lock the fix in:\n` +
        stale.map((e) => `  ✗ ${e}`).join("\n")
    );
  }
  if (orphans.length) {
    parts.push(
      `[openapi-routes] ${orphans.length} documented path(s) without a real route:\n` +
        orphans.map((p) => "  ✗ " + p).join("\n") +
        `\n  → create the route, fix/remove the spec entry, or add it to KNOWN_STALE_SPEC with a justification.`
    );
  }
  if (parts.length) {
    return { ok: false, exitCode: 1, message: parts.join("\n") };
  }
  return {
    ok: true,
    exitCode: 0,
    message: `[openapi-routes] OK — ${specPaths.length} paths in the spec, all with a real route (${implPaths.length} routes)`,
  };
}

function main() {
  // Keep assertNoStale side-effect path for CLI parity with other gates when
  // runOpenapiRoutesCheck is not used alone — here we print structured result.
  const result = runOpenapiRoutesCheck();
  if (result.ok) console.log(result.message);
  else console.error(result.message);
  process.exit(result.exitCode);
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) main();
