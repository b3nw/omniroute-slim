"use client";

import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Badge, Button, Card } from "@/shared/components";
import {
  EMPTY_DRAFTS,
  editDraft,
  setProductBusy,
  syncDraftsWithPersisted,
  type BusyProducts,
  type DraftState,
} from "./clientVersionModesState";

type Mode = "off" | "manual" | "automatic";
type VersionSource = "manual" | "automatic" | "env" | "default";

type ProductStatus = {
  product: string;
  label: string;
  config: {
    mode: Mode;
    manualVersion?: string;
    autoDetectedVersion?: string;
    manualCliVersion?: string;
    autoDetectedCliVersion?: string;
    lastCheckedAt?: string;
    lastCheckError?: string;
  };
  activeVersion: string;
  activeCliVersion?: string;
  source: VersionSource;
  cliSource?: VersionSource;
  envOverrideName: string | null;
  wirePreview: Record<string, string>;
};

const MODES: Mode[] = ["off", "manual", "automatic"];
const VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/;
// Antigravity's CLI (1.x) is versioned apart from its IDE (2.x).
const DUAL_VERSION_PRODUCT = "antigravity";

function readErrorMessage(data: unknown): string | null {
  const error = (data as { error?: unknown } | null)?.error;
  if (typeof error === "string") return error;
  const message = (error as { message?: unknown } | null)?.message;
  return typeof message === "string" ? message : null;
}

