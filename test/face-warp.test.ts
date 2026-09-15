/**
 * Reshaping is the one stage that moves pixels rather than recolouring them, so
 * the failures are different in kind. A colour that is slightly wrong is a
 * colour that is slightly wrong; a displacement with the wrong sign moves a jaw
 * outwards while the slider says "slim", and a displacement that is not relative
 * to the face is a retouch that means something else on the next photograph.
 *
 * Two things are checked here that no single case could establish. The bounds
 * are asserted over the whole cross-product of the sliders rather than over
 * combinations chosen by hand, because the guardrail exists precisely for the
 * settings nobody would think to try — several sliders at once, all pulling on
 * the same part of an outline. And the directions are asserted against the
 * face's own axes on a tilted head, because the image's axes and the face's
 * agree only on a photograph taken straight.
 */

import { describe, expect, it } from 'vitest';
import { centroid, type FaceRegions, faceRegions, type Point } from '../src/core/face/geometry';
import {
  type ControlPoint,
  MAX_CONTROL_POINTS,
  RESHAPE_WARNING,
  warpBudget,
  warpControlPoints,
  warpMagnitude,
} from '../src/core/face/warp';
import { type FaceParams, neutralRecipe } from '../src/core/recipe/schema';
import { along, makeFace } from './helpers/face';

type Warp = FaceParams['warp'];

function warpOf(over: Partial<Warp> = {}): Warp {
  return { ...neutralRecipe().face.warp, ...over };
}

function face(shape: Parameters<typeof makeFace>[0] = {}): FaceRegions {
  const aspect = shape?.aspect ?? 1;
  return faceRegions(makeFace(shape), aspect);
}

function length(p: Point): number {
  return Math.hypot(p.x, p.y);
}

function pointsOf(faces: readonly FaceRegions[], warp: Warp): ControlPoint[] {
  return warpControlPoints(faces, warp).points;
}

/** The control point nearest a place on the face. */
function nearest(points: readonly ControlPoint[], to: Point): ControlPoint {
  let best = points[0] as ControlPoint;
  let close = Infinity;
  for (const p of points) {
    const d = Math.hypot(p.centre.x - to.x, p.centre.y - to.y);
    if (d < close) {
      close = d;
      best = p;
    }
  }
  return best;
}

/** The outline vertex furthest from the midline, on the face's own right. */
function widest(regions: FaceRegions): Point {
  let best = regions.centre;
  let far = -Infinity;
  for (const p of regions.oval) {
    const d = along(p, regions.centre, regions.axes.right);
    if (d > far) {
      far = d;
      best = p;
    }
  }
  return best;
}

function chinTip(regions: FaceRegions): Point {
  let best = regions.centre;
  let far = -Infinity;
  for (const p of regions.oval) {
    const d = along(p, regions.centre, regions.axes.down);
    if (d > far) {
      far = d;
      best = p;
    }
  }
  return best;
}

/**
 * Every setting of every slider, as a cross-product.
 *
 * Three values where the two directions differ and two where only one of them
 * is a retouch. That is 1296 settings, which is cheap enough to assert the
 * bounds over exhaustively — and exhaustive removes the question of whether the
 * combination that breaks the guardrail was one of the ones picked.
 */
function everySetting(): Warp[] {
  const axes: [keyof Warp, number[]][] = [
    ['faceSlim', [0, 1]],
    ['jawline', [0, 1]],
    ['chin', [-1, 0, 1]],
    ['eyeEnlarge', [0, 1]],
    ['eyeTilt', [-1, 0, 1]],
    ['noseNarrow', [0, 1]],
    ['noseBridge', [-1, 0, 1]],
    ['mouthWidth', [-1, 0, 1]],
  ];
  let all: Warp[] = [warpOf()];
  for (const [key, values] of axes) {
    all = all.flatMap((base) => values.map((value) => ({ ...base, [key]: value })));
  }
  return all;
}

/** The guardrail, as it is written in the module. */
const MAX_DISPLACEMENT = 0.08;

