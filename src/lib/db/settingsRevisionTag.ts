/**
 * Settings revision tag: `getSettings()` stamps every result with the
 * `_settingsRevision` it was read at (same SELECT, so the tag and the values
 * are one consistent snapshot). Revision-aware hot-reload sections read it back
 * so a reload without an explicit revision is still ordered against newer ones.
 *
 * Dependency-free leaf module so both the DB layer and the runtime-settings
 * layer can import it without a cycle. The tag is a non-enumerable symbol, so
 * it never leaks into JSON responses, spreads or persisted writes.
 */
const SETTINGS_REVISION_TAG = Symbol.for("omniroute.settingsRevision");

export function tagSettingsRevision<T extends object>(settings: T, revision: number): T {
  Object.defineProperty(settings, SETTINGS_REVISION_TAG, {
    value: revision,
    enumerable: false,
    configurable: true,
  });
  return settings;
}

/** Revision a settings object was read at, or undefined if it carries no tag. */
export function readSettingsRevisionTag(settings: unknown): number | undefined {
  if (!settings || typeof settings !== "object") return undefined;
  const value = (settings as { [SETTINGS_REVISION_TAG]?: unknown })[SETTINGS_REVISION_TAG];
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}
