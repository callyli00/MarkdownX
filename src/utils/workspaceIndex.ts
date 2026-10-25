/**
 * Workspace index: the pure data layer behind the backlinks / tags / unresolved-link panels.
 *
 * No DOM, no Tauri, no filesystem, no renderer. The caller scans documents, this module turns
 * them into a graph (backlinks, tag counts, dangling links) plus a resolution table, and the
 * result is plain JSON-shaped data so it can be `structuredClone`d into the render Worker.
 *
 * Three invariants, each of which has already cost this project a debugging session somewhere:
 *
 *  1. `headingSlug()` from wikiLink.ts is the ONLY slug formula in play - it is byte-identical
 *     to markdownRenderer.ts's heading id. Never re-derive it here: `[[Note#标题]]` silently
 *     scrolling nowhere is exactly what happens the day the two formulas drift.
 *  2. `lookup.byName` candidates are sorted with a code-unit comparison, never `localeCompare`.
 *     The table is built on the main thread and shipped to the render Worker; a locale-dependent
 *     order would let the two render paths disagree, and this repo has a hard
 *     "both paths render byte-identically" gate (tools/render-equivalence-gate).
 *  3. Everything is untrusted input: empty paths, empty content, missing fields, self-links and
 *     cyclic embeds must produce data, never an exception.
 */

import {
  headingSlug,
  maskFencedCode,
  resolveWikiPage,
  scanTags,
  scanWikiLinks,
  wikiKey,
  type ParsedWikiLink,
  type WikiLookup
} from './wikiLink';

export interface HeadingRef {
  /** 1-6, taken from the ATX marker count. */
  level: number;
  /** Heading text as written (ATX closing hashes removed), for display and outline reuse. */
  text: string;
  /** `headingSlug(text)`: the same value markdownRenderer.ts puts in `id="heading-…"`. */
  slug: string;
  /** Character offset of the heading line's first character in the source document. */
  offset: number;
}

/**
 * Where one link sits in its document. Index-aligned with `IndexedDoc.links`.
 *
 * `IndexedDoc` is deliberately a flat, cloneable record with no positions on the links
 * themselves (ParsedWikiLink is owned by wikiLink.ts and must not grow index-only fields), yet
 * `BacklinkRef` needs a line number and the source line. This optional companion array is the
 * seam: scans produced here always fill it, and hand-built documents without it still type-check
 * and simply yield a backlink with an unknown position instead of throwing.
 */
export interface LinkPosition {
  /** 1-based line number, i.e. what an editor gutter shows. */
  line: number;
  /** The source line, trimmed and clipped to 200 characters. */
  context: string;
}

export interface IndexedDoc {
  /** Absolute path, exactly as the document was scanned (separators are not rewritten). */
  path: string;
  /** Base name including the extension (`notes.md`). */
  name: string;
  links: ParsedWikiLink[];
  tags: string[];
  headings: HeadingRef[];
  /** Optional, see `LinkPosition`. Always present on results of `scanDocument`. */
  linkPositions?: LinkPosition[];
}

export interface BacklinkRef {
  /**
   * Absolute path of the referring document, in the form it was scanned (`C:\vault\a.md`), so it
   * can be opened directly. `normalizePath(from)` is its key in `docs`.
   */
  from: string;
  /** 1-based source line of the link. */
  line: number;
  /** The source line, trimmed, at most 200 characters. */
  context: string;
}

export interface WorkspaceIndex {
  /** Normalised absolute path (`/` separators, no trailing slash) -> document. */
  docs: Record<string, IndexedDoc>;
  /** Deterministic resolution table, ready to be structured-cloned into a Worker. */
  lookup: WikiLookup;
  /** Normalised target path -> references that point at it. */
  backlinks: Record<string, BacklinkRef[]>;
  /** Tag -> number of documents containing it. */
  tagCounts: Record<string, number>;
  /** Normalised source path -> links in that document that resolve to nothing. */
  unresolved: Record<string, ParsedWikiLink[]>;
}

