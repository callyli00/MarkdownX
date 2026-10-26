/**
 * Vault-wide search: the query language, the line scanner and the replace planner behind the
 * search panel.
 *
 * Pure on purpose - no DOM, no Tauri, no filesystem - exactly like workspaceIndex.ts. The caller
 * owns the vault walk and hands in `SearchDoc`s; every function here is a function of
 * (docs, query) alone, so the panel can run a search on the main thread, in a Worker, or in a
 * test with no WebView at all.
 *
 * The decisions that are NOT visible from the signatures, written down once here instead of
 * being rediscovered from five scattered comments:
 *
 *  1. `column` is 1-based and counted in UTF-16 code units of the line with its trailing `\r`
 *     stripped (see `forEachLine`). The repository has no other column convention to follow;
 *     editors want 1-based, and a `\r` is not part of the line for any purpose a user can see.
 *  2. Free words / phrases are a same-line AND: every term must appear on the SAME line, in any
 *     order. That is the only rule that keeps a hit's one-line `context` honest.
 *  3. `context` is the hit's line, trimmed and then clipped to 200 characters - the same number
 *     and the same trim-then-clip order as workspaceIndex.ts's `LinkPosition.context`.
 *  4. A single document body over 2 MB is skipped, never searched. The size is measured as
 *     `content.length` (UTF-16 code units), which is a cheap upper-bound-free proxy for bytes -
 *     counting real UTF-8 bytes would need Buffer/TextEncoder, and this module is platform-free.
 *  5. The scan is bounded: at most `limit` (default 200) hits are returned, `total` stops
 *     counting at 5000 so one query cannot freeze the UI, and `truncated` says whether anything
 *     was withheld. `filesWithHits` counts documents that produced at least one counted match,
 *     which is why it stops growing once the 5000 total cap is reached.
 *  6. A filter-only query (`tag:foo` with no text) returns no hits. `SearchHit` is a line, and a
 *     filter alone does not select one; callers that want "every note with this tag" want
 *     `docsWithTag` from workspaceIndex.ts instead. This is a deliberate gap, not an oversight.
 *
 * Negation (`-word`) is LINE-level text exclusion, which is what the `exclude: string[]` field
 * can express. There is no "not this tag" or "not this path": a negated operator such as
 * `-tag:foo` is kept as the literal text `tag:foo`, because the contract has no field for a
 * negative filter. Likewise `ParsedQuery` carries exactly one `/regex/`; a second one in the same
 * query is ignored rather than silently merged into something the caller cannot see.
 */

import { normalizePath } from './workspaceIndex';

/** One searchable document. Shaped so a vault walk can build it without importing the index. */
export interface SearchDoc {
  /** Path as the app holds it (`C:\vault\note.md`). Hits report it back, `planReplace` groups by it. */
  path: string;
  /** Base name including the extension. Falls back to the basename of `path` when empty. */
  name: string;
  /** Raw Markdown source. */
  content: string;
  /** `#tag` names without the `#`, the shape `scanTags` returns. Nested tags keep their `/`. */
  tags?: string[];
  /**
   * ATX headings with character offsets. `workspaceIndex.ts`'s `HeadingRef` satisfies this shape,
   * and its extra `level` field is honoured for section ranges when present (see `sectionSpansOf`).
   */
  headings?: { text: string; slug: string; offset: number }[];
}

/** A parsed query. Built by `parseVaultQuery`; hand-built ones are tolerated field by field. */
export interface ParsedQuery {
  /** The query exactly as typed, for round-tripping into the search box. */
  raw: string;
  /**
   * The free-text words, joined by single spaces. Operators, quotes and regex tokens are not in
   * here; `searchVault` splits it again on whitespace, so the two forms are interchangeable.
   */
  text: string;
  /** `"quoted phrases"`, quotes removed. Each must appear verbatim on the hit's line. */
  phrases: string[];
  /** The single `/pattern/flags` token, or null. `i` is added unless `caseSensitive`. */
  regex: RegExp | null;
  /** `tag:` values, `#` stripped. A value matches its own tag and any nested tag under it. */
  tags: string[];
  /** `path:` values: substring of the normalised path, or a `*` / `?` glob on it. */
  paths: string[];
  /** `section:` values: headings to search inside, `#` stripped. */
  sections: string[];
  /** `file:` values: substring or glob on the document's base name. */
  files: string[];
  /** `task:todo` / `task:done`, or null when the query has neither. */
  tasks: 'todo' | 'done' | null;
  /** `-word` / `-"phrase"` terms: a line containing any of them is dropped. */
  exclude: string[];
  /** `match-case:` appeared in the query. */
  caseSensitive: boolean;
  /** `whole-word:` appeared in the query. Applies to text and phrases, not to a user regex. */
  wholeWord: boolean;
}

