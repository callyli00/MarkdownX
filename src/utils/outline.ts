/**
 * Document outline (TOC) extraction and collapse filtering.
 *
 * Both functions are pure so the two defects they were created for stay testable:
 *
 * 1. Line endings. The extraction must see LF-normalised lines even when the document on disk
 *    is CRLF. `content.split('\n')` leaves a trailing '\r' on every line, and in JavaScript
 *    '.' does not match '\r' while '$' (without the 'm' flag) only matches at the very end of
 *    the string - so `/^(#{1,6})\s+(.+)$/` could never match a heading in a CRLF document.
 *    Measured on a merged book: 0 headings extracted from the CRLF bytes, 395 from the same
 *    text after LF normalisation; the outline panel showed "当前文档暂无标题".
 *
 * 2. Collapse identity. Collapse state used to be keyed by line number and was never reset
 *    between documents. A stale entry that happened to land on a top-level heading hid that
 *    heading's whole subtree - and in a book whose first heading sits at line 2 with everything
 *    else one level deeper, that reduced the outline to a single row. Items now carry a
 *    position-independent `key` (level + title + occurrence), and the caller namespaces it per
 *    document.
 */

export interface OutlineItem {
  level: number;
  title: string;
  /** 0-based line index in the document; matches the LF textarea's line numbering. */
  line: number;
  slug: string;
  /** Collapse-state identity: stable when lines are inserted above the heading. */
  key: string;
}

export type OutlineRow = OutlineItem & { hasChild: boolean; collapsed: boolean };

/** Split into lines without leaving a carriage return on any of them. */
function splitLines(content: string): string[] {
  return content.split(/\r?\n/);
}

/**
 * Headings of `content`, in document order. Headings inside ``` fenced code are skipped.
 * Line numbers are identical for LF and CRLF input, so they can index the LF textarea.
 */
export function extractOutline(content: string): OutlineItem[] {
  if (!content) return [];
  const items: OutlineItem[] = [];
  const occurrences = new Map<string, number>();
  let inCode = false;
  const lines = splitLines(content);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim().startsWith('```')) {
      inCode = !inCode;
      continue;
    }
    if (inCode) continue;
    const m = line.match(/^(#{1,6})\s+(.+)$/);
    if (!m) continue;
    const level = m[1].length;
    const title = m[2].trim().replace(/[*_`#]/g, '');
    const slug = encodeURIComponent(title.toLowerCase().replace(/\s+/g, '-'));
    const base = `${level}:${title}`;
    const occurrence = occurrences.get(base) ?? 0;
    occurrences.set(base, occurrence + 1);
    items.push({ level, title, line: i, slug, key: `${base}#${occurrence}` });
  }
  return items;
}

/**
 * Outline rows with the subtree of every collapsed heading removed.
 *
 * `hasChild` is computed from the full list, so a node's caret does not depend on its own
 * collapsed state. `collapsed` holds namespaced keys (`<fileId>::<item.key>`); keys that name
 * nothing in this document - a leftover from another file - simply never match.
 */
export function visibleOutlineRows(items: OutlineItem[], collapsed: Set<string>): OutlineRow[] {
  const rows: OutlineRow[] = [];
  let hideDeeperThan: number | null = null;
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (hideDeeperThan !== null && it.level > hideDeeperThan) continue;
    hideDeeperThan = null;
    const hasChild = i + 1 < items.length && items[i + 1].level > it.level;
    const isCollapsed = collapsed.has(it.key);
    rows.push({ ...it, hasChild, collapsed: isCollapsed });
    if (hasChild && isCollapsed) hideDeeperThan = it.level;
  }
  return rows;
}

/** Number of lines in `content`, counting CRLF and LF alike. */
export function countLines(content: string): number {
  if (content === '') return 0;
  return splitLines(content).length;
}