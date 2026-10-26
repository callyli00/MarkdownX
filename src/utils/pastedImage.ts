/**
 * Paste-an-image-into-the-note support.
 *
 * A textarea silently drops image data, so before P6 pasting a screenshot into MarkDownX lost it
 * without a word. The host now writes the bytes next to the note and inserts a normal Markdown
 * image reference - no custom syntax, so the result still renders anywhere else.
 *
 * Everything here is pure: naming, the Markdown snippet and the caret arithmetic. The App decides
 * where the file goes and does the actual write.
 */

/** Extension for an image MIME type, or null when the type is not an image we can name. */
export function imageExtension(mime: string): string | null {
  const type = String(mime ?? '').toLowerCase().split(';')[0].trim();
  switch (type) {
    case 'image/png':
      return 'png';
    case 'image/jpeg':
    case 'image/jpg':
      return 'jpg';
    case 'image/gif':
      return 'gif';
    case 'image/webp':
      return 'webp';
    case 'image/bmp':
      return 'bmp';
    case 'image/svg+xml':
      return 'svg';
    case 'image/avif':
      return 'avif';
    default:
      return null;
  }
}

/** `20261026-165012`, in local time - matches how a user reads their own clipboard history. */
function stamp(when: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return (
    `${when.getFullYear()}${pad(when.getMonth() + 1)}${pad(when.getDate())}` +
    `-${pad(when.getHours())}${pad(when.getMinutes())}${pad(when.getSeconds())}`
  );
}

/**
 * File name for a pasted image: `pasted-20261026-165012-ab12.png`.
 *
 * Timestamp first so a folder sorts chronologically, seed last so two pastes inside the same
 * second cannot collide. No spaces, no colons: the name goes into a Markdown link and onto
 * Windows/Android alike.
 */
export function pastedImageFileName(mime: string, when: Date, seed: string): string | null {
  const ext = imageExtension(mime);
  if (!ext) return null;
  const cleanSeed = String(seed ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
    .slice(0, 6);
  return `pasted-${stamp(when)}-${cleanSeed || '0000'}.${ext}`;
}

/** Markdown image reference. Paths with spaces are wrapped in `<>`, which Markdown supports. */
export function imageMarkdown(relativePath: string, alt = ''): string {
  const path = String(relativePath ?? '').replace(/\\/g, '/');
  const target = /\s/.test(path) ? `<${path}>` : path;
  return `![](${target}${alt ? ` "${alt.replace(/"/g, "'")}"` : ''})`;
}

/**
 * Insert `snippet` at the current selection, replacing it if anything was selected.
 *
 * Returns the caret position after the snippet so the caller can put the cursor back - a paste
 * that leaves the caret where it was drops the user into the middle of the inserted markup.
 */
export function insertTextAtSelection(
  text: string,
  start: number,
  end: number,
  snippet: string
): { content: string; caret: number } {
  const source = String(text ?? '');
  const from = Math.max(0, Math.min(start, source.length));
  const to = Math.max(from, Math.min(end, source.length));
  // A pasted image is a block: it must not glue onto the text before *or* after it. Both sides
  // are checked, because pasting at the very start of a document is a normal move.
  const needsNewlineBefore = from > 0 && source[from - 1] !== '\n';
  const needsNewlineAfter = to < source.length && source[to] !== '\n';
  const prefix = needsNewlineBefore ? '\n' : '';
  const suffix = needsNewlineAfter ? '\n' : '';
  const insertion = `${prefix}${snippet}${suffix}`;
  return {
    content: source.slice(0, from) + insertion + source.slice(to),
    caret: from + insertion.length
  };
}
