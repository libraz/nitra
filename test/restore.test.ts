/**
 * The restore stage: the fit, and what the patch does to the pixels.
 *
 * The fit is asserted by giving it a transform and asking for it back, because
 * that is the only kind of check a least-squares solution can fail honestly —
 * a hand-picked expected matrix would be asserting arithmetic against itself.
 * What matters more is the other direction: that a difference a similarity
 * *cannot* absorb comes back as a large residual, since that number is the only
 * thing standing between somebody and a face pasted into a frame that is not
 * its own.
 *
 * The patch is asserted by what it leaves behind rather than against stored
 * bytes. Two claims are written into the module and neither is obvious: that it
 * stops inside the outline, and that matching the light is a gain rather than a
 * sum — which is to say the texture survives it. Both are measured here.
 */

import { describe, expect, it } from 'vitest';
import { transferToLinear } from '../src/core/color/spaces';
import type { Point } from '../src/core/face/geometry';
import { faceRegions } from '../src/core/face/geometry';
import { isRestoreNeutral, neutralRecipe, recipeSchema } from '../src/core/recipe/schema';
import {
  applySimilarity,
  fitResidual,
  fitSimilarity,
  invertSimilarity,
  pairFaces,
  type Similarity,
  similarityScale,
} from '../src/core/restore/align';
import { type GraftImage, graft } from '../src/core/restore/graft';
import { makeFace } from './helpers/face';

/** A face's outlines and mesh, as the analysis would hand them over. */
function regionsAt(centre: Point, width: number) {
  return faceRegions(makeFace({ centre, width }), 1);
}

/** A ring of points, which is all the graft wants of an outline. */
function ring(centre: Point, radius: number, count = 36): Point[] {
  return Array.from({ length: count }, (_, i) => {
    const angle = (i / count) * Math.PI * 2;
    return { x: centre.x + Math.cos(angle) * radius, y: centre.y + Math.sin(angle) * radius };
  });
}

function image(
  size: number,
  paint: (x: number, y: number) => [number, number, number],
): GraftImage {
  const data = new Uint8ClampedArray(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const [r, g, b] = paint(x, y);
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
      data[i + 3] = 255;
    }
  }
  return { data, width: size, height: size, space: 'srgb' };
}

/** Green channel in linear light, which is where a gain is a gain. */
function linearAt(data: Uint8ClampedArray, size: number, x: number, y: number): number {
  return transferToLinear((data[(y * size + x) * 4 + 1] as number) / 255);
}

/** Mean and spread of the linear green over a disc, both in linear light. */
function statsIn(
  data: Uint8ClampedArray,
  size: number,
  centre: Point,
  radius: number,
): { mean: number; spread: number } {
  const values: number[] = [];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (Math.hypot(x - centre.x * size, y - centre.y * size) > radius * size) continue;
      values.push(linearAt(data, size, x, y));
    }
  }
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length;
  return { mean, spread: Math.sqrt(variance) };
}

describe('fitting one face onto the other', () => {
  const surface = regionsAt({ x: 0.5, y: 0.5 }, 0.3).surface;

  it('gives back the transform it was given', () => {
    const known: Similarity = {
      c: 1.1 * Math.cos(0.3),
      s: 1.1 * Math.sin(0.3),
      tx: 0.07,
      ty: -0.04,
    };
    const moved = surface.map((p) => applySimilarity(known, p));
    const fitted = fitSimilarity(surface, moved);

    expect(fitted).not.toBeNull();
    const m = fitted as Similarity;
    expect(m.c).toBeCloseTo(known.c, 10);
    expect(m.s).toBeCloseTo(known.s, 10);
    expect(m.tx).toBeCloseTo(known.tx, 10);
    expect(m.ty).toBeCloseTo(known.ty, 10);
    expect(similarityScale(m)).toBeCloseTo(1.1, 10);
    expect(fitResidual(surface, moved, m)).toBeLessThan(1e-12);
  });

  it('undoes itself', () => {
    const forward: Similarity = { c: 0.8, s: 0.45, tx: 0.2, ty: -0.1 };
    const back = invertSimilarity(forward) as Similarity;
    const there = applySimilarity(forward, { x: 0.31, y: 0.62 });
    const home = applySimilarity(back, there);
    expect(home.x).toBeCloseTo(0.31, 12);
    expect(home.y).toBeCloseTo(0.62, 12);
  });

  it('reports what a move, a turn and a resize cannot absorb', () => {
    // A generator that gave the face a different expression: the mouth and the
    // jaw move and the rest of the head does not. No similarity can account for
    // that, and the whole point of the number is that it says so.
    const changed = surface.map((p) =>
      p.y > 0.55 ? { x: p.x, y: p.y + 0.012, z: p.z } : { x: p.x, y: p.y, z: p.z },
    );
    const fitted = fitSimilarity(surface, changed) as Similarity;
    const width = regionsAt({ x: 0.5, y: 0.5 }, 0.3).width;
    const residual = fitResidual(surface, changed, fitted) / width;

    // Against the same measurement on an exact similarity, which is zero.
    expect(residual).toBeGreaterThan(0.01);
  });

  it('survives every point landing in one place', () => {
    const heap = Array.from({ length: 8 }, () => ({ x: 0.4, y: 0.4 }));
    const moved = heap.map(() => ({ x: 0.6, y: 0.7 }));
    const fitted = fitSimilarity(heap, moved) as Similarity;
    expect(Number.isFinite(fitted.c)).toBe(true);
    expect(applySimilarity(fitted, { x: 0.4, y: 0.4 }).x).toBeCloseTo(0.6, 12);
  });
});