describe('the bounds on a displacement', () => {
  const settings = everySetting();

  it('covers the cross-product it claims to', () => {
    expect(settings).toHaveLength(2 * 2 * 3 * 2 * 3 * 2 * 3 * 3);
  });

  it('never moves any part of a face further than the guardrail allows', () => {
    // Several sliders act on the same part of an outline and nothing stops all
    // of them being raised. Past this much the outline crosses features that
    // are not moving with it.
    const regions = face();
    for (const warp of settings) {
      for (const point of warpControlPoints([regions], warp).points) {
        expect(
          length(point.delta) / regions.width,
          `${JSON.stringify(warp)} at ${JSON.stringify(point.centre)}`,
        ).toBeLessThanOrEqual(MAX_DISPLACEMENT + 1e-9);
      }
    }
  });

  it('stays inside the budget the shader loop is bounded by', () => {
    // Points past the bound would not be summed at all, and the part of the
    // face they described would stay put while its neighbours moved.
    for (const count of [1, 2, 5]) {
      const faces = Array.from({ length: count }, (_, i) =>
        face({ centre: { x: 0.2 + i * 0.15, y: 0.5 }, width: 0.12 }),
      );
      for (const warp of settings) {
        expect(warpControlPoints(faces, warp).points.length, `${count} faces`).toBeLessThanOrEqual(
          MAX_CONTROL_POINTS,
        );
      }
    }
  });

  it('reshapes as many faces as the field can describe, and says how many', () => {
    // The alternative is a fourth face reshaped as far as the budget reached,
    // which is a warp that stops halfway across somebody's jaw.
    const warp = warpOf({ faceSlim: 1, eyeEnlarge: 1, mouthWidth: 1, chin: 1, noseNarrow: 1 });
    for (const count of [1, 2, 3, 4, 5]) {
      const faces = Array.from({ length: count }, (_, i) =>
        face({ centre: { x: 0.12 + i * 0.18, y: 0.5 }, width: 0.1 + i * 0.01 }),
      );
      const field = warpControlPoints(faces, warp);
      expect(field.faces + field.omitted, `${count} faces`).toBe(count);
      expect(field.faces).toBe(Math.min(count, warpBudget(count).faces));
      expect(field.points.length).toBeLessThanOrEqual(MAX_CONTROL_POINTS);
    }
  });

  it('reshapes the largest faces rather than the first ones found', () => {
    // The large face is the one being retouched; the small one at the back of
    // the room is not what the slider was dragged for.
    const small = face({ centre: { x: 0.2, y: 0.5 }, width: 0.06 });
    const large = face({ centre: { x: 0.7, y: 0.5 }, width: 0.34 });
    const field = warpControlPoints([small, large, small, small, small], warpOf({ faceSlim: 1 }));
    const nearLarge = field.points.filter(
      (p) => Math.hypot(p.centre.x - large.centre.x, p.centre.y - large.centre.y) < large.width,
    );
    expect(nearLarge.length).toBeGreaterThan(0);
  });

  it('produces a finite radius and a finite delta everywhere', () => {
    const regions = face();
    for (const warp of settings) {
      for (const point of warpControlPoints([regions], warp).points) {
        expect(Number.isFinite(point.delta.x) && Number.isFinite(point.delta.y)).toBe(true);
        expect(point.radius).toBeGreaterThan(0);
      }
    }
  });
});

describe('a reshaping that was not asked for', () => {
  it('produces nothing at all when every slider is neutral', () => {
    expect(pointsOf([face()], warpOf())).toEqual([]);
  });

  it('produces nothing when there is no face', () => {
    expect(pointsOf([], warpOf({ faceSlim: 1 }))).toEqual([]);
  });

  it('produces something for each slider on its own', () => {
    const keys: (keyof Warp)[] = [
      'faceSlim',
      'jawline',
      'chin',
      'eyeEnlarge',
      'eyeTilt',
      'noseNarrow',
      'noseBridge',
      'mouthWidth',
    ];
    for (const key of keys) {
      expect(pointsOf([face()], warpOf({ [key]: 1 })).length, key).toBeGreaterThan(0);
    }
  });
});

