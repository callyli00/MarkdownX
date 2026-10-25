/**
 * Obsidian-style wiki links: parsing, resolution and (for the workspace index) scanning.
 *
 * Pure on purpose: no DOM, no Tauri, no filesystem. Everything both consumers need from a
 * `[[…]]` token lives here so the renderer and the index can never disagree about what a
 * link means.
 *
 * Two invariants worth stating up front:
 *
 *  1. `headingSlug()` MUST stay byte-identical to the heading-id formula in
 *     markdownRenderer.ts (`encodeURIComponent(raw.trim().toLowerCase().replace(/\s+/g,'-'))`).
 *     If they drift, `[[Note#Heading]]` silently scrolls nowhere - a failure mode this
 *     codebase already lived through once with formulas in headings.
 *  2. Nothing here reads a file. Resolution takes a lookup table, so the same table can be
 *     handed to the render Worker and to the main thread and the two render byte-identically
 *     (see tools/render-equivalence-gate).
 */

export type WikiKind = 'link' | 'embed';

export interface ParsedWikiLink {
  /** The whole `[[…]]` / `![[…]]` source text. */
  raw: string;
  kind: WikiKind;
  /** Target note name or path fragment. '' for a same-page `[[#Heading]]`. */
  page: string;
  /** Heading text when the link points at a heading, else ''. */
  heading: string;
  /** Block id when the heading part was `^id`, else ''. */
  blockId: string;
  /** Display text after `|`, else ''. */
  alias: string;
  /** Embed width in CSS px from `|300`, else null. */
  size: number | null;
  isImage: boolean;
  isPdf: boolean;
  /** True when the target has a file extension we treat as an attachment (image/pdf/other). */
  isAttachment: boolean;
}

const IMAGE_EXT_RE = /\.(?:png|jpe?g|gif|webp|svg|bmp|avif|ico)$/i;
const PDF_EXT_RE = /\.pdf$/i;
/** Anything with one of these extensions is an attachment rather than a note. */
const ATTACHMENT_EXT_RE = /\.(?:png|jpe?g|gif|webp|svg|bmp|avif|ico|pdf|mp3|mp4|wav|webm|m4a|ogg|mov)$/i;

const MAX_INNER = 512;

/** Slug used by heading anchors; keep in sync with markdownRenderer.ts's renderer.heading. */
export function headingSlug(text: string): string {
  return encodeURIComponent(String(text || '').trim().toLowerCase().replace(/\s+/g, '-'));
}

function stripExtension(name: string): string {
  const slash = Math.max(name.lastIndexOf('/'), name.lastIndexOf('\\'));
  const dot = name.lastIndexOf('.');
  return dot > slash + 1 ? name.slice(0, dot) : name;
}

/**
 * Parse the inside of a `[[…]]` token.
 *
 * Grammar accepted (Obsidian-compatible subset):
 *   page | page#Heading | page#^block-id | #Heading | #^block-id
 *   page|alias | embed width: ![[img.png|300]] | ![[img.png|alt|300]]
 */