describe('deciding which face is which', () => {
  it('pairs a face with the one in the same place', () => {
    const destination = [regionsAt({ x: 0.3, y: 0.5 }, 0.2), regionsAt({ x: 0.72, y: 0.48 }, 0.22)];
    const reference = [regionsAt({ x: 0.71, y: 0.5 }, 0.21), regionsAt({ x: 0.31, y: 0.52 }, 0.2)];

    const pairs = pairFaces(destination, reference);
    expect(pairs).toHaveLength(2);
    expect(pairs[0]).toMatchObject({ destination: 0, reference: 1 });
    expect(pairs[1]).toMatchObject({ destination: 1, reference: 0 });
  });

  it('spends each reference face once', () => {
    // Two people standing close together and only one of them in the original.
    // Pairing by nearest alone would put the same face on both.
    const destination = [regionsAt({ x: 0.46, y: 0.5 }, 0.2), regionsAt({ x: 0.54, y: 0.5 }, 0.2)];
    const reference = [regionsAt({ x: 0.47, y: 0.5 }, 0.2)];

    const pairs = pairFaces(destination, reference);
    expect(pairs).toHaveLength(1);
    expect(pairs[0]?.destination).toBe(0);
  });

  it('leaves a face alone when the original has nothing near it', () => {
    const destination = [regionsAt({ x: 0.2, y: 0.3 }, 0.2), regionsAt({ x: 0.5, y: 0.3 }, 0.2)];
    const reference = [regionsAt({ x: 0.85, y: 0.8 }, 0.2), regionsAt({ x: 0.9, y: 0.2 }, 0.2)];
    expect(pairFaces(destination, reference)).toHaveLength(0);
  });

  it('pairs the only two faces there are however far apart they look', () => {
    // A generator that returned a square crop of a 4:3 frame moves every face
    // down the y axis without anything having moved in the photograph, because
    // a coordinate here is a fraction of the image's own width. With one face on
    // each side there is nothing to confuse, so the distance decides nothing.
    const destination = [regionsAt({ x: 0.5, y: 0.5 }, 0.3)];
    const reference = [regionsAt({ x: 0.5, y: 0.375 }, 0.3)];
    const pairs = pairFaces(destination, reference);
    expect(pairs).toHaveLength(1);
    expect(pairs[0]?.residual).toBeLessThan(1e-6);
  });

  it('measures the residual against the face it is going onto', () => {
    const destination = [regionsAt({ x: 0.5, y: 0.5 }, 0.3)];
    const reference = [regionsAt({ x: 0.52, y: 0.49 }, 0.28)];
    const pairs = pairFaces(destination, reference);
    // Two ellipses of the same construction differ by a similarity exactly, so
    // the fit has nothing left over. A residual here would mean the measurement
    // is picking up the move it is supposed to be absorbing.
    expect(pairs[0]?.residual).toBeLessThan(1e-6);
    // The transform carries the reference onto the destination, so its scale is
    // how much larger the generated face is than the photographed one.
    expect(pairs[0]?.scale).toBeCloseTo(0.3 / 0.28, 6);
  });
});

