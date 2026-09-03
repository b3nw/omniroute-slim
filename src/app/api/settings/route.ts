import { NextResponse } from "next/server";
import {
  getSettings,
  getSettingsRevision,
  updateSettings,
  SettingsRevisionConflictError,
} from "@/lib/db/settings";
import { getRuntimePorts } from "@/lib/runtime/ports";
import { updateSettingsSchema } from "@/shared/validation/settingsSchemas";
import { isValidationFailure, validateBody } from "@/shared/validation/helpers";
import { getConsistentMachineId } from "@/shared/utils/machineId";
import { isFeatureFlagEnabled } from "@/shared/utils/featureFlags";
import { resolveModelLockoutSettings } from "@/lib/resilience/modelLockoutSettings";
import {
  validateProxyUrl,
  upsertUpstreamProxyConfig,
  getUpstreamProxyConfig,
} from "@/lib/db/upstreamProxy";
import { getProviderConnections } from "@/lib/db/providers";
import { clearCliproxyapiUrlCache } from "@omniroute/open-sse/executors/cliproxyapi.ts";
import {
  ensurePersistentManagementPasswordHash,
  getStoredManagementPassword,
  hasManagementPasswordConfigured,
  hashManagementPassword,
  verifyManagementPassword,
} from "@/lib/auth/managementPassword";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import { isPaidModelTarget } from "@/shared/utils/freeModels";

/**
 * Force this route to run dynamically per-request and never be cached/prerendered.
 * Combined with the `Cache-Control: no-store` response header below, this keeps
 * persisted settings (e.g. dashboard preferences, debugMode, hidden sidebar
 * items) visible immediately after refresh or restart instead of falling back
 * to stale Next.js fetch cache. Ported from upstream decolua/9router#951.
 */
export const dynamic = "force-dynamic";
export const revalidate = 0;

/** Response headers applied to every successful GET/PATCH on /api/settings. */
const SETTINGS_RESPONSE_HEADERS = { "Cache-Control": "no-store" } as const;

function settingsResponseHeaders(settingsRevision: number): Record<string, string> {
  return {
    ...SETTINGS_RESPONSE_HEADERS,
    ETag: String(settingsRevision),
  };
}

/** Parse opt-in CAS token from If-Match (preferred) or PATCH body. */
function parseExpectedRevision(
  request: Request,
  body: Record<string, unknown>
): number | undefined {
  const ifMatch = request.headers.get("If-Match");
  if (ifMatch !== null) {
    const trimmed = ifMatch.replace(/^W\/"/, "").replace(/"$/, "").trim();
    const parsed = Number(trimmed);
    if (Number.isInteger(parsed) && parsed >= 0) return parsed;
  }
  const fromBody = body.expectedRevision;
  if (typeof fromBody === "number" && Number.isInteger(fromBody) && fromBody >= 0) {
    return fromBody;
  }
  return undefined;
}

/**
 * Settings keys whose change broadens attack surface. Spec §Security:
 * password re-auth is required when any of these is present in a PATCH body.
 *
 * - `localOnlyManageScopeBypassEnabled` / `localOnlyManageScopeBypassPrefixes`:
 *   T-011 bypass kill-switch + per-prefix list. Operator must re-confirm
 *   before broadening the LOCAL_ONLY carve-out.
 * - `requireLogin`: dashboard login enforcement toggle.
 * - `newPassword`: password rotation (existing). Handled by the same gate so
 *   the password-verify only fires ONCE per PATCH.
 *
 * Note: `mcpEnabled` is NOT gated server-side — the dedicated MCP page
 * (/dashboard/mcp) toggles it via patchSetting() without a currentPassword
 * prompt. The Authz section can still prompt client-side for consistency,
 * but the server accepts the change without re-auth.
 */
const SECURITY_IMPACTING_KEYS = [
  "localOnlyManageScopeBypassEnabled",
  "localOnlyManageScopeBypassPrefixes",
  "requireLogin",
  "newPassword",
  "oidcEnabled",
  "oidcDisablePasswordLogin",
  "oidcClientSecret",
] as const;

