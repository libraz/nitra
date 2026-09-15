/**
 * The face's surface normals, as a bitmap the relighting can sample.
 *
 * A normal per pixel is what turns a light direction into shading, and it is the
 * one thing the landmark model does not hand over: it returns 468 points with a
 * depth each, and what a shader wants is the direction the skin faces between
 * them.
 *
 * So the points are made a surface first. Each triangle of the mesh has one
 * direction, exactly, from the cross product of two of its edges; averaging
 * those at every point gives a direction per landmark, and interpolating those
 * across each triangle gives one per pixel. Nothing in that chain is a guess
 * about how far a landmark's influence reaches — the mesh says which points are
 * neighbours, and the triangles between them are where the surface is.
 *
 * The approximation it makes is that the face is single-valued in depth from
 * where the camera stood, which is true of every face that is not in profile and
 * degrades as the head turns rather than breaking. That is also what fixes the
 * winding: every triangle of such a surface faces the camera, so the direction
 * each one is published with is not needed and not used.
 *
 * Rasterised here rather than on the GPU because every pass in the renderer
 * draws one fullscreen triangle with no buffer behind it — there is no vertex
 * path to hand a mesh to, and this runs once per photograph rather than per
 * frame.
 *
 * No GPU and no model runtime is involved, so all of it is testable directly.
 */

import type { Triangle } from './contours';
import type { FaceRegions, Vec3 } from './geometry';
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
 * How much of the model's depth to believe.
 *
 * The model's depth is normalised to the horizontal scale, so in principle this
 * is one and the relief needs no gain at all. It is here as a named number
 * because that scale is the part of the landmark output with the least behind
 * it: the points are fitted to an image, and how far the nose comes forward is
 * the component of that fit the image constrains least.
 *
 * It stays at one because a photograph cannot settle it, and both ways of asking
 * were tried. Fitting a light and an ambient term to the photograph's own
 * luminance over its skin — which has a closed form, since a correlation does
 * not care about the scale or the offset of what it is correlated with — leaves
 * the fit flat: across six photographs, twelve times as much relief moves how
 * much of the luminance the field explains by a few per cent of itself, and that
 * is against a fit that explains well under half of it to begin with and that
 * puts the light behind the head on three of the six. What it is keying on is
 * where the skin is darker, not which way it faces. And symmetry, which would be
 * free of reflectance altogether, cannot do it either: scaling depth maps a
 * mirror-symmetric shape to another one, so no amount of turn in the head makes
 * the scale show up in it.
 *
 * What bounds the risk of leaving it is that the error is mostly absorbed
 * downstream. Doubling it moves the shading by an eighth of the field's own
 * range on average, and almost all of that is the range itself widening —
 * which is what the intensity slider already is. Settling it needs a face whose
 * shape was measured rather than a photograph of one.
 */
const SURFACE_RELIEF = 1;

/**
 * How far the coverage fades out past the mesh, as a fraction of a face width.
 *
 * The mesh has a definite edge and a light does not. Left as it comes off the
 * rasteriser the coverage is one triangle-deep and then nothing, which is a step
 * in brightness along the jaw — the same fault as confining the effect to the
 * face outline, arrived at from the other side.
 *
 * What sets the width is that the ramp must not be the steepest thing the stage
 * draws. The steepest it draws on a face is the ridge of a nose, and measured
 * across six photographs that is a change in brightness of 0.036 per hundredth
 * of a face width; a ramp this wide comes in at 0.029 on every one of them. Half
 * as wide is 0.052, which is half again steeper than a nose and is a line around
 * the face rather than a light falling off. The smallest width that clears the
 * nose at all is 0.08 and it clears it by less than the spread between the
 * photographs, which is not a margin.
 *
 * What it costs is reach: the light touches 39% of the working area rather than
 * 35%, and the extra is hair, neck and a little background — which is where a
 * light in a room does fall.
 */
const FEATHER = 0.09;

/**
 * How far the directions are smoothed, as a fraction of a face width.
 *
 * Separate from the feather because the two are measured against different
 * things, and one number could not satisfy both: the coverage needs a ramp wide
 * enough not to read as an edge, and the directions need exactly as much
 * smoothing as it takes to hide the mesh's own faceting and no more.
 *
 * Interpolating a direction across a triangle is continuous but its slope is
 * not, so every edge of the mesh is a line where the brightness changes slope.
 * Inside the cheek discs, where the surface is smooth by construction and there
 * is no feature for a gradient to belong to, the steepest change in brightness
 * moves with this number rather than with anything about the face — which is
 * what says the faceting is there and that the smoothing is what covers it.
 *
 * Wider is not free: a nose ridge is around three times this across, and the
 * curvature across one measured on the four photographs of six that have a
 * ridge the field can see falls by a fifth going from half this width to this
 * one, and by half again at twice it.
 */