describe('which way each slider moves the face', () => {
  it('slims by pulling the outline towards the midline', () => {
    const regions = face();
    const points = pointsOf([regions], warpOf({ faceSlim: 1 }));
    const point = nearest(points, widest(regions));
    // On the face's own right, so the motion has to be along its own left.
    expect(along(point.centre, regions.centre, regions.axes.right)).toBeGreaterThan(0);
    expect(
      point.delta.x * regions.axes.right.x + point.delta.y * regions.axes.right.y,
    ).toBeLessThan(0);
  });

  it('does not drag the chin sideways while slimming', () => {
    // The chin sits on the midline, and the pull is proportional to how far out
    // a vertex already is — so the vertices either side of the chin are pulled
    // towards each other and what they do to the chin itself cancels. A
    // slimming that moved it would be scaling the face rather than narrowing it.
    const regions = face();
    const points = pointsOf([regions], warpOf({ faceSlim: 1 }));
    const tip = chinTip(regions);
    const near = points.filter(
      (p) => Math.hypot(p.centre.x - tip.x, p.centre.y - tip.y) < regions.width * 0.15,
    );
    expect(near.length).toBeGreaterThan(1);
    const sum = near.reduce((acc, p) => ({ x: acc.x + p.delta.x, y: acc.y + p.delta.y }), {
      x: 0,
      y: 0,
    });
    const widestPull = length(nearest(points, widest(regions)).delta);
    expect(length(sum)).toBeLessThan(widestPull * 0.1);
  });

  it('pulls the lower outline harder than the upper when the jaw is tightened', () => {
    const regions = face();
    const points = pointsOf([regions], warpOf({ jawline: 1 }));
    const half = regions.width / 2;
    let lower = 0;
    let upper = 0;
    for (const p of points) {
      const down = along(p.centre, regions.centre, regions.axes.down) / half;
      if (down > 0.4) lower = Math.max(lower, length(p.delta));
      if (down < -0.4) upper = Math.max(upper, length(p.delta));
    }
    expect(lower).toBeGreaterThan(upper);
  });

  it('shortens the chin on the positive side and lengthens it on the negative', () => {
    const regions = face();
    const tip = chinTip(regions);
    const shorter = nearest(pointsOf([regions], warpOf({ chin: 1 })), tip);
    const longer = nearest(pointsOf([regions], warpOf({ chin: -1 })), tip);
    const downOf = (p: ControlPoint) =>
      p.delta.x * regions.axes.down.x + p.delta.y * regions.axes.down.y;
    expect(downOf(shorter)).toBeLessThan(0);
    expect(downOf(longer)).toBeGreaterThan(0);
  });

  it('opens an eye outwards from its own centre, leaving the centre where it was', () => {
    const regions = face();
    const points = pointsOf([regions], warpOf({ eyeEnlarge: 1 }));
    for (const eye of regions.sclera) {
      const eyeCentre = centroid(eye);
      const mine = points.filter(
        (p) =>
          Math.hypot(p.centre.x - eyeCentre.x, p.centre.y - eyeCentre.y) < regions.width * 0.15,
      );
      expect(mine.length).toBeGreaterThan(2);
      // Every one points away from the centre, so the ring grows.
      for (const p of mine) {
        const out = { x: p.centre.x - eyeCentre.x, y: p.centre.y - eyeCentre.y };
        expect(p.delta.x * out.x + p.delta.y * out.y).toBeGreaterThan(0);
      }
      // And they cancel, so the eye does not slide across the face.
      const sum = mine.reduce((acc, p) => ({ x: acc.x + p.delta.x, y: acc.y + p.delta.y }), {
        x: 0,
        y: 0,
      });
      const biggest = Math.max(...mine.map((p) => length(p.delta)));
      expect(length(sum)).toBeLessThan(biggest);
    }
  });

  it('lifts the outer corner of an eye and not the inner one', () => {
    const regions = face();
    const points = pointsOf([regions], warpOf({ eyeTilt: 1 }));
    expect(points).toHaveLength(2);
    for (const p of points) {
      const lateral = along(p.centre, regions.centre, regions.axes.right);
      const eyes = regions.sclera.map((eye) => centroid(eye));
      const own = eyes.reduce((closest, c) =>
        Math.hypot(c.x - p.centre.x, c.y - p.centre.y) <
        Math.hypot(closest.x - p.centre.x, closest.y - p.centre.y)
          ? c
          : closest,
      );
      const eyeLateral = along(own, regions.centre, regions.axes.right);
      // Further from the midline than the eye's own centre is what makes it the
      // outer corner.
      expect(Math.abs(lateral)).toBeGreaterThan(Math.abs(eyeLateral));
      // Up the face, which is against the axis that points at the mouth.
      expect(p.delta.x * regions.axes.down.x + p.delta.y * regions.axes.down.y).toBeLessThan(0);
    }
  });

  it('narrows the nose from both sides towards the middle', () => {
    const regions = face();
    const points = pointsOf([regions], warpOf({ noseNarrow: 1 }));
    expect(points).toHaveLength(2);
    const [left, right] = points as [ControlPoint, ControlPoint];
    const apartBefore = Math.hypot(left.centre.x - right.centre.x, left.centre.y - right.centre.y);
    const apartAfter = Math.hypot(
      left.centre.x + left.delta.x - (right.centre.x + right.delta.x),
      left.centre.y + left.delta.y - (right.centre.y + right.delta.y),
    );
    expect(apartAfter).toBeLessThan(apartBefore);
  });

  it('moves the corners of the mouth apart when widened and together when not', () => {
    const regions = face();
    const apart = (warp: Warp) => {
      const points = warpControlPoints([regions], warp).points;
      const [a, b] = points as [ControlPoint, ControlPoint];
      return Math.hypot(
        a.centre.x + a.delta.x - (b.centre.x + b.delta.x),
        a.centre.y + a.delta.y - (b.centre.y + b.delta.y),
      );
    };
    const rest = Math.hypot(
      ...(() => {
        const points = pointsOf([regions], warpOf({ mouthWidth: 1 }));
        const [a, b] = points as [ControlPoint, ControlPoint];
        return [a.centre.x - b.centre.x, a.centre.y - b.centre.y];
      })(),
    );
    expect(apart(warpOf({ mouthWidth: 1 }))).toBeGreaterThan(rest);
    expect(apart(warpOf({ mouthWidth: -1 }))).toBeLessThan(rest);
  });
});