export async function GET(request: Request) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;

  try {
    const settings = await getSettings();
    const settingsRevision = await getSettingsRevision();
    const { password, ...safeSettings } = settings;

    const runtimePorts = getRuntimePorts();
    const cloudUrl = process.env.CLOUD_URL || process.env.NEXT_PUBLIC_CLOUD_URL || null;
    const machineId = await getConsistentMachineId();

    // Include cliproxyapi_model_mapping from upstream_proxy_config table
    let cliproxyapiModelMapping: Record<string, string> | null = null;
    try {
      const proxyConfig = await getUpstreamProxyConfig("cliproxyapi");
      if (proxyConfig?.cliproxyapiModelMapping) {
        cliproxyapiModelMapping = proxyConfig.cliproxyapiModelMapping as Record<string, string>;
      }
    } catch {
      // best effort — don't fail GET /api/settings if this lookup fails
    }

    return NextResponse.json(
      {
        ...safeSettings,
        settingsRevision,
        hasPassword: hasManagementPasswordConfigured(settings),
        runtimePorts,
        apiPort: runtimePorts.apiPort,
        dashboardPort: runtimePorts.dashboardPort,
        cloudConfigured: Boolean(cloudUrl),
        cloudUrl,
        machineId,
        // Sidebar.tsx has no server-side feature-flag access (client component);
        // this piggy-backs the RADAR_ENABLED gate onto the settings payload the
        // sidebar already fetches on mount, so the "radar" item can hide itself
        // without a dedicated round trip. See sidebarVisibility.ts's
        // `isSidebarItemVisibleForFlags()`.
        radarEnabled: isFeatureFlagEnabled("RADAR_ENABLED"),
        radarAdminUrl: null,
        ...(cliproxyapiModelMapping !== null
          ? { cliproxyapi_model_mapping: cliproxyapiModelMapping }
          : {}),
      },
      { headers: settingsResponseHeaders(settingsRevision) }
    );
  } catch (error) {
    console.log("Error getting settings:", error);
    return NextResponse.json({ error: "Failed to load settings" }, { status: 500 });
  }
}

