#!/usr/bin/env node
// scripts/check/check-dead-code.mjs
// Dead-code gate via knip — unused exports, unused files.
// Phase 7 INT: promoted from ADVISORY to a blocking RATCHET.
// Reads the baseline from quality-baseline.json (metrics.deadExports), compares, and
// fails with exit 1 if the count GOES UP. Supports --update to ratchet the baseline.
//
// Output (stdout):
//   DEAD_EXPORTS=<n>    — unused exports/re-exports/types
//   DEAD_FILES=<n>      — files with no consumer at all
//   DEAD_TOTAL=<n>      — sum of both (primary metric for the ratchet)
//
// Use --json to print knip's full report as JSON.
// Use --quiet to suppress diagnostic logs.
// Use --update to ratchet the baseline when the count legitimately drops.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = process.cwd();
const KNIP_BIN = path.join(ROOT, "node_modules", ".bin", "knip");
const QUIET = process.argv.includes("--quiet");
const PRINT_JSON = process.argv.includes("--json");
const UPDATE = process.argv.includes("--update");

const BASELINE_PATH = path.resolve(
  process.argv.includes("--baseline")
    ? process.argv[process.argv.indexOf("--baseline") + 1]
    : path.join(ROOT, "config/quality/quality-baseline.json")
);

/**
 * Counts dead exports and dead files from knip's JSON output.
 *
 * knip's JSON reporter emits:
 *   { issues: Array<{ file, exports?, files?, types?, nsExports?, nsTypes?, ... }> }
 *
 * Each entry in `exports`, `types`, `nsExports`, `nsTypes` is a dead symbol in that
 * file. The presence of the file itself in the list (a non-empty `files: []` field, or a
 * file with no other relevant fields and `files: true` in the include) marks a dead file.
 *
 * @param {object} knipJson - Parsed JSON object from knip's output
 * @returns {{ deadExports: number, deadFiles: number, deadTotal: number }}
 */
export function parseKnipMetrics(knipJson) {
  if (!knipJson || !Array.isArray(knipJson.issues)) {
    return { deadExports: 0, deadFiles: 0, deadTotal: 0 };
  }

  let deadExports = 0;
  let deadFiles = 0;

  for (const fileEntry of knipJson.issues) {
    // Dead file: the file appears in the list with a populated `files` field
    // (knip emits an entry with files:[] meaning "this file is dead")
    if (Array.isArray(fileEntry.files) && fileEntry.files.length > 0) {
      deadFiles += fileEntry.files.length;
    }
    // Some reporters flag a dead file without a files field — the entry exists
    // without exports/types = the whole file has no consumer
    // (conservative: only count when files[] is present and populated)

    // Dead exports: sum every dead symbol per export kind
    const exportFields = [
      "exports",
      "types",
      "nsExports",
      "nsTypes",
      "enumMembers",
      "namespaceMembers",
      "duplicates",
    ];
    for (const field of exportFields) {
      if (Array.isArray(fileEntry[field])) {
        deadExports += fileEntry[field].length;
      }
    }
  }

  return {
    deadExports,
    deadFiles,
    deadTotal: deadExports + deadFiles,
  };
}

/**
 * Evaluates the current total dead-code count against the baseline.
 * Direction: down (the count may only GO DOWN).
 *
 * Exported for unit testing.
 *
 * @param {number} current
 * @param {number} baseline
 * @returns {{ regressed: boolean, improved: boolean }}
 */
export function evaluateDeadCode(current, baseline) {
  return {
    regressed: current > baseline,
    improved: current < baseline,
  };
}

function runKnip() {
  const args = [
    "--reporter",
    "json",
    "--no-progress",
    "--no-exit-code", // do not fail on count — we only collect metrics
  ];

  if (!QUIET) {
    process.stderr.write("[dead-code] Running knip --reporter json ...\n");
  }

  let stdout;
  try {
    stdout = execFileSync(KNIP_BIN, args, {
      cwd: ROOT,
      encoding: "utf8",
      maxBuffer: 128 * 1024 * 1024,
      timeout: 300_000, // 5 min (knip can be slow on large monorepos)
    });
  } catch (err) {
    // knip exits with a non-zero code when it finds issues; the JSON still goes to stdout.
    stdout = err.stdout ? String(err.stdout) : "";
    if (!stdout.trim()) {
      process.stderr.write(`[dead-code] ERROR running knip: ${err.message}\n`);
      process.exit(2);
    }
  }

  let knipJson;
  try {
    knipJson = JSON.parse(stdout);
  } catch (parseErr) {
    process.stderr.write(`[dead-code] ERRO ao parsear JSON do knip: ${parseErr.message}\n`);
    process.stderr.write(`[dead-code] stdout (primeiros 500 chars): ${stdout.slice(0, 500)}\n`);
    process.exit(2);
  }

  return knipJson;
}

function main() {
  if (!fs.existsSync(BASELINE_PATH)) {
    process.stderr.write(`[dead-code] FAIL — ${path.basename(BASELINE_PATH)} ausente.\n`);
    process.exit(2);
  }

  const baselineJson = JSON.parse(fs.readFileSync(BASELINE_PATH, "utf8"));
  const baselineMetric = baselineJson.metrics && baselineJson.metrics.deadExports;
  if (!baselineMetric || typeof baselineMetric.value !== "number") {
    process.stderr.write(
      "[dead-code] FAIL — metrics.deadExports ausente em quality-baseline.json.\n"
    );
    process.exit(2);
  }
  const baselineValue = baselineMetric.value;

  const knipJson = runKnip();

  if (PRINT_JSON) {
    process.stdout.write(JSON.stringify(knipJson, null, 2) + "\n");
    return;
  }

  const { deadExports, deadFiles, deadTotal } = parseKnipMetrics(knipJson);

  // Emit in KEY=VALUE format for the metrics collector (collect-metrics.mjs)
  console.log(`DEAD_EXPORTS=${deadExports}`);
  console.log(`DEAD_FILES=${deadFiles}`);
  console.log(`DEAD_TOTAL=${deadTotal}`);

  const { regressed, improved } = evaluateDeadCode(deadTotal, baselineValue);

  if (UPDATE && improved) {
    baselineJson.metrics.deadExports.value = deadTotal;
    fs.writeFileSync(BASELINE_PATH, JSON.stringify(baselineJson, null, 2) + "\n");
    console.log(`[dead-code] baseline ratcheted: ${deadTotal} (was ${baselineValue})`);
  }

  if (regressed) {
    process.stderr.write(
      `[dead-code] REGRESSION — ${deadTotal} dead symbols > baseline ${baselineValue}\n` +
        `  → Remove unused exports/files, or run\n` +
        `    'node scripts/check/check-dead-code.mjs --update' if the count legitimately dropped.\n`
    );
    process.exit(1);
  }

  console.log(`[dead-code] OK — ${deadTotal} dead symbols (baseline ${baselineValue})`);
  process.exitCode = 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) main();
