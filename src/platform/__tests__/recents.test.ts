import { describe, it, expect } from 'vitest';
import { pushRecent, RECENTS_LIMIT, type RecentDocument } from '../recents';

const r = (uri: string): RecentDocument => ({ uri, name: uri.split('/').pop() ?? uri, openedAt: 1 });

describe('recent documents', () => {
  it('puts the newest entry first and preserves the existing order', () => {
    // The stored list is already newest-first, so an inserted entry goes in front and
    // everything else keeps its relative order (no re-sorting by openedAt).
    const out = pushRecent([r('a'), r('b')], { uri: 'c', name: 'c.md', openedAt: 2 });
    expect(out.map((e) => e.uri)).toEqual(['c', 'a', 'b']);
  });

  it('de-duplicates by uri and promotes the existing entry', () => {
    const out = pushRecent([r('a'), r('b')], { uri: 'b', name: 'b.md', openedAt: 3 });
    expect(out.map((e) => e.uri)).toEqual(['b', 'a']);
    expect(out.filter((e) => e.uri === 'b')).toHaveLength(1);
    expect(out.find((e) => e.uri === 'b')?.openedAt).toBe(3);
  });

  it('caps the list without mutating the input', () => {
    const long = Array.from({ length: RECENTS_LIMIT }, (_, i) => r(`u${i}`));
    const out = pushRecent(long, { uri: 'new', name: 'new.md', openedAt: 9 });
    expect(out).toHaveLength(RECENTS_LIMIT);
    expect(out[0].uri).toBe('new');
    expect(long).toHaveLength(RECENTS_LIMIT);
    expect(long[0].uri).toBe('u0');
  });

  it('handles an empty list', () => {
    expect(pushRecent([], { uri: 'a', name: 'a.md', openedAt: 1 }).map((e) => e.uri)).toEqual(['a']);
  });
});
