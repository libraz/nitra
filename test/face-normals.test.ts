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
import { makeFace, meshTriangles } from './helpers/face';

const SOURCE = 800;

function build(shape: Parameters<typeof makeFace>[0] = {}) {
  const regions = faceRegions(makeFace(shape), 1);
  return { regions, ...rasteriseNormals([regions], meshTriangles(), SOURCE, SOURCE, 1) };
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

/**
 * The largest angle between the normals of two neighbouring pixels, in degrees,
 * over the pixels a predicate picks out.
 *
 * An angle rather than a difference per channel, because what a fold in the
 * field is is a turn: two directions can differ in every channel and describe
 * the same surface turning smoothly.
 */
function worstTurn(
  { map }: { map: NormalBitmap },
  pick: (x: number, y: number) => boolean,
): number {
  const unit = (index: number) => {
    const at = index * 4;
    const x = ((map.data[at] as number) / 255) * 2 - 1;
    const y = ((map.data[at + 1] as number) / 255) * 2 - 1;
    const z = ((map.data[at + 2] as number) / 255) * 2 - 1;
    const length = Math.hypot(x, y, z) || 1;
    return [x / length, y / length, z / length, (map.data[at + 3] as number) / 255] as const;
  };
  let worst = 0;
  for (let y = 0; y < map.height; y++) {
    for (let x = 0; x < map.width; x++) {
      if (!pick(x, y)) continue;
      const here = unit(y * map.width + x);
      if (here[3] < 0.5) continue;
      for (const [dx, dy] of [
        [1, 0],
        [0, 1],
      ] as [number, number][]) {
        if (x + dx >= map.width || y + dy >= map.height) continue;
        if (!pick(x + dx, y + dy)) continue;
        const next = unit((y + dy) * map.width + x + dx);
        if (next[3] < 0.5) continue;
        const dot = here[0] * next[0] + here[1] * next[1] + here[2] * next[2];
        worst = Math.max(worst, Math.acos(Math.min(1, Math.max(-1, dot))));
      }
    }
  }
  return (worst * 180) / Math.PI;
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

  it('counts a hole in the mesh as surface', () => {
    // The tessellation has no triangles inside the eye openings or the mouth,
    // because there are no landmarks in there to make any from. So the field
    // arrives with holes in it, and a hole in the mesh is not a hole in the
    // face: a light falls on an eye, and leaving it uncovered puts an unlit
    // patch over each one with the feather drawn round it.
    const regions = faceRegions(makeFace(), 1);
    const { centre, width } = regions;
    const punched = new Set<number>();
    regions.surface.forEach((point, index) => {
      if (Math.hypot(point.x - centre.x, point.y - centre.y) < width * 0.18) punched.add(index);
    });
    const whole = meshTriangles();
    const holed = whole.filter((triangle) => !triangle.some((vertex) => punched.has(vertex)));
    expect(holed.length).toBeLessThan(whole.length);

    const { map, region } = rasteriseNormals([regions], holed, SOURCE, SOURCE, 1);
    expect(normalAt(map, region, centre).coverage).toBeCloseTo(1, 1);
    // Filled from the inside, not by growing the field: what is outside the mesh
    // is still outside it.
    expect(normalAt(map, region, { x: region.x, y: region.y }).coverage).toBe(0);
  });

  it('fills a gap more smoothly than the surface around it', () => {
    // A gap is filled from coarser copies of the field rather than by carrying
    // the nearest direction outwards, and this is the difference between the
    // two: where two fronts of a nearest-neighbour fill meet, the direction
    // steps from one side's to the other's with nothing in between, and the
    // line that leaves runs through the middle of the gap. Nothing about the
    // field's smoothness, its length or its signs can see that — it is a fold
    // in something that is unit length and correctly signed either side of it.
    //
    // So what is asserted is that the gap is the *calmest* part of the field:
    // an interpolation has nothing in it to be steeper than the surface it was
    // interpolated from, while a seam is steeper than anything the mesh does.
    const regions = faceRegions(makeFace(), 1);
    const { centre, width } = regions;
    const punched = new Set<number>();
    regions.surface.forEach((point, index) => {
      if (Math.hypot(point.x - centre.x, point.y - centre.y) < width * 0.3) punched.add(index);
    });
    const whole = meshTriangles();
    const holed = whole.filter((triangle) => !triangle.some((vertex) => punched.has(vertex)));
    expect(holed.length).toBeLessThan(whole.length);

    const intact = rasteriseNormals([regions], whole, SOURCE, SOURCE, 1);
    const gapped = rasteriseNormals([regions], holed, SOURCE, SOURCE, 1);
    const inside = (built: typeof gapped) => {
      const scale = built.map.width / built.region.width;
      const cx = (centre.x - built.region.x) * scale;
      const cy = (centre.y - built.region.y) * scale;
      // Inside the gap and clear of its rim, so what is measured is the fill
      // rather than the triangles it was filled from.
      const radius = width * 0.3 * scale * 0.8;
      return (x: number, y: number) => Math.hypot(x - cx, y - cy) < radius;
    };
    expect(worstTurn(gapped, inside(gapped))).toBeLessThan(worstTurn(intact, () => true));
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
