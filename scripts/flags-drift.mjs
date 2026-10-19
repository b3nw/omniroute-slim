#!/usr/bin/env node
/**
 * flags-drift — diff a live instance's runtime feature flags against ops/flags.expect.json.
 *
 *   node scripts/flags-drift.mjs --base-url http://host:20128 --tier dev
 *   node scripts/flags-drift.mjs --file flags.json --tier prod --json
 *
 * Auth (live mode): OMNIROUTE_API_KEY (sent as `Authorization: Bearer …`) or
 * OMNIROUTE_ADMIN_COOKIE (the `auth_token` session value, or a full `name=value` cookie).
 * --file reads a saved GET /api/settings/feature-flags response instead of the network.
 *
 * Only flags listed for the tier are checked. Each row carries the live `source`
 * (db-override / env / default) so a DB override is distinguishable from an env default.
 *
 * Exit codes: 0 no drift, 1 drift, 2 usage/fetch/parse error.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_EXPECT = path.join(REPO_ROOT, "ops", "flags.expect.json");
const ACTIVE_VALUES = new Set(["true", "1", "yes"]);
const SOURCE_LABELS = { db: "db-override", env: "env", default: "default" };

const USAGE = `Usage: node scripts/flags-drift.mjs --tier dev|prod (--base-url <url> | --file <path>) [options]

Options:
  --tier <dev|prod>     expected profile to compare against (required)
  --base-url <url>      instance to query: GET <url>/api/settings/feature-flags
  --file <path>         offline: read a saved feature-flags JSON response instead
  --expect <path>       expected profiles (default: ops/flags.expect.json)
  --json                machine-readable output
  -h, --help            show this help

Env (live mode): OMNIROUTE_API_KEY (Bearer) or OMNIROUTE_ADMIN_COOKIE (auth_token value or name=value)
Exit: 0 no drift, 1 drift, 2 error`;

class UsageError extends Error {}

function parseArgs(argv) {
  const opts = { expect: DEFAULT_EXPECT, json: false };
  const valueFlags = {
    "--tier": "tier",
    "--base-url": "baseUrl",
    "--file": "file",
    "--expect": "expect",
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "-h" || arg === "--help") return { help: true };
    if (arg === "--json") {
      opts.json = true;
      continue;
    }
    const [name, inline] = arg.includes("=") ? arg.split(/=(.*)/s, 2) : [arg, undefined];
    if (!(name in valueFlags)) throw new UsageError(`unknown argument: ${arg}`);
    const value = inline ?? argv[++i];
    if (value === undefined || value === "") throw new UsageError(`${name} requires a value`);
    opts[valueFlags[name]] = value;
  }
  if (opts.tier !== "dev" && opts.tier !== "prod")
    throw new UsageError("--tier must be dev or prod");
  if (!opts.baseUrl === !opts.file)
    throw new UsageError("pass exactly one of --base-url or --file");
  return opts;
}

async function fetchFlags(baseUrl) {
  const headers = { Accept: "application/json" };
  const apiKey = process.env.OMNIROUTE_API_KEY;
  const cookie = process.env.OMNIROUTE_ADMIN_COOKIE;
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  else if (cookie) headers.Cookie = cookie.includes("=") ? cookie : `auth_token=${cookie}`;
  const url = new URL("/api/settings/feature-flags", baseUrl);
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`GET ${url} → HTTP ${res.status}`);
  return res.json();
}

/** Accepts the full route response ({ flags: [...] }) or a bare flags array. */
function indexFlags(payload) {
  const flags = Array.isArray(payload) ? payload : payload?.flags;
  if (!Array.isArray(flags)) throw new Error("response has no `flags` array");
  return new Map(flags.map((flag) => [flag.key, flag]));
}

function matches(expected, effectiveValue) {
  if (typeof expected === "boolean") return ACTIVE_VALUES.has(effectiveValue) === expected;
  return String(expected) === effectiveValue;
}

export function compareFlags(expectedProfile, payload) {
  const live = indexFlags(payload);
  const rows = Object.entries(expectedProfile).map(([key, expected]) => {
    const flag = live.get(key);
    if (!flag) return { key, expected, actual: null, source: null, status: "missing" };
    const actual = flag.effectiveValue;
    return {
      key,
      expected,
      actual,
      source: SOURCE_LABELS[flag.source] ?? String(flag.source),
      status: matches(expected, actual) ? "ok" : "drift",
    };
  });
  const checked = new Set(Object.keys(expectedProfile));
  const unchecked = [...live.keys()].filter((key) => !checked.has(key)).length;
  return { rows, drift: rows.filter((row) => row.status !== "ok").length, unchecked };
}

function printTable(tier, result) {
  const header = ["FLAG", "EXPECTED", "ACTUAL", "SOURCE", "STATUS"];
  const lines = result.rows.map((row) => [
    row.key,
    String(row.expected),
    row.actual ?? "—",
    row.source ?? "—",
    row.status === "ok" ? "ok" : row.status.toUpperCase(),
  ]);
  const widths = header.map((h, col) =>
    Math.max(h.length, ...lines.map((line) => line[col].length))
  );
  for (const line of [header, ...lines]) {
    console.log(
      line
        .map((cell, col) => cell.padEnd(widths[col]))
        .join("  ")
        .trimEnd()
    );
  }
  console.log(
    `\n${tier}: ${result.rows.length} checked, ${result.drift} drifted, ${result.unchecked} live flags not in the expected profile`
  );
}

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`flags-drift: ${error.message}\n\n${USAGE}`);
    return 2;
  }
  if (opts.help) {
    console.log(USAGE);
    return 0;
  }
  try {
    const expectAll = JSON.parse(readFileSync(opts.expect, "utf8"));
    const profile = expectAll[opts.tier];
    if (!profile || typeof profile !== "object")
      throw new Error(`no "${opts.tier}" profile in ${opts.expect}`);
    const payload = opts.file
      ? JSON.parse(readFileSync(opts.file, "utf8"))
      : await fetchFlags(opts.baseUrl);
    const result = compareFlags(profile, payload);
    if (opts.json) console.log(JSON.stringify({ tier: opts.tier, ...result }, null, 2));
    else printTable(opts.tier, result);
    return result.drift > 0 ? 1 : 0;
  } catch (error) {
    console.error(`flags-drift: ${error.message}`);
    return 2;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}
