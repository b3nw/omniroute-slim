import type { SidebarItemDefinition, SidebarItemGroup, SidebarSectionDefinition } from "./types";

// ─── Item arrays ────────────────────────────────────────────────────────────

const HOME_ITEMS: readonly SidebarItemDefinition[] = [
  {
    id: "home",
    href: "/home",
    i18nKey: "home",
    subtitleKey: "homeSubtitle",
    icon: "home",
    exact: true,
  },
];

const OMNI_PROXY_ITEMS: readonly SidebarItemDefinition[] = [
  {
    id: "api-manager",
    href: "/dashboard/api-manager",
    i18nKey: "apiManager",
    subtitleKey: "apiManagerSubtitle",
    icon: "vpn_key",
  },
  {
    id: "providers",
    href: "/dashboard/providers",
    i18nKey: "providers",
    subtitleKey: "providersSubtitle",
    icon: "dns",
  },
  {
    id: "embedded-services",
    href: "/dashboard/providers/services",
    i18nKey: "embeddedServices",
    subtitleKey: "embeddedServicesSubtitle",
    icon: "deployed_code",
  },
  {
    id: "combos",
    href: "/dashboard/combos",
    i18nKey: "combos",
    subtitleKey: "combosSubtitle",
    icon: "layers",
  },
  {
    id: "combos-live",
    href: "/dashboard/combos/live",
    i18nKey: "combosLive",
    labelFallback: "Combo Studio",
    subtitleKey: "combosLiveSubtitle",
    subtitleFallback: "Live routing cascade",
    icon: "account_tree",
  },
  {
    id: "quota",
    href: "/dashboard/quota",
    i18nKey: "providerQuota",
    subtitleKey: "providerQuotaSubtitle",
    icon: "tune",
  },
  {
    id: "costs-quota-share",
    href: "/dashboard/costs/quota-share",
    i18nKey: "costsQuotaShare",
    subtitleKey: "costsQuotaShareSubtitle",
    icon: "pie_chart",
  },
];

export const COMPRESSION_CONTEXT_GROUP: SidebarItemGroup = {
  type: "group",
  id: "compression-context",
  titleKey: "compressionContextGroup",
  titleFallback: "Compression Context",
  // Order: Settings (the unified panel) → Combos → per-engine pages → Studio (analytics).
  items: [
    {
      id: "context-settings",
      href: "/dashboard/context/settings",
      i18nKey: "contextSettings",
      labelFallback: "Compression Settings",
      subtitleKey: "contextSettingsSubtitle",
      subtitleFallback: "Global defaults",
      icon: "settings",
    },
    {
      id: "context-combos",
      href: "/dashboard/context/combos",
      i18nKey: "contextCombos",
      subtitleKey: "contextCombosSubtitle",
      icon: "hub",
    },
    {
      id: "context-caveman",
      href: "/dashboard/context/caveman",
      i18nKey: "contextCaveman",
      subtitleKey: "contextCavemanSubtitle",
      icon: "compress",
    },
    {
      id: "context-rtk",
      href: "/dashboard/context/rtk",
      i18nKey: "contextRtk",
      subtitleKey: "contextRtkSubtitle",
      icon: "filter_alt",
    },
    {
      id: "context-headroom",
      href: "/dashboard/context/headroom",
      i18nKey: "contextHeadroom",
      labelFallback: "Headroom",
      subtitleKey: "contextHeadroomSubtitle",
      subtitleFallback: "Tabular compaction",
      icon: "table_rows",
    },
    {
      id: "context-session-dedup",
      href: "/dashboard/context/session-dedup",
      i18nKey: "contextSessionDedup",
      labelFallback: "Session Dedup",
      subtitleKey: "contextSessionDedupSubtitle",
      subtitleFallback: "Cross-turn dedup",
      icon: "content_copy",
    },
    {
      id: "context-ccr",
      href: "/dashboard/context/ccr",
      i18nKey: "contextCcr",
      labelFallback: "CCR",
      subtitleKey: "contextCcrSubtitle",
      subtitleFallback: "Retrieve markers",
      icon: "archive",
    },
    {
      id: "context-llmlingua",
      href: "/dashboard/context/llmlingua",
      i18nKey: "contextLlmlingua",
      labelFallback: "LLMLingua",
      subtitleKey: "contextLlmlinguaSubtitle",
      subtitleFallback: "Semantic pruning",
      icon: "psychology",
    },
    {
      id: "context-lite",
      href: "/dashboard/context/lite",
      i18nKey: "contextLite",
      labelFallback: "Lite",
      subtitleKey: "contextLiteSubtitle",
      subtitleFallback: "Fast whitespace cleanup",
      icon: "compress",
    },
    {
      id: "context-aggressive",
      href: "/dashboard/context/aggressive",
      i18nKey: "contextAggressive",
      labelFallback: "Aggressive",
      subtitleKey: "contextAggressiveSubtitle",
      subtitleFallback: "Summary + aging",
      icon: "speed",
    },
    {
      id: "context-ultra",
      href: "/dashboard/context/ultra",
      i18nKey: "contextUltra",
      labelFallback: "Ultra",
      subtitleKey: "contextUltraSubtitle",
      subtitleFallback: "Heuristic pruning",
      icon: "bolt",
    },
    {
      id: "context-omniglyph",
      href: "/dashboard/context/omniglyph",
      i18nKey: "contextOmniglyph",
      labelFallback: "OmniGlyph",
      subtitleKey: "contextOmniglyphSubtitle",
      subtitleFallback: "Context-as-image",
      icon: "grain",
    },
    {
      id: "compression-studio",
      href: "/dashboard/compression/studio",
      i18nKey: "compressionStudio",
      labelFallback: "Compression Studio",
      subtitleKey: "compressionStudioSubtitle",
      subtitleFallback: "Live engine cascade",
      icon: "monitoring",
    },
    {
      id: "compression-exclusions",
      href: "/dashboard/compression/exclusions",
      i18nKey: "compressionExclusions",
      labelFallback: "Exclusions",
      subtitleKey: "compressionExclusionsSubtitle",
      subtitleFallback: "Per-model/endpoint bypass",
      icon: "block",
    },
  ],
};

