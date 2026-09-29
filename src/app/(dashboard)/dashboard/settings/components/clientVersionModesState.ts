/**
 * Pure state helpers for ClientVersionModesCard (kept apart so they can be unit
 * tested without a DOM).
 */

/** Per-product busy flags, so concurrent requests on different products stay independent. */
export type BusyProducts = Record<string, boolean>;

export function setProductBusy(prev: BusyProducts, product: string, busy: boolean): BusyProducts {
  if (busy) return { ...prev, [product]: true };
  if (!prev[product]) return prev;
  const next = { ...prev };
  delete next[product];
  return next;
}

/**
 * Input drafts plus the persisted value each draft was last synced from. A
 * draft that still equals that value has no uncommitted edits and follows the
 * server; one that differs is a dirty edit and is left alone.
 */
export type DraftState = {
  values: Record<string, string>;
  persisted: Record<string, string>;
};

export const EMPTY_DRAFTS: DraftState = { values: {}, persisted: {} };

export function editDraft(state: DraftState, product: string, value: string): DraftState {
  return { ...state, values: { ...state.values, [product]: value } };
}

/**
 * Merge freshly persisted values into the drafts. A draft is replaced when it
 * was never initialised, is not dirty, or already matches the persisted value
 * once trimmed (e.g. right after saving " 1.2.3 " the server stores "1.2.3").
 */
export function syncDraftsWithPersisted(
  state: DraftState,
  persisted: Record<string, string>
): DraftState {
  const values = { ...state.values };
  const nextPersisted = { ...state.persisted };
  for (const [product, value] of Object.entries(persisted)) {
    const draft = values[product];
    const clean =
      draft === undefined || draft === state.persisted[product] || draft.trim() === value;
    if (clean) values[product] = value;
    nextPersisted[product] = value;
  }
  return { values, persisted: nextPersisted };
}
