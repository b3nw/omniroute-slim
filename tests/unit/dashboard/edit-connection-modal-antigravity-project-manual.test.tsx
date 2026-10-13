// @vitest-environment jsdom
//
// Regression guard for the review on #10424: EditConnectionModal set
// providerSpecificData.isProjectIdManual right after the project-id field,
// but the OAuth connection path (Antigravity is always OAuth) rebuilt
// providerSpecificData from connection.providerSpecificData before the save
// request went out, discarding the flag. tokenRefresh.ts guards auto-discovery
// with `!credentials.providerSpecificData?.isProjectIdManual`, so without this
// fix a manually-entered GCP Project ID was silently overwritten on the next
// token refresh.
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}));

vi.mock("@/store/notificationStore", () => ({
  useNotificationStore: () => ({ notify: vi.fn() }),
}));

vi.mock("@/store/emailPrivacyStore", () => ({
  default: () => ({ hidden: false, toggle: vi.fn() }),
}));

const { default: EditConnectionModal } =
  await import("../../../src/app/(dashboard)/dashboard/providers/[id]/components/modals/EditConnectionModal.tsx");

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.clearAllMocks();
});

function renderModal(connection: Record<string, unknown>, onSave = vi.fn()) {
  act(() => {
    root.render(
      <EditConnectionModal
        isOpen={true}
        connection={connection}
        providerId={connection.provider as string}
        onSave={onSave}
        onClose={vi.fn()}
      />
    );
  });
}

function findProjectIdInput(): HTMLInputElement | null {
  return container.querySelector('input[placeholder="antigravityProjectIdPlaceholder"]');
}

function clickSave() {
  const button = Array.from(container.querySelectorAll("button")).find(
    (b) => b.textContent === "save"
  );
  expect(button).toBeTruthy();
  button!.click();
}

describe("EditConnectionModal — antigravity isProjectIdManual persistence (#10424 review)", () => {
  it("persists isProjectIdManual=true on save when a GCP Project ID is entered manually", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    renderModal(
      {
        id: "conn-ag-1",
        provider: "antigravity",
        authType: "oauth",
        name: "Antigravity account",
        providerSpecificData: {},
      },
      onSave
    );

    const input = findProjectIdInput();
    expect(input).not.toBeNull();
    // React controlled input: use the native setter so the value change is
    // seen by the onChange handler, then dispatch an input event.
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value"
    )!.set!;
    await act(async () => {
      setter.call(input, "gcp-proj-10424");
      input!.dispatchEvent(new Event("input", { bubbles: true }));
    });

    await act(async () => {
      clickSave();
    });

    expect(onSave).toHaveBeenCalledTimes(1);
    const updates = onSave.mock.calls[0][0] as {
      providerSpecificData: Record<string, unknown>;
    };
    expect(updates.providerSpecificData?.isProjectIdManual).toBe(true);
  });

  it("persists isProjectIdManual=false when the project id field is left empty", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    renderModal(
      {
        id: "conn-ag-2",
        provider: "antigravity",
        authType: "oauth",
        name: "Antigravity account 2",
        providerSpecificData: {},
      },
      onSave
    );

    await act(async () => {
      clickSave();
    });

    expect(onSave).toHaveBeenCalledTimes(1);
    const updates = onSave.mock.calls[0][0] as {
      providerSpecificData: Record<string, unknown>;
    };
    expect(updates.providerSpecificData?.isProjectIdManual).toBe(false);
  });
});

