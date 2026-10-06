let cached: Uint8Array | null = null;

/**
 * Fetch the CJK note font once and reuse it.
 *
 * Resolves to `undefined` when the asset is missing (postinstall not run, custom
 * build) — callers then flatten Latin-only notes instead of failing the export.
 */
export async function fetchNoteFontBytes(): Promise<Uint8Array | undefined> {
  if (cached) return cached;
  try {
    const res = await fetch('/fonts/NotoSansSC-Regular.ttf');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    cached = new Uint8Array(await res.arrayBuffer());
    return cached;
  } catch (e) {
    console.warn('[pdf] CJK note font unavailable, exporting Latin-only notes:', e);
    return undefined;
  }
}
