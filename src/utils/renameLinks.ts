/**
 * Rename support: rewrite every `[[…]]` that pointed at the old path.
 *
 * Pure: no filesystem, no React. Callers hand in a content getter and get back the exact new
 * text of every document that changed, so the decision of *where* to write (disk vs an open,
 * dirty tab) stays in App.tsx.
 *
 * Two design points that are easy to get wrong:
 *
 *  1. Matching is done on `maskFencedCode(content)`, which is length-identical to the source.
 *     Rewriting the raw text would also hit `[[alpha]]` inside a fenced sample or an inline
 *     code span - the user's example would silently change meaning, and undo is not available.
 *  2. The replacement name is the bare stem only when that stem is unambiguous after the
 *     rename. A vault with two `note.md` must not turn `[[a/note]]` into `[[note]]`, which would
 *     resolve to the other file. Ambiguous renames write the vault-relative path instead.
 */

import { maskFencedCode, parseWikiLink, resolveWikiPage, wikiKey, type ParsedWikiLink } from './wikiLink';
import { normalizePath, vaultRelativeKeyOf, type WorkspaceIndex } from './workspaceIndex';

export interface RenameRewrite {
  /** Absolute path of the document whose text changed (as the index knows it). */
  docPath: string;
  /** Full replacement content. */
  content: string;
  /** How many link tokens were rewritten; always >= 1 for a returned entry. */
  changes: number;
}

/** Where the caller gets a document's text from (disk cache, open tabs, or a test fixture). */
export type ContentSource = (docPath: string) => string | null;

/** `!?[[…]]`, the same shape markdownRenderer.ts matches. */
const WIKI_TOKEN_RE = /(!?)\[\[([^[\]\n]{1,512})\]\]/g;

function basenameOf(path: string): string {
  const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return cut === -1 ? path : path.slice(cut + 1);
}

/** File name without extension (`notes/daily.md` -> `daily`). */
export function stemOf(path: string): string {
  const name = basenameOf(String(path || ''));
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(0, dot) : name;
}

/**
 * `notes/daily` -> `notes/renamed`: the vault-relative key the renamed file will have.
 *
 * Falls back to the bare stem when the old path is not in the vault-relative table (a document
 * outside the workspace root), because a path we cannot derive is worse than a short name.
 */
function relocateRelativeKey(index: WorkspaceIndex, oldPath: string, stem: string): string {
  const previous = vaultRelativeKeyOf(index, oldPath);
  if (!previous) return stem;
  const cut = previous.lastIndexOf('/');
  return cut === -1 ? stem : `${previous.slice(0, cut + 1)}${stem}`;
}

/**
 * Rewrite wiki tokens in one document.
 *
 * `decide` receives each parsed link and returns the new inner text (`page#heading|display`),
 * or `null` to leave the token untouched. Tokens inside fenced code and inline code are never
 * visited, and the untouched ones keep their exact original bytes.
 */
export function rewriteWikiLinks(
  content: string,
  decide: (link: ParsedWikiLink) => string | null
): { content: string; changes: number } {
  const text = typeof content === 'string' ? content : '';
  if (!text) return { content: text, changes: 0 };
  const masked = maskFencedCode(text);
  const edits: Array<{ start: number; end: number; text: string }> = [];
  WIKI_TOKEN_RE.lastIndex = 0;
  let match = WIKI_TOKEN_RE.exec(masked);
  while (match) {
    const bang = match[1];
    const link = parseWikiLink(match[2], bang ? 'embed' : 'link');
    if (link) {
      const next = decide(link);
      if (next !== null) {
        edits.push({
          start: match.index,
          end: match.index + match[0].length,
          text: `${bang}[[${next}]]`
        });
      }
    }
    match = WIKI_TOKEN_RE.exec(masked);
  }
  if (edits.length === 0) return { content: text, changes: 0 };
  // Apply back-to-front so earlier offsets stay valid without re-basing them.
  let result = text;
  for (let i = edits.length - 1; i >= 0; i -= 1) {
    const edit = edits[i];
    result = result.slice(0, edit.start) + edit.text + result.slice(edit.end);
  }
  return { content: result, changes: edits.length };
}