export default function ClientVersionModesCard() {
  const t = useTranslations("settings");
  const [products, setProducts] = useState<ProductStatus[]>([]);
  const [draftState, setDraftState] = useState<DraftState>(EMPTY_DRAFTS);
  const [cliDraftState, setCliDraftState] = useState<DraftState>(EMPTY_DRAFTS);
  const drafts = draftState.values;
  const cliDrafts = cliDraftState.values;
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busyProducts, setBusyProducts] = useState<BusyProducts>({});
  const [errors, setErrors] = useState<Record<string, string>>({});

  const applyStatus = useCallback((data: { products?: ProductStatus[] }) => {
    if (!Array.isArray(data?.products)) return;
    const items = data.products;
    setProducts(items);
    // Inputs follow the persisted (server-trimmed) values unless they hold dirty edits.
    setDraftState((prev) =>
      syncDraftsWithPersisted(
        prev,
        Object.fromEntries(items.map((item) => [item.product, item.config.manualVersion ?? ""]))
      )
    );
    setCliDraftState((prev) =>
      syncDraftsWithPersisted(
        prev,
        Object.fromEntries(items.map((item) => [item.product, item.config.manualCliVersion ?? ""]))
      )
    );
  }, []);

  const load = useCallback(
    async (isCancelled: () => boolean = () => false) => {
      setLoading(true);
      setLoadError(null);
      try {
        const res = await fetch("/api/client-versions", { cache: "no-store" });
        const data = await res.json().catch(() => null);
        if (isCancelled()) return;
        if (!res.ok || !Array.isArray(data?.products)) {
          setLoadError(readErrorMessage(data) ?? t("clientVersionsLoadError"));
          return;
        }
        applyStatus(data);
      } catch {
        if (!isCancelled()) setLoadError(t("clientVersionsLoadError"));
      } finally {
        if (!isCancelled()) setLoading(false);
      }
    },
    [applyStatus, t]
  );

  useEffect(() => {
    let cancelled = false;
    void load(() => cancelled);
    return () => {
      cancelled = true;
    };
  }, [load]);

  const send = async (product: string, url: string, method: string, body: unknown) => {
    setBusyProducts((prev) => setProductBusy(prev, product, true));
    setErrors((prev) => ({ ...prev, [product]: "" }));
    try {
      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        setErrors((prev) => ({
          ...prev,
          [product]: readErrorMessage(data) ?? t("clientVersionsSaveError"),
        }));
        return;
      }
      applyStatus(data);
    } catch {
      setErrors((prev) => ({ ...prev, [product]: t("clientVersionsSaveError") }));
    } finally {
      setBusyProducts((prev) => setProductBusy(prev, product, false));
    }
  };

  // Only send the CLI version when the operator typed one (blank keeps the stored value).
  const cliVersionField = (item: ProductStatus) => {
    if (item.product !== DUAL_VERSION_PRODUCT) return {};
    const cliDraft = (cliDrafts[item.product] ?? "").trim();
    return VERSION_PATTERN.test(cliDraft) ? { manualCliVersion: cliDraft } : {};
  };

  const changeMode = (item: ProductStatus, mode: Mode) => {
    if (mode === item.config.mode) return;
    const draft = (drafts[item.product] ?? "").trim();
    if (mode === "manual") {
      // Wait for a valid version before persisting manual mode.
      if (!VERSION_PATTERN.test(draft)) {
        setProducts((prev) =>
          prev.map((p) =>
            p.product === item.product ? { ...p, config: { ...p.config, mode: "manual" } } : p
          )
        );
        return;
      }
      void send(item.product, "/api/client-versions", "PATCH", {
        product: item.product,
        mode,
        manualVersion: draft,
        ...cliVersionField(item),
      });
      return;
    }
    void send(item.product, "/api/client-versions", "PATCH", { product: item.product, mode });
  };

  const saveManual = (item: ProductStatus) => {
    const draft = (drafts[item.product] ?? "").trim();
    const cliDraft = (cliDrafts[item.product] ?? "").trim();
    if (!VERSION_PATTERN.test(draft) || (cliDraft !== "" && !VERSION_PATTERN.test(cliDraft))) {
      setErrors((prev) => ({ ...prev, [item.product]: t("clientVersionsInvalidVersion") }));
      return;
    }
    void send(item.product, "/api/client-versions", "PATCH", {
      product: item.product,
      mode: "manual",
      manualVersion: draft,
      ...(item.product === DUAL_VERSION_PRODUCT ? { manualCliVersion: cliDraft } : {}),
    });
  };

  const modeLabel = (mode: Mode) =>
    mode === "off"
      ? t("clientVersionsModeOff")
      : mode === "manual"
        ? t("clientVersionsModeManual")
        : t("clientVersionsModeAutomatic");

  const sourceLabel = (item: ProductStatus, source: VersionSource = item.source) => {
    switch (source) {
      case "manual":
        return t("clientVersionsSourceManual");
      case "automatic":
        return t("clientVersionsSourceAutomatic");
      case "env":
        return t("clientVersionsSourceEnv", { name: item.envOverrideName ?? "" });
      default:
        return t("clientVersionsSourceDefault");
    }
  };

  return (
    <Card>
      <div className="flex items-center gap-3 mb-4">
        <div className="p-2 rounded-lg bg-primary/10 text-primary">
          <span className="material-symbols-outlined text-[20px]" aria-hidden="true">
            fingerprint
          </span>
        </div>
        <div>
          <h3 className="text-lg font-semibold">{t("clientVersionsTitle")}</h3>
          <p className="text-sm text-text-muted">{t("clientVersionsDesc")}</p>
        </div>
      </div>

      {loading && <p className="text-sm text-text-muted">{t("clientVersionsLoading")}</p>}

      {loadError && !loading && (
        <div
          role="alert"
          className="mb-4 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-sm text-rose-500"
          data-testid="client-versions-load-error"
        >
          <span>{loadError}</span>
          <Button size="sm" variant="secondary" icon="refresh" onClick={() => void load()}>
            {t("clientVersionsRetry")}
          </Button>
        </div>
      )}

      <div className="space-y-4">
        {products.map((item) => {
          const draft = drafts[item.product] ?? "";
          const draftInvalid = draft.trim() !== "" && !VERSION_PATTERN.test(draft.trim());
          const isDual = item.product === DUAL_VERSION_PRODUCT;
          const cliDraft = cliDrafts[item.product] ?? "";
          const cliDraftInvalid = cliDraft.trim() !== "" && !VERSION_PATTERN.test(cliDraft.trim());
          const isBusy = busyProducts[item.product] === true;
          return (
            <div
              key={item.product}
              className="rounded-lg border border-border p-3 space-y-2"
              data-testid={`client-version-row-${item.product}`}
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <span className="font-medium">{item.label}</span>
                  <Badge size="sm">
                    {isDual
                      ? t("clientVersionsIdeVersion", { version: item.activeVersion })
                      : item.activeVersion}
                  </Badge>
                  <span className="text-xs text-text-muted">{sourceLabel(item)}</span>
                  {isDual && item.activeCliVersion && (
                    <>
                      <Badge size="sm">
                        {t("clientVersionsCliVersion", { version: item.activeCliVersion })}
                      </Badge>
                      <span className="text-xs text-text-muted">
                        {sourceLabel(item, item.cliSource ?? "default")}
                      </span>
                    </>
                  )}
                </div>
                <div
                  className="flex items-center rounded-lg border border-border bg-bg-subtle p-0.5"
                  role="radiogroup"
                  aria-label={t("clientVersionsModeLabel", { product: item.label })}
                >
                  {MODES.map((mode) => {
                    const isActive = item.config.mode === mode;
                    return (
                      <label
                        key={mode}
                        className={`inline-flex h-7 items-center rounded-md px-2.5 text-xs font-medium transition-colors ${
                          isActive
                            ? "bg-bg-primary text-text-main shadow-sm"
                            : "text-text-muted hover:bg-bg-primary/70 hover:text-text-main"
                        } ${isBusy || loading ? "cursor-not-allowed opacity-50" : "cursor-pointer"}`}
                      >
                        <input
                          type="radio"
                          name={`client-version-mode-${item.product}`}
                          value={mode}
                          checked={isActive}
                          disabled={isBusy || loading}
                          onChange={() => changeMode(item, mode)}
                          className="sr-only"
                        />
                        {modeLabel(mode)}
                      </label>
                    );
                  })}
                </div>
              </div>

              {item.config.mode === "manual" && (
                <div className="flex flex-wrap items-center gap-2">
                  <input
                    type="text"
                    value={draft}
                    maxLength={32}
                    placeholder={t("clientVersionsManualPlaceholder")}
                    aria-label={t("clientVersionsManualLabel", { product: item.label })}
                    aria-invalid={draftInvalid}
                    onChange={(e) =>
                      setDraftState((prev) => editDraft(prev, item.product, e.target.value))
                    }
                    className={`h-8 w-48 rounded-md border bg-bg-primary px-2 text-sm font-mono ${
                      draftInvalid ? "border-rose-500" : "border-border"
                    }`}
                  />
                  {isDual && (
                    <input
                      type="text"
                      value={cliDraft}
                      maxLength={32}
                      placeholder={t("clientVersionsManualCliPlaceholder")}
                      aria-label={t("clientVersionsManualCliLabel", { product: item.label })}
                      aria-invalid={cliDraftInvalid}
                      onChange={(e) =>
                        setCliDraftState((prev) => editDraft(prev, item.product, e.target.value))
                      }
                      className={`h-8 w-48 rounded-md border bg-bg-primary px-2 text-sm font-mono ${
                        cliDraftInvalid ? "border-rose-500" : "border-border"
                      }`}
                    />
                  )}
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={isBusy || !draft.trim() || draftInvalid || cliDraftInvalid}
                    loading={isBusy}
                    onClick={() => saveManual(item)}
                  >
                    {t("clientVersionsApply")}
                  </Button>
                </div>
              )}

              {item.config.mode === "automatic" && (
                <div className="flex flex-wrap items-center gap-2 text-xs">
                  <span className="text-text-muted">{t("clientVersionsDetected")}</span>
                  <Badge
                    size="sm"
                    variant={item.config.autoDetectedVersion ? "success" : "default"}
                  >
                    {isDual
                      ? t("clientVersionsIdeVersion", {
                          version: item.config.autoDetectedVersion ?? t("clientVersionsPending"),
                        })
                      : (item.config.autoDetectedVersion ?? t("clientVersionsPending"))}
                  </Badge>
                  {isDual && (
                    <Badge
                      size="sm"
                      variant={item.config.autoDetectedCliVersion ? "success" : "default"}
                    >
                      {t("clientVersionsCliVersion", {
                        version: item.config.autoDetectedCliVersion ?? t("clientVersionsPending"),
                      })}
                    </Badge>
                  )}
                  {item.config.lastCheckedAt && (
                    <span className="text-text-muted">
                      {t("clientVersionsLastChecked", {
                        time: new Date(item.config.lastCheckedAt).toLocaleString(),
                      })}
                    </span>
                  )}
                  <Button
                    size="sm"
                    variant="secondary"
                    icon="refresh"
                    disabled={isBusy}
                    loading={isBusy}
                    onClick={() =>
                      void send(item.product, "/api/client-versions/check", "POST", {
                        product: item.product,
                      })
                    }
                  >
                    {t("clientVersionsCheckNow")}
                  </Button>
                  {item.config.lastCheckError && (
                    <span className="text-rose-500">
                      {t("clientVersionsCheckError", { error: item.config.lastCheckError })}
                    </span>
                  )}
                </div>
              )}

              {errors[item.product] && (
                <p className="text-xs text-rose-500">{errors[item.product]}</p>
              )}

              <div className="rounded-md bg-bg-subtle px-2 py-1.5 font-mono text-[11px] text-text-muted space-y-0.5">
                {Object.entries(item.wirePreview).map(([header, value]) => (
                  <div key={header} className="break-all">
                    <span className="text-text-main">{header}:</span> {value}
                  </div>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </Card>
  );
}
