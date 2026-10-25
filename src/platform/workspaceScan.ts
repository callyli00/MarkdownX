import { invoke } from '@tauri-apps/api/core';

/** One file found by the Rust-side workspace walk. `mtime` is Unix **seconds**, 0 = unknown. */
export interface ScannedFile {
  path: string;
  mtime: number;
  size: number;
}

/**
 * Outcome for a single file from {@link readTextFiles}.
 *
 * `content` and `error` are not mutually exclusive: a non-UTF-8 file arrives with `content`
 * (decoded lossily) *and* an `error` explaining that the text is approximate. `null` (not
 * `undefined`) is what the Rust `Option<String>` serialises to, so both are typed here.
 */
export interface ReadTextResult {
  path: string;
  content: string | null;
  error?: string | null;
}

/**
 * Recursively lists the notes and attachments under `root` (command `scan_workspace_files`).
 *
 * Fails CLOSED to `[]`. Two reasons this must never reject:
 *   1. Outside Tauri there is no `invoke` bridge at all (browser dev harness, Vitest, the
 *      plain web build), and an escaped rejection becomes an unhandled promise rejection
 *      plus a half-rendered panel.
 *   2. An empty array is a signal the caller already knows how to render ("index
 *      unavailable"), while a throw would still have to be turned into exactly that.
 *
 * Rust itself returns a short array rather than an error when it hits its own file/depth
 * caps, so a `[]` here genuinely means "could not scan", never "workspace is empty".
 */
export async function scanWorkspaceFiles(root: string): Promise<ScannedFile[]> {
  try {
    const files = await invoke<ScannedFile[]>('scan_workspace_files', { root });
    // Guard against a `null` reply (older binary without the command, or a test mock):
    // `invoke` resolves whatever Rust returned, and index code assumes an array.
    return Array.isArray(files) ? files : [];
  } catch {
    return [];
  }
}

/**
 * Reads many text files in one IPC round trip (command `read_text_files`).
 *
 * Batched because an index build touches every note at once: N separate `readTextFile`
 * calls are N WebView→Rust hops, and on a network share or on Android that per-call
 * latency, not the bytes, is the cost. Per-file failures arrive as `error` on their own
 * entry; only a whole-batch failure (no bridge) collapses to `[]`, so callers iterating
 * results never see an exception mid-index.
 */
export async function readTextFiles(paths: string[]): Promise<ReadTextResult[]> {
  if (paths.length === 0) return [];
  try {
    const results = await invoke<ReadTextResult[]>('read_text_files', { paths });
    return Array.isArray(results) ? results : [];
  } catch {
    return [];
  }
}
