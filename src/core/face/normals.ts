/**
 * The face's surface normals, as a bitmap the relighting can sample.
 *
 * A normal per pixel is what turns a light direction into shading, and it is the
 * one thing the landmark model does not hand over: it returns 468 points with a
 * depth each, and what a shader wants is the direction the skin faces between
 * them.
 *
 * Built by splatting the points into a height field and differentiating it,
 * rather than by meshing them. The model publishes its tessellation as a list of
 * edges, so meshing would mean recovering the triangles from it — and a triangle
 * rasteriser is a vertex path this renderer does not have, since every pass here
 * draws one fullscreen triangle with no buffer behind it. Differentiating a
 * height field needs neither, and the thing being approximated is smooth: what
 * the relighting wants is the shape of a cheek and the ridge of a nose, not the
 * facets between adjacent landmarks.
 *
 * The approximation it makes is that the face is single-valued in depth from
 * where the camera stood, which is true of every face that is not in profile and
 * degrades as the head turns rather than breaking.
 *
 * No GPU and no model runtime is involved, so all of it is testable directly.
 */

import type { FaceRegions } from './geometry';
import { type FaceMaskRegion, faceRegion, maskSize } from './raster';

/** Normals packed as bytes: the direction in rgb, how much surface in alpha. */
export interface NormalBitmap {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

/**
 * Longest edge of the normal map.
 *
 * Smaller than the coverage bitmaps because it holds something smooth. A mask
 * carries the outline of an eyelid and is judged on how cleanly that edge lands;
 * a normal field's finest feature is the ridge of a nose, which is a quarter of
 * a face across. At this size that ridge is around forty pixels of a working
 * area that spans about one and two thirds of a face.
 */
const NORMAL_LONG_EDGE = 256;

/**
 * Reach of one landmark's contribution, as a fraction of the face width.
 *
 * Derived rather than chosen. The mesh spreads 468 points over an area of
 * roughly one and a half face widths squared, so they sit about five and a half
 * hundredths of a face apart; a reach of this size therefore has half a dozen
 * points inside it everywhere, which is what makes the height between them a
 * surface rather than a set of bumps.
 *
 * Too small and the field is a cone per landmark, with a crease along every
 * midline between two of them — and a crease in a height field is a line of
 * wrong normals, which relighting draws as a bright seam. Too large and the nose
 * flattens into the cheeks.
 */
const LANDMARK_REACH = 0.08;

/**
 * How much of the model's depth to believe.
 *
 * The model's depth is normalised to the horizontal scale, so in principle this
 * is one and the relief needs no gain at all. It is here as a named number
 * because that scale is the part of the landmark output with the least behind
 * it: the points are fitted to an image, and how far the nose comes forward is
 * the component of that fit the image constrains least.
 */
const SURFACE_RELIEF = 1;

/**
 * Smooth, compact falloff for one landmark's contribution.
 *
 * Zero value *and* zero slope at the edge of the reach, which is what keeps a
 * ring of wrong normals from appearing where a contribution stops. A linear
 * falloff has a corner there, and a corner in the weights is a corner in the
 * height.
 */
function falloff(squared: number): number {
  const t = 1 - squared;
  return t * t;
}

/**
 * How far the height field is smoothed, as a fraction of a landmark's reach.
 *
 * Enough to even out the spacing between contributions and not enough to take
 * the nose with it: the ridge is about three times a reach across, so a window
 * of this fraction of one leaves it while the lumps between landmarks go.
 */
const SMOOTHING = 0.6;

/** The widest face's landmark reach, in width units. */
function reachOf(faces: readonly FaceRegions[]): number {
  return Math.max(...faces.map((face) => face.width), 0) * LANDMARK_REACH;
}

/** Separable box blur over a scalar field, run once per axis. */
function blur(field: Float32Array, width: number, height: number, radius: number): Float32Array {
  const out = new Float32Array(field.length);
  const pass = (from: Float32Array, to: Float32Array, alongX: boolean) => {
    const outer = alongX ? height : width;
    const inner = alongX ? width : height;
    const step = alongX ? 1 : width;
    for (let o = 0; o < outer; o++) {
      const base = alongX ? o * width : o;
      for (let i = 0; i < inner; i++) {
        let sum = 0;
        let count = 0;
        for (let k = -radius; k <= radius; k++) {
          const at = i + k;
          if (at < 0 || at >= inner) continue;
          sum += from[base + at * step] as number;
          count += 1;
        }
        to[base + i * step] = sum / Math.max(count, 1);
      }
    }
  };
  const middle = new Float32Array(field.length);
  pass(field, middle, true);
  pass(middle, out, false);
  return out;
}

/**
 * Rasterise every face's normals over the same working area as the masks.
 *
 * The area comes from {@link faceRegion}, so one rectangle addresses the masks
 * and this together and a stage that samples both cannot map them differently.
 */
export function rasteriseNormals(
  faces: readonly FaceRegions[],
  sourceWidth: number,
  sourceHeight: number,
  aspect: number,
): { map: NormalBitmap; region: FaceMaskRegion } {
  const box = faceRegion(faces, aspect);
  const [width, height] = maskSize(
    box.width * sourceWidth,
    box.height * sourceHeight,
    NORMAL_LONG_EDGE,
  );
  const data = new Uint8ClampedArray(width * height * 4);
  const count = width * height;
  const depth = new Float32Array(count);
  const weight = new Float32Array(count);

  // Pixels per unit of image width, and the offset of the working area, in the
  // isotropic units the surface is measured in. Both axes share the scale, so
  // one pixel is the same distance either way and the derivatives below need no
  // second factor.
  const scale = width / box.width;
  const shift = { x: box.x, y: box.y * aspect };

  let depthSum = 0;
  let depthCount = 0;

  for (const face of faces) {
    const reach = Math.max(face.width * LANDMARK_REACH, 1e-6);
    const reachPixels = reach * scale;
    for (const point of face.surface) {
      depthSum += point.z;
      depthCount += 1;
      const cx = (point.x - shift.x) * scale;
      const cy = (point.y - shift.y) * scale;
      const x0 = Math.max(0, Math.floor(cx - reachPixels));
      const x1 = Math.min(width - 1, Math.ceil(cx + reachPixels));
      const y0 = Math.max(0, Math.floor(cy - reachPixels));
      const y1 = Math.min(height - 1, Math.ceil(cy + reachPixels));
      for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
          const dx = (x - cx) / reachPixels;
          const dy = (y - cy) / reachPixels;
          const squared = dx * dx + dy * dy;
          if (squared >= 1) continue;
          const w = falloff(squared);
          const index = y * width + x;
          depth[index] = (depth[index] as number) + w * point.z;
          weight[index] = (weight[index] as number) + w;
        }
      }
    }
  }

  // Height towards the camera, which is the opposite of the depth the model
  // reports. Where no landmark reached, the face's own mean stands in: the
  // alpha fades the result out there anyway, and a hole in the field would put
  // a cliff — and so a ring of sideways normals — around the edge of the mesh.
  const mean = depthCount > 0 ? depthSum / depthCount : 0;
  let rise: Float32Array = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    const w = weight[i] as number;
    const z = w > 0 ? (depth[i] as number) / w : mean;
    rise[i] = -(z - mean) * SURFACE_RELIEF;
  }

  // Smoothed before it is differentiated, and this is not optional.
  //
  // The mesh is not evenly spread: it crowds around the eyes and the mouth and
  // thins out over the forehead and the cheeks, so out there the height comes
  // from a handful of contributions and carries their shape. That shows up in
  // the field as gentle lumps, which a derivative turns into patches of normal
  // pointing in unrelated directions — invisible in the numbers, since the field
  // is still smooth and still unit length, and plainly visible the moment a
  // light is put on it as mottling across a forehead that has none.
  //
  // Twice, because one box leaves its own corners in the result and a second
  // pass over the first is a smooth kernel. The radius is a fraction of the
  // reach rather than of the face: what is being evened out is the spacing of
  // the contributions, and the reach is already a fraction of the face.
  const smoothing = Math.max(1, Math.round(reachOf(faces) * scale * SMOOTHING));
  rise = blur(blur(rise, width, height, smoothing), width, height, smoothing);

  // And the coverage with it, which is a separate defect with the same cause.
  // Out at the rim of the mesh the points have skin on one side of them only,
  // so each one's contribution stops on its own and the edge of the field comes
  // out scalloped — a row of discs rather than a boundary. Confinement is what
  // that channel is for, so the scallops are what the light stops at, and a
  // scalloped edge to a lit area reads as a shape laid over the photograph.
  const reached = blur(blur(weight, width, height, smoothing), width, height, smoothing);

  // The gradient of the height field is the surface's tilt, and the normal is
  // its opposite. Written in a frame where y points up, because the light
  // direction it will be dotted against is a direction somebody chose — and the
  // photo's own y grows downward, so a light from above would otherwise be
  // named with a negative number.
  const pixel = 1 / scale;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const index = y * width + x;
      const left = rise[index - (x > 0 ? 1 : 0)] as number;
      const right = rise[index + (x < width - 1 ? 1 : 0)] as number;
      const above = rise[index - (y > 0 ? width : 0)] as number;
      const below = rise[index + (y < height - 1 ? width : 0)] as number;
      // Central where there are neighbours either side and one-sided at the
      // border, which the spans above express by collapsing to this pixel.
      const runX = (x > 0 ? 1 : 0) + (x < width - 1 ? 1 : 0);
      const runY = (y > 0 ? 1 : 0) + (y < height - 1 ? 1 : 0);
      const dx = runX > 0 ? (right - left) / (runX * pixel) : 0;
      const dy = runY > 0 ? (below - above) / (runY * pixel) : 0;
      const nx = -dx;
      // Up in the picture is towards smaller y, so the sign flips once here and
      // nowhere else.
      const ny = dy;
      const length = Math.hypot(nx, ny, 1);
      const at = index * 4;
      data[at] = Math.round(((nx / length) * 0.5 + 0.5) * 255);
      data[at + 1] = Math.round(((ny / length) * 0.5 + 0.5) * 255);
      data[at + 2] = Math.round((1 / length) * 0.5 * 255 + 0.5 * 255);
      data[at + 3] = Math.round(Math.min(1, reached[index] as number) * 255);
    }
  }

  return { map: { width, height, data }, region: box };
}
