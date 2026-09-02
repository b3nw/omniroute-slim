// @vitest-environment jsdom
//
// #12093 — static `PROVIDER_MODELS` entries that the provider's live sync did NOT
// return must be configurable rows in the provider dashboard: badged apart from
// synced/custom rows, and carrying a working visibility (eye) toggle.
//
// Before this, an operator whose provider had synced a partial catalog had no way
// to suppress a leftover static route from `GET /v1/models` — the static entries
// were indistinguishable from synced built-ins, so there was nothing to act on.
//
// This renders the REAL ModelRow (only the popover is stubbed, it does its own
// network work) over the merged listing `ProviderDetailPageClient` builds, and
// asserts the badge plus the toggle wiring the PATCH handler depends on.

import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../components/ModelCompatPopover", () => ({
  default: () => <div data-testid="compat-popover" />,
}));

import ProviderModelsSection, {
  type ProviderModelsSectionProps,
} from "../components/ProviderModelsSection";
import { mergeProviderModelListing } from "@/lib/providers/mergeProviderModelListing";

const PROVIDER_ID = "command-code";
const DISPLAY_ALIAS = "cmd";
const STATIC_ONLY = "static-only-model";
const SYNCED_STATIC = "static-and-synced-model";
const DISCOVERED = "discovered-only-model";

const t = ((key: string) => key) as ProviderModelsSectionProps["t"];

/** Exactly what ProviderDetailPageClient feeds the section for a partial sync. */
function buildMergedModels() {
  return mergeProviderModelListing({
    providerId: PROVIDER_ID,
    registryModels: [{ id: SYNCED_STATIC }, { id: STATIC_ONLY }],
    syncedModels: [{ id: SYNCED_STATIC }, { id: DISCOVERED }],
    customModels: [],
  });
}

function buildProps(overrides: Partial<ProviderModelsSectionProps>): ProviderModelsSectionProps {
  return {
    providerId: PROVIDER_ID,
    providerAlias: DISPLAY_ALIAS,
    providerStorageAlias: DISPLAY_ALIAS,
    providerDisplayAlias: DISPLAY_ALIAS,
    providerInfo: { name: "Command Code" },
    isCcCompatible: false,
    isAnthropicCompatible: false,
    isAnthropicProtocolCompatible: false,
    isManagedAvailableModelsProvider: false,
    compatibleSupportsModelImport: false,
    allowModelImport: false,
    models: buildMergedModels(),
    modelMeta: { customModels: [], modelCompatOverrides: [] },
    modelAliases: {},
    syncedAvailableModels: [{ id: SYNCED_STATIC }, { id: DISCOVERED }],
    compatibleFallbackModels: [],
    copied: null,
    onCopy: vi.fn(),
    onSetAlias: vi.fn().mockResolvedValue(undefined),
    onDeleteAlias: vi.fn().mockResolvedValue(undefined),
    fetchProviderModelMeta: vi.fn().mockResolvedValue(undefined),
    connections: [],
    selectedConnection: null,
    canImportModels: false,
    importingModels: false,
    handleImportModels: vi.fn().mockResolvedValue(undefined),
    isAutoSyncEnabled: false,
    togglingAutoSync: false,
    handleToggleAutoSync: vi.fn().mockResolvedValue(undefined),
    isAutoFetchModelsEnabled: false,
    togglingAutoFetchModels: false,
    handleToggleAutoFetchModels: vi.fn().mockResolvedValue(undefined),
    handleCompatibleImportWithProgress: vi.fn().mockResolvedValue(undefined),
    compatSavingModelId: null,
    togglingModelId: null,
    bulkVisibilityAction: null,
    clearingModels: false,
    modelFilter: "",
    testingModelId: null,
    modelTestStatus: {},
    onModelTestStatusChange: vi.fn(),
    testingAll: false,
    testProgress: null,
    autoHideFailed: false,
    visibilityFilter: "all",
    providerAliasEntries: [],
    setModelFilter: vi.fn(),
    setAutoHideFailed: vi.fn(),
    setVisibilityFilter: vi.fn(),
    saveModelCompatFlags: vi.fn().mockResolvedValue(undefined),
    handleToggleModelHidden: vi.fn().mockResolvedValue(undefined),
    handleBulkToggleModelHidden: vi.fn().mockResolvedValue(undefined),
    handleClearAllModels: vi.fn().mockResolvedValue(undefined),
    onTestModel: vi.fn().mockResolvedValue(undefined),
    handleTestAll: vi.fn().mockResolvedValue(undefined),
    effectiveModelNormalize: () => false,
    effectiveModelPreserveDeveloper: () => false,
    effectiveModelHidden: () => false,
    getUpstreamHeadersRecordForModel: () => ({}),
    t,
    ...overrides,
  } as ProviderModelsSectionProps;
}

const roots: Array<{ root: ReturnType<typeof createRoot>; el: HTMLDivElement }> = [];

function render(props: ProviderModelsSectionProps) {
  const el = document.createElement("div");
  document.body.appendChild(el);
  const root = createRoot(el);
  act(() => {
    root.render(<ProviderModelsSection {...props} />);
  });
  roots.push({ root, el });
}

