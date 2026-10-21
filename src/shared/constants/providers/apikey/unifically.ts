/**
 * APIKEY provider catalog — Unifically gateway.
 * Pure data; merged by apikey/index.ts via spread.
 */
export const APIKEY_PROVIDERS_UNIFICALLY = {
  unifically: {
    id: "unifically",
    alias: "unifically",
    name: "Unifically",
    icon: "hub",
    color: "#2563EB",
    textIcon: "UF",
    website: "https://unifically.com",
    apiHint: "Create an API key at https://unifically.com, then paste it here as a Bearer token.",
    passthroughModels: true,
  },
};