describe("EditConnectionModal — gemini-cli manual GCP Project ID", () => {
  for (const provider of ["gemini-cli", "gemini_cli"]) {
    it(`${provider}: renders the project id field without the Antigravity client profile`, () => {
      renderModal({
        id: `conn-${provider}-render`,
        provider,
        authType: "oauth",
        name: "Gemini CLI account",
        providerSpecificData: {},
      });
      expect(findProjectIdInput()).not.toBeNull();
      expect(container.textContent).not.toContain("antigravityClientProfileLabel");
    });

    it(`${provider}: persists projectId and isProjectIdManual=true on save`, async () => {
      const onSave = vi.fn().mockResolvedValue(undefined);
      renderModal(
        {
          id: `conn-${provider}-save`,
          provider,
          authType: "oauth",
          name: "Gemini CLI account",
          projectId: "credit-exp-aipro",
          providerSpecificData: { projectId: "credit-exp-aipro", tier: "free-tier" },
        },
        onSave
      );

      const input = findProjectIdInput();
      expect(input).not.toBeNull();
      expect(input!.value).toBe("credit-exp-aipro");
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        "value"
      )!.set!;
      await act(async () => {
        setter.call(input, "  my-code-assist-proj  ");
        input!.dispatchEvent(new Event("input", { bubbles: true }));
      });

      await act(async () => {
        clickSave();
      });

      expect(onSave).toHaveBeenCalledTimes(1);
      const updates = onSave.mock.calls[0][0] as {
        projectId: string | null;
        providerSpecificData: Record<string, unknown>;
      };
      expect(updates.projectId).toBe("my-code-assist-proj");
      expect(updates.providerSpecificData?.projectId).toBe("my-code-assist-proj");
      expect(updates.providerSpecificData?.isProjectIdManual).toBe(true);
      expect(updates.providerSpecificData?.tier).toBe("free-tier");
      expect(updates.providerSpecificData?.clientProfile).toBeUndefined();
    });
  }
});

function findGeminiCliTierSelect(): HTMLSelectElement | null {
  return (
    Array.from(container.querySelectorAll("select")).find((select) =>
      Array.from(select.options).some((option) => option.textContent === "geminiCliTierAuto")
    ) ?? null
  );
}

async function chooseOption(select: HTMLSelectElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, "value")!.set!;
  await act(async () => {
    setter.call(select, value);
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

describe("EditConnectionModal — gemini-cli tier selector", () => {
  for (const provider of ["gemini-cli", "gemini_cli"]) {
    it(`${provider}: pins the selected tier on save`, async () => {
      const onSave = vi.fn().mockResolvedValue(undefined);
      renderModal(
        {
          id: `conn-${provider}-tier`,
          provider,
          authType: "oauth",
          name: "Gemini CLI account",
          projectId: "my-proj",
          providerSpecificData: {
            projectId: "my-proj",
            tier: "free-tier",
            tierCanonical: "FREE",
            tier_full: "FREE",
          },
        },
        onSave
      );

      const select = findGeminiCliTierSelect();
      expect(select).not.toBeNull();
      expect(select!.value).toBe("auto");
      // The shared Select prepends a disabled placeholder option.
      const choices = Array.from(select!.options).filter((o) => !o.disabled);
      expect(choices.map((o) => o.value)).toEqual(["auto", "FREE", "PRO", "ULTRA"]);

      await chooseOption(select!, "PRO");
      await act(async () => {
        clickSave();
      });

      expect(onSave).toHaveBeenCalledTimes(1);
      const psd = onSave.mock.calls[0][0].providerSpecificData as Record<string, unknown>;
      expect(psd.tier).toBe("standard-tier");
      expect(psd.tierCanonical).toBe("PRO");
      expect(psd.tier_full).toBe("PRO");
      expect(psd.isTierManual).toBe(true);
      expect(psd.projectId).toBe("my-proj");
    });
  }

  it("shows a pinned tier and clears the manual flag when switched back to auto", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    renderModal(
      {
        id: "conn-gemini-tier-auto",
        provider: "gemini-cli",
        authType: "oauth",
        name: "Gemini CLI account",
        projectId: "my-proj",
        providerSpecificData: {
          projectId: "my-proj",
          tier: "enterprise-tier",
          tierCanonical: "ULTRA",
          tier_full: "ULTRA",
          isTierManual: true,
        },
      },
      onSave
    );

    const select = findGeminiCliTierSelect();
    expect(select!.value).toBe("ULTRA");

    await chooseOption(select!, "auto");
    await act(async () => {
      clickSave();
    });

    const psd = onSave.mock.calls[0][0].providerSpecificData as Record<string, unknown>;
    expect(psd.isTierManual).toBe(false);
    // "auto" keeps the stored fields; the PUT route re-probes them.
    expect(psd.tierCanonical).toBe("ULTRA");
  });

  it("is not rendered for Antigravity", () => {
    renderModal({
      id: "conn-ag-tier",
      provider: "antigravity",
      authType: "oauth",
      name: "Antigravity account",
      providerSpecificData: {},
    });
    expect(findGeminiCliTierSelect()).toBeNull();
  });
});