const DIRECTION_SMOOTHING = 0.05;

/**
 * Separable box blur, run once per axis, over an interleaved field.
 *
 * Applied twice by the caller. One box leaves its own corners in the result, and
 * a corner in the coverage is a line where the brightness changes slope, which
 * is visible for the same reason a hard edge is.
 */
function blur(
  field: Float32Array,
  width: number,
  height: number,
  channels: number,
  radius: number,
): Float32Array {
  const pass = (from: Float32Array, to: Float32Array, alongX: boolean) => {
    const outer = alongX ? height : width;
    const inner = alongX ? width : height;
    const step = (alongX ? 1 : width) * channels;
    for (let o = 0; o < outer; o++) {
      const base = (alongX ? o * width : o) * channels;
      for (let i = 0; i < inner; i++) {
        for (let channel = 0; channel < channels; channel++) {
          let sum = 0;
          let count = 0;
          for (let k = -radius; k <= radius; k++) {
            const at = i + k;
            if (at < 0 || at >= inner) continue;
            sum += from[base + at * step + channel] as number;
            count += 1;
          }
          to[base + i * step + channel] = sum / Math.max(count, 1);
        }
      }
    }
  };
  const middle = new Float32Array(field.length);
  const out = new Float32Array(field.length);
  pass(field, middle, true);
  pass(middle, out, false);
  return out;
}

/** Where the mesh's points sit, in the frame the surface is measured in. */
interface Surface {
  /** Across and up, in the bitmap's own pixels. */
  x: Float32Array;
  y: Float32Array;
  /** Towards the camera, in those same pixels, so the three axes share a scale. */
  rise: Float32Array;
}

/**
 * The mesh's points in the bitmap's frame, with depth turned into height.
 *
 * Up rather than down, because the light direction this will be dotted against
 * is one somebody chose with up meaning up, and the photograph's own y grows the
 * other way. The flip happens here and nowhere else.
 *
 * Height is measured from the face's own mean depth. Only differences matter to
 * a normal, but keeping the numbers around zero keeps the cross products below
 * from being differences of large ones.
 */
function surfaceOf(
  points: readonly Vec3[],
  scale: number,
  shift: { x: number; y: number },
): Surface {
  let depth = 0;
  for (const point of points) depth += point.z;
  const mean = points.length > 0 ? depth / points.length : 0;

  const surface: Surface = {
    x: new Float32Array(points.length),
    y: new Float32Array(points.length),
    rise: new Float32Array(points.length),
  };
  for (let i = 0; i < points.length; i++) {
    const point = points[i] as Vec3;
    surface.x[i] = (point.x - shift.x) * scale;
    surface.y[i] = -(point.y - shift.y) * scale;
    surface.rise[i] = -(point.z - mean) * SURFACE_RELIEF * scale;
  }
  return surface;
}

/**
 * One direction per landmark, from the triangles that meet at it.
 *
 * The cross products are accumulated before they are normalised, so a triangle
 * counts for its area: the length of a cross product is twice the area of the
 * triangle it came from, which is the weighting that makes the average a
 * property of the surface rather than of how finely the mesh happens to be cut
 * around a point. The mesh crowds around the eyes and thins over the cheeks, so
 * that difference is real.
 */
