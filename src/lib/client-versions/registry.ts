/**
 * In-memory hot-reload registry for per-product client version modes.
 *
 * Deliberately dependency-free: the wire-version getters in
 * `src/shared/constants/claudeCodeClient.ts`, `open-sse/config/codexClient.ts`,
 * `open-sse/services/antigravityVersion.ts` and `open-sse/executors/geminiCli.ts`
 * import this on the request path, so it must do 0 I/O and never pull the DB.
 *
 * State lives on `globalThis` so every Next.js chunk that bundles its own copy
 * of this module (route handlers, instrumentation, open-sse) sees one registry.
 */

export const CLIENT_VERSION_PRODUCTS = [
  "claude-code",
  "codex",
  "antigravity",
  "gemini-cli",
] as const;
export type ClientVersionProduct = (typeof CLIENT_VERSION_PRODUCTS)[number];

/**
 * Wire-version targets. Antigravity ships two independently versioned clients
 * (IDE 2.x, CLI 1.x) under one product toggle: `antigravity` is the IDE and
 * `antigravity-cli` the CLI, each resolved from its own config fields.
 */
export type ClientVersionTarget = ClientVersionProduct | "antigravity-cli";

export const CLIENT_VERSION_MODES = ["off", "manual", "automatic"] as const;
export type ClientVersionMode = (typeof CLIENT_VERSION_MODES)[number];

export interface ProductClientVersionConfig {
  mode: ClientVersionMode;
  manualVersion?: string;
  autoDetectedVersion?: string;
  lastCheckedAt?: string;
  lastCheckError?: string;
  /** Antigravity only: the CLI version, kept apart from the IDE version above. */
  manualCliVersion?: string;
  autoDetectedCliVersion?: string;
  /**
   * Persisted mode-transition counter, bumped on every committed mode change.
   * An upstream check records it when it starts and drops its outcome if it
   * moved by merge time, even when another process made the transition.
   */
  modeRevision?: number;
}

export type ClientVersionModesSettings = Record<ClientVersionProduct, ProductClientVersionConfig>;

/** Same token pattern the env overrides (CLAUDE_CODE_CLIENT_VERSION etc.) already enforce. */
export const SAFE_CLIENT_VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/;

export function isSafeClientVersion(value: unknown): value is string {
  return typeof value === "string" && SAFE_CLIENT_VERSION_PATTERN.test(value);
}

export function isClientVersionProduct(value: unknown): value is ClientVersionProduct {
  return (
    typeof value === "string" && (CLIENT_VERSION_PRODUCTS as readonly string[]).includes(value)
  );
}

export function createDefaultClientVersionModes(): ClientVersionModesSettings {
  return {
    "claude-code": { mode: "off" },
    codex: { mode: "off" },
    antigravity: { mode: "off" },
    "gemini-cli": { mode: "off" },
  };
}

function normalizeProductConfig(value: unknown): ProductClientVersionConfig {
  const record =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  const mode = (CLIENT_VERSION_MODES as readonly string[]).includes(record.mode as string)
    ? (record.mode as ClientVersionMode)
    : "off";
  const config: ProductClientVersionConfig = { mode };
  if (typeof record.manualVersion === "string" && record.manualVersion.trim()) {
    config.manualVersion = record.manualVersion.trim();
  }
  if (isSafeClientVersion(record.autoDetectedVersion)) {
    config.autoDetectedVersion = record.autoDetectedVersion;
  }
  if (typeof record.manualCliVersion === "string" && record.manualCliVersion.trim()) {
    config.manualCliVersion = record.manualCliVersion.trim();
  }
  if (isSafeClientVersion(record.autoDetectedCliVersion)) {
    config.autoDetectedCliVersion = record.autoDetectedCliVersion;
  }
  if (
    typeof record.modeRevision === "number" &&
    Number.isInteger(record.modeRevision) &&
    record.modeRevision > 0
  ) {
    config.modeRevision = record.modeRevision;
  }
  if (typeof record.lastCheckedAt === "string") config.lastCheckedAt = record.lastCheckedAt;
  if (typeof record.lastCheckError === "string") config.lastCheckError = record.lastCheckError;
  return config;
}

