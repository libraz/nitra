/**
 * Seeding conceal circles from irises.
 *
 * The one thing worth failing loudly on is an axis mix-up: irises are isotropic
 * in image-width units, a conceal circle's `y` is a height fraction, and a
 * landscape frame is the only shape that tells the two apart.
 */

import { describe, expect, it } from 'vitest';
import type { ConcealSpot } from '../src/core/conceal/conceal';
import { seedConcealFromIrises } from '../src/core/conceal/seed';
import type { Disc } from '../src/core/face/geometry';
import { CONCEAL_LIMIT, paramDef } from '../src/core/recipe/schema';

function iris(x: number, y: number, radius: number): Disc {
  return { centre: { x, y }, radius, feather: 0 };
}

/** The first (and, in these tests, only) circle the seeding placed. */
function first(result: { added: ConcealSpot[] }): ConcealSpot {
  return result.added[0] as ConcealSpot;
}

describe('seedConcealFromIrises', () => {
  it('returns nothing for a face with no irises', () => {
    expect(seedConcealFromIrises([], 0.5625, [])).toEqual({ added: [], overflow: 0 });
  });

  it('converts y from width units to a height fraction on a 16:9 frame', () => {
    // width=1600, height=900: an iris at y=0.3 (of the width) sits at
    // pixel row 480, which is 480/900 of the frame's height.
    const aspect = 900 / 1600;
    const result = seedConcealFromIrises([iris(0.4, 0.3, 0.03)], aspect, []);
    expect(result.added).toHaveLength(1);
    expect(first(result).x).toBeCloseTo(0.4, 10);
    expect(first(result).y).toBeCloseTo(0.3 / aspect, 10);
    // Using the raw width-unit value directly would have left y at 0.3.
    expect(first(result).y).not.toBeCloseTo(0.3, 2);
  });

  it('converts y from width units to a height fraction on a 4:3 frame', () => {
    const aspect = 900 / 1200;
    const result = seedConcealFromIrises([iris(0.6, 0.45, 0.02)], aspect, []);
    expect(first(result).y).toBeCloseTo(0.45 / aspect, 10);
  });

  it('leaves x unchanged, already a width fraction', () => {
    const result = seedConcealFromIrises([iris(0.62, 0.4, 0.02)], 0.75, []);
    expect(first(result).x).toBe(0.62);
  });

  it('takes the iris radius whole, not a fraction of it', () => {
    const result = seedConcealFromIrises([iris(0.5, 0.4, 0.025)], 1, []);
    expect(first(result).r).toBeCloseTo(0.025, 10);
  });

  it('clamps a radius under the schema minimum up to it', () => {
    const { min } = paramDef('conceal.r');
    const result = seedConcealFromIrises([iris(0.5, 0.4, min / 4)], 1, []);
    expect(first(result).r).toBe(min);
  });

  it('clamps a radius over the schema maximum down to it', () => {
    const { max } = paramDef('conceal.r');
    const result = seedConcealFromIrises([iris(0.5, 0.4, max * 2)], 1, []);
    expect(first(result).r).toBe(max);
  });

  it('skips an eye an existing circle already holds the whole of', () => {
    // Off-centre and larger, with the iris's far edge exactly on the ring: all
    // three numbers are dyadic, so the comparison lands on equality.
    const existing: ConcealSpot[] = [{ x: 0.5 + 2 ** -6, y: 0.4, r: 0.0625 + 2 ** -6 }];
    const result = seedConcealFromIrises([iris(0.5, 0.4, 0.0625)], 1, existing);
    expect(result.added).toEqual([]);
  });

  it('covers an eye whose only circle is a smaller one inside the iris', () => {
    // A circle drawn over a catchlight is not the eye covered: the reflection
    // can be anywhere on the cornea.
    const existing: ConcealSpot[] = [{ x: 0.51, y: 0.4, r: 0.02 }];
    const result = seedConcealFromIrises([iris(0.5, 0.4, 0.0625)], 1, existing);
    expect(result.added).toEqual([{ x: 0.5, y: 0.4, r: 0.0625 }]);
  });

  it('covers an eye an existing circle of its own size only half holds', () => {
    const existing: ConcealSpot[] = [{ x: 0.5625, y: 0.4, r: 0.0625 }];
    const result = seedConcealFromIrises([iris(0.5, 0.4, 0.0625)], 1, existing);
    expect(result.added).toHaveLength(1);
  });

  it('does not stack on an iris wider than a circle can be', () => {
    // The circle placed is the widest the recipe carries, and that is what the
    // second press has to recognise as already there.
    const { max } = paramDef('conceal.r');
    const wide = [iris(0.5, 0.4, max * 2)];
    const placed = seedConcealFromIrises(wide, 0.75, []);
    expect(seedConcealFromIrises(wide, 0.75, placed.added).added).toEqual([]);
  });

  it('is idempotent: seeding again against its own output places nothing', () => {
    const aspect = 900 / 1600;
    const irises = [iris(0.35, 0.3, 0.02), iris(0.55, 0.31, 0.021)];
    const placed = seedConcealFromIrises(irises, aspect, []);
    expect(placed.added).toHaveLength(2);

    const second = seedConcealFromIrises(irises, aspect, placed.added);
    expect(second).toEqual({ added: [], overflow: 0 });
  });

  it('places both eyes independently when neither is covered', () => {
    const result = seedConcealFromIrises([iris(0.35, 0.3, 0.02), iris(0.65, 0.3, 0.02)], 1, []);
    expect(result.added).toHaveLength(2);
    expect(result.overflow).toBe(0);
  });

  it('places nothing and reports the overflow once the limit is reached', () => {
    const full: ConcealSpot[] = Array.from({ length: CONCEAL_LIMIT }, () => ({
      x: 0,
      y: 0,
      r: paramDef('conceal.r').min,
    }));
    const result = seedConcealFromIrises([iris(0.5, 0.4, 0.02), iris(0.6, 0.4, 0.02)], 1, full);
    expect(result.added).toEqual([]);
    expect(result.overflow).toBe(2);
  });

  it('stops placing once a partial call reaches the limit mid-way', () => {
    const almostFull: ConcealSpot[] = Array.from({ length: CONCEAL_LIMIT - 1 }, () => ({
      x: 0,
      y: 0,
      r: paramDef('conceal.r').min,
    }));
    const result = seedConcealFromIrises(
      [iris(0.5, 0.4, 0.02), iris(0.6, 0.4, 0.02)],
      1,
      almostFull,
    );
    expect(result.added).toHaveLength(1);
    expect(result.overflow).toBe(1);
  });
});
