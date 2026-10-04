/**
 * Client Version Mode service: persistence (key_value settings, key
 * `clientVersionModes`), upstream checks for `automatic` mode, the periodic
 * auto-check scheduler, and the status/wire-preview payload for the dashboard.
 */
import {
  getSettings,
  getSettingsRevision,
  SettingsRevisionConflictError,
  updateSettings,
} from "@/lib/db/settings";
import { sanitizeErrorMessage } from "@omniroute/open-sse/utils/error.ts";
import {
  getClaudeCodeClientBillingVersion,
  getClaudeCodeClientVersion,
  getClaudeCodeUserAgent,
} from "@/shared/constants/claudeCodeClient";
import {
  getCodexClientVersion,
  getCodexDefaultHeaders,
} from "@omniroute/open-sse/config/codexClient.ts";
import {
  getCachedAntigravityCliVersion,
  getCachedAntigravityIdeVersion,
} from "@omniroute/open-sse/services/antigravityVersion.ts";
import {
  antigravityCliUserAgent,
  antigravityIdeUserAgent,
} from "@omniroute/open-sse/services/antigravityHeaders.ts";
import { getGeminiCliAuthHeaders } from "@omniroute/open-sse/services/geminiCliDiscovery.ts";
import {
  CLIENT_VERSION_PRODUCTS,
  getActiveClientVersion,
  getModeRevision,
  isSafeClientVersion,
  normalizeClientVersionModes,
  setClientVersionModes,
  type ClientVersionMode,
  type ClientVersionModesSettings,
  type ClientVersionProduct,
  type ClientVersionTarget,
  type ProductClientVersionConfig,
} from "./registry";
import { fetchLatestClientVersion, type FetchLike } from "./upstream";

export const CLIENT_VERSION_SETTINGS_KEY = "clientVersionModes";
export const CLIENT_VERSION_AUTO_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

export const CLIENT_VERSION_PRODUCT_LABELS: Record<ClientVersionProduct, string> = {
  "claude-code": "Claude Code",
  codex: "OpenAI Codex",
  antigravity: "Google Antigravity",
  "gemini-cli": "Google Gemini CLI",
};

/** Host env overrides that sit between the dynamic registry and the compiled pin. */
const ENV_OVERRIDE_NAMES: Record<ClientVersionProduct, string | null> = {
  "claude-code": "CLAUDE_CODE_CLIENT_VERSION",
  codex: "CODEX_CLIENT_VERSION",
  antigravity: null,
  "gemini-cli": "GEMINI_CLI_UA_VERSION",
};

export type ActiveVersionSource = "manual" | "automatic" | "env" | "default";

let fetchImplOverride: FetchLike | null = null;

/** Test seam: route every upstream check through a mock fetch (null restores global fetch). */
export function setClientVersionFetchImpl(fetchImpl: FetchLike | null): void {
  fetchImplOverride = fetchImpl;
}

function getFetchImpl(): FetchLike {
  return fetchImplOverride ?? ((url, init) => fetch(url, init));
}

export async function getClientVersionModes(): Promise<ClientVersionModesSettings> {
  const settings = await getSettings();
  return normalizeClientVersionModes(settings[CLIENT_VERSION_SETTINGS_KEY]);
}

/** Optimistic-concurrency attempts before a persistent revision conflict is surfaced. */
const MAX_SAVE_ATTEMPTS = 5;

// In-process write queue: PATCH handlers and background checks mutate the same
// `clientVersionModes` blob, so their read-modify-write cycles run one at a time.
let writeQueue: Promise<unknown> = Promise.resolve();

function serializeWrite<T>(task: () => Promise<T>): Promise<T> {
  const run = writeQueue.then(task, task);
  writeQueue = run.catch(() => undefined);
  return run;
}

/**
 * Advance the persisted `modeRevision` of every product whose mode changed.
 * It is written in the same CAS commit as the mode itself, so every process
 * (and every check that re-reads settings) sees the transition.
 */
function bumpChangedModeRevisions(
  before: ClientVersionModesSettings,
  after: ClientVersionModesSettings
): void {
  for (const product of CLIENT_VERSION_PRODUCTS) {
    if (before[product].mode !== after[product].mode) {
      after[product] = { ...after[product], modeRevision: getModeRevision(before[product]) + 1 };
    }
  }
}