/** One occurrence of the query on one line. */
export interface SearchHit {
  /** The document's path in the form it was scanned. */
  path: string;
  /** The document's base name, for the result row's title. */
  name: string;
  /** 1-based line number, i.e. what an editor gutter shows. */
  line: number;
  /** 1-based column, in code units of the line without its trailing `\r`. */
  column: number;
  /** Character offset into `SearchDoc.content`; what `planReplace` consumes. */
  offset: number;
  /** Length of the matched text, in code units. Never 0 (zero-width matches are skipped). */
  length: number;
  /** The matched text, sliced out of the document. */
  text: string;
  /** The whole source line, trimmed and clipped to 200 characters. */
  context: string;
}

export interface VaultSearchResult {
  /** The hits that fit under `limit`, in document order then by position. */
  hits: SearchHit[];
  /** Every counted match, including the ones past `limit`; capped at 5000. */
  total: number;
  /** True when `hits` or `total` withheld anything. */
  truncated: boolean;
  /** Number of documents that produced at least one counted match. */
  filesWithHits: number;
}

/** One document's planned replacement. Nothing here touches the disk. */
export interface FileEdit {
  /** The document's path in the form it was scanned. */
  path: string;
  /** Original source, so the caller can diff or undo without re-reading the file. */
  before: string;
  /** Source after every planned replacement. CRLF is preserved as-is. */
  after: string;
  /** How many hits were actually applied (overlapping or out-of-range hits are skipped). */
  count: number;
}

/** Longest context snippet a result row shows before it stops being a row. */
const CONTEXT_MAX = 200;

/** Hits returned when the caller does not ask for a number. */
const DEFAULT_LIMIT = 200;

/** Hard stop for `total`: past this the panel's "N results" label is already meaningless. */
const TOTAL_CAP = 5000;

/** Per-document body ceiling (code units); see decision 4 in the file header. */
const MAX_DOC_LENGTH = 2 * 1024 * 1024;

/** Per-matcher, per-line occurrence ceiling: bounds a pathological dot-star pattern on a 2 MB line. */
const MAX_MATCHES_PER_MATCHER = 1000;

/** `- [ ] item` / `* [ ]` / `1. [ ]`. Obsidian accepts all three list markers. */
const TODO_LINE_RE = /^[ \t]*(?:[-*+]|\d+[.)])[ \t]+\[ \]/;
const DONE_LINE_RE = /^[ \t]*(?:[-*+]|\d+[.)])[ \t]+\[[xX]\]/;

/** Operator names the parser understands. Anything else with a colon stays plain text. */
const OPERATOR_RE = /^([A-Za-z][A-Za-z-]*):/;
const OPERATORS = new Set(['tag', 'path', 'file', 'section', 'task', 'match-case', 'whole-word']);

/** Flags a stored `ParsedQuery.regex` may keep; `g`/`y` are excluded on purpose (see below). */
const REGEX_FLAG_KEEP = 'imsu';

/** Values that turn a `match-case:` / `whole-word:` toggle back off. */
const OFF_WORDS = ['0', 'false', 'off', 'no'];

/**
 * Heading as `searchVault` reads it: the contract fields plus an optional `level`.
 *
 * `level` is optional because `SearchDoc.headings` does not require it - the interface is the
 * documented contract, and widening it would break hand-built documents. `HeadingRef` from
 * workspaceIndex.ts carries it, so a real index keeps proper nesting; a bare `{text,slug,offset}`
 * degrades every heading to level 1, which means "a section ends at the next heading".
 */
