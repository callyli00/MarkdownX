/**
 * Helpers for the two shapes a document path takes in this app:
 *   - a real filesystem path  ("C:/docs/paper.md", "/sdcard/notes/x.md")
 *   - an Android SAF content URI ("content://…"), which is what the file dialog returns
 *     on Android. The fs plugin reads and writes those directly, so they are ordinary
 *     document identifiers here - only display and classification need to understand them.
 */

const MARKDOWN_EXTENSIONS = ['md', 'markdown', 'mdown', 'mkd', 'mdx', 'txt'];

export function isContentUri(uri: string): boolean {
  return uri.startsWith('content://');
}

/**
 * A human-readable file name for a path or a content URI. SAF URIs arrive
 * percent-encoded, so decode before showing it; a URI with no usable segment falls back
 * to the trimmed input so the UI never renders an empty label.
 */
export function displayNameFromUri(uri: string): string {
  const withoutQuery = uri.split('?')[0];
  const segments = withoutQuery.split(/[\\/]/).filter(Boolean);
  const last = segments.length > 0 ? segments[segments.length - 1] : withoutQuery;
  try {
    return decodeURIComponent(last);
  } catch {
    // Malformed percent-escapes: show it raw rather than throwing inside a render.
    return last;
  }
}

export function extensionOf(pathOrUri: string): string {
  const name = displayNameFromUri(pathOrUri);
  const dot = name.lastIndexOf('.');
  return dot >= 0 ? name.slice(dot + 1).toLowerCase() : '';
}

export function isMarkdownPath(pathOrUri: string): boolean {
  return MARKDOWN_EXTENSIONS.includes(extensionOf(pathOrUri));
}

export function isPdfPath(pathOrUri: string): boolean {
  return extensionOf(pathOrUri) === 'pdf';
}
