/**
 * Browser-safe M365 Copilot ChatHub trust check shared by HAR import, validation
 * and execution, so the three entry points cannot drift apart (#16327).
 */

export const M365_CHATHUB_PATH = "/m365Copilot/Chathub/";

// Current web endpoint (m365.cloud.microsoft, incl. regional subdomains), the two
// legacy hosts, and the exact Microsoft substrate ChatHub host. The substrate.svc
// host is matched exactly: no subdomains and no sibling *.svc.cloud.microsoft hosts.
const TRUSTED_HOST =
  /^(?:(?:[a-z0-9-]+\.)*(?:m365\.cloud\.microsoft|copilot\.microsoft\.com|substrate\.office\.com)|substrate\.svc\.cloud\.microsoft)$/i;

export function isTrustedM365ChatHubHost(hostname: string): boolean {
  return TRUSTED_HOST.test(hostname);
}

/**
 * Whether a parsed URL is a trusted ChatHub WebSocket endpoint: `wss:` on a trusted
 * host and default port, without userinfo, on the ChatHub path. Never infer a
 * destination from an arbitrary pasted URL or HAR entry.
 */
export function isTrustedM365ChatHubUrl(url: URL): boolean {
  return (
    url.protocol === "wss:" &&
    isTrustedM365ChatHubHost(url.hostname) &&
    !url.port &&
    !url.username &&
    !url.password &&
    url.pathname.startsWith(M365_CHATHUB_PATH)
  );
}