const TOOLS_GROUP: SidebarItemGroup = {
  type: "group",
  id: "tools",
  titleKey: "toolsGroup",
  titleFallback: "Tools",
  items: [
    {
      id: "discovery",
      href: "/dashboard/discovery",
      i18nKey: "discovery",
      subtitleKey: "discoverySubtitle",
      icon: "travel_explore",
    },
  ],
};

const INTEGRATIONS_GROUP: SidebarItemGroup = {
  type: "group",
  id: "integrations",
  titleKey: "integrationsGroup",
  titleFallback: "Integrations",
  items: [
    {
      id: "api-endpoints",
      href: "/dashboard/api-endpoints",
      i18nKey: "apiEndpoints",
      subtitleKey: "apiEndpointsSubtitle",
      icon: "api",
    },
  ],
};

const PROXY_ITEM: SidebarItemDefinition = {
  id: "proxy",
  href: "/dashboard/system/proxy",
  i18nKey: "proxy",
  subtitleKey: "proxySubtitle",
  icon: "dns",
};

const ANALYTICS_ITEMS: readonly SidebarItemDefinition[] = [
  {
    id: "analytics",
    href: "/dashboard/analytics",
    i18nKey: "usage",
    subtitleKey: "usageSubtitle",
    icon: "analytics",
  },
  {
    id: "analytics-combo-health",
    href: "/dashboard/analytics/combo-health",
    i18nKey: "analyticsComboHealth",
    subtitleKey: "analyticsComboHealthSubtitle",
    icon: "monitor_heart",
  },
  {
    id: "analytics-utilization",
    href: "/dashboard/analytics/utilization",
    i18nKey: "analyticsUtilization",
    subtitleKey: "analyticsUtilizationSubtitle",
    icon: "bar_chart",
  },
  {
    id: "cache",
    href: "/dashboard/cache",
    i18nKey: "cache",
    subtitleKey: "cacheSubtitle",
    icon: "cached",
  },
  {
    id: "analytics-compression",
    href: "/dashboard/analytics/compression",
    i18nKey: "analyticsCompression",
    subtitleKey: "analyticsCompressionSubtitle",
    icon: "compress",
  },
  {
    id: "analytics-search",
    href: "/dashboard/analytics/search",
    i18nKey: "analyticsSearch",
    subtitleKey: "analyticsSearchSubtitle",
    icon: "manage_search",
  },
  {
    id: "provider-stats",
    href: "/dashboard/provider-stats",
    i18nKey: "providerStats",
    subtitleKey: "providerStatsSubtitle",
    icon: "speed",
  },
];

