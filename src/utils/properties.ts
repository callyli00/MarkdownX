/**
 * B layer: YAML frontmatter / properties.
 *
 * Deliberately a SMALL subset of YAML, not a parser: this handles the shapes a note's
 * frontmatter actually uses - text, numbers, booleans, dates, inline lists `[a, b]`, block
 * lists (`- a` on following lines) and nested-looking keys are ignored. Anything else is
 * kept as plain text rather than guessed at, and a block that yields no properties at all
 * is reported as empty so the caller can leave the author's text completely alone.
 *
 * One rule taken from Obsidian's own documentation: property values are atomic metadata, and
 * Markdown inside them is NOT rendered. The card therefore escapes every value.
 */

export type PropertyKind = 'text' | 'number' | 'checkbox' | 'date' | 'list' | 'tags';

export interface Property {
  key: string;
  /** Display value (list entries joined with ', '). */
  value: string;
  kind: PropertyKind;
  /** Present for kind 'list' and 'tags'. */
  items?: string[];
}

const KEY_RE = /^([A-Za-z0-9_.\- ]+):[ \t]*(.*)$/;
const BLOCK_ITEM_RE = /^\s*-\s+(.*)$/;
const NUMBER_RE = /^-?\d+(?:\.\d+)?$/;
const BOOL_RE = /^(?:true|false|yes|no)$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2}(?::\d{2})?)?$/;

function stripQuotes(text: string): string {
  const t = text.trim();
  if (t.length >= 2 && ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'")))) {
    return t.slice(1, -1);
  }
  return t;
}

function detectKind(key: string, raw: string, items?: string[]): PropertyKind {
  if (items) return key.toLowerCase() === 'tags' ? 'tags' : 'list';
  if (BOOL_RE.test(raw)) return 'checkbox';
  if (DATE_RE.test(raw)) return 'date';
  if (NUMBER_RE.test(raw)) return 'number';
  return 'text';
}

/** Parse a frontmatter block (the text BETWEEN the `---` fences). */
export function parseFrontmatter(block: string): Property[] {
  const lines = block.split('\n');
  const out: Property[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim() || line.trim().startsWith('#')) { i++; continue; }
    const match = KEY_RE.exec(line);
    if (!match) { i++; continue; }                      // not a key/value line: skip, never guess
    const key = match[1].trim();
    const raw = match[2].trim();

    if (raw === '') {
      const items: string[] = [];
      let j = i + 1;
      while (j < lines.length) {
        const it = BLOCK_ITEM_RE.exec(lines[j]);
        if (!it) break;
        items.push(stripQuotes(it[1]));
        j++;
      }
      if (items.length > 0) {
        const kind = key.toLowerCase() === 'tags' ? 'tags' : 'list';
        out.push({ key, value: items.join(', '), kind, items });
        i = j;
        continue;
      }
      i++;
      continue;                                          // empty value with no list: ignore
    }

    i++;
    if (/^\[.*\]$/.test(raw)) {
      const items = raw.slice(1, -1).split(',').map((s) => stripQuotes(s)).filter((s) => s.length > 0);
      const kind = key.toLowerCase() === 'tags' ? 'tags' : 'list';
      out.push({ key, value: items.join(', '), kind, items });
      continue;
    }
    const value = stripQuotes(raw);
    out.push({ key, value, kind: detectKind(key, value) });
  }
  return out;
}

export function escapePropertyText(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Render the property card.
 *
 * `data-prop-*` attributes carry the machine-readable values so that export and print paths
 * can pick up `title` / `author` / `date` straight from the rendered HTML, without any
 * function signature having to change.
 */
export function buildPropertiesCard(props: Property[]): string {
  const escape = escapePropertyText;
  const rows = props
    .map((p) => {
      let body: string;
      if (p.kind === 'list' || p.kind === 'tags') {
        const chips = (p.items || [])
          .map((v) => `<span class="props-chip">${p.kind === 'tags' ? '#' : ''}${escape(v)}</span>`)
          .join('');
        body = `<span class="props-values">${chips}</span>`;
      } else if (p.kind === 'checkbox') {
        const on = /^(?:true|yes)$/i.test(p.value);
        body = `<span class="props-bool ${on ? 'props-on' : 'props-off'}">${on ? '是 (true)' : '否 (false)'}</span>`;
      } else {
        body = `<span class="props-values"><span class="props-value">${escape(p.value)}</span></span>`;
      }
      return `<div class="props-row props-row-${p.kind}"><span class="props-key">${escape(p.key)}</span>${body}</div>`;
    })
    .join('');

  const meta = ['title', 'author', 'date', 'description', 'subject']
    .map((name) => {
      const found = props.find((p) => p.key.toLowerCase() === name);
      return found ? ` data-prop-${name}="${escape(found.value)}"` : '';
    })
    .join('');

  return `<div class="props-card" data-props="${props.length}"${meta}>${rows}</div>`;
}