export function parseWikiLink(inner: string, kind: WikiKind): ParsedWikiLink | null {
  const text = String(inner ?? '').trim();
  if (!text || text.length > MAX_INNER) return null;
  // Brackets or newlines inside would mean the tokenizer's match was nonsense.
  if (/[[\]\n]/.test(text)) return null;

  const parts = text.split('|');
  const target = parts[0].trim();
  const rest = parts.slice(1).map((s) => s.trim());

  let alias = '';
  let size: number | null = null;
  if (rest.length > 0) {
    const last = rest[rest.length - 1];
    // `![[img.png|300]]` - a trailing pure number is a width, never an alias.
    if (kind === 'embed' && /^\d{1,4}$/.test(last) && ATTACHMENT_EXT_RE.test(target)) {
      size = Number(last);
      alias = rest.slice(0, -1).join('|');
    } else {
      alias = rest.join('|');
    }
  }

  const hashAt = target.indexOf('#');
  const page = (hashAt === -1 ? target : target.slice(0, hashAt)).trim();
  const headingRaw = hashAt === -1 ? '' : target.slice(hashAt + 1).trim();
  if (!page && !headingRaw) return null;
  // A page name may not contain angle brackets or a protocol separator; such text is just
  // prose. A FORWARD SLASH is legal and meaningful: `[[folder/note]]` and `[[assets/a.png]]`
  // both address a file by path, which is how attachments are embedded.
  if (/[<>"]/.test(page) || page.includes('://')) return null;

  const isBlock = headingRaw.startsWith('^');
  const blockId = isBlock ? headingRaw.slice(1).trim() : '';
  const heading = isBlock ? '' : headingRaw;
  if (blockId && !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(blockId)) return null;

  return {
    raw: '',
    kind,
    page,
    heading,
    blockId,
    alias,
    size,
    isImage: IMAGE_EXT_RE.test(page),
    isPdf: PDF_EXT_RE.test(page),
    isAttachment: ATTACHMENT_EXT_RE.test(page)
  };
}

/** The display text for a link: the alias when present, otherwise the target. */
export function wikiDisplayText(link: ParsedWikiLink): string {
  if (link.alias) return link.alias;
  if (link.page) return link.heading ? link.page : stripExtension(link.page);
  return link.heading || link.blockId;
}

/**
 * Key under which a page name is indexed: lowercase, extension stripped, `./` removed.
 * Windows is case-insensitive and Android's ext4 is not, so the index is always
 * case-folded - a link written `[[Notes]]` must find `notes.md` on both platforms.
 */
export function wikiKey(page: string): string {
  const cleaned = String(page || '').trim().split('\\').join('/').replace(/^\.\//, '');
  return stripExtension(cleaned).toLowerCase();
}

export interface WikiLookup {
  /** lowercase note name (no extension) -> candidate absolute paths, in a stable order. */
  byName: Record<string, string[]>;
  /** lowercase vault-relative path (with extension) -> absolute path, for `[[dir/note]]`. */
  byPath: Record<string, string>;
}

export interface WikiResolution {
  /** Absolute path of the resolved target. */
  path: string;
  /** Other candidates that also matched, when the name was ambiguous. */
  ambiguous: string[];
}

function sameDir(a: string, b: string): boolean {
  const da = a.split('\\').join('/').replace(/\/[^/]*$/, '');
  const db = b.split('\\').join('/').replace(/\/[^/]*$/, '');
  return da === db;
}

/**
 * Resolve a page name to a file path, Obsidian-style:
 *   1. an explicit relative/vault path (`dir/note`) wins,
 *   2. a note sitting in the SAME directory as the source wins over a global match,
 *   3. otherwise the shortest matching path (stable tiebreak: alphabetical).
 * Ambiguity is reported, never hidden: the caller shows "打开哪一个".
 */
export function resolveWikiPage(
  lookup: WikiLookup,
  page: string,
  fromPath: string
): WikiResolution | null {
  const key = wikiKey(page);
  if (!key) return null;

  const explicit = lookup.byPath[key] || lookup.byPath[key + '.md'];
  if (explicit) return { path: explicit, ambiguous: [] };

  const candidates = lookup.byName[key];
  if (!candidates || candidates.length === 0) return null;
  if (candidates.length === 1) return { path: candidates[0], ambiguous: [] };

  const local = candidates.filter((c) => sameDir(c, fromPath));
  const pool = local.length > 0 ? local : candidates;
  const sorted = [...pool].sort((a, b) => a.length - b.length || a.localeCompare(b));
  return { path: sorted[0], ambiguous: sorted.slice(1) };
}

/** Separator used by the source document, so generated hrefs match the platform's style. */
function separatorOf(path: string): string {
  return path.includes('\\') && !path.includes('/') ? '\\' : '/';
}

/**
 * Relative path from the document's directory to a target file.
 *
 * Deliberately separator-preserving: a document opened from `C:\vault\a.md`
 * produces `..\b.md`, exactly as Windows writes it, while an Android document
 * (`/storage/emulated/0/notes/a.md`) stays on `/`. Different volumes/roots fall
 * back to the absolute path rather than inventing a bogus `../..` chain.
 */
export function relativeFromDoc(fromDocPath: string, targetPath: string): string {
  const sep = separatorOf(fromDocPath);
  const from = String(fromDocPath || '').split('\\').join('/');
  const to = String(targetPath || '').split('\\').join('/');
  if (!from || !to) return targetPath;

  const fromParts = from.split('/');
  fromParts.pop(); // drop the file name
  const toParts = to.split('/');

  // A Windows drive letter or a POSIX root must agree before a relative path is possible.
  const fromRoot = fromParts[0] || '';
  const toRoot = toParts[0] || '';
  if (fromRoot !== toRoot) return targetPath;

  let common = 0;
  while (common < fromParts.length && common < toParts.length - 1 && fromParts[common] === toParts[common]) {
    common++;
  }
  const ups = fromParts.length - common;
  const rest = toParts.slice(common);
  const parts: string[] = [];
  for (let i = 0; i < ups; i++) parts.push('..');
  parts.push(...rest);
  const joined = parts.join('/');
  return sep === '\\' ? joined.split('/').join('\\') : joined;
}

/**
 * href for a resolved link. Fragments follow the renderer's conventions:
 * headings are `heading-<slug>`, block ids are `blk-<id>`.
 */
export function wikiHref(fromDocPath: string, targetPath: string, link: ParsedWikiLink): string {
  const same = fromDocPath && targetPath && fromDocPath.split('\\').join('/') === targetPath.split('\\').join('/');
  let href = same ? '' : relativeFromDoc(fromDocPath, targetPath || '');
  // An unquoted '#' in a file name would be read as a fragment separator.
  href = href.split('#').join('%23');
  if (same) href = '';
  if (link.blockId) return `${href}#blk-${link.blockId}`;
  if (link.heading) return `${href}#heading-${headingSlug(link.heading)}`;
  return href ? href : '#';
}

/**
 * Neutralise code - fenced blocks AND inline code spans - while keeping every byte offset:
 * masked regions are replaced by spaces of identical length. Used by the scanners so a
 * `[[link]]` or a `#tag` written as an example never becomes an index edge.
 */
export function maskFencedCode(content: string): string {
  const lines = String(content ?? '').split('\n');
  const out: string[] = [];
  let fence: string | null = null;
  for (const line of lines) {
    const open = line.match(/^[ \t]{0,3}(`{3,}|~{3,})(.*)$/);
    if (fence === null) {
      if (open) {
        fence = open[1];
        out.push(' '.repeat(line.length));
        continue;
      }
      // Inline code spans on this line only. `[[x]]` inside backticks is an EXAMPLE of
      // the syntax, not a link: missing this produced phantom backlinks (found by the
      // v2.7.0 smoke test - a note documenting `[[b]]` in a code span became b's third
      // referencing page). A backtick span cannot cross a newline in CommonMark, so this
      // pass stays line-local and can never swallow a fenced block.
      out.push(line.replace(/(`+)([^\n]*?)\1/g, (m) => ' '.repeat(m.length)));
      continue;
    }
    const close = line.match(/^[ \t]{0,3}(`{3,}|~{3,})[ \t]*$/);
    if (close && close[1][0] === fence[0] && close[1].length >= fence.length) {
      fence = null;
    }
    out.push(' '.repeat(line.length));
  }
  return out.join('\n');
}

/** Every `[[…]]` / `![[…]]` in a document, in source order, fences masked out. */
export function scanWikiLinks(content: string): ParsedWikiLink[] {
  const masked = maskFencedCode(content);
  const out: ParsedWikiLink[] = [];
  const re = /(!?)\[\[([^[\]\n]{1,512})\]\]/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(masked)) !== null) {
    const parsed = parseWikiLink(match[2], match[1] ? 'embed' : 'link');
    if (parsed) out.push({ ...parsed, raw: match[0] });
  }
  return out;
}

/** Inline `#tag` occurrences, fences masked out. Mirrors the renderer's tag pass. */
export function scanTags(content: string): string[] {
  const masked = maskFencedCode(content);
  const out: string[] = [];
  const re = /(?<![\w&#/\\])#([\p{L}\p{N}][\p{L}\p{N}_/-]*)/gu;
  let match: RegExpExecArray | null;
  while ((match = re.exec(masked)) !== null) {
    const tag = match[1];
    if (/^\d+$/.test(tag)) continue;
    if (!out.includes(tag)) out.push(tag);
  }
  return out;
}

/**
 * True when the tag pass may claim `#` at this position: it must not be a heading marker
 * (`# Title`), part of a URL fragment, an HTML entity (`&#39;`) or an escape (`\#`).
 * Exposed because the renderer tests assert the same rule the scanner uses.
 */
export function isTagCandidate(before: string, after: string): boolean {
  if (!after || /^\s/.test(after)) return false;
  if (!/^[\p{L}\p{N}]/u.test(after)) return false;
  if (!before) return true;
  return !/[\w&#/\\]/.test(before.slice(-1));
}
