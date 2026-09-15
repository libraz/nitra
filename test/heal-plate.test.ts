/**
 * The plate: the copy of the photograph the fills accumulate in.
 *
 * What is asserted here is the bookkeeping rather than the fill — that a
 * photograph nobody heals is never copied, that appending a spot does not redo
 * the ones before it, and that taking one away puts back what was underneath.
 * The last of those is the only way a fill is undoable at all: there is no
 * inverse of a fill, so the pixels have to come from the decoded photograph.
 */

import { describe, expect, it } from 'vitest';
import type { HealSpot } from '../src/core/heal/inpaint';
import { HealPlate } from '../src/core/heal/plate';

const SIZE = 192;

/** Flat skin with grain, and a dark mark wherever one is asked for. */
function photograph(marks: readonly { x: number; y: number; r: number }[]): Uint8ClampedArray {
  const out = new Uint8ClampedArray(SIZE * SIZE * 4);
  let state = 7919;
  const noise = () => {
    state = (state * 1103515245 + 12345) >>> 0;
    return state / 4294967296 - 0.5;
  };
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const i = (y * SIZE + x) * 4;
      const grain = noise() * 20;
      const marked = marks.some((m) => Math.hypot(x - m.x * SIZE, y - m.y * SIZE) < m.r * SIZE);
      const value = 176 + grain + (marked ? -60 : 0);
      out[i] = value;
      out[i + 1] = value * 0.84;
      out[i + 2] = value * 0.74;
      out[i + 3] = 255;
    }
  }
  return out;
}

/** Mean red over a disc, which is what a dark mark shows up in. */
function meanAt(pixels: Uint8ClampedArray, spot: HealSpot): number {
  const cx = spot.x * SIZE;
  const cy = spot.y * SIZE;
  const r = spot.r * SIZE;
  let total = 0;
  let count = 0;
  for (let y = Math.max(0, Math.floor(cy - r)); y < Math.min(SIZE, Math.ceil(cy + r)); y++) {
    for (let x = Math.max(0, Math.floor(cx - r)); x < Math.min(SIZE, Math.ceil(cx + r)); x++) {
      if (Math.hypot(x - cx, y - cy) > r) continue;
      total += pixels[(y * SIZE + x) * 4] as number;
      count += 1;
    }
  }
  return total / Math.max(count, 1);
}

// The largest radius the recipe will hold, so the arithmetic under test is the
// arithmetic a real spot goes through.
const LEFT: HealSpot = { x: 0.3, y: 0.4, r: 0.03 };
const RIGHT: HealSpot = { x: 0.7, y: 0.6, r: 0.03 };

function plateOf(marks: readonly HealSpot[] = [LEFT, RIGHT]) {
  const pristine = photograph(marks);
  return { pristine, plate: new HealPlate(pristine, SIZE, SIZE) };
}

