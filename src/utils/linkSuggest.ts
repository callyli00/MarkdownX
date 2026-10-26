/**
 * `[[` completion: what the picker offers, in what order, and nothing else.
 *
 * Pure data layer - no DOM, no caret arithmetic, no filesystem. The editor owns "where is the
 * caret and what does the popup look like"; this module owns "given the text typed after `[[`,
 * which notes / headings / block ids match, and what should be inserted if the user hits Enter".
 *
 * Two rules worth knowing before reading the code:
 *
 *  1. Ranking is a total order computed with `<` / `>`, never `localeCompare`. The picker is fed
 *     from the same table the render Worker resolves links against, and this repo has a hard
 *     "both render paths agree" gate; ICU-dependent ordering is exactly how such a gate breaks.
 *  2. `insert` is what goes inside `[[ ]]`, so it must be a name the resolver can find again.
 *     A note whose bare name is ambiguous (two `notes.md` in different folders) is offered by
 *     its relative path instead - otherwise accepting the top suggestion would silently link to
 *     the wrong file. That is the whole reason `insert` is computed here and not by the caller.
 */

import { resolveWikiPage, wikiKey } from './wikiLink';
import {
  normalizePath,
  vaultRelativeKeyOf,
  type BlockRef,
  type IndexedDoc,
  type WorkspaceIndex
} from './workspaceIndex';

export type SuggestKind = 'page' | 'heading' | 'block';

export interface SuggestItem {
  kind: SuggestKind;
  /** Text to place inside `[[ ]]`; already carries `#` / `#^` for anchors. */
  insert: string;
  /** Bold part of the row. */
  label: string;
  /** Right-hand hint: 别名 / H2 / 行号 etc. */
  hint: string;
  /** Higher is better. Stable tiebreak: label, then kind. */
  score: number;
  /** Absolute path of the file the item belongs to (pages: itself, anchors: its owner). */
  path?: string;
}

export interface SuggestQuery {
  /** Page part before `#` (may be empty: `[[#heading]]` links inside the current note). */
  page: string;
  /** Anchor part after `#` / `#^`; empty when the user is still typing a page name. */
  anchor: string;
  /** `null` while no `#` has been typed. */
  anchorKind: 'heading' | 'block' | null;
}

/** Longest hint string kept, so a 3 MB paragraph cannot become a picker row. */
const HINT_MAX = 60;

function clip(text: unknown): string {
  const value = typeof text === 'string' ? text : '';
  return value.length > HINT_MAX ? value.slice(0, HINT_MAX) : value;
}

/**
 * Split the text typed after `[[` into a page part and an anchor part.
 *
 * `|display text` is dropped: it is presentation, and the picker should still match the target.
 * A leading `#` means "this document", which is how `[[#Heading]]` is written.
 */
export function parseSuggestQuery(text: unknown): SuggestQuery {
  const raw = typeof text === 'string' ? text : '';
  const withoutDisplay = raw.split('|')[0];
  const hash = withoutDisplay.indexOf('#');
  if (hash === -1) {
    return { page: withoutDisplay.trim(), anchor: '', anchorKind: null };
  }
  const page = withoutDisplay.slice(0, hash).trim();
  const rest = withoutDisplay.slice(hash + 1);
  if (rest.startsWith('^')) {
    return { page, anchor: rest.slice(1).trim(), anchorKind: 'block' };
  }
  return { page, anchor: rest.trim(), anchorKind: 'heading' };
}

/**
 * Match score of one candidate string against the typed needle. `-1` means "no match".
 *
 * The bands are deliberately far apart so that an exact name always beats a prefix, which always
 * beats a mid-word hit: typing `alpha` must never rank `my-alpha-notes` above `alpha`.
 */
export function scoreCandidate(candidate: unknown, needle: unknown): number {
  const haystack = typeof candidate === 'string' ? candidate.toLowerCase() : '';
  const needleText = typeof needle === 'string' ? needle.trim().toLowerCase() : '';
  if (!haystack) return -1;
  if (!needleText) return 1;
  if (haystack === needleText) return 1000;
  if (haystack.startsWith(needleText)) return 800 - Math.min(199, haystack.length - needleText.length);
  const at = haystack.indexOf(needleText);
  if (at > 0) {
    const prev = haystack.charAt(at - 1);
    const boundary =
      prev === ' ' || prev === '/' || prev === '\\' || prev === '-' || prev === '_' ||
      prev === '.' || prev === '(' || prev === '[' || prev === '#';
    return (boundary ? 600 : 400) - Math.min(199, at);
  }
  return -1;
}

function basenameOf(path: string): string {
  const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return cut === -1 ? path : path.slice(cut + 1);
}

/** File name without its extension, or '' when it has none (a dotfile). */
function stemOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(0, dot) : name;
}

function docOf(index: WorkspaceIndex | null | undefined, path: string | null): IndexedDoc | null {
  const docs = index && index.docs ? index.docs : null;
  if (!docs || !path) return null;
  const key = normalizePath(path);
  if (!key) return null;
  return docs[key] ?? null;
}

