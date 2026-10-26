import { maskFencedCode } from './wikiLink';
import { normalizePath } from './workspaceIndex';

/**
 * "Unlinked mentions": places where a note is named in plain text but not linked.
 *
 * This is the other half of the backlink panel. A backlink proves the author remembered the
 * `[[...]]` syntax; a plain mention only proves they wrote the name, which is exactly the
 * moment a links panel is worth opening - the note is already discussed, it just is not wired.
 *
 * Deliberately a pure function over `{path, content}` pairs: the panel can pass the host's
 * text cache (already bounded by the index build) and get back rows it can render, with no
 * disk access of its own and nothing to keep in sync.
 */
export interface MentionTarget {
  /** Absolute path of the note being described. */
  path: string;
  /** File name, with or without the `.md` suffix. */
  name: string;
  /** Frontmatter aliases, if the note declares any. */
  aliases?: string[];
}

export interface MentionHit {
  docPath: string;
  /** 1-based line number in the mentioning document. */
  line: number;
  /** The mentioning line, whitespace-collapsed and truncated. */
  snippet: string;
  /** Which term matched, so the panel can say why this row is here. */
  term: string;
}

export interface MentionOptions {
  /** Hits per document. A note that says the name 40 times is one row, not forty. */
  limitPerDoc?: number;
  /** Documents scanned. The panel is a sidebar, not a report. */
  maxDocs?: number;
  /** Snippet length cap before truncation. */
  snippetMax?: number;
}

const DEFAULTS = { limitPerDoc: 3, maxDocs: 200, snippetMax: 160 } as const;

/** Existing `[[...]]` / `![[...]]` spans, matched on the masked text. */
const WIKILINK_SPAN = /!?\[\[[^[\]\n]{1,512}\]\]/g;

/** Latin word character. CJK has no word boundaries, so only these stop a match from being one. */
const WORD_CHAR = /[A-Za-z0-9_]/;

/** Blank a span in place, preserving length so offsets on the masked text stay meaningful. */
function blankSpan(text: string, start: number, end: number): string {
  return text.slice(0, start) + ' '.repeat(end - start) + text.slice(end);
}

/**
 * Candidate search terms for a note: its file name (with and without the extension) and its
 * aliases.
 *
 * The base name gates the whole list: a note called `a.md` describes itself with one character,
 * and matching that would flag most of the workspace as a mention. Aliases shorter than two
 * characters are dropped for the same reason.
 */
export function mentionTerms(target: MentionTarget): string[] {
  const name = String(target.name ?? '').trim();
  const base = name.replace(/\.(md|markdown|txt)$/i, '').trim();
  if (base.length < 2) return [];

  const seen = new Set<string>();
  const out: string[] = [];
  for (const term of [name, base, ...(target.aliases ?? [])]) {
    const trimmed = String(term ?? '').trim();
    if (trimmed.length < 2) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
  }
  return out;
}

/** Collapse runs of whitespace so a snippet stays a single visual line. */
function collapse(text: string): string {
    return text.replace(/\s+/g, ' ').trim();
}

/** True when the match at `at` sits inside a longer Latin word (`alpha` in `alphabet`). */
function insideLatinWord(line: string, at: number, length: number): boolean {
  const before = at > 0 ? line[at - 1] : '';
  const after = at + length < line.length ? line[at + length] : '';
  return WORD_CHAR.test(before) || WORD_CHAR.test(after);
}

/**
 * Find plain-text mentions of `target` across `docs`.
 *
 * Fenced code, inline code and every existing `[[link]]` on the same document are masked before
 * searching: the first two are examples rather than prose, and a link is already a backlink -
 * counting it again would make the panel claim the note is discussed where it is already wired.
 */
export function findUnlinkedMentions(
  docs: Array<{ path: string; content: string }>,
  target: MentionTarget,
  options: MentionOptions = {}
): MentionHit[] {
  const limitPerDoc = Math.max(1, options.limitPerDoc ?? DEFAULTS.limitPerDoc);
  const maxDocs = Math.max(1, options.maxDocs ?? DEFAULTS.maxDocs);
  const snippetMax = Math.max(20, options.snippetMax ?? DEFAULTS.snippetMax);

  const terms = mentionTerms(target);
  const targetKey = normalizePath(target.path);
  if (terms.length === 0) return [];

  const hits: MentionHit[] = [];
  for (const doc of docs.slice(0, maxDocs)) {
    if (normalizePath(doc.path) === targetKey) continue;
    const content = String(doc.content ?? '');
    if (!content) continue;

    // Mask, then mask again: maskFencedCode() covers fences and inline code spans, and the
    // link pass is applied on top so a mention inside `[[note]]` cannot survive into a hit.
    let masked = maskFencedCode(content);
    let match: RegExpExecArray | null;
    WIKILINK_SPAN.lastIndex = 0;
    while ((match = WIKILINK_SPAN.exec(masked)) !== null) {
      masked = blankSpan(masked, match.index, match.index + match[0].length);
      WIKILINK_SPAN.lastIndex = match.index + match[0].length;
    }

    // Split both texts together so a hit can report the original line, not the masked one.
    const maskedLines = masked.split('\n');
    const plainLines = content.split('\n');
    let perDoc = 0;
    const hitLines = new Set<number>();

    for (let i = 0; i < maskedLines.length && perDoc < limitPerDoc; i += 1) {
      const maskedLine = maskedLines[i];
      if (!maskedLine) continue;
      const lower = maskedLine.toLowerCase();

      for (const term of terms) {
        const needle = term.toLowerCase();
        let at = lower.indexOf(needle);
        while (at !== -1) {
          if (!insideLatinWord(maskedLine, at, needle.length)) break;
          at = lower.indexOf(needle, at + needle.length);
        }
        if (at === -1) continue;
        if (hitLines.has(i)) break; // one row per line, whichever term matched first
        hitLines.add(i);

        const snippet = collapse(plainLines[i] ?? '');
        hits.push({
          docPath: doc.path,
          line: i + 1,
          snippet: snippet.length > snippetMax ? `${snippet.slice(0, snippetMax - 1)}…` : snippet,
          term
        });
        perDoc += 1;
        break;
      }
    }
  }

  return hits.sort((a, b) => a.docPath.localeCompare(b.docPath) || a.line - b.line);
}
