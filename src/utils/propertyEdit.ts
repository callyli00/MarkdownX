/**
 * B3: editing properties from the preview, written back into the document source.
 *
 * Every function here is pure and byte-conservative. The rule that shapes all of them:
 * a property edit may only touch the property in question. Untouched lines are re-emitted
 * exactly as they were, including their indentation, their quoting and any keys this module
 * does not understand - the same rule the renderer follows for author text.
 */

import { extractFrontmatterBlock, PropertyKind } from './properties';

const KEY_LINE_RE = (key: string) =>
  new RegExp(`^(${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[ \t]*:)([ \t]*)(.*)$`, 'i');

/**
 * Turn what the user typed into YAML for the given type.
 *
 * A text value is quoted only when leaving it bare would change its meaning (leading
 * indicator characters, an embedded `: `, or surrounding spaces). Quoting everything would
 * be simpler but would rewrite values the user never touched, and diffs would fill up with
 * quote churn.
 */
export function formatPropertyValue(kind: PropertyKind, raw: string): string {
  const text = raw.trim();
  if (kind === 'checkbox') return /^(?:true|yes|1|是)$/i.test(text) ? 'true' : 'false';
  if (kind === 'number') return /^-?\d+(?:\.\d+)?$/.test(text) ? text : text;
  if (kind === 'list' || kind === 'tags') {
    const items = text.split(/[,，]/).map((s) => s.trim()).filter((s) => s.length > 0);
    return `[${items.join(', ')}]`;
  }
  const needsQuotes = /^[\s\-?:,\[\]{}#&*!|>'"%@`]/.test(text) || /:\s/.test(text) || /\s$/.test(raw) || /^\s/.test(raw);
  if (!needsQuotes) return text;
  return `"${text.replace(/"/g, '\\"')}"`;
}

/**
 * Set (or create) a property.
 *
 * With no frontmatter block present a new one is created at the top of the document - that
 * is the only case where this module adds lines that were not there before.
 */
export function setProperty(source: string, key: string, rawValue: string, kind: PropertyKind): string {
  const value = formatPropertyValue(kind, rawValue);
  const block = extractFrontmatterBlock(source);
  const eol = source.includes('\r\n') ? '\r\n' : '\n';

  if (block === null) {
    return `---${eol}${key}: ${value}${eol}---${eol}${eol}${source}`;
  }

  const lines = block.split(/\r?\n/);
  const re = KEY_LINE_RE(key);
  let found = -1;
  for (let i = 0; i < lines.length; i++) {
    if (re.test(lines[i])) { found = i; break; }
  }
  if (found === -1) {
    lines.push(`${key}: ${value}`);
  } else {
    lines[found] = `${key}: ${value}`;
    // A block list is continued by indented `- item` lines; replacing the head must consume
    // them, or the old items survive as orphaned list entries.
    let j = found + 1;
    while (j < lines.length && /^[ \t]+-\s+/.test(lines[j])) { lines.splice(j, 1); }
  }

  const rebuilt = `---${eol}${lines.join(eol)}${eol}---`;
  return source.replace(/^---\r?\n[\s\S]*?\r?\n---[ \t]*(?=\r?\n|$)/, rebuilt);
}

/** Remove a property. The frontmatter block itself is kept even when it becomes empty. */
export function removeProperty(source: string, key: string): string {
  const block = extractFrontmatterBlock(source);
  if (block === null) return source;
  const eol = source.includes('\r\n') ? '\r\n' : '\n';
  const lines = block.split(/\r?\n/);
  const re = KEY_LINE_RE(key);
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (re.test(lines[i])) {
      let j = i + 1;
      while (j < lines.length && /^[ \t]+-\s+/.test(lines[j])) j++;
      i = j - 1;
      continue;
    }
    out.push(lines[i]);
  }
  const rebuilt = `---${eol}${out.join(eol)}${eol}---`;
  return source.replace(/^---\r?\n[\s\S]*?\r?\n---[ \t]*(?=\r?\n|$)/, rebuilt);
}
