import { describe, expect, it } from 'vitest';
import { mat3Apply } from '../src/core/color/matrix';
import { ASPECTS, aspectByKey, resolveAspect } from '../src/core/geometry/aspects';
import {
  type CropHandle,
  clampCrop,
  fitCropToAspect,
  flipFieldFor,
  frameSize,
  frameToSource,
  isNeutralGeometry,
  normalisedRatio,
  outputToSource,
  quarterTurnedSize,
  resizeCrop,
  straightenScale,
} from '../src/core/geometry/transform';
import { type GeometryParams, neutralRecipe } from '../src/core/recipe/schema';

type Crop = GeometryParams['crop'];

function geometry(patch: Partial<GeometryParams>): GeometryParams {
  return { ...neutralRecipe().geometry, ...patch };
}

/** The four corners of the output, mapped back to where they come from. */
function corners(width: number, height: number, geo: GeometryParams): [number, number][] {
  const m = outputToSource(width, height, geo);
  return (
    [
      [0, 0],
      [1, 0],
      [0, 1],
      [1, 1],
    ] as const
  ).map(([u, v]) => {
    const [x, y] = mat3Apply(m, [u, v, 1]);
    return [x, y] as [number, number];
  });
}

/** Determinant of the affine part: area scale, and sign for orientation. */
function determinant(width: number, height: number, geo: GeometryParams): number {
  const m = outputToSource(width, height, geo);
  return m[0] * m[4] - m[1] * m[3];
}

describe('quarter turns', () => {
  it('swaps the frame for an odd number of them', () => {
    expect(quarterTurnedSize(1600, 900, 0)).toEqual([1600, 900]);
    expect(quarterTurnedSize(1600, 900, 1)).toEqual([900, 1600]);
    expect(quarterTurnedSize(1600, 900, 2)).toEqual([1600, 900]);
    expect(quarterTurnedSize(1600, 900, 3)).toEqual([900, 1600]);
  });

  it('puts the source corner a clockwise turn would put there', () => {
    // Turning a photo a quarter turn clockwise brings its bottom left corner to
    // the top left of what is displayed. Getting this backwards is a rotation
    // that goes the wrong way, which no invariant about areas would catch.
    const [topLeft] = corners(1600, 900, geometry({ quarterTurns: 1 }));
    expect(topLeft?.[0]).toBeCloseTo(0, 9);
    expect(topLeft?.[1]).toBeCloseTo(1, 9);

    const [alsoTopLeft] = corners(1600, 900, geometry({ quarterTurns: 3 }));
    expect(alsoTopLeft?.[0]).toBeCloseTo(1, 9);
    expect(alsoTopLeft?.[1]).toBeCloseTo(0, 9);
  });
});

describe('straightening', () => {
  it('leaves the frame alone at zero', () => {
    expect(straightenScale(1600, 900, 0)).toBe(1);
    expect(frameSize(1600, 900, geometry({}))).toEqual([1600, 900]);
  });

  it('shrinks by the same amount either way round', () => {
    expect(straightenScale(1600, 900, 7)).toBeCloseTo(straightenScale(1600, 900, -7), 12);
    expect(straightenScale(1600, 900, 7)).toBeLessThan(1);
  });

  it('shrinks further the more it turns', () => {
    const gentle = straightenScale(1600, 900, 3);
    const steep = straightenScale(1600, 900, 15);
    expect(steep).toBeLessThan(gentle);
  });
});

/**
 * The framing, over every combination of the choices that make it up.
 *
 * The transform is pure and costs nothing to evaluate, so this is the whole
 * cross product rather than a sample of it: the failures worth catching are the
 * ones where two settings interact — a flip applied on the wrong side of a
 * quarter turn, or a crop measured against the frame before it was straightened
 * rather than after — and those are exactly the ones a sample can miss.
 */
