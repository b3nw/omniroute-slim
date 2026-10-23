export function normalizeCliCompatProviderId(providerId: string): string {
  const normalized = providerId.toLowerCase();
  if (normalized === "copilot") return "github";
  if (normalized === "gemini_cli") return "gemini-cli";
  return normalized;
}