function vertexNormals(
  surface: Surface,
  triangles: readonly Triangle[],
  count: number,
): Float32Array {
  const normals = new Float32Array(count * 3);
  for (const [a, b, c] of triangles) {
    if (a >= count || b >= count || c >= count) continue;
    const ux = (surface.x[b] as number) - (surface.x[a] as number);
    const uy = (surface.y[b] as number) - (surface.y[a] as number);
    const uh = (surface.rise[b] as number) - (surface.rise[a] as number);
    const vx = (surface.x[c] as number) - (surface.x[a] as number);
    const vy = (surface.y[c] as number) - (surface.y[a] as number);
    const vh = (surface.rise[c] as number) - (surface.rise[a] as number);

    let nx = uy * vh - uh * vy;
    let ny = uh * vx - ux * vh;
    let nh = ux * vy - uy * vx;
    // A surface single-valued in depth faces the camera everywhere, so the
    // winding the edge list happened to give is discarded rather than trusted —
    // half of the mesh would otherwise come out inside out.
    if (nh < 0) {
      nx = -nx;
      ny = -ny;
      nh = -nh;
    }
    for (const vertex of [a, b, c]) {
      normals[vertex * 3] = (normals[vertex * 3] as number) + nx;
      normals[vertex * 3 + 1] = (normals[vertex * 3 + 1] as number) + ny;
      normals[vertex * 3 + 2] = (normals[vertex * 3 + 2] as number) + nh;
    }
  }

  for (let i = 0; i < count; i++) {
    const at = i * 3;
    const length = Math.hypot(
      normals[at] as number,
      normals[at + 1] as number,
      normals[at + 2] as number,
    );
    // A point no triangle reached has no direction. Facing the camera is the
    // answer that adds nothing, and it is never read: no triangle interpolates
    // it either.
    if (length < 1e-12) {
      normals[at + 2] = 1;
      continue;
    }
    normals[at] = (normals[at] as number) / length;
    normals[at + 1] = (normals[at + 1] as number) / length;
    normals[at + 2] = (normals[at + 2] as number) / length;
  }
  return normals;
}

/**
 * Interpolate the vertex normals across every triangle.
 *
 * Barycentric, so the result is continuous across each shared edge and the mesh
 * does not show through the shading as facets. The accumulated field is not
 * averaged anywhere — it is normalised at the end, which makes its length
 * irrelevant and a pixel written twice along a shared edge harmless.
 */
function shade(
  surface: Surface,
  normals: Float32Array,
  triangles: readonly Triangle[],
  field: Float32Array,
  cover: Float32Array,
  width: number,
  height: number,
): void {
  const count = surface.x.length;
  for (const [a, b, c] of triangles) {
    if (a >= count || b >= count || c >= count) continue;
    const ax = surface.x[a] as number;
    const bx = surface.x[b] as number;
    const cx = surface.x[c] as number;
    // Back into the bitmap's own rows, which run downward.
    const ay = -(surface.y[a] as number);
    const by = -(surface.y[b] as number);
    const cy = -(surface.y[c] as number);

    const area = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
    if (Math.abs(area) < 1e-9) continue;

    const x0 = Math.max(0, Math.ceil(Math.min(ax, bx, cx)));
    const x1 = Math.min(width - 1, Math.floor(Math.max(ax, bx, cx)));
    const y0 = Math.max(0, Math.ceil(Math.min(ay, by, cy)));
    const y1 = Math.min(height - 1, Math.floor(Math.max(ay, by, cy)));
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const wa = ((by - cy) * (x - cx) + (cx - bx) * (y - cy)) / area;
        const wb = ((cy - ay) * (x - cx) + (ax - cx) * (y - cy)) / area;
        const wc = 1 - wa - wb;
        if (wa < 0 || wb < 0 || wc < 0) continue;
        const at = (y * width + x) * 3;
        for (let channel = 0; channel < 3; channel++) {
          field[at + channel] =
            (field[at + channel] as number) +
            wa * (normals[a * 3 + channel] as number) +
            wb * (normals[b * 3 + channel] as number) +
            wc * (normals[c * 3 + channel] as number);
        }
        cover[y * width + x] = 1;
      }
    }
  }
}

/** One resolution of the field, with how much of each pixel is known. */
interface Level {
  value: Float32Array;
  /** Fraction of the pixel that came from the mesh, 0 to 1. */
  weight: Float32Array;
  width: number;
  height: number;
}

/** Half-resolution, averaging each 2x2 by how much of it was known. */
function coarser({ value, weight, width, height }: Level): Level {
  const half = { width: Math.max(1, width >> 1), height: Math.max(1, height >> 1) };
  const out: Level = {
    value: new Float32Array(half.width * half.height * 3),
    weight: new Float32Array(half.width * half.height),
    ...half,
  };
  for (let y = 0; y < half.height; y++) {
    for (let x = 0; x < half.width; x++) {
      let sum = 0;
      const total = [0, 0, 0];
      for (const [dy, dx] of [
        [0, 0],
        [0, 1],
        [1, 0],
        [1, 1],
      ]) {
        const fy = y * 2 + (dy as number);
        const fx = x * 2 + (dx as number);
        if (fy >= height || fx >= width) continue;
        const from = fy * width + fx;
        const w = weight[from] as number;
        if (w <= 0) continue;
        sum += w;
        for (let channel = 0; channel < 3; channel++) {
          total[channel] = (total[channel] as number) + (value[from * 3 + channel] as number) * w;
        }
      }
      const at = y * half.width + x;
      out.weight[at] = sum / 4;
      if (sum > 0) {
        for (let channel = 0; channel < 3; channel++) {
          out.value[at * 3 + channel] = (total[channel] as number) / sum;
        }
      }
    }
  }
  return out;
}

