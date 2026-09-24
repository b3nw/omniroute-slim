"use client";

/**
 * Web-only stubs for the former Electron desktop shell.
 *
 * The Electron main/preload processes were excised, so `window.electronAPI`
 * never exists at runtime. These hooks keep the historical call sites
 * compiling while collapsing to constants — no IPC listeners, no state, no
 * re-renders, and nothing to clean up.
 */

/** Always `false`: the desktop shell no longer ships. */
export function useIsElectron(): boolean {
  return false;
}

/** No desktop app metadata is available in the web build. */
export function useElectronAppInfo(): { appInfo: null; loading: false; error: null } {
  return { appInfo: null, loading: false, error: null };
}

/** Opens a URL in a new browser tab; no-op during SSR. */
export function useOpenExternal(): (url: string) => void {
  return (url: string) => {
    if (typeof window !== "undefined") window.open(url, "_blank", "noopener,noreferrer");
  };
}

/** The data directory is a server-side concept in the web build. */
export function useDataDir(): { dataDir: null; loading: false; error: null } {
  return { dataDir: null, loading: false, error: null };
}

/** Always `"web"`: there is no native platform to report. */
export function usePlatform(): string {
  return "web";
}