describe('framing, over every combination', () => {
  const SHAPES: [number, number][] = [
    [1600, 900],
    [900, 1600],
    [1000, 1000],
  ];
  const TURNS = [0, 1, 2, 3];
  const STRAIGHTEN = [0, 7, -12];
  const CROPS: Crop[] = [
    { x: 0, y: 0, w: 1, h: 1 },
    { x: 0.25, y: 0.25, w: 0.5, h: 0.5 },
    { x: 0.6, y: 0, w: 0.4, h: 0.3 },
  ];

  const cases: {
    name: string;
    width: number;
    height: number;
    geo: GeometryParams;
    crop: Crop;
  }[] = [];
  for (const [width, height] of SHAPES) {
    for (const quarterTurns of TURNS) {
      for (const flipH of [false, true]) {
        for (const flipV of [false, true]) {
          for (const straighten of STRAIGHTEN) {
            for (const crop of CROPS) {
              cases.push({
                name: `${width}x${height} turn${quarterTurns}${flipH ? ' H' : ''}${
                  flipV ? ' V' : ''
                } ${straighten}° crop ${crop.w}x${crop.h}`,
                width,
                height,
                crop,
                geo: geometry({ quarterTurns, flipH, flipV, straighten, crop }),
              });
            }
          }
        }
      }
    }
  }

  it('covers every combination', () => {
    expect(cases).toHaveLength(3 * 4 * 2 * 2 * 3 * 3);
  });

  it('never samples outside the photo', () => {
    // This is the promise straightening makes: the frame is trimmed until it
    // fits inside the rotated photo, so no output pixel is ever fetched from
    // beyond the edge and no corner comes out empty.
    for (const entry of cases) {
      for (const [x, y] of corners(entry.width, entry.height, entry.geo)) {
        expect(x, `${entry.name} x`).toBeGreaterThanOrEqual(-1e-9);
        expect(x, `${entry.name} x`).toBeLessThanOrEqual(1 + 1e-9);
        expect(y, `${entry.name} y`).toBeGreaterThanOrEqual(-1e-9);
        expect(y, `${entry.name} y`).toBeLessThanOrEqual(1 + 1e-9);
      }
    }
  });

  it('takes exactly the area the crop asks for', () => {
    for (const entry of cases) {
      const [w, h] = quarterTurnedSize(entry.width, entry.height, entry.geo.quarterTurns);
      const k = straightenScale(w, h, entry.geo.straighten);
      const expected = k * k * entry.crop.w * entry.crop.h;
      expect(Math.abs(determinant(entry.width, entry.height, entry.geo)), entry.name).toBeCloseTo(
        expected,
        9,
      );
    }
  });

  it('mirrors exactly when one flip is on', () => {
    // A mirrored frame has a negative determinant. Two flips is a half turn, and
    // reads the right way round again.
    for (const entry of cases) {
      const mirrored = entry.geo.flipH !== entry.geo.flipV;
      const sign = Math.sign(determinant(entry.width, entry.height, entry.geo));
      expect(sign, entry.name).toBe(mirrored ? -1 : 1);
    }
  });

  it('agrees with the whole-frame transform at the crop corners', () => {
    // The crop tool renders the whole frame and draws a rectangle over it. If
    // the two transforms disagreed, the rectangle would sit somewhere other than
    // the part of the photo that is actually kept.
    for (const entry of cases) {
      const frame = frameToSource(entry.width, entry.height, entry.geo);
      const output = outputToSource(entry.width, entry.height, entry.geo);
      const { x, y, w, h } = entry.crop;
      for (const [u, v] of [
        [0, 0],
        [1, 1],
      ] as const) {
        const viaFrame = mat3Apply(frame, [x + u * w, y + v * h, 1]);
        const viaOutput = mat3Apply(output, [u, v, 1]);
        expect(viaFrame[0], entry.name).toBeCloseTo(viaOutput[0] as number, 12);
        expect(viaFrame[1], entry.name).toBeCloseTo(viaOutput[1] as number, 12);
      }
    }
  });

  it('is the identity only when nothing was asked for', () => {
    for (const entry of cases) {
      const untouched =
        entry.geo.quarterTurns === 0 &&
        !entry.geo.flipH &&
        !entry.geo.flipV &&
        entry.geo.straighten === 0 &&
        entry.crop.w === 1 &&
        entry.crop.h === 1;
      expect(isNeutralGeometry(entry.geo), entry.name).toBe(untouched);
    }
  });
});

describe('locking a crop to a shape', () => {
  it('produces the ratio that was asked for, in pixels', () => {
    for (const frameAspect of [16 / 9, 9 / 16, 1]) {
      for (const ratio of [1, 4 / 5, 1.91, 3]) {
        const fitted = fitCropToAspect({ x: 0, y: 0, w: 1, h: 1 }, ratio, frameAspect);
        expect((fitted.w * frameAspect) / fitted.h).toBeCloseTo(ratio, 9);
        expect(fitted.x).toBeGreaterThanOrEqual(-1e-12);
        expect(fitted.y).toBeGreaterThanOrEqual(-1e-12);
        expect(fitted.x + fitted.w).toBeLessThanOrEqual(1 + 1e-12);
        expect(fitted.y + fitted.h).toBeLessThanOrEqual(1 + 1e-12);
      }
    }
  });

  it('leaves an already-correct crop alone', () => {
    // Reapplying the lock after a drag that maintained it has to be a no-op, or
    // dragging one edge of a locked crop would spring back.
    const once = fitCropToAspect({ x: 0.2, y: 0.1, w: 0.5, h: 0.5 }, 4 / 5, 1.5);
    const twice = fitCropToAspect(once, 4 / 5, 1.5);
    expect(twice.w).toBeCloseTo(once.w, 12);
    expect(twice.h).toBeCloseTo(once.h, 12);
    expect(twice.x).toBeCloseTo(once.x, 12);
    expect(twice.y).toBeCloseTo(once.y, 12);
  });

  it('takes the whole frame when the shapes already match', () => {
    const fitted = fitCropToAspect({ x: 0, y: 0, w: 1, h: 1 }, 3 / 2, 3 / 2);
    expect(fitted).toEqual({ x: 0, y: 0, w: 1, h: 1 });
  });

  it('keeps the crop centred where it was', () => {
    const start = { x: 0.5, y: 0.0, w: 0.4, h: 0.4 };
    const fitted = fitCropToAspect(start, 1, 1);
    expect(fitted.x + fitted.w / 2).toBeCloseTo(start.x + start.w / 2, 9);
  });
});

