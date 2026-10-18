export const ANTIGRAVITY_CLIENT_PROFILE_VALUES = ["app", "cli"] as const;

export type AntigravityClientProfile = (typeof ANTIGRAVITY_CLIENT_PROFILE_VALUES)[number];

/**
 * Antigravity ships several independently versioned client surfaces. Only two still
 * receive current upstream model access:
 *
 * - `app` — the Antigravity App (a.k.a. Hub, `antigravity/hub/<v>`). Primary identity.
 * - `cli` — the Antigravity CLI (`antigravity/cli/<v> (aidev_client; …)`).
 *
 * The legacy Antigravity IDE identity (`antigravity/ide/<v>`) is retired: its
 * `:fetchAvailableModels` response omits current families such as `gemini-4-argon-*` and
 * `gemini-3.8-flash-*`, and generation for them is rejected upstream under that identity.
 * `ide` is deliberately NOT a member of this type, so no switch or UA builder can branch
 * on it. Connections persisted with `clientProfile: "ide"` are accepted at the read
 * boundary and coerced to `app` by `normalizeAntigravityClientProfile`; new writes are
 * validated against ANTIGRAVITY_CLIENT_PROFILE_VALUES and cannot store it again.
 */
export const DEFAULT_ANTIGRAVITY_CLIENT_PROFILE: AntigravityClientProfile = "app";

export type AntigravityClientProfileSetting = AntigravityClientProfile;

export const ANTIGRAVITY_CLIENT_PROFILE_OPTIONS: Array<{
  value: AntigravityClientProfileSetting;
  labelKey: "antigravityClientProfileApp" | "antigravityClientProfileCli";
}> = [
  { value: "app", labelKey: "antigravityClientProfileApp" },
  { value: "cli", labelKey: "antigravityClientProfileCli" },
];

export function normalizeAntigravityClientProfile(value: unknown): AntigravityClientProfile {
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "app" || normalized === "cli") {
      return normalized;
    }
    // The retired IDE identity migrates to the App: same desktop product line, and the
    // App is the surface that still receives the current model catalog.
    if (normalized === "ide") {
      return "app";
    }
    // Read-only compatibility for values persisted before the official CLI profile
    // replaced OmniRoute's synthetic harness/sdk naming. New writes are validated
    // against ANTIGRAVITY_CLIENT_PROFILE_VALUES and cannot reintroduce these aliases.
    if (normalized === "harness" || normalized === "sdk") {
      return "cli";
    }
  }
  return DEFAULT_ANTIGRAVITY_CLIENT_PROFILE;
}

export const normalizeAntigravityClientProfileSetting = normalizeAntigravityClientProfile;