export async function PATCH(request: Request) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;

  let rawBody: Record<string, unknown> = {};
  try {
    rawBody = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json(
      { error: { code: "INVALID_JSON", message: "Request body is not valid JSON" } },
      { status: 400 }
    );
  }
  const expectedRevision = parseExpectedRevision(request, rawBody);

  try {
    // Zod validation
    const validation = validateBody(updateSettingsSchema, rawBody);
    if (isValidationFailure(validation)) {
      return NextResponse.json({ error: validation.error }, { status: 400 });
    }
    const body: typeof validation.data & { password?: string } = { ...validation.data };

    // Sanitize model lockout settings: clamp values to valid bounds.
    if (body.modelLockout) {
      body.modelLockout = resolveModelLockoutSettings({
        modelLockout: body.modelLockout as Record<string, unknown>,
      }) as typeof body.modelLockout;
    }

    if (body.oidcEnabled === true) {
      const current = await getSettings();
      const subjects = Array.isArray(body.oidcAllowedSubjects)
        ? (body.oidcAllowedSubjects as unknown[])
        : ((current.oidcAllowedSubjects as unknown[] | undefined) ?? []);
      const hasAtLeastOne = subjects.some((s) => typeof s === "string" && s.trim().length > 0);
      if (!hasAtLeastOne) {
        return NextResponse.json(
          {
            error: {
              code: "OIDC_ALLOWED_SUBJECTS_REQUIRED",
              message:
                "oidcAllowedSubjects must contain at least one subject or email when oidcEnabled is true",
            },
          },
          { status: 400 }
        );
      }
    }

    // VALIDATED body so we never trip on stray unknown keys. If any security
    // key is present, require currentPassword + verify against the stored
    // bcrypt hash. Dedupes with the previous inline newPassword reauth — the
    // password is verified at most once per PATCH.
    const touchedSecurityKeys = SECURITY_IMPACTING_KEYS.filter((k) => k in validation.data);
    if (touchedSecurityKeys.length > 0) {
      const settings = await getSettings();
      // Lazy-hash any plaintext INITIAL_PASSWORD migration BEFORE we read the
      // stored hash, so the gate works on fresh deploys too.
      const passwordState = await ensurePersistentManagementPasswordHash({
        settings,
        source: "settings.security_impacting_update",
      });
      const storedPasswordHash = getStoredManagementPassword(passwordState.settings);
      // Cold-boot exception: same condition the existing newPassword path
      // honoured before T-011 — when no password is configured yet AND login
      // is currently disabled, allow the first write to set policy (incl.
      // the password itself). Once a hash exists the gate always fires.
      // #8950: also treat the request as cold boot when newPassword is present
      // without a stored hash, so the Security tab's two-step flow (enable
      // requireLogin first, then set password) does not deadlock.
      const isColdBoot =
        !storedPasswordHash &&
        (passwordState.settings.requireLogin === false || Boolean(body.newPassword));
      if (!isColdBoot) {
        if (!body.currentPassword) {
          return NextResponse.json(
            {
              error: {
                code: "PASSWORD_REQUIRED",
                message: "currentPassword required for security-impacting setting changes",
                keys: touchedSecurityKeys,
              },
            },
            { status: 400 }
          );
        }
        const isValid = await verifyManagementPassword(body.currentPassword, storedPasswordHash);
        if (!isValid) {
          return NextResponse.json(
            {
              error: {
                code: "PASSWORD_MISMATCH",
                message: "Invalid current password",
              },
            },
            { status: 401 }
          );
        }
      }
    }

    // #6540: reject a paid-only webSearchRouteModel target when hidePaidModels
    // is on. Business-rule check (needs an async DB read), so it runs after
    // Zod shape validation rather than as a Zod .refine(). Fails open on
    // "unknown" (aliases/combo names) — only a positively-identified paid
    // catalog entry is blocked.
    if (typeof body.webSearchRouteModel === "string" && body.webSearchRouteModel.trim() !== "") {
      const currentSettings = await getSettings();
      if ((currentSettings as Record<string, unknown>)?.hidePaidModels === true) {
        if (isPaidModelTarget(body.webSearchRouteModel) === "paid") {
          return NextResponse.json(
            {
              error: {
                code: "PAID_MODEL_TARGET_BLOCKED",
                message:
                  "This field cannot target a paid-only model while 'Hide paid models' is enabled.",
              },
            },
            { status: 400 }
          );
        }
      }
    }

    // Password rotation: hash the new value AFTER the gate has accepted the
    // currentPassword (or the cold-boot exception fired). The gate already
    // included `newPassword` in SECURITY_IMPACTING_KEYS, so no separate
    // verify happens here — strictly hashing + body rewriting.
    if (body.newPassword) {
      body.password = await hashManagementPassword(body.newPassword);
      delete body.newPassword;
    }
    delete body.currentPassword;
    delete body.expectedRevision;

    let settings: Awaited<ReturnType<typeof getSettings>>;
    try {
      settings = await updateSettings(body, { expectedRevision });
    } catch (error) {
      if (error instanceof SettingsRevisionConflictError) {
        return NextResponse.json(
          {
            error: {
              code: "SETTINGS_REVISION_CONFLICT",
              message: "Settings changed since this snapshot; refresh and retry",
              currentRevision: error.currentRevision,
            },
          },
          { status: 409, headers: settingsResponseHeaders(error.currentRevision) }
        );
      }
      throw error;
    }

    // Sync CLIProxyAPI settings to upstream_proxy_config table
    const cpaUrl = rawBody.cliproxyapi_url as string | undefined;
    const cpaFallback = rawBody.cliproxyapi_fallback_enabled as boolean | undefined;
    if (cpaUrl && typeof cpaUrl === "string") {
      const urlValidation = validateProxyUrl(cpaUrl);
      if (urlValidation.valid === false) {
        return NextResponse.json(
          { error: `Invalid CLIProxyAPI URL: ${urlValidation.error}` },
          { status: 400 }
        );
      }
      // Invalidate the executor's URL cache so it picks up the new URL immediately
      clearCliproxyapiUrlCache();
    }

    const cpaModelMapping = rawBody.cliproxyapi_model_mapping as Record<string, string> | undefined;

    if (cpaFallback !== undefined || cpaUrl !== undefined || cpaModelMapping !== undefined) {
      const enabled =
        cpaFallback ?? (settings as Record<string, unknown>).cliproxyapi_fallback_enabled;
      const mode = enabled ? "fallback" : "native";

      // Get all distinct active provider IDs so each one gets its own
      // upstream_proxy_config row. chatCore reads per-provider config
      // (e.g. getUpstreamProxyConfig("anthropic")), not a single global row.
      // Embedded service IDs are not real routing targets and must be skipped.
      const EMBEDDED_SERVICE_IDS = new Set(["cliproxyapi", "9router"]);
      const activeConnections = await getProviderConnections({ isActive: true });
      const activeProviderIds = [
        ...new Set(
          activeConnections
            .map((c: Record<string, unknown>) => c.provider as string)
            .filter((id: string) => !EMBEDDED_SERVICE_IDS.has(id))
        ),
      ];

      for (const providerId of activeProviderIds) {
        await upsertUpstreamProxyConfig({
          providerId,
          mode,
          enabled: !!enabled,
          ...(cpaModelMapping !== undefined ? { cliproxyapiModelMapping: cpaModelMapping } : {}),
        });
      }

      // Update the "cliproxyapi" sentinel row used by GET /api/settings to
      // retrieve cliproxyapi_model_mapping. This row is NOT used for routing
      // (chatCore reads per-real-provider rows above); it exists solely as
      // storage for the global model-mapping blob.
      await upsertUpstreamProxyConfig({
        providerId: "cliproxyapi",
        mode,
        enabled: !!enabled,
        ...(cpaModelMapping !== undefined ? { cliproxyapiModelMapping: cpaModelMapping } : {}),
      });
    }

    const { password, ...safeSettings } = settings;
    const settingsRevision = await getSettingsRevision();
    return NextResponse.json(
      { ...safeSettings, settingsRevision },
      { headers: settingsResponseHeaders(settingsRevision) }
    );
  } catch (error) {
    console.log("Error updating settings:", error);
    return NextResponse.json({ error: "Failed to update settings" }, { status: 500 });
  }
}

export async function PUT(request: Request) {
  return PATCH(request);
}