/**
 * The coarser level's value at a finer level's pixel, interpolated.
 *
 * Weighted, so a coarse pixel nothing reached contributes nothing rather than a
 * zero — which would otherwise pull the fill towards no direction at all.
 */
function sampled(level: Level, fx: number, fy: number, into: Float32Array): number {
  const x = fx / 2 - 0.25;
  const y = fy / 2 - 0.25;
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const tx = x - x0;
  const ty = y - y0;
  let sum = 0;
  into[0] = 0;
  into[1] = 0;
  into[2] = 0;
  for (const [dy, dx, share] of [
    [0, 0, (1 - tx) * (1 - ty)],
    [0, 1, tx * (1 - ty)],
    [1, 0, (1 - tx) * ty],
    [1, 1, tx * ty],
  ] as [number, number, number][]) {
    const cy = Math.min(level.height - 1, Math.max(0, y0 + dy));
    const cx = Math.min(level.width - 1, Math.max(0, x0 + dx));
    const at = cy * level.width + cx;
    const w = share * (level.weight[at] as number);
    if (w <= 0) continue;
    sum += w;
    for (let channel = 0; channel < 3; channel++) {
      into[channel] = (into[channel] as number) + (level.value[at * 3 + channel] as number) * w;
    }
  }
  if (sum > 0) {
    for (let channel = 0; channel < 3; channel++) {
      into[channel] = (into[channel] as number) / sum;
    }
  }
  return sum;
}

/**
 * Give every pixel a direction, carried outwards from the ones the mesh reached.
 *
 * Without this the feather is what fills the gaps, and a blur fills a gap with a
 * fade towards nothing rather than with a direction — which the byte writer then
 * has to read as facing the camera. Across a wide gap that is a step in the
 * middle of the face: measured on a mouth open enough to show teeth, the
 * sharpest change in brightness anywhere in the field ran along the line of
 * them, and it was above anything at the border.
 *
 * Carrying the nearest direction outwards is what this replaces, and what was
 * wrong with it is where two fronts meet: on either side of that line the
 * nearest landmark is a different part of the face, so the fill steps from one
 * direction to another with nothing in between. Measured on six photographs,
 * changing nothing but the fill left the steepest change in brightness anywhere
 * in the field lower on four of them, by a tenth to a third, and untouched on
 * the two where the steepest was already a nose — so on four of six the field's
 * worst gradient was the fill's own and not the face's. It moved with the width
 * of the smoothing rather than with anything about the face as well, which is
 * what says a blur was hiding a step rather than a surface producing a slope.
 *
 * So the gaps are filled from coarser copies of the field instead: each halving
 * averages what is known, and each step back up fills a pixel by how much of it
 * is still missing. Far from the mesh that settles towards the whole field's
 * average and near it towards the neighbours, smoothly and with no seam, because
 * a pixel's value is a weighted average of everything that reached its level
 * rather than of whichever front arrived first. Nothing the mesh reached is
 * touched: a known pixel keeps its own direction exactly.
 */
function spread(field: Float32Array, cover: Float32Array, width: number, height: number): void {
  // The coverage is read, never written: what the fill marks as known is its own
  // bookkeeping, and writing it back would hand the feather a working area that
  // is covered everywhere.
  const levels: Level[] = [{ value: field, weight: Float32Array.from(cover), width, height }];
  while (true) {
    const last = levels[levels.length - 1] as Level;
    if (last.width <= 1 && last.height <= 1) break;
    levels.push(coarser(last));
  }
  const from = new Float32Array(3);
  for (let level = levels.length - 2; level >= 0; level--) {
    const fine = levels[level] as Level;
    const coarse = levels[level + 1] as Level;
    for (let y = 0; y < fine.height; y++) {
      for (let x = 0; x < fine.width; x++) {
        const at = y * fine.width + x;
        const known = Math.min(1, fine.weight[at] as number);
        if (known >= 1) continue;
        if (sampled(coarse, x, y, from) <= 0) continue;
        for (let channel = 0; channel < 3; channel++) {
          fine.value[at * 3 + channel] =
            (fine.value[at * 3 + channel] as number) * known +
            (from[channel] as number) * (1 - known);
        }
        // Filled counts as known to the level below, which is what stops the
        // next step up from averaging a gap in again.
        fine.weight[at] = 1;
      }
    }
  }
}

