/**
 * The cache the renderer keeps its readback targets and text rasters in.
 */

import { describe, expect, it } from 'vitest';
import { LruCache } from '../src/core/render/gl';

function cache(capacity: number) {
  const disposed: string[] = [];
  return { lru: new LruCache<string>(capacity, (value) => disposed.push(value)), disposed };
}

describe('LruCache', () => {
  it('evicts the least recently used entry, counting a hit as a use', () => {
    const { lru, disposed } = cache(2);
    lru.set('a', 'A');
    lru.set('b', 'B');
    lru.get('a');
    lru.set('c', 'C');
    expect(disposed).toEqual(['B']);
    expect(lru.get('a')).toBe('A');
    expect(lru.get('b')).toBeUndefined();
  });

  it('never holds more than its capacity', () => {
    const { lru, disposed } = cache(3);
    for (let i = 0; i < 20; i++) lru.set(`k${i}`, `v${i}`);
    expect(lru.size).toBe(3);
    expect(disposed).toHaveLength(17);
  });

  it('never evicts the entry just stored', () => {
    const { lru, disposed } = cache(1);
    lru.set('a', 'A');
    lru.set('b', 'B');
    expect(lru.get('b')).toBe('B');
    expect(disposed).toEqual(['A']);
  });

  it('disposes every value exactly once, however it leaves', () => {
    const { lru, disposed } = cache(2);
    lru.set('a', 'A');
    lru.set('a', 'A2');
    lru.set('b', 'B');
    lru.delete('b');
    lru.delete('b');
    lru.set('c', 'C');
    lru.clear();
    lru.clear();
    expect(disposed.sort()).toEqual(['A', 'A2', 'B', 'C']);
  });

  it('does not dispose a value stored again under its own key', () => {
    const { lru, disposed } = cache(2);
    lru.set('a', 'A');
    lru.set('a', 'A');
    expect(disposed).toEqual([]);
  });
});
