/**
 * Auto-update (Tauri updater plugin, signed manifest).
 *
 * Policy (decided by the user): the app *checks*, the *user decides* whether to
 * install, and there is no rollback path. Consequences for this module:
 *
 *   - checkForUpdate() never throws and never blocks the UI. A missing endpoint, an
 *     unreachable host, a bad signature or a plain "no update" all collapse into a
 *     status value so the caller can decide what (not) to show.
 *   - Nothing here installs anything on its own. installUpdate() only runs after the
 *     user pressed the button in the update dialog.
 *   - The private signing key is never part of this project: the plugin verifies the
 *     download against the public key baked into tauri.conf.json and refuses anything
 *     that does not match.
 */

import { check, type Update } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';

export type UpdateStatus = 'idle' | 'checking' | 'none' | 'available' | 'error';

export interface UpdateCheckResult {
  status: UpdateStatus;
  /** Present when status === 'available'. */
  update?: Update;
  version?: string;
  notes?: string;
  currentVersion?: string;
  /** Human-readable reason when status === 'error'. */
  error?: string;
}

export interface UpdateProgress {
  /** 0..1 when the server announced a content length, otherwise undefined. */
  ratio?: number;
  downloaded: number;
  total?: number;
  phase: 'downloading' | 'installing' | 'done';
}

/** True when the updater plugin is actually available (packaged app, not a browser). */
function updaterAvailable(): boolean {
  const w = window as unknown as { __TAURI_INTERNALS__?: unknown };
  return !!w.__TAURI_INTERNALS__;
}

export async function checkForUpdate(): Promise<UpdateCheckResult> {
  if (!updaterAvailable()) {
    return { status: 'error', error: '更新功能仅在打包后的应用内可用' };
  }
  try {
    const update = await check();
    if (!update) return { status: 'none' };
    return {
      status: 'available',
      update,
      version: update.version,
      notes: update.body || '',
      currentVersion: update.currentVersion
    };
  } catch (err) {
    // Quiet by design: an unreachable update source must never disturb editing.
    console.warn('[MarkdownX] update check failed:', err);
    return { status: 'error', error: String(err) };
  }
}

/**
 * Download and install, then relaunch into the new version.
 * `onProgress` is called for each engine event so the dialog can show movement.
 */
export async function installUpdate(
  update: Update,
  onProgress: (progress: UpdateProgress) => void
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    let downloaded = 0;
    let total: number | undefined;

    await update.downloadAndInstall((event) => {
      switch (event.event) {
        case 'Started':
          total = event.data.contentLength ?? undefined;
          onProgress({ downloaded: 0, total, ratio: total ? 0 : undefined, phase: 'downloading' });
          break;
        case 'Progress':
          downloaded += event.data.chunkLength ?? 0;
          onProgress({
            downloaded,
            total,
            ratio: total ? Math.min(1, downloaded / total) : undefined,
            phase: 'downloading'
          });
          break;
        case 'Finished':
          onProgress({ downloaded, total, ratio: 1, phase: 'installing' });
          break;
        default:
          break;
      }
    });

    onProgress({ downloaded, total, ratio: 1, phase: 'done' });
    await relaunch();
    return { ok: true };
  } catch (err) {
    console.error('[MarkdownX] update install failed:', err);
    return { ok: false, error: String(err) };
  }
}