describe('the plate', () => {
  it('is not copied until something is filled', () => {
    const { plate } = plateOf();
    expect(plate.pixels).toBeNull();
    // An empty list is not a change to apply; the photograph is already it.
    expect(plate.apply([])).toBeNull();
    expect(plate.pixels).toBeNull();
  });

  it('fills a spot and leaves the photograph it was given alone', () => {
    const { pristine, plate } = plateOf();
    const before = pristine.slice();
    const dark = meanAt(pristine, LEFT);

    const update = plate.apply([LEFT]);
    expect(update).not.toBeNull();
    expect(update?.rebuilt).toBe(false);
    expect(update?.rects).toHaveLength(1);
    expect(plate.pixels).not.toBeNull();

    // The mark is gone from the plate, and still there in what it was copied
    // from: the decoded pixels are the only record of what was underneath.
    expect(meanAt(plate.pixels as Uint8ClampedArray, LEFT)).toBeGreaterThan(dark + 20);
    expect(pristine).toEqual(before);
  });

  it('reports the rectangle the fill reached, not the whole frame', () => {
    const { plate } = plateOf();
    const update = plate.apply([LEFT]);
    const rect = update?.rects[0] as { x: number; y: number; width: number; height: number };
    // The region reaches past the spot on every side, because the surrounding
    // skin is the only place the fill has to copy from.
    expect(rect.width).toBeGreaterThan(LEFT.r * SIZE * 2);
    expect(rect.width).toBeLessThan(SIZE);
    expect(rect.x).toBeGreaterThan(0);
    expect(rect.x + rect.width).toBeLessThan(SIZE);
  });

  it('does nothing when asked for what it has already done', () => {
    const { plate } = plateOf();
    expect(plate.apply([LEFT, RIGHT])).not.toBeNull();
    expect(plate.apply([LEFT, RIGHT])).toBeNull();
    // A separate object with the same numbers is the same edit: the recipe is
    // replaced on every change, so identity would report work on every render.
    expect(plate.apply([{ ...LEFT }, { ...RIGHT }])).toBeNull();
  });

  it('appends without redoing what is already in the plate', () => {
    const { plate } = plateOf();
    plate.apply([LEFT]);
    const filled = (plate.pixels as Uint8ClampedArray).slice();

    const update = plate.apply([LEFT, RIGHT]);
    expect(update?.rebuilt).toBe(false);
    expect(update?.rects).toHaveLength(1);

    const pixels = plate.pixels as Uint8ClampedArray;
    // The first fill came through untouched — byte for byte, not approximately.
    const rect = update?.rects[0] as { x: number; y: number; width: number; height: number };
    for (let y = 0; y < SIZE; y++) {
      for (let x = 0; x < SIZE; x++) {
        const inside =
          x >= rect.x && x < rect.x + rect.width && y >= rect.y && y < rect.y + rect.height;
        if (inside) continue;
        expect(pixels[(y * SIZE + x) * 4]).toBe(filled[(y * SIZE + x) * 4]);
      }
    }
  });

  it('puts back what was under a spot that is taken away', () => {
    const { pristine, plate } = plateOf();
    plate.apply([LEFT, RIGHT]);

    const update = plate.apply([LEFT]);
    // There is no inverse of a fill, so the plate is built again from the
    // photograph and the remaining spots are replayed.
    expect(update?.rebuilt).toBe(true);
    expect(update?.rects).toHaveLength(1);

    const pixels = plate.pixels as Uint8ClampedArray;
    expect(meanAt(pixels, RIGHT)).toBeCloseTo(meanAt(pristine, RIGHT), 5);
    expect(meanAt(pixels, LEFT)).toBeGreaterThan(meanAt(pristine, LEFT) + 20);
  });

  it('rebuilds when a spot moves rather than treating it as a new one', () => {
    const { plate } = plateOf();
    plate.apply([LEFT, RIGHT]);
    const update = plate.apply([LEFT, { ...RIGHT, x: 0.66 }]);
    expect(update?.rebuilt).toBe(true);
    expect(update?.rects).toHaveLength(2);
  });

  it('goes back to costing nothing when the last spot is removed', () => {
    const { plate } = plateOf();
    plate.apply([LEFT]);
    const update = plate.apply([]);
    expect(update).toEqual({ rebuilt: true, rects: [] });
    // The plate is dropped rather than refilled: the photograph is already the
    // answer, and holding a copy of it is holding the decoded image twice.
    expect(plate.pixels).toBeNull();
  });

  it('composes two spots that overlap', () => {
    const near: HealSpot = { x: 0.32, y: 0.4, r: 0.03 };
    const { pristine, plate } = plateOf([LEFT, near]);
    plate.apply([LEFT, near]);
    const pixels = plate.pixels as Uint8ClampedArray;
    // The second fill read what the first left behind, so neither mark is left
    // in the overlap — which is what would happen if a person had healed them
    // one after the other.
    expect(meanAt(pixels, LEFT)).toBeGreaterThan(meanAt(pristine, LEFT) + 20);
    expect(meanAt(pixels, near)).toBeGreaterThan(meanAt(pristine, near) + 20);
  });

  it('remembers a spot too small to fill anything', () => {
    const { plate } = plateOf();
    const speck: HealSpot = { x: 0.5, y: 0.5, r: 0.002 };
    const update = plate.apply([speck]);
    // Under a pixel and a half of radius there is nothing to fill, so there is
    // nothing to upload either — but the spot is in the recipe, and asking again
    // must not run it a second time.
    expect(update).toEqual({ rebuilt: false, rects: [] });
    expect(plate.apply([speck])).toBeNull();
  });
});