/**
 * Read-modify-write `clientVersionModes` without losing concurrent updates.
 * Writes are serialized in-process and guarded by the settings revision (CAS),
 * so a write from another process or another settings key between our read and
 * our write triggers a fresh re-read instead of clobbering it. The in-memory
 * registry is only touched after the DB write succeeds.
 */
async function mutateClientVersionModes(
  mutate: (modes: ClientVersionModesSettings) => void
): Promise<ClientVersionModesSettings> {
  return serializeWrite(async () => {
    for (let attempt = 1; ; attempt += 1) {
      const expectedRevision = await getSettingsRevision();
      const before = await getClientVersionModes();
      const modes = normalizeClientVersionModes(before);
      mutate(modes);
      bumpChangedModeRevisions(before, modes);
      try {
        await updateSettings({ [CLIENT_VERSION_SETTINGS_KEY]: modes }, { expectedRevision });
      } catch (error) {
        if (error instanceof SettingsRevisionConflictError && attempt < MAX_SAVE_ATTEMPTS) {
          continue;
        }
        throw error;
      }
      // updateSettings already hot-reloads through applyRuntimeSettings; set the
      // registry directly as well in case that reload path failed (it only warns).
      // Tagged with the committed revision so it never rolls back a newer reload.
      setClientVersionModes(modes, { revision: expectedRevision + 1 });
      return modes;
    }
  });
}

export class ClientVersionValidationError extends Error {}

export async function updateClientVersionMode(input: {
  product: ClientVersionProduct;
  mode: ClientVersionMode;
  manualVersion?: string;
  manualCliVersion?: string;
}): Promise<ClientVersionModesSettings> {
  const manualVersion = input.manualVersion?.trim();
  const manualCliVersion = input.manualCliVersion?.trim();
  if (manualVersion && !isSafeClientVersion(manualVersion)) {
    throw new ClientVersionValidationError("Invalid version string");
  }
  if (manualCliVersion && !isSafeClientVersion(manualCliVersion)) {
    throw new ClientVersionValidationError("Invalid CLI version string");
  }
  if (input.manualCliVersion !== undefined && input.product !== "antigravity") {
    throw new ClientVersionValidationError("manualCliVersion is only supported for antigravity");
  }
  if (input.mode === "manual" && !manualVersion) {
    throw new ClientVersionValidationError("manualVersion is required for manual mode");
  }

  return mutateClientVersionModes((modes) => {
    const next: ProductClientVersionConfig = { ...modes[input.product], mode: input.mode };
    if (input.manualVersion !== undefined) {
      if (manualVersion) next.manualVersion = manualVersion;
      else delete next.manualVersion;
    }
    if (input.manualCliVersion !== undefined) {
      if (manualCliVersion) next.manualCliVersion = manualCliVersion;
      else delete next.manualCliVersion;
    }
    modes[input.product] = next;
  });
}

// Keyed by target + modeRevision so a check started after a mode transition
// never joins (and inherits) a fetch that began under the previous mode.
const inFlightChecks = new Map<string, Promise<CheckOutcome>>();

type CheckOutcome = { version: string | null; error: string | null; checkedAt: string };

function checkTarget(
  product: ClientVersionTarget,
  modeRevision: number,
  fetchImpl: FetchLike
): Promise<CheckOutcome> {
  const key = `${product}#${modeRevision}`;
  const existing = inFlightChecks.get(key);
  if (existing) return existing;
  const promise = (async (): Promise<CheckOutcome> => {
    try {
      const version = await fetchLatestClientVersion(product, fetchImpl);
      return { version, error: null, checkedAt: new Date().toISOString() };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        version: null,
        error: sanitizeErrorMessage(message) || "Upstream check failed",
        checkedAt: new Date().toISOString(),
      };
    }
  })().finally(() => inFlightChecks.delete(key));
  inFlightChecks.set(key, promise);
  return promise;
}

/**
 * Query upstream for every `automatic` product (or just `product` when given,
 * still only if it is `automatic`). Never throws: failures are recorded on the
 * product as `lastCheckError` and the previous auto-detected version is kept,
 * so the active version falls back to manual → env → compiled pin.
 *
 * Outcomes for a product whose mode changed while the check was in flight
 * (its persisted `modeRevision` moved, in this or any other process) are
 * reported in `discarded` and not stored.
 */
