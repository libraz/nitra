import { describe, expect, it } from 'vitest';
import { type Mat3, mat3Mul } from '../src/core/color/matrix';
import { outputToSource } from '../src/core/geometry/transform';
import { neutralRecipe } from '../src/core/recipe/schema';
import { flipGeometry } from '../src/ui/useEditor';

function apply(m: Mat3, x: number, y: number): [number, number] {
  return [m[0] * x + m[1] * y + m[2], m[3] * x + m[4] * y + m[5]];
}

const MIRROR: Record<'h' | 'v', Mat3> = {
  h: [-1, 0, 1, 0, 1, 0, 0, 0, 1],
  v: [1, 0, 0, 0, -1, 1, 0, 0, 1],
};

const CROPS = [
  { x: 0, y: 0, w: 1, h: 1 },
  { x: 0.05, y: 0.2, w: 0.5, h: 0.6 },
  { x: 0.3, y: 0, w: 0.7, h: 0.45 },
];

describe('flipping the framed picture', () => {
  it('mirrors what is on screen across every combination of the framing', () => {
    const base = neutralRecipe().geometry;
    for (const quarterTurns of [0, 1, 2, 3]) {
      for (const flipH of [false, true]) {
        for (const flipV of [false, true]) {
          for (const straighten of [0, -8.5, 12]) {
            for (const crop of CROPS) {
              for (const axis of ['h', 'v'] as const) {
                const before = { ...base, quarterTurns, flipH, flipV, straighten, crop };
                const after = flipGeometry(before, axis);
                const where = `${quarterTurns} ${flipH} ${flipV} ${straighten} ${crop.x} ${axis}`;
                const expected = mat3Mul(outputToSource(4000, 3000, before), MIRROR[axis]);
                const actual = outputToSource(4000, 3000, after);
                for (const [x, y] of [
                  [0, 0],
                  [1, 0],
                  [0.3, 0.8],
                  [1, 1],
                ] as const) {
                  const [ex, ey] = apply(expected, x, y);
                  const [ax, ay] = apply(actual, x, y);
                  expect(ax, where).toBeCloseTo(ex, 9);
                  expect(ay, where).toBeCloseTo(ey, 9);
                }

                const back = flipGeometry(after, axis);
                expect(back.flipH, where).toBe(flipH);
                expect(back.flipV, where).toBe(flipV);
                expect(back.straighten, where).toBe(straighten);
                expect(back.crop.x, where).toBeCloseTo(crop.x, 12);
                expect(back.crop.y, where).toBeCloseTo(crop.y, 12);
              }
            }
          }
        }
      }
    }
  });
});
