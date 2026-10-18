/**
 * In-document link navigation: what a Markdown link in the preview should do when clicked.
 *
 * The preview is rendered HTML inside a WebView, where the DEFAULT behaviour is wrong in two
 * different ways: a `#anchor` changes the document URL instead of scrolling the preview
 * container, and a relative file link (`./other.md`) NAVIGATES THE WEBVIEW AWAY from the app
 * - the editor would be replaced by a raw file view. So every link is classified here first,
 * and the caller decides what to do with each class.
 *
 * Pure on purpose: the classification and the path arithmetic are where the bugs live, and
 * they are testable without a DOM.
 */

export type LinkTarget =
  | { kind: 'anchor'; fragment: string }
  | { kind: 'file'; path: string; fragment: string }
  | { kind: 'external'; url: string }
  | { kind: 'other'; raw: string };

const EXTERNAL_RE = /^(?:https?:|mailto:|tel:|ftp:)/i;
const OPAQUE_RE = /^(?:data:|blob:|asset:|javascript:)/i;
/** A path that ends in a known document-ish extension, or that has no extension at all. */
const FILE_EXT_RE = /\.(?:md|markdown|mdown|mkd|mdx|pdf|txt)$/i;

export function classifyLink(href: string): LinkTarget {
  const raw = (href || '').trim();
  if (!raw) return { kind: 'other', raw };
  if (raw.startsWith('#')) return { kind: 'anchor', fragment: raw.slice(1) };
  if (EXTERNAL_RE.test(raw)) return { kind: 'external', url: raw };
  if (OPAQUE_RE.test(raw)) return { kind: 'other', raw };
  if (/^[A-Za-z]:[\\/]/.test(raw)) return { kind: 'file', path: raw, fragment: '' };

  // Split an optional fragment off the path before deciding what it points at.
  const hashAt = raw.indexOf('#');
  const path = hashAt === -1 ? raw : raw.slice(0, hashAt);
  const fragment = hashAt === -1 ? '' : raw.slice(hashAt + 1);
  if (!path) return { kind: 'anchor', fragment };
  if (FILE_EXT_RE.test(path)) return { kind: 'file', path, fragment };
  return { kind: 'other', raw };
}

/**
 * Resolve a relative link against the directory of the document that contains it.
 *
 * `documentPath` is the open document's path ('' when the document has never been saved, in
 * which case a relative link cannot be resolved and the caller must say so rather than guess).
 * Separators are normalised to `/` for the arithmetic and converted back on the way out, so a
 * document opened from a Windows path still resolves a link written with `/`.
 */
export function resolveRelativePath(linkPath: string, documentPath: string): string {
  const usesBackslash = documentPath.includes('\\') && !documentPath.includes('/');
  const doc = documentPath.split('\\').join('/');
  const slash = doc.lastIndexOf('/');
  const dir = slash === -1 ? '' : doc.slice(0, slash);
  const link = linkPath.split('\\').join('/');

  const segments = (dir ? dir.split('/') : []).filter((s) => s.length > 0 && s !== '.');
  const linkParts = link.split('/');
  for (const part of linkParts) {
    if (part === '' || part === '.') continue;
    if (part === '..') { segments.pop(); continue; }
    segments.push(part);
  }
  const joined = segments.join('/');
  const isAbsoluteLike = /^[A-Za-z]:/.test(doc);
  const out = isAbsoluteLike ? joined : (dir ? joined : joined);
  return usesBackslash ? out.split('/').join('\\') : out;
}

/** Scroll target for an anchor fragment: heading ids are percent-encoded, authors are not. */
export function anchorCandidates(fragment: string): string[] {
  const out: string[] = [];
  const push = (v: string) => { if (v && !out.includes(v)) out.push(v); };
  push(fragment);
  try { push(decodeURIComponent(fragment)); } catch { /* malformed escape: keep the raw form */ }
  try { push(encodeURIComponent(decodeURIComponent(fragment))); } catch { /* ignore */ }
  return out;
}