export async function runClientVersionCheck(
  options: { product?: ClientVersionProduct; fetchImpl?: FetchLike } = {}
): Promise<{
  checked: ClientVersionProduct[];
  skipped: ClientVersionProduct[];
  discarded: ClientVersionProduct[];
}> {
  const fetchImpl = options.fetchImpl ?? getFetchImpl();
  const candidates = options.product ? [options.product] : [...CLIENT_VERSION_PRODUCTS];
  const modes = await getClientVersionModes();
  // Record each product's modeRevision from the same read that decides what to
  // check; any transition committed after it invalidates the outcome.
  const startModeRevisions = new Map(
    candidates.map((product) => [product, getModeRevision(modes[product])])
  );
  const checked = candidates.filter((product) => modes[product].mode === "automatic");
  const skipped = candidates.filter((product) => modes[product].mode !== "automatic");
  const discarded: ClientVersionProduct[] = [];
  if (checked.length === 0) return { checked, skipped, discarded };

  // Antigravity IDE and CLI come from different feeds and are stored separately.
  const outcomes = await Promise.all(
    checked.map((product) => {
      const modeRevision = startModeRevisions.get(product) ?? 0;
      return product === "antigravity"
        ? Promise.all([
            checkTarget("antigravity", modeRevision, fetchImpl),
            checkTarget("antigravity-cli", modeRevision, fetchImpl),
          ])
        : Promise.all([checkTarget(product, modeRevision, fetchImpl)]);
    })
  );

  // Merge onto a fresh read inside the CAS loop so a PATCH that landed while we
  // were on the network (or races this write) is not clobbered. A product that
  // left automatic mode meanwhile — or left and came back — keeps its state:
  // the stale outcome is dropped. `latest` is re-read from SQLite on every CAS
  // attempt, so a transition made by another process is caught here too.
  await mutateClientVersionModes((latest) => {
    discarded.length = 0;
    checked.forEach((product, index) => {
      if (
        latest[product].mode !== "automatic" ||
        getModeRevision(latest[product]) !== startModeRevisions.get(product)
      ) {
        discarded.push(product);
        return;
      }
      const [ide, cli] = outcomes[index];
      const config: ProductClientVersionConfig = {
        ...latest[product],
        lastCheckedAt: ide.checkedAt,
      };
      const errors: string[] = [];
      if (ide.version) config.autoDetectedVersion = ide.version;
      else if (ide.error) errors.push(cli ? `IDE: ${ide.error}` : ide.error);
      if (cli?.version) config.autoDetectedCliVersion = cli.version;
      else if (cli?.error) errors.push(`CLI: ${cli.error}`);
      if (errors.length > 0) config.lastCheckError = errors.join("; ");
      else delete config.lastCheckError;
      latest[product] = config;
    });
  });
  return { checked, skipped, discarded };
}

// ── Periodic auto-check scheduler ────────────────────────────────────────────

let schedulerTimer: ReturnType<typeof setInterval> | null = null;
const pendingScheduledChecks = new Set<Promise<unknown>>();

function hasAutomaticProduct(modes: ClientVersionModesSettings): boolean {
  return CLIENT_VERSION_PRODUCTS.some((product) => modes[product].mode === "automatic");
}

function isStale(config: ProductClientVersionConfig, now: number): boolean {
  if (config.mode !== "automatic") return false;
  const checkedAt = config.lastCheckedAt ? Date.parse(config.lastCheckedAt) : Number.NaN;
  return !Number.isFinite(checkedAt) || now - checkedAt >= CLIENT_VERSION_AUTO_CHECK_INTERVAL_MS;
}

function runScheduledCheck(): void {
  const pending = runClientVersionCheck()
    .catch((error) => {
      console.warn(
        "[CLIENT_VERSIONS] Scheduled upstream check failed:",
        error instanceof Error ? error.message : error
      );
    })
    .finally(() => pendingScheduledChecks.delete(pending));
  pendingScheduledChecks.add(pending);
}

/** Resolve once every background check started by the scheduler has settled. */
export async function flushClientVersionChecks(): Promise<void> {
  while (pendingScheduledChecks.size > 0) {
    await Promise.allSettled([...pendingScheduledChecks]);
  }
}

/**
 * Start/stop the periodic check to match the current modes. With every product
 * `off` (the default) no timer exists and no network call is ever made.
 */