/** The document the anchors belong to: the named page, or the current note for `[[#x]]`. */
function anchorOwner(
  index: WorkspaceIndex | null | undefined,
  page: string,
  currentPath: string | null
): { doc: IndexedDoc; prefix: string } | null {
  if (!page) {
    const doc = docOf(index, currentPath);
    return doc ? { doc, prefix: '' } : null;
  }
  const lookup = index?.lookup ?? null;
  const hit = lookup ? resolveWikiPage(lookup, page, currentPath || '') : null;
  if (!hit) return null;
  const doc = docOf(index, hit.path);
  return doc ? { doc, prefix: page } : null;
}

/**
 * Name to insert for a page: the bare stem, unless that stem is ambiguous inside the vault.
 *
 * Ambiguity is read from `lookup.byName` rather than from the document list, because that table
 * IS the resolver's view: if `byName` has one candidate the renderer will resolve the bare name
 * to this very file, and if it has two the renderer picks by directory - which is not
 * necessarily this file. Accepting a suggestion must never link somewhere else, so an ambiguous
 * page is offered by its vault-relative path instead.
 */
function insertFor(doc: IndexedDoc, index: WorkspaceIndex | null | undefined): string {
  const name = typeof doc.name === 'string' && doc.name ? doc.name : basenameOf(doc.path);
  const stem = stemOf(name);
  const candidates = index?.lookup?.byName?.[wikiKey(stem || name)] ?? [];
  if (candidates.length <= 1) return stem || name;
  const relativeKey = vaultRelativeKeyOf(index as WorkspaceIndex, doc.path);
  // A document at the vault root has no longer key than its own name; nothing better exists.
  return relativeKey || stem || name;
}

function compareItems(a: SuggestItem, b: SuggestItem): number {
  if (a.score !== b.score) return b.score - a.score;
  if (a.label !== b.label) return a.label < b.label ? -1 : 1;
  const order = { page: 0, heading: 1, block: 2 } as const;
  return order[a.kind] - order[b.kind];
}

/**
 * Ranked suggestions for the text typed after `[[`.
 *
 * `limit` is clamped (a caller passing NaN must not yield an empty picker); the result is a new
 * array of plain objects, safe to `structuredClone` or to keep in React state.
 */
export function suggestLinks(
  index: WorkspaceIndex | null | undefined,
  query: unknown,
  currentPath: string | null = null,
  limit = 20
): SuggestItem[] {
  const cap = typeof limit === 'number' && Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 20;
  const parsed = parseSuggestQuery(query);

  if (parsed.anchorKind) {
    const owner = anchorOwner(index, parsed.page, currentPath);
    if (!owner) return [];
    const { doc, prefix } = owner;
    const lead = prefix ? `${prefix}#` : '#';
    const out: SuggestItem[] = [];
    if (parsed.anchorKind === 'block') {
      const blocks: BlockRef[] = Array.isArray(doc.blocks) ? doc.blocks : [];
      for (const block of blocks) {
        const score = Math.max(scoreCandidate(block.id, parsed.anchor), scoreCandidate(block.text, parsed.anchor));
        if (score < 0) continue;
        out.push({
          kind: 'block',
          insert: `${lead}^${block.id}`,
          label: `^${block.id}`,
          hint: clip(block.text) || `第 ${block.line} 行`,
          score,
          path: doc.path
        });
      }
    } else {
      const headings = Array.isArray(doc.headings) ? doc.headings : [];
      for (const heading of headings) {
        const score = scoreCandidate(heading.text, parsed.anchor);
        if (score < 0) continue;
        out.push({
          kind: 'heading',
          insert: `${lead}${heading.text}`,
          label: heading.text,
          hint: `H${heading.level}`,
          score,
          path: doc.path
        });
      }
    }
    return out.sort(compareItems).slice(0, cap);
  }

  const docs = index && index.docs ? index.docs : null;
  if (!docs) return [];
  const out: SuggestItem[] = [];
  for (const key of Object.keys(docs)) {
    const doc = docs[key];
    if (!doc || typeof doc.path !== 'string') continue;
    const name = typeof doc.name === 'string' && doc.name ? doc.name : basenameOf(doc.path);
    const stem = stemOf(name) || name;
    let best = scoreCandidate(stem, parsed.page);
    let hint = '';
    for (const alias of Array.isArray(doc.aliases) ? doc.aliases : []) {
      const aliasScore = scoreCandidate(alias, parsed.page);
      if (aliasScore > best) {
        best = aliasScore;
        hint = `别名：${alias}`;
      }
    }
    if (best < 0) continue;
    out.push({
      kind: 'page',
      insert: insertFor(doc, index),
      label: stem,
      hint,
      score: best,
      path: doc.path
    });
  }
  return out.sort(compareItems).slice(0, cap);
}

/**
 * Everything the picker can insert for a NEW note: the vault's block ids and headings, used to
 * decide whether "create note" also needs a heading. Exposed for tests and for the future
 * `[[`-completion of an unresolved name; not used by the popup itself.
 */