/** Longest context snippet a panel row shows before it stops being a row. */
const CONTEXT_MAX = 200;

/**
 * Canonical form of a path used as an index key: `/` separators, single separators, no trailing
 * separator.
 *
 * Deliberately NOT case-folded. The document set comes from one directory walk, so its casing is
 * already canonical; folding it would make `docs` / `backlinks` unreadable in a debugger, and
 * case-insensitive *linking* is `wikiKey`'s job, not the index key's. UNC paths keep their
 * leading `//` so a share cannot collide with a POSIX path.
 *
 * Exported because the panels hold paths the way the app holds them (`C:\vault\note.md`, the form
 * Windows and Tauri return) while `docs` / `backlinks` / `unresolved` are keyed by this form;
 * `index.docs[normalizePath(ref.from)]` is the supported way to go from one to the other.
 */
export function normalizePath(path: unknown): string {
  const raw = typeof path === 'string' ? path.trim() : '';
  if (!raw) return '';
  const slashed = raw.split('\\').join('/');
  const unc = slashed.startsWith('//');
  const body = slashed.replace(/\/{2,}/g, '/');
  const kept = unc && !body.startsWith('//') ? '/' + body : body;
  return kept.length > 1 ? kept.replace(/\/+$/, '') : kept;
}

function basenameOf(path: string): string {
  const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return cut === -1 ? path : path.slice(cut + 1);
}

/**
 * Code-unit comparison. `localeCompare` is locale/ICU dependent, which would make the lookup
 * table - and therefore link resolution inside the Worker - differ between two machines running
 * the same vault. Plain `<` / `>` is the only order that is identical everywhere.
 */
function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function hasOwn(obj: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

/** Start offset of every line, so a character offset can be turned into a line number in O(log n). */
function lineStartsOf(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) starts.push(i + 1);
  }
  return starts;
}

/** Trim, then clip: a 3 MB single-line document must not end up in a panel row. */
function clipContext(line: string): string {
  const trimmed = line.trim();
  return trimmed.length > CONTEXT_MAX ? trimmed.slice(0, CONTEXT_MAX) : trimmed;
}

/**
 * ATX headings of an already fence-masked document, with real character offsets.
 *
 * Offsets are accumulated from the masked text, which `maskFencedCode` guarantees is
 * length-identical to the source, rather than estimated as `lineNumber * lineLength`: a CRLF
 * document (every Windows file) is one character wider per line, and `\r` inside the length is
 * what makes `offset = line.length + 1` correct for LF and CRLF alike.
 */