/**
 * Rebuild a link's inner text with a new page part, keeping its anchor / display / embed width.
 *
 * Exported because it is the contract of `rewriteWikiLinks`'s decider (which receives a parsed
 * link and must return a complete inner string) and because the width rule is easy to lose:
 * `![[pic.png|300]]` must come back as `![[asset.png|300]]`, not as `![[asset.png]]`.
 */
export function rebuildInner(link: ParsedWikiLink, page: string): string {
  let inner = page;
  if (link.heading) inner += `#${link.heading}`;
  else if (link.blockId) inner += `#^${link.blockId}`;
  if (link.alias) inner += `|${link.alias}`;
  else if (link.size !== null) inner += `|${link.size}`;
  return inner;
}

/**
 * Plan the link rewrites for `oldPath -> newPath`.
 *
 * `skipPaths` exists for documents the caller cannot rewrite safely (an open tab that is
 * dirty, or an unreadable file): those are reported as untouched instead of being rewritten
 * from a stale copy.
 */
export function planRenameReferences(
  index: WorkspaceIndex | null | undefined,
  oldPath: string,
  newPath: string,
  getContent: ContentSource,
  skipPaths: string[] = []
): RenameRewrite[] {
  const docs = index && index.docs ? index.docs : null;
  const lookup = index?.lookup ?? null;
  const fromKey = normalizePath(oldPath);
  const toKey = normalizePath(newPath);
  if (!docs || !lookup || !fromKey || !toKey || fromKey === toKey) return [];

  const stem = stemOf(newPath);
  if (!stem) return [];
  // Ambiguity is judged WITHOUT the old path: after the rename that candidate is gone, so a
  // stem that is unique once `oldPath` drops out may be written bare.
  const rivals = (lookup.byName?.[wikiKey(stem)] ?? []).filter((p) => normalizePath(p) !== fromKey);
  const bareName = rivals.length === 0;
  // The new path is not in `byPath` yet (the file has not moved when this runs), so the relative
  // key is built by keeping the OLD folder and swapping the file stem.
  const replacement = bareName ? stem : relocateRelativeKey(index as WorkspaceIndex, oldPath, stem);

  const skip = new Set(skipPaths.map((p) => normalizePath(p)));
  const out: RenameRewrite[] = [];
  for (const key of Object.keys(docs)) {
    if (skip.has(key)) continue;
    const doc = docs[key];
    if (!doc || typeof doc.path !== 'string') continue;
    // A document with no links cannot contain a reference; skip the read entirely.
    if (!Array.isArray(doc.links) || doc.links.length === 0) continue;
    const content = getContent(doc.path);
    if (typeof content !== 'string') continue;
    const rewritten = rewriteWikiLinks(content, (link) => {
      if (!link.page) return null; // `[[#heading]]` points inside the same note
      const hit = resolveWikiPage(lookup, link.page, doc.path);
      if (!hit || normalizePath(hit.path) !== fromKey) return null;
      return rebuildInner(link, replacement);
    });
    if (rewritten.changes > 0) {
      out.push({ docPath: doc.path, content: rewritten.content, changes: rewritten.changes });
    }
  }
  return out;
}

/**
 * New path for renaming a note inside its own directory.
 *
 * Kept here (not in App) so the "丢掉的扩展名" rule is testable: renaming `daily.md` to `2026-10-26`
 * must produce `2026-10-26.md`, while renaming to `2026-10-26.txt` keeps the extension the user
 * typed - a rename is also how one intentionally changes the file type.
 */
export function renamedPathFor(currentPath: string, nextName: string): string {
  const path = String(currentPath || '');
  const name = String(nextName || '').trim();
  if (!path || !name) return '';
  const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  const dir = cut === -1 ? '' : path.slice(0, cut + 1);
  const currentName = basenameOf(path);
  const dot = currentName.lastIndexOf('.');
  const extension = dot > 0 ? currentName.slice(dot) : '';
  const trimmed = name.replace(/[\\/]+/g, '-');
  const hasExtension = /\.[A-Za-z0-9]{1,8}$/.test(trimmed);
  return `${dir}${hasExtension || !extension ? trimmed : trimmed + extension}`;
}
