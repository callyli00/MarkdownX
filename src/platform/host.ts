import { invoke } from '@tauri-apps/api/core';

/** What the Rust side was compiled for, plus a `web` fallback for non-Tauri hosts. */
export type HostPlatform = 'android' | 'ios' | 'windows' | 'macos' | 'linux' | 'web';

export function isMobilePlatform(platform: HostPlatform): boolean {
  return platform === 'android' || platform === 'ios';
}

export function isDesktopPlatform(platform: HostPlatform): boolean {
  return platform === 'windows' || platform === 'macos' || platform === 'linux';
}

let cached: HostPlatform | null = null;

/**
 * Asks the Rust side which platform it was built for (command `get_host_platform`).
 *
 * The answer drives which desktop-only UI is hidden, so it must fail CLOSED: when the
 * IPC bridge is absent (browser dev harness, Vitest) we return 'web', which is neither
 * mobile nor desktop and therefore enables neither set of affordances. Cached because
 * every gating decision in the editor asks for it.
 */
export async function hostPlatform(): Promise<HostPlatform> {
  if (cached) return cached;
  try {
    cached = (await invoke<string>('get_host_platform')) as HostPlatform;
  } catch {
    cached = 'web';
  }
  return cached;
}

/** Test seam: forget the cached probe (used by tests and by the browser harness). */
export function resetHostPlatformCache(): void {
  cached = null;
}
