/**
 * Pure, transport-free helpers that extract a `copilot-m365-web` credential
 * (`access_token=...; chathubPath=...`) directly from a DevTools HAR export,
 * so the "Add connection" / "Edit connection" dialogs can offer a one-click
 * "Import .har file" button instead of the user hand-extracting the token
 * from the WebSocket URL (see `HarImportButton.tsx`).
 *
 * The token rides in the query string of the BizChat ChatHub WebSocket URL
 * (`wss://substrate.office.com/m365Copilot/Chathub/<oid>@<tenant>?...
 * access_token=...`) — the same URL the executor itself connects to (see
 * `open-sse/executors/copilot-m365-connection.ts`). No network calls here;
 * everything operates on the HAR text already in the browser.
 */

import { isTrustedM365ChatHubUrl } from "@omniroute/open-sse/utils/m365Credentials.ts";

/** Legacy BizChat ChatHub WebSocket prefix (one of the trusted ChatHub hosts). */
export const M365_CHATHUB_WS_PREFIX = "wss://substrate.office.com/m365Copilot/Chathub/";

export type M365HarImportResult =
  | { ok: true; apiKey: string; chathubPath: string; expiresAt: number | null }
  | { ok: false; error: string };

interface HarEntryLike {
  request?: { url?: unknown };
}

interface HarLike {
  log?: { entries?: unknown };
}

/** Decode a JWT payload WITHOUT verification — exp is a display hint only. */
function decodeJwtExpiry(token: string): number | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
    const json = JSON.parse(atob(padded)) as { exp?: unknown };
    return typeof json.exp === "number" ? json.exp * 1000 : null;
  } catch {
    return null;
  }
}

/**
 * Extract the `copilot-m365-web` credential from raw HAR file text.
 *
 * Scans every request in `log.entries` for the ChatHub WebSocket URL and
 * uses the LAST match (a HAR may contain several turns of the same session;
 * the most recent one carries the freshest token). Returns a structured
 * error — never throws — so callers can render it directly.
 */
export function extractM365CredentialFromHar(text: string): M365HarImportResult {
  let har: HarLike;
  try {
    har = JSON.parse(text) as HarLike;
  } catch {
    return { ok: false, error: "notJson" };
  }

  const entries = har.log?.entries;
  if (!Array.isArray(entries)) {
    return { ok: false, error: "noEntries" };
  }

  // The last ChatHub request on any trusted host wins (#16327: current captures use
  // substrate.svc.cloud.microsoft / m365.cloud.microsoft, not only substrate.office.com).
  let parsed: URL | null = null;
  for (const entry of entries as HarEntryLike[]) {
    const url = entry?.request?.url;
    if (typeof url !== "string" || !/^wss:\/\//i.test(url)) continue;
    try {
      const candidate = new URL(url);
      if (isTrustedM365ChatHubUrl(candidate)) parsed = candidate;
    } catch {
      // Not a parsable URL — never a ChatHub match.
    }
  }

  if (!parsed) {
    return { ok: false, error: "noChathubUrl" };
  }

  const token = parsed.searchParams.get("access_token");
  let chathubPath: string;
  try {
    chathubPath = decodeURIComponent(parsed.pathname.split("/m365Copilot/Chathub/")[1] || "");
  } catch {
    return { ok: false, error: "unparsableUrl" };
  }

  if (!token || !chathubPath) {
    return { ok: false, error: "missingFields" };
  }

  return {
    ok: true,
    apiKey: `access_token=${token}; chathubPath=${chathubPath}`,
    chathubPath,
    expiresAt: decodeJwtExpiry(token),
  };
}

export type HarImportExpiryTone = "ok" | "warn" | "bad" | "unknown";

export interface HarImportExpiryStatus {
  tone: HarImportExpiryTone;
  minutesRemaining: number | null;
}

/** Classify a decoded token expiry for the inline status hint. */
export function describeHarImportExpiry(
  expiresAt: number | null,
  now: number = Date.now()
): HarImportExpiryStatus {
  if (expiresAt === null) return { tone: "unknown", minutesRemaining: null };
  const minutesRemaining = Math.round((expiresAt - now) / 60000);
  if (minutesRemaining <= 0) return { tone: "bad", minutesRemaining };
  if (minutesRemaining < 15) return { tone: "warn", minutesRemaining };
  return { tone: "ok", minutesRemaining };
}