describe('dragging a crop handle', () => {
  const start: Crop = { x: 0.2, y: 0.2, w: 0.4, h: 0.4 };

  it('moves only the edges the handle belongs to', () => {
    const dragged = resizeCrop(start, 'e', 0.8, 0.5, null);
    expect(dragged.x).toBeCloseTo(0.2, 9);
    expect(dragged.y).toBeCloseTo(0.2, 9);
    expect(dragged.h).toBeCloseTo(0.4, 9);
    expect(dragged.w).toBeCloseTo(0.6, 9);
  });

  it('holds the opposite corner still', () => {
    const dragged = resizeCrop(start, 'nw', 0.05, 0.1, null);
    expect(dragged.x + dragged.w).toBeCloseTo(0.6, 9);
    expect(dragged.y + dragged.h).toBeCloseTo(0.6, 9);
  });

  it('keeps a locked shape on every handle', () => {
    const locked = 4 / 5;
    const handles: CropHandle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
    for (const handle of handles) {
      const dragged = resizeCrop(start, handle, 0.75, 0.78, locked);
      expect(dragged.w / dragged.h, handle).toBeCloseTo(locked, 6);
    }
  });

  it('will not collapse to nothing', () => {
    const dragged = resizeCrop(start, 'e', -5, 0.5, null);
    expect(dragged.w).toBeGreaterThanOrEqual(0.04 - 1e-12);
  });

  it('stays inside the frame however far the pointer goes', () => {
    for (const handle of ['nw', 'se', 'n', 'w'] as CropHandle[]) {
      const dragged = resizeCrop(start, handle, 5, -5, null);
      const clamped = clampCrop(dragged);
      expect(dragged, handle).toEqual(clamped);
      expect(dragged.x).toBeGreaterThanOrEqual(0);
      expect(dragged.y).toBeGreaterThanOrEqual(0);
      expect(dragged.x + dragged.w).toBeLessThanOrEqual(1 + 1e-12);
      expect(dragged.y + dragged.h).toBeLessThanOrEqual(1 + 1e-12);
    }
  });
});

describe('shape presets', () => {
  it('names every preset uniquely', () => {
    const keys = ASPECTS.map((preset) => preset.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('leaves a free crop unconstrained', () => {
    expect(resolveAspect('free', 1.5)).toBeNull();
    expect(resolveAspect('nonsense', 1.5)).toBeNull();
  });

  it('follows the frame when asked to keep the original shape', () => {
    // The frame, not the photo: a quarter turn has to take the lock with it.
    expect(resolveAspect('original', 1.5)).toBe(1.5);
    expect(resolveAspect('original', 1 / 1.5)).toBe(1 / 1.5);
  });

  it('carries a size only where a service publishes one', () => {
    expect(aspectByKey('square')?.longEdge).toBe(0);
    expect(aspectByKey('instagram.portrait')?.longEdge).toBe(1350);
    expect(aspectByKey('instagram.portrait')?.ratio).toBeCloseTo(4 / 5, 9);
  });

  it('converts a pixel ratio into the frame’s own coordinates', () => {
    // A square crop on a 3:2 frame is not a normalised square.
    expect(normalisedRatio(1, 1.5)).toBeCloseTo(2 / 3, 9);
    expect(normalisedRatio(1.5, 1.5)).toBe(1);
  });
});

describe('flipping along the axis on screen', () => {
  it('reaches the stored field directly when the photo is upright', () => {
    expect(flipFieldFor(0, 'h')).toBe('flipH');
    expect(flipFieldFor(0, 'v')).toBe('flipV');
    expect(flipFieldFor(2, 'h')).toBe('flipH');
  });

  it('swaps them on a photo turned a quarter turn', () => {
    // A flip is stored in the photo's own frame. On a turned photo the button
    // labelled for the screen has to reach the other field, or it mirrors the
    // picture along the axis the user did not ask for.
    expect(flipFieldFor(1, 'h')).toBe('flipV');
    expect(flipFieldFor(1, 'v')).toBe('flipH');
    expect(flipFieldFor(3, 'h')).toBe('flipV');
  });
});
