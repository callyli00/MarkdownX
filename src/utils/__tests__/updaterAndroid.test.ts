import { describe, it, expect } from 'vitest';
import { androidPollStep, androidProgress, type AndroidDownloadState } from '../updater';

/**
 * The Android update dialog is driven entirely by these two pure functions, and the only
 * other coverage that path can get is on a real phone. Everything asserted here was a real
 * design decision: which states mean "still working", which mean "done", which must not loop
 * forever, and what the progress bar should show.
 */
function state(phase: AndroidDownloadState['phase'], downloaded = 0, total = -1): AndroidDownloadState {
  return { phase, downloaded, total };
}

describe('android update polling', () => {
  it('keeps waiting while bytes are downloading', () => {
    expect(androidPollStep(state('downloading', 1024, 4096))).toBe('wait');
  });

  it('finishes only once the installer has been launched', () => {
    // 'done' means the APK is fully on disk but the system installer has not been opened
    // yet. Treating it as finished would tell the user "updated" while nothing installed.
    expect(androidPollStep(state('done', 4096, 4096))).toBe('wait');
    expect(androidPollStep(state('installer', 4096, 4096))).toBe('finished');
  });

  it('surfaces a refused install (unknown-sources) as its own step', () => {
    expect(androidPollStep(state('permission'))).toBe('permission');
  });

  it('reports failures instead of polling to the timeout', () => {
    const failed = { ...state('error'), error: '下载失败：HTTP 404' };
    expect(androidPollStep(failed)).toBe('failed');
  });
});

describe('android update progress mapping', () => {
  it('reports a ratio only when the server announced a length', () => {
    expect(androidProgress(state('downloading', 512, 2048))).toEqual({
      downloaded: 512,
      total: 2048,
      ratio: 0.25,
      phase: 'downloading',
    });
    // Unknown length (chunked / no Content-Length): no ratio, so the bar cannot lie.
    const unknown = androidProgress(state('downloading', 512, -1));
    expect(unknown?.ratio).toBeUndefined();
    expect(unknown?.total).toBeUndefined();
  });

  it('never reports more than 100%', () => {
    // Redirect chains can deliver more bytes than the first Content-Length announced.
    const over = androidProgress(state('downloading', 4096, 2048));
    expect(over?.ratio).toBe(1);
  });

  it('maps the installer phase onto the dialog wording', () => {
    expect(androidProgress(state('done', 2048, 2048))?.phase).toBe('installing');
    expect(androidProgress(state('installer', 2048, 2048))?.phase).toBe('done');
  });

  it('shows no progress for states that are not progress', () => {
    expect(androidProgress(state('idle'))).toBeNull();
    expect(androidProgress(state('permission'))).toBeNull();
    expect(androidProgress({ ...state('error'), error: 'x' })).toBeNull();
  });
});
