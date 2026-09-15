/**
 * The regions are where a wrong number stops being a wrong number and becomes a
 * lip colour on somebody's chin, so they are checked against a face whose
 * geometry is known rather than against a photograph.
 *
 * The property that carries the most weight here is the one about the face
 * width. Every radius in the pipeline is a fraction of it, so if it moves when
 * the head tilts then every retouch moves with the tilt — and that is exactly
 * what a bounding box would have done.
 */

import { describe, expect, it } from 'vitest';
import {
  centroid,
  convexHull,
  dilate,
  faceRegions,
  type Point,
  polygonArea,
} from '../src/core/face/geometry';
import { along, inside, makeFace } from './helpers/face';

describe('the face width every radius is a fraction of', () => {
  it('recovers the width of the outline it was built from', () => {
    expect(faceRegions(makeFace({ width: 0.3 }), 1).width).toBeCloseTo(0.3, 2);
  });

  it('scales with the face and not with the frame', () => {
    const small = faceRegions(makeFace({ width: 0.12 }), 1).width;
    const large = faceRegions(makeFace({ width: 0.48 }), 1).width;
    expect(large / small).toBeCloseTo(4, 1);
  });

  it('does not move when the head tilts', () => {
    // A bounding box around a face rotated thirty degrees is half again too
    // wide, and every radius keyed to it would grow with the tilt.
    const upright = faceRegions(makeFace(), 1).width;
    for (const degrees of [10, 30, 45, 90, -25]) {
      const tilted = faceRegions(makeFace({ rotation: (degrees * Math.PI) / 180 }), 1).width;
      expect(tilted / upright, `${degrees}°`).toBeCloseTo(1, 2);
    }
  });

  it('does not move when the frame stops being square', () => {
    const square = faceRegions(makeFace({ aspect: 1 }), 1).width;
    for (const aspect of [0.5, 1.5, 2.2]) {
      const other = faceRegions(makeFace({ aspect }), aspect).width;
      expect(other / square, `aspect ${aspect}`).toBeCloseTo(1, 2);
    }
  });

  it('does not move when the face does', () => {
    const middle = faceRegions(makeFace({ centre: { x: 0.5, y: 0.5 } }), 1).width;
    const corner = faceRegions(makeFace({ centre: { x: 0.25, y: 0.7 } }), 1).width;
    expect(corner).toBeCloseTo(middle, 3);
  });
});

describe('the regions', () => {
  it('tells the outer lip ring from the inner one by its area', () => {
    // Both rings carry the same number of landmarks, so nothing in the index
    // lists could say which is which.
    const regions = faceRegions(makeFace(), 1);
    expect(polygonArea(regions.lips)).toBeGreaterThan(polygonArea(regions.mouth) * 1.5);
  });

  it('excludes both eyes, both brows and the lips from the skin', () => {
    expect(faceRegions(makeFace(), 1).features).toHaveLength(5);
  });

  it('grows each exclusion past the feature it covers', () => {
    // A brow smoothed at its edge is a visible smear, so the margin errs
    // outwards rather than tracing the landmarks exactly.
    const regions = faceRegions(makeFace(), 1);
    const eye = regions.sclera[0] as Point[];
    const covering = regions.features.find(
      (feature) => polygonArea(feature) > polygonArea(eye) && inside(feature, centroid(eye)),
    );
    expect(covering).toBeDefined();
    expect(polygonArea(covering as Point[])).toBeGreaterThan(polygonArea(eye));
  });

  it('puts the under-eye bands under the eyes, on a tilted head too', () => {
    for (const degrees of [0, 35, -35]) {
      const regions = faceRegions(makeFace({ rotation: (degrees * Math.PI) / 180 }), 1);
      const down = {
        x: Math.sin((degrees * Math.PI) / 180) * -1,
        y: Math.cos((degrees * Math.PI) / 180),
      };
      for (const [i, band] of regions.undereye.entries()) {
        const eye = centroid(regions.sclera[i] as Point[]);
        expect(along(centroid(band), eye, down), `${degrees}° eye ${i}`).toBeGreaterThan(0);
      }
    }
  });

  it('keeps the under-eye bands off the lips', () => {
    const regions = faceRegions(makeFace(), 1);
    for (const band of regions.undereye) {
      expect(inside(regions.lips, centroid(band))).toBe(false);
    }
  });

  it('puts the cheeks inside the face, below the eyes and off the middle', () => {
    const regions = faceRegions(makeFace(), 1);
    const eyes = centroid([...(regions.sclera[0] as Point[]), ...(regions.sclera[1] as Point[])]);
    expect(regions.cheeks).toHaveLength(2);
    for (const cheek of regions.cheeks) {
      expect(inside(regions.oval, cheek.centre)).toBe(true);
      expect(cheek.centre.y).toBeGreaterThan(eyes.y);
      expect(Math.abs(cheek.centre.x - regions.centre.x)).toBeGreaterThan(regions.width * 0.1);
      // A hard-edged disc of colour is unmistakable, so the falloff is wide.
      expect(cheek.feather).toBeGreaterThan(0);
    }
  });

  it('keeps every radius proportional to the face', () => {
    const small = faceRegions(makeFace({ width: 0.15 }), 1);
    const large = faceRegions(makeFace({ width: 0.45 }), 1);
    const ratio = large.width / small.width;
    expect((large.cheeks[0] as { radius: number }).radius).toBeCloseTo(
      (small.cheeks[0] as { radius: number }).radius * ratio,
      3,
    );
    expect(polygonArea(large.undereye[0] as Point[])).toBeCloseTo(
      polygonArea(small.undereye[0] as Point[]) * ratio * ratio,
      3,
    );
  });

  it('refuses a landmark set that is missing one', () => {
    const short = makeFace().slice(0, 100);
    expect(() => faceRegions(short, 1)).toThrow(/landmark/);
  });
});

describe('the polygon helpers', () => {
  it('measures area whichever way round the outline is wound', () => {
    const square = [
      { x: 0, y: 0 },
      { x: 2, y: 0 },
      { x: 2, y: 2 },
      { x: 0, y: 2 },
    ];
    expect(polygonArea(square)).toBeCloseTo(4, 9);
    expect(polygonArea([...square].reverse())).toBeCloseTo(4, 9);
  });

  it('grows a polygon outwards and keeps it centred', () => {
    const square = [
      { x: -1, y: -1 },
      { x: 1, y: -1 },
      { x: 1, y: 1 },
      { x: -1, y: 1 },
    ];
    const grown = dilate(square, 0.5);
    expect(polygonArea(grown)).toBeGreaterThan(polygonArea(square));
    expect(centroid(grown).x).toBeCloseTo(0, 9);
    expect(centroid(grown).y).toBeCloseTo(0, 9);
  });

  it('leaves a degenerate polygon where it is rather than dividing by nothing', () => {
    const point = [
      { x: 1, y: 1 },
      { x: 1, y: 1 },
      { x: 1, y: 1 },
    ];
    expect(dilate(point, 0.5)).toEqual(point);
  });

  it('drops the points a hull encloses', () => {
    const hull = convexHull([
      { x: 0, y: 0 },
      { x: 4, y: 0 },
      { x: 4, y: 4 },
      { x: 0, y: 4 },
      { x: 2, y: 2 },
      { x: 1, y: 3 },
    ]);
    expect(hull).toHaveLength(4);
    expect(polygonArea(hull)).toBeCloseTo(16, 9);
  });

  it('returns what it was given when there is no hull to take', () => {
    const two = [
      { x: 0, y: 0 },
      { x: 1, y: 1 },
    ];
    expect(convexHull(two)).toEqual(two);
  });
});