/**
 * Coverage inside the mesh but inside none of its triangles, filled in.
 *
 * The tessellation is not a disc: it has a border around the face and three more
 * around the eye openings and the mouth, because there are no landmarks inside
 * those to make triangles from. They are holes in the mesh and they are not
 * holes in the face — a light falls on an eye — so leaving them uncovered would
 * put an unlit patch over each one, ringed by the feather below.
 *
 * Found by flooding inward from the border of the working area: what the flood
 * cannot reach is enclosed by the mesh. A gap in the raster lets the flood
 * through and the hole stays a hole, which is the harmless way for this to fail.
 */
function fillHoles(cover: Float32Array, width: number, height: number): void {
  const outside = new Uint8Array(cover.length);
  const queue: number[] = [];
  const reach = (index: number) => {
    if (outside[index] === 1 || (cover[index] as number) > 0) return;
    outside[index] = 1;
    queue.push(index);
  };
  for (let x = 0; x < width; x++) {
    reach(x);
    reach((height - 1) * width + x);
  }
  for (let y = 0; y < height; y++) {
    reach(y * width);
    reach(y * width + width - 1);
  }
  for (let head = 0; head < queue.length; head++) {
    const index = queue[head] as number;
    const x = index % width;
    if (x > 0) reach(index - 1);
    if (x < width - 1) reach(index + 1);
    if (index >= width) reach(index - width);
    if (index < cover.length - width) reach(index + width);
  }
  for (let i = 0; i < cover.length; i++) {
    if (outside[i] === 0) cover[i] = 1;
  }
}

/**
 * Rasterise every face's normals over the same working area as the masks.
 *
 * The area comes from {@link faceRegion}, so one rectangle addresses the masks
 * and this together and a stage that samples both cannot map them differently.
 *
 * The triangles are passed in rather than read from the model here, because they
 * are the model's topology and this is arithmetic over it.
 */
export function rasteriseNormals(
  faces: readonly FaceRegions[],
  triangles: readonly Triangle[],
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
  const count = width * height;
  const field = new Float32Array(count * 3);
  const cover = new Float32Array(count);

  // Pixels per unit of image width, and the offset of the working area, in the
  // isotropic units the surface is measured in. Both axes share the scale, so
  // one pixel is the same distance either way.
  const scale = width / box.width;
  const shift = { x: box.x, y: box.y * aspect };

  let widest = 0;
  for (const face of faces) {
    widest = Math.max(widest, face.width);
    const surface = surfaceOf(face.surface, scale, shift);
    const normals = vertexNormals(surface, triangles, face.surface.length);
    shade(surface, normals, triangles, field, cover, width, height);
  }
  // Before the holes are covered, so what seeds the directions is where the mesh
  // actually is rather than where the coverage ends up.
  spread(field, cover, width, height);
  fillHoles(cover, width, height);

  // Both in bitmap pixels, from the largest face in the frame: the field is one
  // bitmap however many faces are in it, and a feather set by the smallest of
  // them would be a hard edge around the largest.
  const smoothing = Math.max(1, Math.round(widest * DIRECTION_SMOOTHING * scale));
  const feather = Math.max(1, Math.round(widest * FEATHER * scale));
  const eased = blur(blur(field, width, height, 3, smoothing), width, height, 3, smoothing);
  const reached = blur(blur(cover, width, height, 1, feather), width, height, 1, feather);

  const data = new Uint8ClampedArray(count * 4);
  for (let i = 0; i < count; i++) {
    const at = i * 3;
    const x = eased[at] as number;
    const y = eased[at + 1] as number;
    const rise = eased[at + 2] as number;
    const length = Math.hypot(x, y, rise);
    const out = i * 4;
    if (length < 1e-9) {
      data[out] = 128;
      data[out + 1] = 128;
      data[out + 2] = 255;
    } else {
      data[out] = Math.round(((x / length) * 0.5 + 0.5) * 255);
      data[out + 1] = Math.round(((y / length) * 0.5 + 0.5) * 255);
      data[out + 2] = Math.round(((rise / length) * 0.5 + 0.5) * 255);
    }
    data[out + 3] = Math.round(Math.min(1, reached[i] as number) * 255);
  }

  return { map: { width, height, data }, region: box };
}