export function anchorsOf(doc: IndexedDoc | null): Array<{ insert: string; label: string }> {
  if (!doc) return [];
  const out: Array<{ insert: string; label: string }> = [];
  for (const heading of Array.isArray(doc.headings) ? doc.headings : []) {
    out.push({ insert: heading.text, label: heading.text });
  }
  for (const block of Array.isArray(doc.blocks) ? doc.blocks : []) {
    out.push({ insert: `^${block.id}`, label: `^${block.id}` });
  }
  return out;
}

/**
 * File name for a note created from an unresolved link.
 *
 * Obsidian allows almost anything in a note name; Windows does not. Characters Windows rejects
 * become `-`, runs collapse into one (so `[[a/b:c]]` does not produce `a-b-c`), leading and
 * trailing dots/spaces go away, and a name that reduces to nothing falls back to `未命名` instead
 * of asking `writeTextFile` to create `C:\vault\.md` and reporting a confusing IO error.
 */
export function sanitizeNoteName(page: unknown): string {
  const raw = typeof page === 'string' ? page.trim() : '';
  if (!raw) return '未命名';
  const forbidden = '\\/:*?"<>|';
  const mapped = Array.from(raw).map((ch) =>
    forbidden.indexOf(ch) !== -1 || ch.charCodeAt(0) < 32 ? '-' : ch
  );
  const collapsed = mapped.join('').replace(/-+/g, '-').replace(/^[.\-\s]+|[.\-\s]+$/g, '');
  return collapsed || '未命名';
}

/**
 * Absolute path for a note created from an unresolved `[[page]]`.
 *
 * Placement rule: next to the document that contains the link when that document lives inside
 * the workspace, otherwise at the workspace root. `..` never appears - a link in a note outside
 * the workspace falls back to the root, because writing outside the folder the user opened would
 * be a surprise.
 *
 * The separator comes from the workspace path itself, so the same code produces a Windows path
 * for a Windows vault and a POSIX path for an Android one.
 */
export function notePathFor(workspacePath: unknown, currentDocPath: unknown, page: unknown): string {
  const root = typeof workspacePath === 'string' ? workspacePath.trim() : '';
  if (!root) return '';
  const sep = root.indexOf('\\') !== -1 && root.indexOf('/') === -1 ? '\\' : '/';
  const normalizedRoot = root.split(sep === '\\' ? '/' : '\\').join(sep);
  const trimmedRoot =
    normalizedRoot.length > 1 && (normalizedRoot.endsWith('/') || normalizedRoot.endsWith('\\'))
      ? normalizedRoot.replace(/[\\/]+$/, '')
      : normalizedRoot;

  const name = sanitizeNoteName(page);
  const doc = typeof currentDocPath === 'string' ? currentDocPath.trim() : '';
  if (doc) {
    const normalizedDoc = doc.split(sep === '\\' ? '/' : '\\').join(sep);
    const cut = normalizedDoc.lastIndexOf(sep);
    const dir = cut > 0 ? normalizedDoc.slice(0, cut) : '';
    const inside = dir && (dir === trimmedRoot || dir.startsWith(trimmedRoot + sep));
    if (inside) return `${dir}${sep}${name}.md`;
  }
  return `${trimmedRoot}${sep}${name}.md`;
}

/** How far back from the caret a `[[` may be for the picker to stay open. */
export const SUGGEST_TRIGGER_MAX = 200;

/**
 * Does the caret sit inside an unfinished `[[…`?
 *
 * `start` is the index of the first `[` in the textarea value, so accepting a suggestion can
 * replace `[[typed` with `[[insert]]` by plain string slicing - no `execCommand`, no selection
 * juggling, and the same code path on every platform.
 *
 * Returns null for the cases where a popup would be wrong rather than helpful: a closed link
 * (`[[a]]`), a newline in between, a third bracket (`[[[`), and a caret outside the text.
 */
export function detectTrigger(value: unknown, caret: unknown): { start: number; typed: string } | null {
  const text = typeof value === 'string' ? value : '';
  const at =
    typeof caret === 'number' && Number.isFinite(caret)
      ? Math.max(0, Math.min(text.length, Math.floor(caret)))
      : text.length;
  const windowStart = Math.max(0, at - SUGGEST_TRIGGER_MAX);
  const before = text.slice(windowStart, at);
  const open = before.lastIndexOf('[[');
  if (open === -1) return null;
  const typed = before.slice(open + 2);
  if (typed.indexOf(']]') !== -1) return null;
  if (typed.indexOf('\n') !== -1 || typed.indexOf('\r') !== -1) return null;
  // `[[[x` matches at offset 1 with '[' typed first; a still-lower bracket means the user is
  // not writing a link opener (nested brackets are not valid Obsidian syntax either).
  if (typed.charAt(0) === '[') return null;
  if (open > 0 && before.charAt(open - 1) === '[') return null;
  return { start: windowStart + open, typed };
}
