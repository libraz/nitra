/**
 * The normal field, which is a set of signs waiting to be got wrong.
 *
 * Everything here is one convention meeting another: the model's depth grows
 * away from the camera, the picture's y grows downward, and the light direction
 * the field will be dotted against is one somebody chose with up meaning up. A
 * sign lost between any two of those still renders — it renders a face lit from
 * the wrong side, or inflated where it should be hollow, and both look enough
 * like lighting to survive a glance at the screen.
 *
 * So the directions are asserted against a head whose shape is known, in all
 * four of them, rather than the field being checked for plausibility.
 */

import { describe, expect, it } from 'vitest';
import { faceRegions } from '../src/core/face/geometry';
import { type NormalBitmap, rasteriseNormals } from '../src/core/face/normals';
import { faceRegion } from '../src/core/face/raster';
import { makeFace } from './helpers/face';

const SOURCE = 800;

function build(shape: Parameters<typeof makeFace>[0] = {}) {
  const regions = faceRegions(makeFace(shape), 1);
  return { regions, ...rasteriseNormals([regions], SOURCE, SOURCE, 1) };
}

/** The normal at a point given in image-width units, unpacked back to a vector. */
function normalAt(
  map: NormalBitmap,
  region: { x: number; y: number; width: number },
  point: { x: number; y: number },
) {
  const scale = map.width / region.width;
  const x = Math.round((point.x - region.x) * scale);
  const y = Math.round((point.y - region.y) * scale);
  const at = (y * map.width + x) * 4;
  return {
    x: ((map.data[at] as number) / 255) * 2 - 1,
    y: ((map.data[at + 1] as number) / 255) * 2 - 1,
    z: ((map.data[at + 2] as number) / 255) * 2 - 1,
    coverage: (map.data[at + 3] as number) / 255,
  };
}

describe('the face normal field', () => {
  it('addresses the same working area as the coverage masks', () => {
    // One rectangle for both, so a stage that samples a mask and a normal at the
    // same pixel is reading the same place on the face. Two rectangles that
    // agree today are two that can stop agreeing.
    const { regions, region } = build();
    expect(region).toEqual(faceRegion([regions], 1));
  });

  it('reports a flat face as facing the camera', () => {
    // Not a shape any head has, which is the point: it is the one shape whose
    // answer is known exactly, so anything the arithmetic adds shows up here.
    const { regions, map, region } = build({ relief: 0, nose: 0 });
    const middle = normalAt(map, region, regions.centre);
    expect(middle.x).toBeCloseTo(0, 2);
    expect(middle.y).toBeCloseTo(0, 2);
    expect(middle.z).toBeCloseTo(1, 2);
  });

  it('points every normal somewhere, at unit length', () => {
    // A zero-length normal is a black pixel in the shading, and a normal longer
    // than one is a pixel brighter than the light that fell on it.
    const { map } = build();
    let checked = 0;
    for (let i = 0; i < map.data.length; i += 4) {
      const x = ((map.data[i] as number) / 255) * 2 - 1;
      const y = ((map.data[i + 1] as number) / 255) * 2 - 1;
      const z = ((map.data[i + 2] as number) / 255) * 2 - 1;
      expect(Math.hypot(x, y, z)).toBeCloseTo(1, 1);
      checked++;
    }
    expect(checked).toBeGreaterThan(1000);
  });

  it('turns a dome outward in all four directions', () => {
    // The whole of the sign question in one assertion. Left of the middle of a
    // face, the surface faces left; above it, it faces up — and up is towards
    // smaller y in the picture, which is the flip that gets lost.
    const { regions, map, region } = build({ nose: 0 });
    const { centre, width } = regions;
    const step = width * 0.28;
    const left = normalAt(map, region, { x: centre.x - step, y: centre.y });
    const right = normalAt(map, region, { x: centre.x + step, y: centre.y });
    const above = normalAt(map, region, { x: centre.x, y: centre.y - step });
    const below = normalAt(map, region, { x: centre.x, y: centre.y + step });

    expect(left.x).toBeLessThan(-0.05);
    expect(right.x).toBeGreaterThan(0.05);
    expect(above.y).toBeGreaterThan(0.05);
    expect(below.y).toBeLessThan(-0.05);
    // Sideways at the sides and nothing much vertical, which is what says the
    // two axes have not been crossed.
    expect(Math.abs(left.y)).toBeLessThan(Math.abs(left.x));
    expect(Math.abs(above.x)).toBeLessThan(Math.abs(above.y));
  });

  it('puts a ridge down the nose rather than a mound', () => {
    // The feature the relighting exists to catch. Either side of the midline the
    // surface has to face away from it, and by more than the dome alone does —
    // a ridge that came out as a bulge would light the whole middle of the face
    // instead of drawing a line down it.
    const domed = build({ nose: 0 });
    const ridged = build();
    const { centre, width } = domed.regions;
    const offset = width * 0.07;
    const flank = (built: ReturnType<typeof build>, side: number) =>
      normalAt(built.map, built.region, { x: centre.x + side * offset, y: centre.y }).x;

    expect(flank(ridged, -1)).toBeLessThan(flank(domed, -1));
    expect(flank(ridged, 1)).toBeGreaterThan(flank(domed, 1));
    // And symmetric, because the synthetic nose is.
    expect(flank(ridged, -1)).toBeCloseTo(-flank(ridged, 1), 1);
  });

  it('carries how much surface it had, and none outside the mesh', () => {
    // The field is only an answer where landmarks surrounded the pixel. Beyond
    // them there is no surface to have measured, which is a different statement
    // from a surface facing the camera — and the corners of the working area
    // are exactly where a face turned away leaves the mesh behind.
    const { regions, map, region } = build();
    expect(normalAt(map, region, regions.centre).coverage).toBeCloseTo(1, 1);
    const corner = normalAt(map, region, { x: region.x, y: region.y });
    expect(corner.coverage).toBe(0);
  });

  it('holds the shape still when the head is somewhere else in the frame', () => {
    // The relief is a property of the head, so moving the head across the frame
    // or changing its size must not change which way its cheek faces. What this
    // is really checking is that the depth was scaled into width units and not
    // left in the model's own box.
    const near = build({ centre: { x: 0.5, y: 0.5 }, width: 0.3 });
    const far = build({ centre: { x: 0.25, y: 0.7 }, width: 0.15 });
    const cheek = (built: ReturnType<typeof build>) => {
      const { centre, width } = built.regions;
      return normalAt(built.map, built.region, { x: centre.x + width * 0.28, y: centre.y }).x;
    };
    expect(cheek(far)).toBeCloseTo(cheek(near), 1);
  });
});