const LOGS_GROUP: SidebarItemGroup = {
  type: "group",
  id: "logs",
  titleKey: "logsGroup",
  titleFallback: "Logs",
  items: [
    {
      id: "logs",
      href: "/dashboard/logs",
      i18nKey: "logs",
      subtitleKey: "logsSubtitle",
      icon: "description",
    },
    {
      id: "logs-proxy",
      href: "/dashboard/logs/proxy",
      i18nKey: "logsProxy",
      subtitleKey: "logsProxySubtitle",
      icon: "lan",
    },
    {
      id: "logs-console",
      href: "/dashboard/logs/console",
      i18nKey: "consoleLogs",
      subtitleKey: "consoleLogsSubtitle",
      icon: "terminal",
    },
    {
      id: "logs-timeline",
      href: "/dashboard/logs/timeline",
      i18nKey: "logsTimeline",
      subtitleKey: "logsTimelineSubtitle",
      icon: "view_timeline",
    },
    {
      id: "conversations",
      href: "/dashboard/conversations",
      i18nKey: "conversations",
      subtitleKey: "conversationsSubtitle",
      icon: "forum",
    },
  ],
};

const SYSTEM_GROUP: SidebarItemGroup = {
  type: "group",
  id: "system",
  titleKey: "systemGroup",
  titleFallback: "System",
  items: [
    {
      id: "health",
      href: "/dashboard/health",
      i18nKey: "health",
      subtitleKey: "healthSubtitle",
      icon: "health_and_safety",
    },
    {
      id: "runtime",
      href: "/dashboard/runtime",
      i18nKey: "runtime",
      subtitleKey: "runtimeSubtitle",
      icon: "bolt",
    },
    {
      id: "resilience-connections",
      href: "/dashboard/resilience/connections",
      i18nKey: "resilienceConnections",
      subtitleKey: "resilienceConnectionsSubtitle",
      icon: "shield",
    },
  ],
};

const COSTS_ITEMS: readonly SidebarItemDefinition[] = [
  {
    id: "costs",
    href: "/dashboard/costs",
    i18nKey: "costsOverview",
    subtitleKey: "costsOverviewSubtitle",
    icon: "account_balance_wallet",
  },
  {
    id: "costs-pricing",
    href: "/dashboard/costs/pricing",
    i18nKey: "costsPricing",
    subtitleKey: "costsPricingSubtitle",
    icon: "price_change",
  },
  {
    id: "costs-budget",
    href: "/dashboard/costs/budget",
    i18nKey: "costsBudget",
    subtitleKey: "costsBudgetSubtitle",
    icon: "savings",
  },
  {
    id: "costs-free-tiers",
    href: "/dashboard/free-tiers",
    i18nKey: "costsFreeTiers",
    subtitleKey: "costsFreeTiersSubtitle",
    icon: "request_quote",
  },
  {
    id: "free-provider-rankings",
    href: "/dashboard/free-provider-rankings",
    i18nKey: "freeProviderRankings",
    subtitleKey: "freeProviderRankingsSubtitle",
    icon: "leaderboard",
  },
];

const DEVTOOLS_ITEMS: readonly SidebarItemDefinition[] = [
  {
    id: "translator",
    href: "/dashboard/translator",
    i18nKey: "translator",
    subtitleKey: "translatorSubtitle",
    icon: "translate",
  },
];