describe('the amounts staying relative to the face', () => {
  it('moves a face twice as wide exactly twice as far', () => {
    // The whole reason the reaches are fractions of the face width: the same
    // recipe has to be the same retouch on a portrait and on a group photo.
    const warp = warpOf({ faceSlim: 1, jawline: 0.5, eyeEnlarge: 1, mouthWidth: 1 });
    const small = face({ width: 0.15 });
    const large = face({ width: 0.3 });
    expect(warpMagnitude(warpControlPoints([large], warp).points, large.width)).toBeCloseTo(
      warpMagnitude(warpControlPoints([small], warp).points, small.width),
      6,
    );
  });

  it('follows the face when the head tilts rather than the frame', () => {
    const warp = warpOf({ faceSlim: 1 });
    const upright = face();
    const straight = warpMagnitude(warpControlPoints([upright], warp).points, upright.width);
    for (const degrees of [15, 40, -30]) {
      const tilted = face({ rotation: (degrees * Math.PI) / 180 });
      expect(
        warpMagnitude(warpControlPoints([tilted], warp).points, tilted.width),
        `${degrees}°`,
      ).toBeCloseTo(straight, 2);
    }
  });

  it('means the same thing on a frame that is not square', () => {
    const warp = warpOf({ faceSlim: 1, eyeEnlarge: 1 });
    const square = face({ aspect: 1 });
    const base = warpMagnitude(warpControlPoints([square], warp).points, square.width);
    for (const aspect of [0.6, 1.8]) {
      const other = face({ aspect });
      expect(
        warpMagnitude(warpControlPoints([other], warp).points, other.width),
        `aspect ${aspect}`,
      ).toBeCloseTo(base, 2);
    }
  });
});

describe('the measured magnitude the guardrail reports', () => {
  it('rises with the slider and is zero when nothing is asked for', () => {
    const regions = face();
    const at = (amount: number) =>
      warpMagnitude(pointsOf([regions], warpOf({ faceSlim: amount })), regions.width);
    expect(at(0)).toBe(0);
    let previous = 0;
    for (const amount of [0.25, 0.5, 0.75, 1]) {
      const now = at(amount);
      expect(now, `at ${amount}`).toBeGreaterThan(previous);
      previous = now;
    }
  });

  it('reports nothing for a face of no width rather than dividing by it', () => {
    expect(warpMagnitude([{ centre: { x: 0, y: 0 }, delta: { x: 1, y: 0 }, radius: 1 }], 0)).toBe(
      0,
    );
  });

  it('is not diluted by a larger face standing next to a small one', () => {
    // The reading is a fraction of each face's own width, so putting a face four
    // times the size in the frame does not change what the small one reports.
    const warp = warpOf({ faceSlim: 1, chin: 1 });
    const large = face({ width: 0.36 });
    const small = face({ centre: { x: 0.85, y: 0.3 }, width: 0.09 });
    const alone = warpControlPoints([small], warp).magnitude;
    expect(warpControlPoints([large, small], warp).magnitude).toBeCloseTo(alone, 3);
  });

  it('reports nothing when there is nothing to reshape', () => {
    expect(warpControlPoints([], warpOf({ faceSlim: 1 })).magnitude).toBe(0);
    expect(warpControlPoints([face()], warpOf()).magnitude).toBe(0);
  });

  it('stops short of the sum when several sliders pull the same part', () => {
    // Slimming and the jawline both draw the lower outline inwards, and nothing
    // in the panel stops a person raising both. What the ceiling is there for is
    // that the two together do not reach their own sum, so the reading cannot
    // climb indefinitely by stacking controls.
    const regions = face();
    const slim = warpControlPoints([regions], warpOf({ faceSlim: 1 })).magnitude;
    const jaw = warpControlPoints([regions], warpOf({ jawline: 1 })).magnitude;
    const both = warpControlPoints([regions], warpOf({ faceSlim: 1, jawline: 1 })).magnitude;
    expect(both).toBeGreaterThan(Math.max(slim, jaw));
    expect(both).toBeLessThan(slim + jaw);
  });

  it('warns below the ceiling it is measuring against', () => {
    // A warning that only appeared at the ceiling would never appear: the
    // displacement is clamped there, so the reading cannot pass it.
    const regions = face();
    const everything = warpControlPoints(
      [regions],
      warpOf({
        faceSlim: 1,
        jawline: 1,
        chin: 1,
        eyeEnlarge: 1,
        eyeTilt: 1,
        noseNarrow: 1,
        noseBridge: 1,
        mouthWidth: 1,
      }),
    ).magnitude;
    expect(RESHAPE_WARNING).toBeLessThan(everything);
  });
});