interface HeadingWithLevel {
  text: string;
  slug: string;
  offset: number;
  level?: number;
}

interface SectionSpan {
  start: number;
  end: number;
  text: string;
  slug: string;
}

interface Occurrence {
  index: number;
  length: number;
}

/** A prepared same-line matcher. `re` always carries `g`; `lastIndex` is reset before each line. */
interface LineMatcher {
  re: RegExp;
  /** Text and phrase terms get boundary checks; a user regex carries its own `\b`. */
  wholeWord: boolean;
}

/** A token straight out of the scanner, before the query stops caring about its origin. */
interface RawToken {
  kind: 'word' | 'phrase' | 'regex' | 'operator' | 'toggle';
  /** Lowercase operator name for `operator` / `toggle`; empty otherwise. */
  name: string;
  /** Token payload: text for word/phrase, pattern source for regex, value for operator. */
  value: string;
  /** Regex flags as written; only ever filled for `regex`. */
  flags: string;
  negated: boolean;
}

function isSpace(ch: string): boolean {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f' || ch === '\v';
}

function basenameOf(path: string): string {
  const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return cut === -1 ? path : path.slice(cut + 1);
}

/** `#alpha`, ` alpha ` and actual `alpha` name the same tag, same rule as workspaceIndex.ts. */
function normalizeTagValue(tag: string): string {
  return tag.trim().replace(/^#+/, '');
}

/** `section:## Usage` and `section:Usage` address the same heading. */
function normalizeSectionValue(section: string): string {
  return section
    .trim()
    .replace(/^#+\s*/, '')
    .trim();
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const trimmed = item.trim();
    if (trimmed) out.push(trimmed);
  }
  return out;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Boundary test for `whole-word:`.
 *
 * A boundary is only required on a side whose adjacent character is itself a word character:
 * `#todo` starts with `#`, so there is nothing to bound on the left, while its `o` still cannot
 * be followed by another letter. `\w` alone is not enough because it misses CJK: every code unit
 * above ASCII is treated as a word character, so `中` in `中文` counts as part of the word.
 */
function isWordCode(code: number): boolean {
  return (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || code === 95 || code > 127;
}

function wholeWordOk(line: string, index: number, length: number): boolean {
  const before = index > 0 ? line.charCodeAt(index - 1) : -1;
  const after = index + length < line.length ? line.charCodeAt(index + length) : -1;
  if (before !== -1 && isWordCode(before) && isWordCode(line.charCodeAt(index))) return false;
  if (after !== -1 && isWordCode(after) && isWordCode(line.charCodeAt(index + length - 1))) return false;
  return true;
}

/** Trim, then clip: a 3 MB single-line document must not end up in a result row. */
function clipContext(line: string): string {
  const trimmed = line.trim();
  return trimmed.length > CONTEXT_MAX ? trimmed.slice(0, CONTEXT_MAX) : trimmed;
}

/**
 * Walk `content` line by line, handing out the line text (trailing `\r` removed), its start
 * offset and its 0-based index. Returning `false` from `visit` stops the walk.
 *
 * `\n` and `\r\n` both end a line, and the `\r` is excluded from the line text but still counted
 * in every offset - which is the whole point: a character offset must match what
 * `String.prototype.slice` sees, so a CRLF document is one code unit wider per line.
 */
function forEachLine(content: string, visit: (line: string, lineStart: number, lineIndex: number) => boolean): void {
  let start = 0;
  let index = 0;
  for (;;) {
    const newline = content.indexOf('\n', start);
    const end = newline === -1 ? content.length : newline;
    const lineEnd = end > start && content.charCodeAt(end - 1) === 13 ? end - 1 : end;
    if (!visit(content.slice(start, lineEnd), start, index)) return;
    if (newline === -1) return;
    start = newline + 1;
    index++;
  }
}

/**
 * Read one `/pattern/flags` token, or null when the slashes are not a regex.
 *
 * `and/or` and `2024/05` must stay plain words, so a whitespace-terminated run aborts the token
 * instead of swallowing the rest of the query. The pattern text is passed to the RegExp
 * constructor verbatim, escapes included: `/a\/b/` has to compile to `a\/b`.
 */
function readRegexToken(text: string, start: number): { source: string; flags: string; end: number } | null {
  let i = start + 1;
  let source = '';
  while (i < text.length) {
    const ch = text.charAt(i);
    if (ch === '\\') {
      const next = text.charAt(i + 1);
      if (!next) return null;
      source += ch + next;
      i += 2;
      continue;
    }
    if (ch === '/') break;
    if (isSpace(ch)) return null;
    source += ch;
    i++;
  }
  if (i >= text.length || text.charAt(i) !== '/' || !source) return null;
  i++;
  let flags = '';
  while (i < text.length && /[A-Za-z]/.test(text.charAt(i))) {
    flags += text.charAt(i);
    i++;
  }
  return { source, flags, end: i };
}

/**
 * Compile a user pattern, or null when it is not a valid regex.
 *
 * `g` and `y` are stripped: the result is stored on the parsed query, and a stateful `lastIndex`
 * would make `query.regex.test(line)` answer true/false alternately. `searchVault` re-creates a
 * global copy for its own scan. Unsupported or unknown flags are dropped rather than throwing.
 */
function compileRegex(source: string, flags: string, caseSensitive: boolean): RegExp | null {
  let kept = '';
  for (const flag of flags) {
    if (REGEX_FLAG_KEEP.includes(flag) && !kept.includes(flag)) kept += flag;
  }
  if (!caseSensitive && !kept.includes('i')) kept += 'i';
  const ordered = REGEX_FLAG_KEEP.split('')
    .filter((flag) => kept.includes(flag))
    .join('');
  try {
    return new RegExp(source, ordered);
  } catch {
    // `/foo(/` is a typo, not a reason to lose the query: the caller searches for it literally.
    return null;
  }
}

/** Split the raw query into tokens. Operators are recognised here so their values may be quoted. */
function scanTokens(text: string): RawToken[] {
  const out: RawToken[] = [];
  let i = 0;
  while (i < text.length) {
    if (isSpace(text.charAt(i))) {
      i++;
      continue;
    }
    let negated = false;
    if (text.charAt(i) === '-' && i + 1 < text.length && !isSpace(text.charAt(i + 1))) {
      negated = true;
      i++;
    }
    const head = text.charAt(i);

    if (head === '"') {
      const close = text.indexOf('"', i + 1);
      out.push({ kind: 'phrase', name: '', value: text.slice(i + 1, close === -1 ? text.length : close), flags: '', negated });
      i = close === -1 ? text.length : close + 1;
      continue;
    }

    if (head === '/') {
      const parsed = readRegexToken(text, i);
      if (parsed) {
        out.push({ kind: 'regex', name: '', value: parsed.source, flags: parsed.flags, negated });
        i = parsed.end;
        continue;
      }
      // Not a regex after all: fall through so `and/or` is scanned as the word it is.
    }

    const op = OPERATOR_RE.exec(text.slice(i));
    if (op && OPERATORS.has(op[1].toLowerCase())) {
      const name = op[1].toLowerCase();
      let at = i + op[0].length;
      let value: string;
      if (text.charAt(at) === '"') {
        const close = text.indexOf('"', at + 1);
        value = text.slice(at + 1, close === -1 ? text.length : close);
        at = close === -1 ? text.length : close + 1;
      } else {
        const valueStart = at;
        while (at < text.length && !isSpace(text.charAt(at))) at++;
        value = text.slice(valueStart, at);
      }
      const toggle = name === 'match-case' || name === 'whole-word';
      out.push({ kind: toggle ? 'toggle' : 'operator', name, value, flags: '', negated });
      i = at;
      continue;
    }

    const wordStart = i;
    while (i < text.length && !isSpace(text.charAt(i))) i++;
    out.push({ kind: 'word', name: '', value: text.slice(wordStart, i), flags: '', negated });
  }
  return out;
}

/**
 * Turn a raw query string into the structure `searchVault` consumes. Never throws.
 *
 * Toggles are read in a first pass so `foo /bar/ match-case:` behaves like
 * `match-case: foo /bar/`: a case-sensitivity flag that only works when written first is the kind
 * of papercut nobody reports and everybody works around.
 */
export function parseVaultQuery(raw: string): ParsedQuery {
  const source = typeof raw === 'string' ? raw : '';
  const tokens = scanTokens(source);

  let caseSensitive = false;
  let wholeWord = false;
  for (const token of tokens) {
    if (token.kind !== 'toggle') continue;
    const on = !token.negated && !OFF_WORDS.includes(token.value.trim().toLowerCase());
    if (token.name === 'match-case') caseSensitive = on;
    else wholeWord = on;
  }

  const words: string[] = [];
  const phrases: string[] = [];
  const tags: string[] = [];
  const paths: string[] = [];
  const sections: string[] = [];
  const files: string[] = [];
  const exclude: string[] = [];
  let tasks: 'todo' | 'done' | null = null;
  let regex: RegExp | null = null;

  for (const token of tokens) {
    if (token.kind === 'toggle') continue;

    if (token.kind === 'regex') {
      if (token.negated) {
        // No field can express "this line must not match": fall back to literal exclusion.
        exclude.push(token.value);
        continue;
      }
      const compiled = compileRegex(token.value, token.flags, caseSensitive);
      if (!compiled) {
        phrases.push(token.value);
        continue;
      }
      if (!regex) regex = compiled;
      continue;
    }

    if (token.kind === 'operator') {
      const value = token.value.trim();
      if (!value) continue;
      if (token.negated) {
        // See the header: negation is line-level text exclusion, so `-tag:foo` cannot mean
        // "not tagged foo". Keeping the literal text is at least visible in `exclude`.
        exclude.push(`${token.name}:${value}`);
        continue;
      }
      switch (token.name) {
        case 'tag':
          tags.push(normalizeTagValue(value));
          break;
        case 'path':
          paths.push(value);
          break;
        case 'file':
          files.push(value);
          break;
        case 'section':
          sections.push(normalizeSectionValue(value));
          break;
        case 'task': {
          const state = value.toLowerCase();
          if (state === 'todo' || state === 'done') tasks = state;
          // `task:someday` is not a state this module knows; search for the text instead of
          // dropping the token, so the user sees why they got no results.
          else words.push(`task:${value}`);
          break;
        }
        default:
          words.push(`${token.name}:${value}`);
          break;
      }
      continue;
    }

    if (token.negated) {
      if (token.value) exclude.push(token.value);
      continue;
    }
    if (!token.value) continue;
    if (token.kind === 'phrase') phrases.push(token.value);
    else words.push(token.value);
  }

  return {
    raw: source,
    text: words.join(' '),
    phrases,
    regex,
    tags,
    paths,
    sections,
    files,
    tasks,
    exclude,
    caseSensitive,
    wholeWord
  };
}

/** `doc.tags` as comparable values: `#` stripped, blanks dropped. */
function tagsOf(doc: SearchDoc): string[] {
  const raw: string[] = Array.isArray(doc.tags) ? doc.tags : [];
  const out: string[] = [];
  for (const tag of raw) {
    if (typeof tag !== 'string') continue;
    const value = normalizeTagValue(tag);
    if (value) out.push(value);
  }
  return out;
}

/** A `tag:` value matches its own tag and everything nested under it: `foo` hits `foo/bar`. */
function hasTag(docTags: string[], wanted: string): boolean {
  const want = wanted.trim().replace(/^#+/, '').toLowerCase();
  if (!want) return true;
  for (const tag of docTags) {
    const value = tag.toLowerCase();
    if (value === want || value.startsWith(`${want}/`)) return true;
  }
  return false;
}

/** Glob body for `*` (one path segment), `**` (any depth) and `?` (one character). */
function globSource(pattern: string): string {
  let out = '';
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern.charAt(i);
    if (ch === '*') {
      if (pattern.charAt(i + 1) === '*') {
        out += '.*';
        i++;
      } else {
        out += '[^/]*';
      }
      continue;
    }
    if (ch === '?') {
      out += '[^/]';
      continue;
    }
    out += /[.*+?^${}()|[\]\\/]/.test(ch) ? `\\${ch}` : ch;
  }
  return out;
}

function hasWildcard(pattern: string): boolean {
  return pattern.includes('*') || pattern.includes('?');
}

/**
 * `path:` match against a normalised path.
 *
 * A plain value is a substring test (`path:daily` finds `C:/vault/daily/2024.md`). A glob is
 * anchored at a segment boundary, so `path:sub/*.md` matches `C:/vault/sub/a.md` without the
 * caller having to know where the vault root is - this module is never told.
 */
function pathMatches(normalizedPath: string, pattern: string): boolean {
  const want = normalizePath(pattern).toLowerCase();
  if (!want) return true;
  const haystack = normalizedPath.toLowerCase();
  if (hasWildcard(want)) return new RegExp(`(?:^|/)${globSource(want)}$`).test(haystack);
  return haystack.includes(want);
}

/** `file:` match against the base name: substring, or a whole-name glob (`*.md`, `note-?.md`). */
function fileMatches(name: string, pattern: string): boolean {
  const want = (pattern || '').trim().toLowerCase();
  if (!want) return true;
  const base = (name || '').toLowerCase();
  if (hasWildcard(want)) return new RegExp(`^${globSource(want)}$`).test(base);
  return base.includes(want);
}

/**
 * Character spans of every heading's section: from the heading's own line to the next heading of
 * the same or a higher level (a `###` under a `##` belongs to the `##`).
 *
 * Headings are sorted by offset first: callers may hand in any order, and a span computed from an
 * unsorted list would silently cut sections at the wrong line.
 */
function sectionSpansOf(headings: HeadingWithLevel[], contentLength: number): SectionSpan[] {
  const list: Array<{ text: string; slug: string; offset: number; level: number }> = [];
  for (const heading of headings) {
    if (!heading || typeof heading.offset !== 'number' || !Number.isFinite(heading.offset)) continue;
    list.push({
      text: typeof heading.text === 'string' ? heading.text : '',
      slug: typeof heading.slug === 'string' ? heading.slug : '',
      offset: Math.max(0, Math.floor(heading.offset)),
      // No level means "same rank as everything else" -> a section ends at the next heading.
      level: typeof heading.level === 'number' && heading.level >= 1 ? Math.floor(heading.level) : 1
    });
  }
  list.sort((a, b) => a.offset - b.offset);
  const spans: SectionSpan[] = [];
  for (let i = 0; i < list.length; i++) {
    let end = contentLength;
    for (let j = i + 1; j < list.length; j++) {
      if (list[j].level <= list[i].level) {
        end = list[j].offset;
        break;
      }
    }
    spans.push({ start: list[i].offset, end, text: list[i].text, slug: list[i].slug });
  }
  return spans;
}

/** Sections named by the query. Several `section:` values are a union, never an intersection. */
function selectedSections(spans: SectionSpan[], wanted: string[]): SectionSpan[] {
  const wants = wanted.map((value) => value.toLowerCase());
  return spans.filter(
    (span) =>
      wants.includes(span.text.toLowerCase()) || (span.slug ? wants.includes(span.slug.toLowerCase()) : false)
  );
}

/** Occurrences of one prepared matcher on one line. Zero-width matches are skipped, not counted. */
function occurrencesOf(matcher: LineMatcher, line: string): Occurrence[] {
  const re = matcher.re;
  re.lastIndex = 0;
  const out: Occurrence[] = [];
  let match: RegExpExecArray | null;
  while ((match = re.exec(line)) !== null) {
    if (match[0].length === 0) {
      // `/(?=x)/` and `/^/` match without consuming: `exec` would return the same index forever.
      re.lastIndex = Math.max(re.lastIndex + 1, match.index + 1);
      continue;
    }
    if (matcher.wholeWord && !wholeWordOk(line, match.index, match[0].length)) continue;
    out.push({ index: match.index, length: match[0].length });
    if (out.length >= MAX_MATCHES_PER_MATCHER) break;
  }
  return out;
}

/**
 * All occurrences on one line, or `[]` when any matcher missed - that is the same-line AND.
 *
 * Results are ordered by position so a result list reads left to right, and exact duplicates
 * (`foo foo` querying `foo`) collapse into one hit, because two identical hits at one offset
 * would become two overlapping replacements in `planReplace`.
 */
function matchLine(line: string, matchers: LineMatcher[]): Occurrence[] {
  const found: Occurrence[] = [];
  for (const matcher of matchers) {
    const occurrences = occurrencesOf(matcher, line);
    if (occurrences.length === 0) return [];
    for (const occurrence of occurrences) found.push(occurrence);
  }
  found.sort((a, b) => a.index - b.index || b.length - a.length);
  const out: Occurrence[] = [];
  for (const occurrence of found) {
    const last = out[out.length - 1];
    if (last && last.index === occurrence.index && last.length === occurrence.length) continue;
    out.push(occurrence);
  }
  return out;
}

/** `g` is mandatory for the scan; `y` would stop at the first non-match, so it is dropped. */
function ensureGlobal(flags: string): string {
  let out = '';
  for (const flag of flags) {
    if (flag === 'g' || flag === 'y' || out.includes(flag)) continue;
    out += flag;
  }
  return `${out}g`;
}

/** Search one document set. Pure: same docs and query always produce the same result. */
export function searchVault(docs: SearchDoc[], query: ParsedQuery, opts?: { limit?: number }): VaultSearchResult {
  const hits: SearchHit[] = [];
  const empty: VaultSearchResult = { hits, total: 0, truncated: false, filesWithHits: 0 };

  // Everything below is untrusted input as far as this module is concerned: the panels build
  // these objects from state, and a partially-filled query must degrade, never throw.
  const source = query && typeof query === 'object' ? query : null;
  if (!source) return empty;

  const caseSensitive = source.caseSensitive === true;
  const wholeWord = source.wholeWord === true;
  const text = typeof source.text === 'string' ? source.text : '';
  const words = text.split(/\s+/).filter(Boolean);
  const phrases = stringList(source.phrases).filter(Boolean);
  const tags = stringList(source.tags);
  const paths = stringList(source.paths);
  const files = stringList(source.files);
  const sections = stringList(source.sections);
  const exclude = stringList(source.exclude).map((term) => (caseSensitive ? term : term.toLowerCase()));
  const tasks = source.tasks === 'todo' || source.tasks === 'done' ? source.tasks : null;
  const regex = source.regex instanceof RegExp ? source.regex : null;

  // Decision 6 in the header: a filter alone selects no line, so it produces no hits.
  if (words.length === 0 && phrases.length === 0 && !regex) return empty;

  const textFlags = caseSensitive ? 'g' : 'gi';
  const matchers: LineMatcher[] = [];
  for (const word of words) matchers.push({ re: new RegExp(escapeRegExp(word), textFlags), wholeWord });
  for (const phrase of phrases) matchers.push({ re: new RegExp(escapeRegExp(phrase), textFlags), wholeWord });
  if (regex) matchers.push({ re: new RegExp(regex.source, ensureGlobal(regex.flags)), wholeWord: false });

  const requested = opts && typeof opts.limit === 'number' && Number.isFinite(opts.limit) ? Math.floor(opts.limit) : DEFAULT_LIMIT;
  const limit = requested > 0 ? requested : DEFAULT_LIMIT;

  const list: SearchDoc[] = Array.isArray(docs) ? docs : [];
  let total = 0;
  let filesWithHits = 0;
  let capped = false;

  for (const doc of list) {
    if (capped) break;
    if (!doc || typeof doc.path !== 'string') continue;
    const path = normalizePath(doc.path);
    // A document with no usable path cannot be opened, so a hit in it cannot be acted on.
    if (!path) continue;
    const content = typeof doc.content === 'string' ? doc.content : '';
    // Decision 4: a 2 MB note is a data file, not a note; scanning it would stall the panel.
    if (content.length > MAX_DOC_LENGTH) continue;

    const docTags = tagsOf(doc);
    if (tags.length && !tags.every((tag) => hasTag(docTags, tag))) continue;
    if (paths.length && !paths.every((pattern) => pathMatches(path, pattern))) continue;
    const name = typeof doc.name === 'string' && doc.name ? doc.name : basenameOf(doc.path);
    if (files.length && !files.every((pattern) => fileMatches(name, pattern))) continue;

    let spans: SectionSpan[] | null = null;
    if (sections.length) {
      const headings: HeadingWithLevel[] = Array.isArray(doc.headings) ? doc.headings : [];
      spans = selectedSections(sectionSpansOf(headings, content.length), sections);
      // The document has none of the requested sections: nothing in it can match.
      if (spans.length === 0) continue;
    }

    let hasHit = false;
    forEachLine(content, (line, lineStart, lineIndex) => {
      if (tasks === 'todo' && !TODO_LINE_RE.test(line)) return true;
      if (tasks === 'done' && !DONE_LINE_RE.test(line)) return true;
      if (spans && !spans.some((span) => lineStart >= span.start && lineStart < span.end)) return true;
      if (exclude.length > 0) {
        const folded = caseSensitive ? line : line.toLowerCase();
        if (exclude.some((term) => folded.includes(term))) return true;
      }

      const occurrences = matchLine(line, matchers);
      if (occurrences.length === 0) return true;

      hasHit = true;
      const context = clipContext(line);
      for (const occurrence of occurrences) {
        if (total >= TOTAL_CAP) {
          capped = true;
          return false;
        }
        total++;
        if (hits.length >= limit) continue;
        hits.push({
          path: doc.path,
          name,
          line: lineIndex + 1,
          column: occurrence.index + 1,
          offset: lineStart + occurrence.index,
          length: occurrence.length,
          text: line.slice(occurrence.index, occurrence.index + occurrence.length),
          context
        });
      }
      return true;
    });
    if (hasHit) filesWithHits++;
  }

  return { hits, total, truncated: capped || total > hits.length, filesWithHits };
}

/**
 * Plan a "replace all" without touching anything: for every document with hits, splice
 * `replacement` over each hit's range, from the END of the document backwards.
 *
 * Backwards is not a micro-optimisation, it is the only order that keeps earlier offsets valid:
 * replacing left to right shifts every later offset by `replacement.length - hit.length`, so a
 * same-line replacement corrupts the next hit. Because each splice happens inside the original
 * string, a `\r\n` between two hits is never rewitten - CRLF documents stay CRLF.
 *
 * Overlapping, duplicate and out-of-range hits are skipped rather than clamped: a clamped splice
 * would silently edit text the user never selected. `count` therefore reports what was applied.
 */
export function planReplace(docs: SearchDoc[], hits: SearchHit[], replacement: string): FileEdit[] {
  const list: SearchDoc[] = Array.isArray(docs) ? docs : [];
  const hitList: SearchHit[] = Array.isArray(hits) ? hits : [];
  const insert = typeof replacement === 'string' ? replacement : '';

  const byPath = new Map<string, SearchHit[]>();
  for (const hit of hitList) {
    if (!hit || typeof hit.path !== 'string') continue;
    const key = normalizePath(hit.path);
    if (!key) continue;
    const bucket = byPath.get(key);
    if (bucket) bucket.push(hit);
    else byPath.set(key, [hit]);
  }

  const edits: FileEdit[] = [];
  for (const doc of list) {
    if (!doc || typeof doc.path !== 'string') continue;
    const key = normalizePath(doc.path);
    if (!key) continue;
    const bucket = byPath.get(key);
    if (!bucket) continue;
    // One edit per document: if the caller passes the same path twice, the first entry wins so
    // the plan cannot contain two conflicting rewrites of one file.
    byPath.delete(key);

    const before = typeof doc.content === 'string' ? doc.content : '';
    const ordered = bucket
      .filter((hit) => typeof hit.offset === 'number' && typeof hit.length === 'number')
      .sort((a, b) => b.offset - a.offset || b.length - a.length);

    let after = before;
    let count = 0;
    // Start of the already-rewritten region; a hit must end at or before it to not overlap.
    let appliedStart = Number.POSITIVE_INFINITY;
    for (const hit of ordered) {
      const offset = Math.floor(hit.offset);
      const length = Math.floor(hit.length);
      if (!Number.isFinite(offset) || !Number.isFinite(length)) continue;
      if (length <= 0 || offset < 0 || offset + length > before.length) continue;
      if (offset + length > appliedStart) continue;
      after = after.slice(0, offset) + insert + after.slice(offset + length);
      appliedStart = offset;
      count++;
    }
    if (count > 0) edits.push({ path: doc.path, before, after, count });
  }
  return edits;
}