const CONFIGURATION_ITEMS: readonly SidebarItemDefinition[] = [
  {
    id: "settings-general",
    href: "/dashboard/settings/general",
    i18nKey: "settingsGeneral",
    subtitleKey: "settingsGeneralSubtitle",
    icon: "tune",
  },
  {
    id: "settings-appearance",
    href: "/dashboard/settings/appearance",
    i18nKey: "settingsAppearance",
    subtitleKey: "settingsAppearanceSubtitle",
    icon: "palette",
  },
  {
    id: "settings-ai",
    href: "/dashboard/settings/ai",
    i18nKey: "settingsAi",
    subtitleKey: "settingsAiSubtitle",
    icon: "auto_awesome",
  },
  {
    id: "settings-routing",
    href: "/dashboard/settings/routing",
    i18nKey: "globalRouting",
    subtitleKey: "globalRoutingSubtitle",
    icon: "route",
  },
  {
    id: "settings-resilience",
    href: "/dashboard/settings/resilience",
    i18nKey: "settingsResilience",
    subtitleKey: "settingsResilienceSubtitle",
    icon: "health_and_safety",
  },
  {
    id: "settings-advanced",
    href: "/dashboard/settings/advanced",
    i18nKey: "settingsAdvanced",
    subtitleKey: "settingsAdvancedSubtitle",
    icon: "engineering",
  },
  {
    id: "settings-security",
    href: "/dashboard/settings/security",
    i18nKey: "settingsSecurity",
    subtitleKey: "settingsSecuritySubtitle",
    icon: "shield",
  },
  {
    id: "settings-access-tokens",
    href: "/dashboard/settings/access-tokens",
    i18nKey: "settingsAccessTokens",
    labelFallback: "Access Tokens",
    subtitleKey: "settingsAccessTokensSubtitle",
    icon: "key",
  },
  {
    id: "settings-feature-flags",
    href: "/dashboard/settings/feature-flags",
    i18nKey: "settingsFeatureFlags",
    subtitleKey: "settingsFeatureFlagsSubtitle",
    icon: "flag",
  },
  {
    id: "settings-cache",
    href: "/dashboard/settings/cache",
    i18nKey: "settingsCache",
    subtitleKey: "settingsCacheSubtitle",
    icon: "memory",
  },
  {
    id: "settings-sidebar",
    href: "/dashboard/settings/sidebar",
    i18nKey: "settingsSidebar",
    subtitleKey: "settingsSidebarSubtitle",
    icon: "view_sidebar",
  },
];

const HELP_ITEMS: readonly SidebarItemDefinition[] = [
  {
    id: "docs",
    href: "/docs",
    i18nKey: "docs",
    subtitleKey: "docsSubtitle",
    icon: "menu_book",
    external: true,
  },
  {
    id: "issues",
    href: "https://github.com/diegosouzapw/OmniRoute/issues",
    i18nKey: "issues",
    subtitleKey: "issuesSubtitle",
    icon: "bug_report",
    external: true,
  },
];

// ─── Sections ────────────────────────────────────────────────────────────────

export const SIDEBAR_SECTIONS: readonly SidebarSectionDefinition[] = [
  {
    id: "home",
    titleKey: "home",
    titleFallback: "Home",
    children: HOME_ITEMS,
    showTitle: false,
  },
  {
    id: "omni-proxy",
    titleKey: "omniProxySection",
    titleFallback: "OmniProxy",
    children: [
      ...OMNI_PROXY_ITEMS,
      COMPRESSION_CONTEXT_GROUP,
      TOOLS_GROUP,
      INTEGRATIONS_GROUP,
      PROXY_ITEM,
    ],
  },
  {
    id: "analytics",
    titleKey: "analyticsSection",
    titleFallback: "Analytics",
    children: ANALYTICS_ITEMS,
  },
  {
    id: "costs",
    titleKey: "costsSection",
    titleFallback: "Costs",
    children: COSTS_ITEMS,
  },
  {
    id: "monitoring",
    titleKey: "monitoringSection",
    titleFallback: "Monitoring",
    children: [LOGS_GROUP, SYSTEM_GROUP],
  },
  {
    id: "devtools",
    titleKey: "devtoolsSection",
    titleFallback: "Dev Tools",
    children: DEVTOOLS_ITEMS,
    visibility: "debug",
  },
  {
    id: "configuration",
    titleKey: "configurationSection",
    titleFallback: "Configuration",
    children: CONFIGURATION_ITEMS,
  },
  {
    id: "help",
    titleKey: "helpSection",
    titleFallback: "Help",
    children: HELP_ITEMS,
  },
] as const;
