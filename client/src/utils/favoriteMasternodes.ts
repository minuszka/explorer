import { useSyncExternalStore } from 'react';

/**
 * The visitor's starred masternodes ("My nodes"): a list of proTxHashes kept in this browser.
 * Every storage access is guarded: when the browser refuses storage, the stars still work until
 * the page is reloaded and `persistent` is false, so the page can say they will not be kept.
 */
export const FAVORITES_KEY = 'deftrack-fav-masternodes';
export const MAX_FAVORITES = 50;

const PRO_TX = /^[0-9a-f]{64}$/;

interface FavoritesSnapshot {
  list: readonly string[];
  /** False when the list lives only in this tab because the browser storage cannot be used. */
  persistent: boolean;
}

/** Set once storage fails; from then on this tab keeps the list in memory. */
let memory: string[] | null = null;
let snapshot: FavoritesSnapshot | null = null;
const listeners = new Set<() => void>();
let watchingOtherTabs = false;

/** Lower-case proTxHashes, without duplicates, at most MAX_FAVORITES; anything else is dropped. */
function clean(value: unknown): string[] {
  const list: string[] = [];
  if (!Array.isArray(value)) return list;
  for (const item of value) {
    const id = typeof item === 'string' ? item.toLowerCase() : '';
    if (PRO_TX.test(id) && !list.includes(id)) list.push(id);
    if (list.length === MAX_FAVORITES) break;
  }
  return list;
}

function load(): FavoritesSnapshot {
  if (memory) return { list: memory, persistent: false };
  let raw: string | null;
  try {
    raw = window.localStorage.getItem(FAVORITES_KEY);
  } catch {
    memory = [];
    return { list: memory, persistent: false };
  }
  try {
    // A damaged value counts as an empty list; it is replaced on the next change.
    return { list: clean(raw ? JSON.parse(raw) : []), persistent: true };
  } catch {
    return { list: [], persistent: true };
  }
}

function current(): FavoritesSnapshot {
  if (!snapshot) snapshot = load();
  return snapshot;
}

function emit() {
  for (const listener of listeners) listener();
}

function onOtherTab(event: StorageEvent) {
  if (event.key !== null && event.key !== FAVORITES_KEY) return;
  if (memory) return;
  snapshot = null;
  emit();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  if (!watchingOtherTabs) {
    watchingOtherTabs = true;
    window.addEventListener('storage', onOtherTab);
  }
  return () => {
    listeners.delete(listener);
  };
}

export type FavoriteToggle = 'added' | 'removed' | 'full' | 'invalid';

/** Stars or unstars a proTxHash. A full list (MAX_FAVORITES) refuses a new star rather than dropping one. */
export function toggleFavorite(proTxHash: string): FavoriteToggle {
  const id = proTxHash.toLowerCase();
  if (!PRO_TX.test(id)) return 'invalid';
  const { list } = current();
  let next: string[];
  let result: FavoriteToggle;
  if (list.includes(id)) {
    next = list.filter((item) => item !== id);
    result = 'removed';
  } else if (list.length >= MAX_FAVORITES) {
    return 'full';
  } else {
    next = [...list, id];
    result = 'added';
  }
  let persistent = false;
  if (!memory) {
    try {
      window.localStorage.setItem(FAVORITES_KEY, JSON.stringify(next));
      persistent = true;
    } catch {
      persistent = false;
    }
  }
  if (!persistent) memory = next;
  snapshot = { list: next, persistent };
  emit();
  return result;
}

export function useFavoriteMasternodes() {
  const { list, persistent } = useSyncExternalStore(subscribe, current, current);
  return {
    favorites: list,
    persistent,
    isFavorite: (proTxHash: string | null | undefined) => Boolean(proTxHash) && list.includes(proTxHash!.toLowerCase()),
    toggle: toggleFavorite,
  };
}