/** The rendered row whose `<code>` shows `<alias>/<modelId>`. */
function rowFor(modelId: string): HTMLElement {
  const code = Array.from(document.querySelectorAll("code")).find(
    (node) => node.textContent === `${DISPLAY_ALIAS}/${modelId}`
  );
  expect(code, `expected a rendered row for ${modelId}`).toBeDefined();
  return code!.closest("div.rounded-lg") as HTMLElement;
}

function visibilityButton(row: HTMLElement): HTMLButtonElement {
  const button = Array.from(row.querySelectorAll("button")).find((candidate) =>
    ["visibility", "visibility_off"].includes(candidate.textContent?.trim() ?? "")
  );
  expect(button, "expected a visibility toggle on the row").toBeDefined();
  return button as HTMLButtonElement;
}

beforeEach(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  for (const { root, el } of roots.splice(0)) {
    act(() => root.unmount());
    el.remove();
  }
  vi.clearAllMocks();
});

describe("#12093 static registry model visibility", () => {
  it("renders a row for a static model the live sync did not return", () => {
    render(buildProps({}));

    for (const modelId of [STATIC_ONLY, SYNCED_STATIC, DISCOVERED]) {
      expect(rowFor(modelId)).toBeTruthy();
    }
  });

  it("badges the static-only row apart from synced and built-in rows", () => {
    render(buildProps({}));

    expect(rowFor(STATIC_ONLY).textContent).toContain("Static Registry");
    // A registry entry the sync DID return is an ordinary built-in — no new badge.
    expect(rowFor(SYNCED_STATIC).textContent).toContain("Built-in");
    expect(rowFor(SYNCED_STATIC).textContent).not.toContain("Static Registry");
    expect(rowFor(DISCOVERED).textContent).toContain("Imported");
  });

  it("hides a static-only model through the eye toggle, keyed by the canonical provider id", () => {
    const handleToggleModelHidden = vi.fn().mockResolvedValue(undefined);
    render(buildProps({ handleToggleModelHidden }));

    const toggle = visibilityButton(rowFor(STATIC_ONLY));
    expect(toggle.textContent?.trim()).toBe("visibility");

    act(() => {
      toggle.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    // This is the call that PATCHes /api/provider-models and lands the override in
    // modelCompatOverrides — the only place a static-only model can carry state.
    expect(handleToggleModelHidden).toHaveBeenCalledWith(PROVIDER_ID, STATIC_ONLY, true);
  });

  it("reflects an already-hidden static model and offers to show it again", () => {
    const handleToggleModelHidden = vi.fn().mockResolvedValue(undefined);
    render(
      buildProps({
        effectiveModelHidden: (modelId: string) => modelId === STATIC_ONLY,
        handleToggleModelHidden,
      })
    );

    const row = rowFor(STATIC_ONLY);
    expect(row.className).toContain("opacity-50");

    const toggle = visibilityButton(row);
    expect(toggle.textContent?.trim()).toBe("visibility_off");

    act(() => {
      toggle.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(handleToggleModelHidden).toHaveBeenCalledWith(PROVIDER_ID, STATIC_ONLY, false);
  });

  it("keeps static-only rows under the hidden visibility filter once hidden", () => {
    render(
      buildProps({
        visibilityFilter: "hidden",
        effectiveModelHidden: (modelId: string) => modelId === STATIC_ONLY,
      })
    );

    expect(rowFor(STATIC_ONLY)).toBeTruthy();
    expect(
      Array.from(document.querySelectorAll("code")).map((node) => node.textContent)
    ).not.toContain(`${DISPLAY_ALIAS}/${SYNCED_STATIC}`);
  });

  it("surfaces static registry rows on managed-available-models providers too", () => {
    const handleToggleModelHidden = vi.fn().mockResolvedValue(undefined);
    // OpenRouter and every openai/anthropic-compatible node render through
    // CompatibleModelsSection, whose row sources (synced / custom / fallback) never
    // included the static registry — so a static entry like `openrouter/auto` was
    // advertised by /v1/models with no dashboard row to switch it off.
    render(
      buildProps({
        isManagedAvailableModelsProvider: true,
        handleToggleModelHidden,
      })
    );

    const rendered = Array.from(document.querySelectorAll("code")).map((node) => node.textContent);
    expect(rendered).toContain(`${DISPLAY_ALIAS}/${STATIC_ONLY}`);

    const toggle = visibilityButton(rowFor(STATIC_ONLY));
    act(() => {
      toggle.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(handleToggleModelHidden).toHaveBeenCalledWith(PROVIDER_ID, STATIC_ONLY, true);
  });

  it("finds static-only rows by searching for their origin", () => {
    render(buildProps({ modelFilter: "static registry" }));

    const rendered = Array.from(document.querySelectorAll("code")).map((node) => node.textContent);
    expect(rendered).toContain(`${DISPLAY_ALIAS}/${STATIC_ONLY}`);
    expect(rendered).not.toContain(`${DISPLAY_ALIAS}/${DISCOVERED}`);
  });
});