/** Coerce any stored/partial value into a complete, safe settings object (unknown keys dropped). */
export function normalizeClientVersionModes(value: unknown): ClientVersionModesSettings {
  let raw = value;
  if (typeof raw === "string") {
    try {
      raw = JSON.parse(raw);
    } catch {
      raw = null;
    }
  }
  const record =
    raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const result = createDefaultClientVersionModes();
  for (const product of CLIENT_VERSION_PRODUCTS) {
    result[product] = normalizeProductConfig(record[product]);
  }
  return result;
}

function resolveVersionPair(
  mode: ClientVersionMode,
  manualValue: unknown,
  autoValue: unknown
): string | null {
  if (mode === "off") return null;
  const manual = isSafeClientVersion(manualValue) ? manualValue : null;
  if (mode === "manual") return manual;
  return (isSafeClientVersion(autoValue) ? autoValue : null) ?? manual;
}

/**
 * Resolve the version a product config advertises, or null to defer to the
 * existing env → compiled-pin fallback chain.
 *   off       → null
 *   manual    → manualVersion (null if blank/invalid)
 *   automatic → autoDetectedVersion → manualVersion → null
 */
export function resolveConfiguredVersion(
  config: ProductClientVersionConfig | undefined
): string | null {
  if (!config) return null;
  return resolveVersionPair(config.mode, config.manualVersion, config.autoDetectedVersion);
}

/** Same chain as resolveConfiguredVersion, over the Antigravity CLI fields only. */
export function resolveConfiguredCliVersion(
  config: ProductClientVersionConfig | undefined
): string | null {
  if (!config) return null;
  return resolveVersionPair(config.mode, config.manualCliVersion, config.autoDetectedCliVersion);
}

type RegistryState = {
  active: Partial<Record<ClientVersionTarget, string>>;
  /** Settings revision the active map was built from (null = unversioned/startup). */
  revision: number | null;
};

const REGISTRY_KEY = Symbol.for("omniroute.clientVersionRegistry");

function getState(): RegistryState {
  const g = globalThis as typeof globalThis & { [REGISTRY_KEY]?: RegistryState };
  if (!g[REGISTRY_KEY]) g[REGISTRY_KEY] = { active: {}, revision: null };
  return g[REGISTRY_KEY];
}

/** Mode-transition counter of a product config (0 = never transitioned). */
export function getModeRevision(config: ProductClientVersionConfig | undefined): number {
  return config?.modeRevision ?? 0;
}

/**
 * Hot-swap the registry from a (possibly partial / raw) settings value.
 *
 * Pass the settings `revision` the value was read at. Revisions only move
 * forward: an older revision (an earlier reload finishing after a newer one)
 * is ignored instead of rolling the registry back, and once any revision has
 * been recorded an unversioned update is ignored too, since its age is
 * unknown. Unversioned calls apply only before the first versioned one.
 * Returns whether the value was applied.
 */
export function setClientVersionModes(
  value: unknown,
  options: { revision?: number } = {}
): boolean {
  const state = getState();
  const { revision } = options;
  if (state.revision !== null && (revision === undefined || revision < state.revision)) {
    return false;
  }
  const settings = normalizeClientVersionModes(value);
  const active: RegistryState["active"] = {};
  for (const product of CLIENT_VERSION_PRODUCTS) {
    const version = resolveConfiguredVersion(settings[product]);
    if (version) active[product] = version;
  }
  const antigravityCli = resolveConfiguredCliVersion(settings.antigravity);
  if (antigravityCli) active["antigravity-cli"] = antigravityCli;
  state.active = active;
  if (revision !== undefined) state.revision = revision;
  return true;
}

/** Settings revision of the last versioned registry update (null if none yet). */
export function getClientVersionRegistryRevision(): number | null {
  return getState().revision;
}

/** Synchronous, 0-I/O lookup. Null when the product is off or the registry is uninitialized. */
export function getActiveClientVersion(product: ClientVersionTarget): string | null {
  return getState().active[product] ?? null;
}

export function resetClientVersionRegistry(): void {
  const state = getState();
  state.active = {};
  state.revision = null;
}