describe('the patch', () => {
  const SIZE = 200;
  const CENTRE: Point = { x: 0.5, y: 0.5 };
  const IDENTITY: Similarity = { c: 1, s: 0, tx: 0, ty: 0 };
  const face = {
    outline: ring(CENTRE, 0.15),
    source: ring(CENTRE, 0.15),
    width: 0.3,
    transform: IDENTITY,
  };

  /** Flat, so anything the patch writes is visible against it. */
  const flat = image(SIZE, () => [120, 120, 120]);

  /** Darker, and textured, so both the gain and the texture can be measured. */
  const textured = image(SIZE, (x, y) => {
    const base = 95 + 18 * Math.sin(x / 5) * Math.cos(y / 7);
    return [base, base, base];
  });

  it('does nothing without a face to put back', () => {
    expect(graft(flat, textured, [], 0.08, 1)).toBeNull();
  });

  it('leaves the photograph exactly as it was when it is its own reference', () => {
    // The round trip through linear light and back is the whole of what this
    // asserts, and it is worth asserting: every pixel inside the boundary goes
    // through it, so a transfer function applied the wrong way round would show
    // up as the face changing brightness and nothing else.
    const result = graft(flat, flat, [face], 0.08, 0);
    expect(result).not.toBeNull();
    const out = (result as { data: Uint8ClampedArray }).data;
    for (let i = 0; i < out.length; i++) {
      expect(out[i], `byte ${i}`).toBe(flat.data[i]);
    }
  });

  it('puts the reference inside the outline and nothing outside it', () => {
    const result = graft(flat, textured, [face], 0.08, 0);
    const out = (result as { data: Uint8ClampedArray }).data;
    const half = SIZE / 2;

    // Well inside: the reference, untouched, because the light is not matched.
    expect(out[(half * SIZE + half) * 4 + 1]).toBe(textured.data[(half * SIZE + half) * 4 + 1]);

    // Just inside the outline — the boundary is held short of it, so the frame
    // is still the frame here. This is the claim that makes the stage avoid the
    // hairline at all.
    const nearEdge = Math.round(0.145 * SIZE);
    expect(out[(half * SIZE + (half + nearEdge)) * 4 + 1]).toBe(120);

    // Outside it entirely.
    expect(out[(5 * SIZE + 5) * 4 + 1]).toBe(120);
  });

  it('reports the rectangle it wrote into', () => {
    const result = graft(flat, textured, [face], 0.08, 0);
    const region = (result as { regions: { x: number; y: number }[] }).regions[0];
    expect(region).toBeDefined();
    // The face is a disc of radius 0.15 about the middle, so the rectangle
    // around it cannot reach the corner of a 200-pixel frame.
    expect(region?.x).toBeGreaterThan(SIZE * 0.3);
  });

  it('matches the light by a gain, so the texture comes through it', () => {
    const matched = graft(flat, textured, [face], 0.08, 1);
    const out = (matched as { data: Uint8ClampedArray }).data;
    // Well inside the ramp, which ends two bands in: what is measured here is
    // the patch itself rather than the crossfade at its edge.
    const inner = 0.07;

    const before = statsIn(textured.data, SIZE, CENTRE, inner);
    const after = statsIn(out, SIZE, CENTRE, inner);
    const target = statsIn(flat.data, SIZE, CENTRE, inner);

    // It arrived at the frame's own level.
    expect(after.mean / target.mean).toBeGreaterThan(0.97);
    expect(after.mean / target.mean).toBeLessThan(1.03);

    // And it got there by being multiplied. A gain leaves the spread in
    // proportion to the mean, so the relative texture is untouched.
    const relativeBefore = before.spread / before.mean;
    const relativeAfter = after.spread / after.mean;
    expect(relativeAfter / relativeBefore).toBeGreaterThan(0.97);
    expect(relativeAfter / relativeBefore).toBeLessThan(1.03);

    // A sum would have carried the spread across unchanged while the mean rose,
    // so the relative texture would have fallen by exactly the factor the mean
    // was lifted by. That is the comparison the choice of a gain is about.
    const summed = before.spread / target.mean;
    expect(summed / relativeBefore).toBeCloseTo(before.mean / target.mean, 6);
    expect(summed / relativeBefore).toBeLessThan(0.7);
  });

  it('refuses to match a difference no relight would account for', () => {
    // The two regions are four stops apart, which is not one photograph lit two
    // ways — it is the patch being averaged against something that is not the
    // face. The clamp keeps it visibly dark instead of blowing it out.
    const black = image(SIZE, () => [12, 12, 12]);
    const bright = image(SIZE, () => [230, 230, 230]);
    const out = (graft(bright, black, [face], 0.08, 1) as { data: Uint8ClampedArray }).data;
    const half = SIZE / 2;
    const lifted = linearAt(out, SIZE, half, half);
    // Not exactly four: a value this dark has few codes under it, so what comes
    // back is the nearest byte to four times the input rather than four times
    // it. Reading the clamp back through eight bits is the honest measurement —
    // eight bits is what the plate holds.
    const ratio = lifted / transferToLinear(12 / 255);
    expect(ratio).toBeGreaterThan(3.8);
    expect(ratio).toBeLessThan(4.05);
    expect(lifted).toBeLessThan(transferToLinear(230 / 255));
  });

  it('takes the patch from where the transform says', () => {
    // The photographed face sits a fifth of the frame to the left of where the
    // generated one ended up; the transform is what carries that.
    const shift: Similarity = { c: 1, s: 0, tx: 0.2, ty: 0 };
    const offsetFace = {
      outline: ring(CENTRE, 0.15),
      source: ring({ x: CENTRE.x - 0.2, y: CENTRE.y }, 0.15),
      width: 0.3,
      transform: shift,
    };
    const result = graft(flat, textured, [offsetFace], 0.08, 0);
    const out = (result as { data: Uint8ClampedArray }).data;

    const half = SIZE / 2;
    const from = half - 0.2 * SIZE;
    expect(out[(half * SIZE + half) * 4 + 1]).toBe(textured.data[(half * SIZE + from) * 4 + 1]);
  });
});

describe('a recipe that says nothing about restoring', () => {
  it('restores nothing', () => {
    const fresh = neutralRecipe();
    expect(fresh.restore.reference).toBe('');
    expect(isRestoreNeutral(fresh.restore)).toBe(true);
  });

  it('restores nothing when it predates the field', () => {
    // The rule the whole schema is built on: a field an older build never wrote
    // has to render the photo unchanged.
    const old = recipeSchema.parse({ version: 1 });
    expect(isRestoreNeutral(old.restore)).toBe(true);
  });
});
