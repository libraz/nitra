/**
 * Duplicate detections of one face are resolved by how much of its own search
 * window the face filled, never by its absolute width.
 */

import { describe, expect, it } from 'vitest';
import { type Detection, merge } from '../src/core/face/analyze';
import { faceRegions } from '../src/core/face/geometry';
import { makeFace } from './helpers/face';

/** A detection of a face of the given width, found in a window of the given width. */
function detect(width: number, window: number, x = 0.5): Detection {
  const face = faceRegions(makeFace({ width, centre: { x, y: 0.5 } }), 1);
  return { face, share: face.width / window };
}

describe('merging duplicate detections', () => {
  it('keeps the detection that filled more of its window, even when it is narrower', () => {
    const wholeFrame = detect(0.3, 1);
    const tile = detect(0.29, 0.4);
    for (const order of [
      [wholeFrame, tile],
      [tile, wholeFrame],
    ]) {
      const kept = merge(order);
      expect(kept).toHaveLength(1);
      expect(kept[0]).toBe(tile.face);
    }
  });

  it('keeps faces that are not the same face', () => {
    expect(merge([detect(0.2, 1, 0.2), detect(0.2, 0.4, 0.8)])).toHaveLength(2);
  });
});
