import { describe, it, expect } from 'vitest';
import { isMobilePlatform, isDesktopPlatform } from '../host';

describe('host platform predicates', () => {
  it('treats android and ios as mobile', () => {
    expect(isMobilePlatform('android')).toBe(true);
    expect(isMobilePlatform('ios')).toBe(true);
  });

  it('treats windows/macos/linux as desktop', () => {
    expect(isDesktopPlatform('windows')).toBe(true);
    expect(isDesktopPlatform('macos')).toBe(true);
    expect(isDesktopPlatform('linux')).toBe(true);
  });

  it('never reports a platform as both mobile and desktop', () => {
    for (const p of ['android', 'ios', 'windows', 'macos', 'linux'] as const) {
      expect(isMobilePlatform(p) && isDesktopPlatform(p)).toBe(false);
    }
  });

  it('does not claim an unknown platform (web) is desktop or mobile', () => {
    // The Rust probe can fail (browser harness, IPC error) and yields the 'web' fallback.
    // Treating that as a desktop would re-enable desktop-only UI in the browser.
    expect(isMobilePlatform('web')).toBe(false);
    expect(isDesktopPlatform('web')).toBe(false);
  });
});
