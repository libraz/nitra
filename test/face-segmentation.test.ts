/**
 * What to do when the two halves of the mask disagree.
 *
 * The intersection of the outline and the segmentation is what makes the mask
 * good, and an empty intersection is the worst outcome available: every skin
 * control moves and nothing happens. So the agreement is measured, and the
 * outline is allowed to stand on its own where there is none.
 */

import { describe, expect, it } from 'vitest';
import type { Point } from '../src/core/face/geometry';
import {
  SEGMENT_CHANNELS,
  type Segmentation,
  segmentationWeight,
  skinConfidence,
} from '../src/core/face/segmentation';

/**
 * A segmentation whose face-skin and person channels fill the given box.
 *
 * One builder for both because they are the same bitmap: the mask reads the
 * first channel and the separation reads the third, and a helper that packed
 * them differently would let a wrong channel index pass.
 */
function segmentation(
  size: number,
  skin: number,
  box: { x0: number; y0: number; x1: number; y1: number } = { x0: 0, y0: 0, x1: 1, y1: 1 },
  person = 0,
): Segmentation {
  const data = new Uint8ClampedArray(size * size * SEGMENT_CHANNELS);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = (x + 0.5) / size;
      const v = (y + 0.5) / size;
      const inBox = u >= box.x0 && u <= box.x1 && v >= box.y0 && v <= box.y1;
      data[(y * size + x) * SEGMENT_CHANNELS] = inBox ? skin * 255 : 0;
      data[(y * size + x) * SEGMENT_CHANNELS + 2] = inBox ? person * 255 : 0;
    }
  }
  return { width: size, height: size, data };
}

/** A square outline, in image-width units. */
function square(cx: number, cy: number, half: number): { oval: Point[] } {
  return {
    oval: [
      { x: cx - half, y: cy - half },
      { x: cx + half, y: cy - half },
      { x: cx + half, y: cy + half },
      { x: cx - half, y: cy + half },
    ],
  };
}

describe('measuring the agreement', () => {
  it('reads the confidence the segmentation has where the face is', () => {
    const found = skinConfidence(segmentation(64, 0.9), [square(0.5, 0.5, 0.2)], 1);
    expect(found).toBeCloseTo(0.9, 2);
  });

  it('reports nothing when the segmentation found nothing', () => {
    expect(skinConfidence(segmentation(64, 0), [square(0.5, 0.5, 0.2)], 1)).toBe(0);
  });

  it('asks about the face and not about the frame', () => {
    // A face filling a tenth of the frame would look like a disagreement if the
    // background were averaged in.
    const confident = segmentation(64, 1, { x0: 0.42, y0: 0.42, x1: 0.58, y1: 0.58 });
    expect(skinConfidence(confident, [square(0.5, 0.5, 0.06)], 1)).toBeCloseTo(1, 2);
  });

  it('does not count the segmentation outside the outline', () => {
    // Skin found on the other side of the frame says nothing about this face.
    const elsewhere = segmentation(64, 1, { x0: 0.0, y0: 0.0, x1: 0.2, y1: 0.2 });
    expect(skinConfidence(elsewhere, [square(0.7, 0.7, 0.15)], 1)).toBe(0);
  });

  it('finds the face on a frame that is not square', () => {
    // The outlines are in width units and the segmentation is in its own grid;
    // getting the conversion wrong would sample the wrong part of the photo.
    const aspect = 2;
    const lower = segmentation(64, 1, { x0: 0.3, y0: 0.6, x1: 0.7, y1: 0.95 });
    // In width units, three quarters of the way down a frame twice as tall as
    // it is wide sits at y = 1.5.
    expect(skinConfidence(lower, [square(0.5, 1.5, 0.1)], aspect)).toBeCloseTo(1, 2);
  });

  it('has nothing to say with no face at all', () => {
    expect(skinConfidence(segmentation(64, 1), [], 1)).toBe(0);
  });

  it('ignores an outline with no area', () => {
    const degenerate = {
      oval: [
        { x: 0.5, y: 0.5 },
        { x: 0.5, y: 0.5 },
        { x: 0.5, y: 0.5 },
      ],
    };
    expect(skinConfidence(segmentation(64, 1), [degenerate], 1)).toBe(0);
  });

  it('averages over every face in the frame', () => {
    const half = segmentation(64, 1, { x0: 0, y0: 0, x1: 0.5, y1: 1 });
    const both = skinConfidence(half, [square(0.25, 0.5, 0.1), square(0.75, 0.5, 0.1)], 1);
    expect(both).toBeGreaterThan(0.3);
    expect(both).toBeLessThan(0.7);
  });
});

describe('how much of it to believe', () => {
  it('believes a segmentation that agrees', () => {
    expect(segmentationWeight(0.9)).toBe(1);
  });

  it('ignores one that has nothing to say', () => {
    // Which leaves the outline standing on its own: a mask rougher at the
    // hairline, which is worth far more than no mask.
    expect(segmentationWeight(0.02)).toBe(0);
  });

  it('ramps between the two rather than switching', () => {
    // A photo sitting on the threshold must not flip between two different
    // masks from one analysis to the next.
    const ramp = [0.1, 0.2, 0.3, 0.4, 0.5].map(segmentationWeight);
    for (let i = 1; i < ramp.length; i++) {
      expect(ramp[i] as number, `step ${i}`).toBeGreaterThanOrEqual(ramp[i - 1] as number);
    }
    expect(ramp.some((weight) => weight > 0 && weight < 1)).toBe(true);
  });

  it('stays inside nought and one whatever it is given', () => {
    for (const confidence of [-1, 0, 0.5, 1, 4]) {
      const weight = segmentationWeight(confidence);
      expect(weight, `${confidence}`).toBeGreaterThanOrEqual(0);
      expect(weight, `${confidence}`).toBeLessThanOrEqual(1);
    }
  });
});
