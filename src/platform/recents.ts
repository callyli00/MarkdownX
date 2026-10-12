export interface RecentDocument {
  uri: string;
  name: string;
  /** Epoch ms. Kept on the entry so re-opening promotes it with a fresh timestamp. */
  openedAt: number;
}

/** Mobile has no workspace tree, so this list is the only way back to a document. */
export const RECENTS_LIMIT = 20;

/**
 * Newest-first, de-duplicated, capped. Pure: returns a new array and never mutates the
 * input, so React state updates stay predictable.
 */
export function pushRecent(list: RecentDocument[], entry: RecentDocument): RecentDocument[] {
  const without = list.filter((e) => e.uri !== entry.uri);
  return [entry, ...without].slice(0, RECENTS_LIMIT);
}