export function syncClientVersionScheduler(value: unknown): void {
  const modes = normalizeClientVersionModes(value);
  if (!hasAutomaticProduct(modes)) {
    stopClientVersionScheduler();
    return;
  }
  if (!schedulerTimer) {
    schedulerTimer = setInterval(runScheduledCheck, CLIENT_VERSION_AUTO_CHECK_INTERVAL_MS);
    schedulerTimer.unref?.();
  }
  const now = Date.now();
  if (CLIENT_VERSION_PRODUCTS.some((product) => isStale(modes[product], now))) {
    runScheduledCheck();
  }
}

export function stopClientVersionScheduler(): void {
  if (schedulerTimer) clearInterval(schedulerTimer);
  schedulerTimer = null;
}

export function isClientVersionSchedulerRunning(): boolean {
  return schedulerTimer !== null;
}

// ── Active versions + wire preview ───────────────────────────────────────────

export function getActiveClaudeCodeVersion(): string {
  return getClaudeCodeClientVersion();
}

export function getActiveCodexVersion(): string {
  return getCodexClientVersion();
}

export function getActiveAntigravityVersion(): string {
  return getCachedAntigravityIdeVersion();
}

export function getActiveGeminiCliVersion(): string {
  const userAgent = getGeminiCliAuthHeaders("preview")["User-Agent"];
  return userAgent.match(/^GeminiCLI\/([^\s/]+)/)?.[1] ?? "";
}

export function getClientWirePreview(product: ClientVersionProduct): Record<string, string> {
  switch (product) {
    case "claude-code":
      return {
        "User-Agent": getClaudeCodeUserAgent("cli"),
        "x-anthropic-billing-header": `cc_version=${getClaudeCodeClientBillingVersion()}`,
      };
    case "codex": {
      const headers = getCodexDefaultHeaders();
      return { Version: headers.Version, "User-Agent": headers["User-Agent"] };
    }
    case "antigravity":
      return {
        "User-Agent (IDE)": antigravityIdeUserAgent(),
        "User-Agent (CLI)": antigravityCliUserAgent(),
      };
    case "gemini-cli":
      return { "User-Agent": getGeminiCliAuthHeaders("preview")["User-Agent"] };
  }
}

function getActiveVersion(product: ClientVersionProduct): string {
  switch (product) {
    case "claude-code":
      return getActiveClaudeCodeVersion();
    case "codex":
      return getActiveCodexVersion();
    case "antigravity":
      return getActiveAntigravityVersion();
    case "gemini-cli":
      return getActiveGeminiCliVersion();
  }
}

function getEnvOverride(product: ClientVersionProduct): string | null {
  const name = ENV_OVERRIDE_NAMES[product];
  const raw = name ? process.env[name]?.trim() : undefined;
  return isSafeClientVersion(raw) ? raw : null;
}

/** Source of the Antigravity CLI version (no env override exists for it). */
export function resolveAntigravityCliVersionSource(
  config: ProductClientVersionConfig
): ActiveVersionSource {
  if (!getActiveClientVersion("antigravity-cli")) return "default";
  return config.mode === "automatic" && isSafeClientVersion(config.autoDetectedCliVersion)
    ? "automatic"
    : "manual";
}

export function resolveActiveVersionSource(
  product: ClientVersionProduct,
  config: ProductClientVersionConfig
): ActiveVersionSource {
  if (getActiveClientVersion(product)) {
    if (config.mode === "automatic" && isSafeClientVersion(config.autoDetectedVersion)) {
      return "automatic";
    }
    return "manual";
  }
  return getEnvOverride(product) ? "env" : "default";
}

/**
 * Strictly read-only: never touches the registry. It is updated only by the
 * startup/hot-reload path (applyRuntimeSettings) and after committed writes, so
 * a slow GET can never roll back a newer registry or race a PATCH.
 */
export async function getClientVersionStatus() {
  const modes = await getClientVersionModes();
  return {
    products: CLIENT_VERSION_PRODUCTS.map((product) => ({
      product,
      label: CLIENT_VERSION_PRODUCT_LABELS[product],
      config: modes[product],
      activeVersion: getActiveVersion(product),
      source: resolveActiveVersionSource(product, modes[product]),
      envOverrideName: ENV_OVERRIDE_NAMES[product],
      ...(product === "antigravity"
        ? {
            activeCliVersion: getCachedAntigravityCliVersion(),
            cliSource: resolveAntigravityCliVersionSource(modes[product]),
          }
        : {}),
      wirePreview: getClientWirePreview(product),
    })),
  };
}
