import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// The Docker publish workflow builds on GitHub-hosted runners (ubuntu-24.04 and
// ubuntu-24.04-arm): 4 vCPU, 16 GB RAM. Every Next page-data worker AND the
// parent `next build` process are separate OS processes, so the budget has to
// cover all of them, not just the workers.
//
// With 7 workers × 6144 MB the runner ran out and buildkit failed the step with
// `ResourceExhausted: ... cannot allocate memory`, right after "Collecting page
// data using 7 workers" — every Docker publish since 2026-08-22 23:14 UTC.
// Lowering to 2 workers (#10060 / PR #11419) was not enough: it modeled the
// per-process peak as an INFERENCE (`WORKER_PEAK_MB = 2560`, derived only from
// "7 workers didn't fit") and assumed the parent process tracked the V8 heap
// ceiling (`OMNIROUTE_BUILD_MEMORY_MB`) rather than its own RSS. The owner's
// live VPS reproduction (issue #7518, dmesg OOM-killer report, 2026-08-24)
// measured the real number directly: `next-build (v16) ... anon-rss:4522744kB`
// (~4.5 GB) per process, independent of the NODE_OPTIONS heap flag — Turbopack
// itself is native/Rust and compiles outside the V8 heap. With 2 workers that
// keeps the publish pipeline failing at "Collecting page data using 2 workers"
// (run 32907937950, 2026-08-25).
//
// This pins the budget on the MEASURED figure, applied uniformly to every
// process (parent + workers), so raising the worker count has to be a
// deliberate change that re-does the arithmetic, not a one-line bump that
// silently reds the publish pipeline again.

const RUNNER_MEMORY_MB = 16 * 1024;
// Leave room for buildkit, the snapshotter and page cache.
const HEADROOM_FRACTION = 0.75;
// Measured (not inferred) peak RSS for a single Next/Turbopack build process —
// parent or page-data worker alike — from the dmesg OOM-killer report above.
// If a future build OOMs again, re-measure via dmesg before raising this
// number — do not weaken the budget with another guess.
const MEASURED_PROCESS_RSS_MB = 4500;

const dockerfile = readFileSync(
  fileURLToPath(new URL("../../Dockerfile", import.meta.url)),
  "utf8"
);

function readArgDefault(name: string): number {
  const match = dockerfile.match(new RegExp(`^ARG ${name}=(\\d+)$`, "m"));
  assert.ok(match, `Dockerfile no longer declares ARG ${name}`);
  return Number(match![1]);
}

test("the Docker build's worker pool is derived from OMNIROUTE_BUILD_WORKERS", () => {
  // assert.ok(boolean), not assert.match — a failing assert.match dumps the
  // whole Dockerfile into the report.
  assert.ok(
    /^ENV CIRCLE_NODE_TOTAL=\$\{OMNIROUTE_BUILD_WORKERS\}$/m.test(dockerfile),
    "CIRCLE_NODE_TOTAL must stay wired to the build arg so a big builder can raise it"
  );
  assert.ok(
    /^ENV NODE_OPTIONS="--max-old-space-size=\$\{OMNIROUTE_BUILD_MEMORY_MB\}"$/m.test(dockerfile),
    "the build heap ceiling must stay wired to OMNIROUTE_BUILD_MEMORY_MB"
  );
});

test("worker count × measured per-process RSS fits a 16 GB GitHub runner", () => {
  const workerPool = readArgDefault("OMNIROUTE_BUILD_WORKERS");

  // Next derives `workers = CIRCLE_NODE_TOTAL - 1`.
  const workers = workerPool - 1;
  assert.ok(workers >= 1, `CIRCLE_NODE_TOTAL=${workerPool} leaves no build workers`);

  // Every process — the parent `next build` process AND each page-data
  // worker — is budgeted at the measured per-process RSS floor (see the file
  // banner comment). The V8 heap ceiling (OMNIROUTE_BUILD_MEMORY_MB) bounds
  // JS allocations but not Turbopack's native/Rust memory, so it cannot stand
  // in for the parent process's real RSS.
  const processes = workers + 1;
  const worstCaseMb = processes * MEASURED_PROCESS_RSS_MB;
  const budgetMb = RUNNER_MEMORY_MB * HEADROOM_FRACTION;
  assert.ok(
    worstCaseMb <= budgetMb,
    `${processes} processes (1 parent + ${workers} workers) × ${MEASURED_PROCESS_RSS_MB} MB ` +
      `measured RSS = ${worstCaseMb} MB exceeds the ${budgetMb} MB budget on a ` +
      `${RUNNER_MEMORY_MB} MB runner — the Docker publish step dies with "ResourceExhausted: ` +
      `cannot allocate memory" during page-data collection`
  );
});

