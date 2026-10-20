/**
 * Auto-update.
 *
 * Two back ends behind one API, because the platforms differ fundamentally:
 *
 *   - **Desktop (Windows NSIS)** — `tauri-plugin-updater` verifies a minisign-signed manifest
 *     and runs the installer itself.
 *   - **Android** — that plugin does not support mobile at all. The APK path is ours: the
 *     Rust side reads `latest.json` through the Kotlin bridge, compares versions, downloads
 *     the APK into the app cache and hands it to the system installer, which enforces the
 *     signing-certificate match. (Details: `src-tauri/src/lib.rs`, `android_update.rs`,
 *     `MobileExtrasPlugin.kt`.)
 *
 * Policy (unchanged): the app *checks*, the *user decides*, and there is no rollback path.
 * Consequences for this module:
 *
 *   - checkForUpdate() never throws and never blocks the UI. A missing endpoint, an
 *     unreachable host, a bad signature or a plain "no update" all collapse into a status
 *     value so the caller can decide what (not) to show.
 *   - Nothing here installs anything on its own. installUpdate() only runs after the user
 *     pressed the button in the update dialog.
 *   - The private signing key is never part of this project: the plugin verifies the
 *     download against the public key baked into tauri.conf.json and refuses anything that
 *     does not match.
 */

import { invoke } from '@tauri-apps/api/core';
import { check, type Update } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';
import { hostPlatform } from '../platform/host';

export type UpdateStatus = 'idle' | 'checking' | 'none' | 'available' | 'error';

export interface UpdateCheckResult {
  status: UpdateStatus;
  /** Present when status === 'available' on desktop. */
  update?: Update;
  version?: string;
  notes?: string;
  currentVersion?: string;
  /** Human-readable reason when status === 'error'. */
  error?: string;
  /**
   * Android only: absolute URL of the APK to download. Its presence is what tells the UI
   * (and installUpdate) that the download/install is ours to drive, not the plugin's.
   */
  androidUrl?: string;
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

/** Reply of the Rust `android_update_check` command. */
interface AndroidCheckReply {
  available: boolean;
  currentVersion: string;
  version: string;
  notes: string;
  url: string;
}

/** State of the native download, as reported by `MobileExtrasPlugin`. */
export interface AndroidDownloadState {
  phase: 'idle' | 'downloading' | 'done' | 'installer' | 'permission' | 'error';
  downloaded: number;
  total: number;
  error?: string | null;
  version?: string;
}

/** What the polling loop should do next. Pure, so the transitions are unit-tested. */
export type AndroidPollStep = 'wait' | 'finished' | 'failed' | 'permission';

export function androidPollStep(state: AndroidDownloadState): AndroidPollStep {
  switch (state.phase) {
    case 'error':
      return 'failed';
    case 'permission':
      return 'permission';
    case 'installer':
      return 'finished';
    default:
      // 'idle' / 'downloading' / 'done': 'done' means the bytes are complete but the
      // installer has not been launched yet, so it is still "wait", not "finished".
      return 'wait';
  }
}

/** Map the native download state onto the dialog's progress model. */
export function androidProgress(state: AndroidDownloadState): UpdateProgress | null {
  const total = state.total > 0 ? state.total : undefined;
  switch (state.phase) {
    case 'downloading':
      return {
        downloaded: state.downloaded,
        total,
        ratio: total ? Math.min(1, state.downloaded / total) : undefined,
        phase: 'downloading',
      };
    case 'done':
      return { downloaded: state.downloaded, total, ratio: 1, phase: 'installing' };
    case 'installer':
      return { downloaded: state.downloaded, total, ratio: 1, phase: 'done' };
    default:
      return null;
  }
}

export async function checkForUpdate(): Promise<UpdateCheckResult> {
  if (!updaterAvailable()) {
    return { status: 'error', error: '更新功能仅在打包后的应用内可用' };
  }

  // Android: no updater plugin, so ask the native bridge instead.
  if ((await hostPlatform()) === 'android') {
    try {
      const reply = await invoke<AndroidCheckReply>('android_update_check');
      if (!reply.available) return { status: 'none' };
      return {
        status: 'available',
        version: reply.version,
        notes: reply.notes,
        currentVersion: reply.currentVersion,
        androidUrl: reply.url,
      };
    } catch (err) {
      // Quiet by design: an unreachable update source must never disturb editing.
      console.warn('[MarkdownX] android update check failed:', err);
      return { status: 'error', error: String(err) };
    }
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

/** How long to wait for the native download before giving up on the UI poll. */
const ANDROID_INSTALL_TIMEOUT_MS = 15 * 60 * 1000;
const ANDROID_POLL_INTERVAL_MS = 600;

const sleep = (ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, ms));

/**
 * Android: download the APK in the native side and hand it to the system installer.
 *
 * Resolves when the installer has been launched (the app stays alive until the user acts in
 * the system dialog - there is nothing to relaunch here, Android replaces the process during
 * the update itself). A missing "install unknown apps" grant resolves as a failure with the
 * reason, because the grant happens in system Settings and cannot be awaited.
 */
export async function installAndroidUpdate(
  url: string,
  version: string,
  onProgress: (progress: UpdateProgress) => void
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    let state = await invoke<AndroidDownloadState>('android_update_install', { url, version });
    const deadline = Date.now() + ANDROID_INSTALL_TIMEOUT_MS;

    for (;;) {
      const step = androidPollStep(state);
      const progress = androidProgress(state);
      if (progress) onProgress(progress);

      if (step === 'finished') return { ok: true };
      if (step === 'failed') return { ok: false, error: state.error || '下载 APK 失败' };
      if (step === 'permission') {
        return {
          ok: false,
          error:
            '需要在系统设置里允许 MarkdownX「安装未知应用」，已替你打开该页面；' +
            '打开开关后回到应用再点一次「下载并安装」。',
        };
      }
      if (Date.now() > deadline) {
        return { ok: false, error: '下载超时，请检查网络后重试' };
      }

      await sleep(ANDROID_POLL_INTERVAL_MS);
      state = await invoke<AndroidDownloadState>('android_update_progress');
    }
  } catch (err) {
    console.error('[MarkdownX] android update install failed:', err);
    return { ok: false, error: String(err) };
  }
}