function extractHeadings(masked: string): HeadingRef[] {
  const out: HeadingRef[] = [];
  let offset = 0;
  while (offset < masked.length) {
    let end = masked.indexOf('\n', offset);
    if (end === -1) end = masked.length;
    let line = masked.slice(offset, end);
    if (line.endsWith('\r')) line = line.slice(0, -1);
    const m = /^ {0,3}(#{1,6})[ \t]+(.*)$/.exec(line);
    if (m) {
      // `## Title ##` renders as "Title"; the closing sequence is syntax, not text.
      const text = m[2].replace(/[ \t]+#+$/, '').trim();
      if (text) out.push({ level: m[1].length, text, slug: headingSlug(text), offset });
    }
    offset = end + 1;
  }
  return out;
}

/**
 * Attach a line/context to every link, in source order.
 *
 * The links themselves come from `scanWikiLinks` (single source of truth for what a `[[…]]` is),
 * and their positions are recovered with `indexOf` over the masked text. Masking blanks fenced
 * regions character-for-character, so searching the masked text skips `[[…]]` that only exist
 * inside a code sample - searching the raw text would happily attribute a fenced occurrence to a
 * real link with the same target.
 */
function locateLinks(masked: string, links: ParsedWikiLink[]): LinkPosition[] {
  const starts = lineStartsOf(masked);
  const out: LinkPosition[] = [];
  let cursor = 0;
  let line = 0;
  for (const link of links) {
    const at = link.raw ? masked.indexOf(link.raw, cursor) : -1;
    if (at === -1) {
      // Only reachable if the scanner's regex ever changes shape. Report "unknown position"
      // instead of attaching a line that points at unrelated text.
      out.push({ line: 1, context: '' });
      continue;
    }
    cursor = at + link.raw.length;
    while (line + 1 < starts.length && starts[line + 1] <= at) line++;
    const start = starts[line];
    const end = line + 1 < starts.length ? starts[line + 1] - 1 : masked.length;
    out.push({ line: line + 1, context: clipContext(masked.slice(start, end)) });
  }
  return out;
}

/** Scan one document. Pure: the full scan and any incremental re-scan share this. */
export function scanDocument(path: string, content: string): IndexedDoc {
  const docPath = typeof path === 'string' ? path : '';
  const text = typeof content === 'string' ? content : '';
  // Fences are masked three times (here, and inside scanWikiLinks / scanTags). That is
  // deliberate: depending on their internals would couple the index to their regexes, and three
  // linear passes still leave scanDocument at O(n).
  const masked = maskFencedCode(text);
  const links = scanWikiLinks(text);
  return {
    path: docPath,
    name: basenameOf(docPath),
    links,
    tags: scanTags(text),
    headings: extractHeadings(masked),
    linkPositions: locateLinks(masked, links)
  };
}

/** Directory segments of a normalised path (the file name dropped). */
function directorySegmentsOf(path: string): string[] {
  const segments = String(path || '').split('/');
  segments.pop();
  return segments;
}

/**
 * Deepest directory that contains every document, as path segments.
 *
 * `WikiLookup.byPath` is keyed by *vault-relative* path and this module is never told where the
 * vault root is. Deriving it from the document set keeps `[[notes/daily]]` working while staying
 * a pure function of the input: the same documents always produce the same table, which is what
 * the Worker/main-thread equivalence gate needs. Documents on different roots simply yield an
 * empty root, and path-shaped links then fall through to the name table.
 */
function commonDirectorySegments(paths: string[]): string[] {
  if (paths.length === 0) return [];
  let common = directorySegmentsOf(paths[0]);
  for (let i = 1; i < paths.length; i++) {
    const other = directorySegmentsOf(paths[i]);
    let n = 0;
    while (n < common.length && n < other.length && common[n].toLowerCase() === other[n].toLowerCase()) n++;
    common = common.slice(0, n);
    if (common.length === 0) return [];
  }
  return common;
}

/** Lowercase vault-relative key (`sub/note.md`) for a document, or '' when it is off-root. */
function relativePathKey(path: string, root: string[]): string {
  if (root.length === 0) return '';
  const segments = path.split('/');
  if (segments.length - 1 < root.length) return '';
  for (let i = 0; i < root.length; i++) {
    if (segments[i].toLowerCase() !== root[i].toLowerCase()) return '';
  }
  return segments.slice(root.length).join('/').toLowerCase();
}

/** Mirrors wikiLink.ts's private extension rule so both sides strip the same way. */
function stripExtensionKey(path: string): string {
  const slash = path.lastIndexOf('/');
  const dot = path.lastIndexOf('.');
  return dot > slash + 1 ? path.slice(0, dot) : path;
}

function addNameCandidate(map: Map<string, Set<string>>, key: string, abs: string): void {
  const bucket = map.get(key);
  if (bucket) bucket.add(abs);
  else map.set(key, new Set([abs]));
}

/**
 * Keep the code-unit-smallest path for a key.
 *
 * `byPath` holds one path per key, and two documents can collide there (a note and an attachment
 * with the same stem, or two roots). Picking the smaller path makes the winner independent of
 * the order in which documents happened to be scanned, which is required for the index to be
 * reproducible between the two render paths.
 */
function keepSmallest(map: Map<string, string>, key: string, abs: string): void {
  if (!key) return;
  const current = map.get(key);
  if (current === undefined || compareStrings(abs, current) < 0) map.set(key, abs);
}

/**
 * Build the resolution table the renderer needs, and only that.
 *
 * `byName` keys are `wikiKey` (lowercase, extension stripped) because `[[Notes]]` must find
 * `notes.md` on Windows and on Android; the values are the original absolute paths, sorted, so a
 * Worker clone resolves exactly like the main thread. `byPath` carries BOTH `sub/note.md` (the
 * documented shape) and `sub/note` (what `resolveWikiPage` probes first) so path-shaped links do
 * not depend on which branch of that function happens to run.
 */
export function buildWikiLookup(docs: IndexedDoc[]): WikiLookup {
  const list: IndexedDoc[] = Array.isArray(docs) ? docs : [];
  const byNameSets = new Map<string, Set<string>>();
  const byPathMap = new Map<string, string>();
  const paths: string[] = [];
  for (const doc of list) {
    if (!doc || typeof doc.path !== 'string') continue;
    const abs = doc.path;
    const key = normalizePath(abs);
    // A whitespace-only path would otherwise put '' into the root computation and flatten the
    // whole table, so it is dropped here exactly like buildIndex drops it.
    if (!key) continue;
    paths.push(key);
    const name = typeof doc.name === 'string' && doc.name ? doc.name : basenameOf(abs);
    const nameKey = wikiKey(name);
    if (nameKey) addNameCandidate(byNameSets, nameKey, abs);
  }
  const root = commonDirectorySegments(paths);

  for (const doc of list) {
    if (!doc || typeof doc.path !== 'string') continue;
    const abs = doc.path;
    const key = normalizePath(abs);
    if (!key) continue;
    const rel = relativePathKey(key, root);
    if (!rel) continue;
    keepSmallest(byPathMap, rel, abs);
    keepSmallest(byPathMap, stripExtensionKey(rel), abs);
  }

  // Object.create(null) because both tables are indexed by user-controlled names: on a plain
  // object a document called `constructor.md` would make `byName['constructor']` return
  // `Object.prototype.constructor` instead of nothing.
  const byName: Record<string, string[]> = Object.create(null);
  for (const key of [...byNameSets.keys()].sort(compareStrings)) {
    byName[key] = [...(byNameSets.get(key) ?? [])].sort(compareStrings);
  }
  const byPath: Record<string, string> = Object.create(null);
  for (const key of [...byPathMap.keys()].sort(compareStrings)) {
    byPath[key] = byPathMap.get(key) as string;
  }
  return { byName, byPath };
}

/**
 * Build the whole index.
 *
 * Cost is O(documents + links + tags): the lookup table is built once, and each link is resolved
 * with two hash probes instead of a walk over the document set. A link that resolves to a file
 * outside the index (typically an attachment: `![[assets/x.png]]` names a file the note scanner
 * never read) is reported as unresolved rather than silently dropped - the panel shows it as
 * "attachment missing".
 */
export function buildIndex(docs: IndexedDoc[]): WorkspaceIndex {
  const list: IndexedDoc[] = Array.isArray(docs) ? docs : [];
  const lookup = buildWikiLookup(list);

  const indexDocs: Record<string, IndexedDoc> = Object.create(null);
  const backlinks: Record<string, BacklinkRef[]> = Object.create(null);
  const unresolved: Record<string, ParsedWikiLink[]> = Object.create(null);
  const tagCounts: Record<string, number> = Object.create(null);

  // Pass 1 registers every document before any link is resolved. A single pass would report
  // every forward reference as dangling (A links to B, B has not been visited yet) - which is
  // exactly the "backlinks panel is empty for half the vault" bug.
  const seenDocs = new Set<string>();
  for (const doc of list) {
    if (!doc || typeof doc.path !== 'string') continue;
    const key = normalizePath(doc.path);
    if (!key || seenDocs.has(key)) continue;
    seenDocs.add(key);
    indexDocs[key] = doc;

    // `scanTags` already de-duplicates within a document, so a count is "one per document":
    // repeating #todo three times in one note is still one note to open.
    const seenTags = new Set<string>();
    for (const rawTag of Array.isArray(doc.tags) ? doc.tags : []) {
      const tag = typeof rawTag === 'string' ? rawTag.trim() : '';
      if (!tag || seenTags.has(tag)) continue;
      seenTags.add(tag);
      tagCounts[tag] = (tagCounts[tag] ?? 0) + 1;
    }
  }

  // Pass 2 resolves links; `indexDocs` is complete, so membership is meaningful.
  for (const doc of list) {
    if (!doc || typeof doc.path !== 'string') continue;
    const from = normalizePath(doc.path);
    // Only the document that actually owns this key contributes edges, so a duplicate path
    // cannot double-count references or tags.
    if (!from || indexDocs[from] !== doc) continue;

    const links = Array.isArray(doc.links) ? doc.links : [];
    const positions =
      Array.isArray(doc.linkPositions) && doc.linkPositions.length === links.length ? doc.linkPositions : null;

    for (let i = 0; i < links.length; i++) {
      const link = links[i];
      if (!link || typeof link.page !== 'string') continue;
      // `[[#Heading]]` / `[[#^block]]` addresses this very document: resolved by definition, so
      // it must never show up as a dangling link.
      if (!link.page) continue;

      const resolution = resolveWikiPage(lookup, link.page, doc.path);
      const target = resolution && typeof resolution.path === 'string' ? normalizePath(resolution.path) : '';
      // Membership check, not just a null check: it also rejects the prototype-leak shape above
      // and any path the lookup claims but this index does not actually hold.
      if (!target || !hasOwn(indexDocs, target)) {
        const bucket = unresolved[from];
        if (bucket) bucket.push(link);
        else unresolved[from] = [link];
        continue;
      }

      const position = positions ? positions[i] : null;
      const ref: BacklinkRef = {
        from: doc.path,
        line: position && Number.isFinite(position.line) && position.line >= 1 ? Math.floor(position.line) : 1,
        context: position && typeof position.context === 'string' ? clipContext(position.context) : ''
      };
      const refs = backlinks[target];
      if (refs) refs.push(ref);
      else backlinks[target] = [ref];
    }
  }

  return { docs: indexDocs, lookup, backlinks, tagCounts, unresolved };
}

/**
 * References pointing at `path`, in scan order.
 *
 * A self-link (`[[a]]` inside `a.md`) is kept: it is a real edge in the graph, and it is what
 * makes a cyclic embed observable. The panel hides it with `from !== path` when it wants to.
 */
export function backlinksOf(index: WorkspaceIndex, path: string): BacklinkRef[] {
  if (!index || !index.backlinks) return [];
  const key = normalizePath(path);
  if (!key || !hasOwn(index.backlinks, key)) return [];
  const list = index.backlinks[key];
  // Copied: panels sort and filter this for display and must not reorder the index itself.
  return Array.isArray(list) ? list.slice() : [];
}

/** Canonical tag text: `#alpha` and ` alpha ` name the same tag. */
function normalizeTag(tag: unknown): string {
  return typeof tag === 'string' ? tag.trim().replace(/^#+/, '') : '';
}

/** Documents carrying `tag`, as their original absolute paths, sorted for a stable panel order. */
export function docsWithTag(index: WorkspaceIndex, tag: string): string[] {
  const want = normalizeTag(tag);
  if (!want || !index || !index.docs) return [];
  const out: string[] = [];
  for (const key of Object.keys(index.docs)) {
    const doc = index.docs[key];
    if (!doc || !Array.isArray(doc.tags)) continue;
    if (doc.tags.some((candidate) => normalizeTag(candidate) === want)) out.push(doc.path);
  }
  return out.sort(compareStrings);
}

/** Every tag with its document count: count descending, then tag ascending. */
export function allTags(index: WorkspaceIndex): Array<{ tag: string; count: number }> {
  const counts = index && index.tagCounts ? index.tagCounts : {};
  const out: Array<{ tag: string; count: number }> = [];
  for (const tag of Object.keys(counts)) {
    const count = counts[tag];
    if (!tag || !Number.isFinite(count) || count <= 0) continue;
    out.push({ tag, count });
  }
  return out.sort((a, b) => b.count - a.count || compareStrings(a.tag, b.tag));
}