test("the webpack compile phase (parent + webpackBuildWorker subprocess) fits the runner budget", () => {
  const buildMemoryMb = readArgDefault("OMNIROUTE_BUILD_MEMORY_MB");

  // On the webpack path (Dockerfile's effective default, OMNIROUTE_USE_TURBOPACK=0)
  // `experimental.webpackBuildWorker` (next.config.mjs) runs the compile in a
  // SUBPROCESS, and build-next-isolated.mjs → resolveNextBuildEnv propagates
  // NODE_OPTIONS into it, so the compile phase holds TWO processes each capped at
  // OMNIROUTE_BUILD_MEMORY_MB. OMNIROUTE_BUILD_WORKERS does not bound this worker —
  // it only caps the page-data pool — so the test above cannot catch it. At 2 ×
  // 7168 MB = 14.3 GB the 16 GB lab runner (shared with the act runner + buildkit)
  // OOM-killed the compile worker: "Next.js build worker exited with code: null and
  // signal: SIGKILL" during "Creating an optimized production build", then
  // `ResourceExhausted: ... cannot allocate memory` (Gitea Actions run 1753, job
  // 1802, commit b121150b2, 2026-09-08).
  //
  // Here the V8 ceiling — not MEASURED_PROCESS_RSS_MB (4500) — is the right
  // per-process knob to pin: that figure was measured on the TURBOPACK path, where
  // the compile is native/Rust and allocates outside the V8 heap, so RSS floats free
  // of --max-old-space-size. Webpack compiles ON V8, so the heap ceiling is the
  // dominant term in its RSS and scales with whatever we set here; budgeting it at a
  // fixed 4500 MB would let a ceiling bump sail past this assertion.
  //
  // SCOPE — what this actually asserts: the configured HEAP-CEILING POLICY (2 ×
  // ceiling must fit the 75% budget), NOT a guarantee that the compile fits the
  // runner's RAM. --max-old-space-size bounds only V8's old space; a process's real
  // RSS also carries the young generation, code space, native allocations, Buffers
  // and allocator overhead, so RSS can run past the ceiling. Treat this as a
  // necessary-but-not-sufficient guard: it catches a ceiling bump that is doomed on
  // the arithmetic alone, but clearing it does not prove the build survives. The
  // authoritative validation stays a real lab Docker build, whose failure mode names
  // the bound that was hit — a kernel SIGKILL (OOM killer, as in run 1753 / job 1802)
  // means real RSS outgrew the machine, whereas a V8 "JavaScript heap out of memory"
  // abort means the ceiling itself is too low.
  const processes = 2; // parent `next build` + webpackBuildWorker compile subprocess
  const worstCaseMb = processes * buildMemoryMb;
  const budgetMb = RUNNER_MEMORY_MB * HEADROOM_FRACTION;
  assert.ok(
    worstCaseMb <= budgetMb,
    `heap-ceiling policy violated: ${processes} processes (1 parent + 1 ` +
      `webpackBuildWorker) × ${buildMemoryMb} MB V8 ceiling = ${worstCaseMb} MB exceeds ` +
      `the ${budgetMb} MB budget on a ${RUNNER_MEMORY_MB} MB runner. This bounds the ` +
      `configured V8 old-space ceilings only — actual RSS adds non-V8 memory on top, so ` +
      `clearing this budget is necessary but not sufficient; confirm with a real lab ` +
      `Docker build (a SIGKILL, e.g. "Next.js build worker exited with code: null and ` +
      `signal: SIGKILL" during the webpack compile, means RSS blew the machine, not the heap)`
  );
});

test("the worker pool does not oversubscribe the runner's 4 vCPU", () => {
  const workers = readArgDefault("OMNIROUTE_BUILD_WORKERS") - 1;
  assert.ok(workers <= 4, `${workers} workers oversubscribe a 4 vCPU runner`);
});
