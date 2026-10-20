/**
 * Laying the photographed face into the generated frame.
 *
 * The transform is already known — {@link ./align} fitted it from the two
 * meshes — so what is left is three decisions, and each of them is the same
 * decision the rest of the pipeline already made somewhere else.
 *
 * **Where the patch stops.** Inside the skin, never on the outline. A boundary
 * that ran along the face oval would cross the hairline, the jaw and the ear in
 * a single stroke, which is the matting problem that makes cutting a person out
 * hard; a boundary held a little way inside the outline crosses nothing but
 * cheek. It is one number rather than two — how far in, and how soft, are the
 * same control — for the reason the background separation's `edgeRefine` is one
 * number: two that have to be balanced against each other is a worse control
 * than one that cannot be got wrong.
 *
 * **What makes it belong to the light in the picture.** A gain, not a sum. The
 * generated frame has been relit, and the photographed face carries the light it
 * was shot under; the recorded value is reflectance times that light, so the
 * correction that leaves the reflectance alone is a multiply. This is the same
 * argument the relighting makes, and it has the same consequence: a sum flattens
 * the texture this whole stage exists to bring back.
 *
 * The gain is a field rather than one number: seamless cloning's membrane
 * (Pérez et al. 2003; Farbman et al. 2009), taken over ratios instead of
 * differences. It is measured only along the join, where the two images show the
 * same cheek, and carried inwards as a harmonic interpolation, so a frame the
 * generator lit from one side meets the patch at its own level on both sides,
 * and the eyes and the mouth — which the generator drew differently — never
 * enter the measurement.
 *
 * The gain is taken in the frame's own primaries, which is not where the patch
 * is read. A photograph carried in Display-P3 dropped into a frame written in
 * sRGB is the ordinary case rather than an exotic one, and a ratio taken between
 * a mean in one set of primaries and a mean in the other is not a ratio of
 * anything: a scale and a primaries matrix do not commute, so the patch lands
 * somewhere neither space asked for. Measured on a coloured frame that way, the
 * three channels came out +18.9%, -19.5% and -32.0% from the level they were
 * being matched to. The conversion therefore happens before the ratio.
 *
 * **What the blend happens in.** Linear light, because a crossfade between two
 * exposures of the same face is a mixture of light.
 *
 * It runs on the CPU and once, which puts it in the fill's family rather than
 * the shaders': it is a step the caller takes before rendering, and every stage
 * downstream reads the result as though the photograph had always looked like
 * that. Grain lands on the seam and the grade runs over it, which is most of
 * what stops a patch from reading as a patch.
 */

import { type Mat3, mat3Apply, type Vec3 } from '../color/matrix';
import {
  type ColorSpaceName,
  DISPLAY_P3_TO_SRGB,
  SRGB_TO_DISPLAY_P3,
  transferFromLinear,
} from '../color/spaces';
import { dilate, type Point } from '../face/geometry';
import { fillPolygon, type MaskBitmap } from '../face/raster';
import { BLUR_PASSES, boxBlur, clampIndex, linearTable } from '../plate/blur';
import { applySimilarity, invertSimilarity, type Similarity } from './align';

/**
 * How far short of the outline the patch reaches zero, in bands.
 *
 * The reason the boundary is placed by arithmetic rather than by eye: repeated
 * box passes reach {@link BLUR_PASSES} radii, not one, so a polygon rasterised
 * one band in and softened by a radius of one band would have coverage three
 * bands further out than intended — across the hairline, which is the single
 * thing this boundary exists to stay inside of. Placing the polygon at this
 * clearance *plus* the blur's own reach puts the outer end of the ramp exactly
 * one band inside the outline whatever the radius rounds to.
 */
const EDGE_CLEAR = 1;

/**
 * How far the colour match is allowed to push, as a factor on linear light.
 *
 * Two stops, which is a drastic relight and still a plausible one — a generator
 * asked for a different time of day will move a face by more than one. Past it,
 * the two regions are not describing the same thing, which is what happens when
 * the fit was poor enough that the patch is being averaged against somebody's
 * hair. Clamping turns that into a visible mismatch rather than a blown-out
 * face, and a visible mismatch is the one a person can act on.
 */
const MAX_GAIN = 4;

/** Pixels between samples when the two means are measured. */
const MEAN_STRIDE = 3;

/**
 * Cells of the gain field across one face width.
 *
 * Coarse enough that a cell on the join averages over the skin's texture and
 * measures its light: at two cells per band, a textured reference had its
 * texture cancelled along the join and landed 3.2% off the frame's level. Fine
 * enough to follow a generator's relight from one side of a face to the other.
 */
const CELLS_PER_FACE = 8;

/**
 * How much of the ramp a cell has to hold before it is measured rather than
 * interpolated, as a fraction of the most a cell could hold.
 *
 * A cell that only grazes the join holds a handful of pixels, and a ratio taken
 * over a handful is the noise of the photograph rather than its light.
 */
const RING_SUPPORT = 1 / 8;

/** Enough of the region to be worth writing anything for. */
const MIN_COVERAGE = 1 / 255;

/** One image, as the decoder leaves it. */
export interface GraftImage {
  /** Non-linear RGBA, eight bits per channel, encoded in {@link space}. */
  data: Uint8ClampedArray;
  width: number;
  height: number;
  space: ColorSpaceName;
}

/** One face to put back, with both outlines and the transform between them. */
export interface GraftFace {
  /** The generated face's outline, in the destination's own width units. */
  outline: readonly Point[];
  /** The photographed face's outline, in the reference's own width units. */
  source: readonly Point[];
  /** The generated face's width, which the edge is a fraction of. */
  width: number;
  /** Reference width units to destination width units. */
  transform: Similarity;
}

/** The rectangle one face's patch can reach, in destination pixels. */
interface GraftRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The matrix taking the reference's linear primaries to the destination's. */
function primaries(from: ColorSpaceName, to: ColorSpaceName): Mat3 | null {
  if (from === to) return null;
  return from === 'display-p3' ? DISPLAY_P3_TO_SRGB : SRGB_TO_DISPLAY_P3;
}

/**
 * One face's patch, in the destination's frame.
 *
 * The coverage is the destination outline and the photographed outline mapped
 * over it, intersected. Both halves are needed: the first keeps the patch inside
 * the face the generator drew, and the second keeps it inside the face that was
 * photographed — without it, a generator that widened a jaw would have the patch
 * reach past the real face's edge and paste the original's background in.
 */
function coverageFor(
  face: GraftFace,
  band: number,
  scale: number,
  bounds: GraftRegion,
): Float32Array {
  const bitmap: MaskBitmap = {
    width: bounds.width,
    height: bounds.height,
    data: new Uint8ClampedArray(bounds.width * bounds.height * 4),
  };
  // The ramp is one band wide in total: coverage reaches zero one band inside
  // the outline and full two bands in. Only the outer end is exact — the radius
  // has to be a whole number of pixels, and the inset is measured back from
  // whatever it rounded to, so it is the end that matters that cannot drift.
  const radius = Math.max(1, Math.round((band * scale) / (BLUR_PASSES * 2)));
  const inset = (EDGE_CLEAR * band * scale + radius * BLUR_PASSES) / scale;

  const originX = bounds.x / scale;
  const originY = bounds.y / scale;
  const shift = (points: readonly Point[]): Point[] =>
    points.map((p) => ({ x: p.x - originX, y: p.y - originY }));

  fillPolygon(bitmap, 0, shift(dilate(face.outline, -inset)), scale);
  fillPolygon(
    bitmap,
    1,
    shift(
      dilate(
        face.source.map((p) => applySimilarity(face.transform, p)),
        -inset,
      ),
    ),
    scale,
  );

  const coverage = new Float32Array(bounds.width * bounds.height);
  for (let i = 0; i < coverage.length; i++) {
    const a = bitmap.data[i * 4] as number;
    const b = bitmap.data[i * 4 + 1] as number;
    coverage[i] = Math.min(a, b) / 255;
  }
  boxBlur(coverage, bounds.width, bounds.height, radius, new Float32Array(coverage.length));
  return coverage;
}

/** The rectangle a face's patch can reach, in destination pixels. */
function boundsFor(face: GraftFace, band: number, scale: number, image: GraftImage): GraftRegion {
  const points = [...face.outline, ...face.source.map((p) => applySimilarity(face.transform, p))];
  if (points.length === 0) return { x: 0, y: 0, width: 0, height: 0 };
  // One band past the outline, because the blur carries coverage outwards from
  // wherever the rasterised polygon ended.
  const margin = band * scale + 2;
  const xs = points.map((p) => p.x * scale);
  const ys = points.map((p) => p.y * scale);
  const x = clampIndex(Math.floor(Math.min(...xs) - margin), image.width);
  const y = clampIndex(Math.floor(Math.min(...ys) - margin), image.height);
  const right = clampIndex(Math.ceil(Math.max(...xs) + margin), image.width);
  const bottom = clampIndex(Math.ceil(Math.max(...ys) + margin), image.height);
  return { x, y, width: Math.max(0, right - x), height: Math.max(0, bottom - y) };
}

/** A gain per channel on a coarse grid over one face's region. */
interface GainField {
  /** Three planes, one per channel, each `columns·rows` long. */
  values: Float32Array;
  columns: number;
  rows: number;
  /** Destination pixels per cell. */
  step: number;
}

/**
 * The gain field for one face: measured along the join, relaxed everywhere else.
 *
 * Each cell the ramp passes through takes the ratio of the two images' means
 * over the part of the ramp inside it, weighted by `w·(1−w)` so the middle of
 * the ramp counts most and neither the solid patch nor the untouched frame
 * counts at all. The other cells solve Laplace's equation with those as fixed
 * values, by successive over-relaxation for a fixed number of sweeps, which
 * makes the field the smoothest one that agrees with the join.
 *
 * @param initial The single gain the whole-region means gave, which is where the
 *   relaxation starts and what the field stays when the join was never measured.
 * @param read The reference in the frame's primaries and the frame beneath it, at
 *   one pixel of the region, both linear; null outside the reference.
 */
function gainField(
  bounds: GraftRegion,
  coverage: Float32Array,
  facePixels: number,
  bandPixels: number,
  initial: readonly number[],
  match: number,
  read: (x: number, y: number) => { from: Vec3; under: Vec3 } | null,
): GainField {
  const step = Math.max(1, Math.round(facePixels / CELLS_PER_FACE));
  const columns = Math.ceil(bounds.width / step);
  const rows = Math.ceil(bounds.height / step);
  const cells = columns * rows;
  const fromSum = new Float64Array(cells * 3);
  const underSum = new Float64Array(cells * 3);
  const support = new Float64Array(cells);

  // On the same stride as the whole-region means, for the same reason.
  for (let y = 0; y < bounds.height; y += MEAN_STRIDE) {
    const cellRow = Math.floor(y / step) * columns;
    for (let x = 0; x < bounds.width; x += MEAN_STRIDE) {
      const w = coverage[y * bounds.width + x] as number;
      if (w < MIN_COVERAGE || w > 1 - MIN_COVERAGE) continue;
      const taken = read(x, y);
      if (!taken) continue;
      const q = w * (1 - w);
      const cell = cellRow + Math.floor(x / step);
      for (let c = 0; c < 3; c++) {
        fromSum[c * cells + cell] =
          (fromSum[c * cells + cell] as number) + (taken.from[c] as number) * q;
        underSum[c * cells + cell] =
          (underSum[c * cells + cell] as number) + (taken.under[c] as number) * q;
      }
      support[cell] = (support[cell] as number) + q;
    }
  }

  // The most a cell can hold is the ramp crossing it at its middle: a band wide
  // at a weight of a quarter, or the whole cell when the band is wider.
  const needed =
    (RING_SUPPORT * 0.25 * step * Math.min(step, Math.max(1, bandPixels))) /
    (MEAN_STRIDE * MEAN_STRIDE);
  const fixed = new Uint8Array(cells);
  const values = new Float32Array(cells * 3);
  for (let cell = 0; cell < cells; cell++) {
    const measured = (support[cell] as number) >= needed;
    fixed[cell] = measured ? 1 : 0;
    for (let c = 0; c < 3; c++) {
      let gain = initial[c] as number;
      if (measured) {
        const level = fromSum[c * cells + cell] as number;
        const ratio = level > 1e-9 ? (underSum[c * cells + cell] as number) / level : 1;
        const wanted = 1 + (ratio - 1) * match;
        gain = Math.min(MAX_GAIN, Math.max(1 / MAX_GAIN, wanted));
      }
      values[c * cells + cell] = gain;
    }
  }

  // Over-relaxation at the factor that is optimal for a square grid this wide,
  // for long enough that the slowest mode has decayed by about e^-12. The grid
  // edge reflects, so cells outside the face carry the nearest join outwards
  // rather than pulling the field towards anything.
  const span = Math.max(columns, rows);
  const omega = 2 / (1 + Math.PI / span);
  const sweeps = 2 * span;
  for (let sweep = 0; sweep < sweeps; sweep++) {
    for (let gy = 0; gy < rows; gy++) {
      for (let gx = 0; gx < columns; gx++) {
        const cell = gy * columns + gx;
        if (fixed[cell]) continue;
        let count = 0;
        if (gx > 0) count++;
        if (gx < columns - 1) count++;
        if (gy > 0) count++;
        if (gy < rows - 1) count++;
        if (count === 0) continue;
        for (let c = 0; c < 3; c++) {
          const plane = c * cells;
          let sum = 0;
          if (gx > 0) sum += values[plane + cell - 1] as number;
          if (gx < columns - 1) sum += values[plane + cell + 1] as number;
          if (gy > 0) sum += values[plane + cell - columns] as number;
          if (gy < rows - 1) sum += values[plane + cell + columns] as number;
          const old = values[plane + cell] as number;
          values[plane + cell] = old + omega * (sum / count - old);
        }
      }
    }
  }

  return { values, columns, rows, step };
}

/**
 * Put the photographed faces back into the generated frame.
 *
 * @param edge Where the patch stops, as a fraction of the face's width.
 * @param match How far the patch is taken towards the destination's own light.
 * @returns Null when no face reached a pixel, which is what leaves the caller
 * holding the image it already had rather than a copy of it.
 */
export function graft(
  destination: GraftImage,
  reference: GraftImage,
  faces: readonly GraftFace[],
  edge: number,
  match: number,
): Uint8ClampedArray | null {
  if (faces.length === 0 || edge <= 0) return null;

  const toLinear = linearTable();
  const convert = primaries(reference.space, destination.space);
  const scale = destination.width;
  const refScale = reference.width;

  let out: Uint8ClampedArray | null = null;
  let landed = false;

  for (const face of faces) {
    // What is under this face: the frame, or the frame with an earlier face
    // already in it. Faces overlap rarely and the patches have to agree where
    // they do, since the second one would otherwise blend against pixels that
    // are no longer what the picture shows and then write over the first.
    const beneath = out ?? destination.data;
    const inverse = invertSimilarity(face.transform);
    if (!inverse) continue;
    const band = edge * face.width;
    const bounds = boundsFor(face, band, scale, destination);
    if (bounds.width === 0 || bounds.height === 0) continue;

    const coverage = coverageFor(face, band, scale, bounds);

    // Where the reference is read from, for a destination pixel's centre. The
    // two steps are folded together so the inner loops carry one multiply and
    // one add per axis: destination pixel to its own width units, through the
    // inverse, then into the reference's pixels.
    const at = (x: number, y: number): Point => {
      const p = applySimilarity(inverse, {
        x: (x + 0.5) / scale,
        y: (y + 0.5) / scale,
      });
      return { x: p.x * refScale - 0.5, y: p.y * refScale - 0.5 };
    };

    /** Bilinear, in linear light, or null outside the reference. */
    const sample = (px: number, py: number): [number, number, number] | null => {
      if (px < 0 || py < 0 || px > reference.width - 1 || py > reference.height - 1) return null;
      const x0 = Math.floor(px);
      const y0 = Math.floor(py);
      const x1 = Math.min(x0 + 1, reference.width - 1);
      const y1 = Math.min(y0 + 1, reference.height - 1);
      const fx = px - x0;
      const fy = py - y0;
      const rowTop = y0 * reference.width;
      const rowBottom = y1 * reference.width;
      const out3: [number, number, number] = [0, 0, 0];
      for (let c = 0; c < 3; c++) {
        const tl = toLinear[reference.data[(rowTop + x0) * 4 + c] as number] as number;
        const tr = toLinear[reference.data[(rowTop + x1) * 4 + c] as number] as number;
        const bl = toLinear[reference.data[(rowBottom + x0) * 4 + c] as number] as number;
        const br = toLinear[reference.data[(rowBottom + x1) * 4 + c] as number] as number;
        out3[c] = (tl + (tr - tl) * fx) * (1 - fy) + (bl + (br - bl) * fx) * fy;
      }
      return out3;
    };

    // The two means, over the same region in both images. Sampled on a stride
    // rather than every pixel: a mean does not need the detail, and this pass
    // reads the reference a second time.
    const refMean = [0, 0, 0];
    const dstMean = [0, 0, 0];
    let weight = 0;
    for (let y = 0; y < bounds.height; y += MEAN_STRIDE) {
      for (let x = 0; x < bounds.width; x += MEAN_STRIDE) {
        const w = coverage[y * bounds.width + x] as number;
        if (w < MIN_COVERAGE) continue;
        const px = bounds.x + x;
        const py = bounds.y + y;
        const source = at(px, py);
        const taken = sample(source.x, source.y);
        if (!taken) continue;
        const index = (py * destination.width + px) * 4;
        for (let c = 0; c < 3; c++) {
          refMean[c] = (refMean[c] as number) + (taken[c] as number) * w;
          dstMean[c] =
            (dstMean[c] as number) + (toLinear[beneath[index + c] as number] as number) * w;
        }
        weight += w;
      }
    }
    if (weight <= 0) continue;

    // The reference's mean, carried into the frame's primaries so the ratio
    // below is between two means of the same thing. A matrix is linear, so
    // converting the mean and taking the mean of the converted pixels are the
    // same number, and this way it happens once per face rather than per pixel.
    const refLevel = [0, 1, 2].map((c) => (refMean[c] as number) / weight) as unknown as Vec3;
    const from = convert ? mat3Apply(convert, refLevel) : refLevel;

    // One gain per channel over the whole region, taken as far towards a full
    // match as asked. It is where the field starts, and what it stays when no
    // part of the join could be measured.
    const gain: [number, number, number] = [1, 1, 1];
    for (let c = 0; c < 3; c++) {
      const level = from[c] as number;
      const to = (dstMean[c] as number) / weight;
      const ratio = level > 1e-6 ? to / level : 1;
      const wanted = 1 + (ratio - 1) * match;
      gain[c] = Math.min(MAX_GAIN, Math.max(1 / MAX_GAIN, wanted));
    }

    /** The reference in the frame's primaries, linear. */
    const carried = (taken: [number, number, number]): Vec3 =>
      convert ? mat3Apply(convert, taken) : taken;

    const field = gainField(
      bounds,
      coverage,
      face.width * scale,
      band * scale,
      gain,
      match,
      (x, y) => {
        const px = bounds.x + x;
        const py = bounds.y + y;
        const source = at(px, py);
        const taken = sample(source.x, source.y);
        if (!taken) return null;
        const index = (py * destination.width + px) * 4;
        return {
          from: carried(taken),
          under: [
            toLinear[beneath[index] as number] as number,
            toLinear[beneath[index + 1] as number] as number,
            toLinear[beneath[index + 2] as number] as number,
          ],
        };
      },
    );
    const cells = field.columns * field.rows;

    if (!out) out = new Uint8ClampedArray(destination.data);
    const target = out;

    for (let y = 0; y < bounds.height; y++) {
      // A cell's value stands for its centre, half a step in from its corner.
      const v = (y + 0.5) / field.step - 0.5;
      const rowBase = Math.floor(v);
      const fy = v - rowBase;
      const lowRow = clampIndex(rowBase, field.rows - 1) * field.columns;
      const highRow = clampIndex(rowBase + 1, field.rows - 1) * field.columns;
      for (let x = 0; x < bounds.width; x++) {
        const w = coverage[y * bounds.width + x] as number;
        if (w < MIN_COVERAGE) continue;
        const px = bounds.x + x;
        const py = bounds.y + y;
        const source = at(px, py);
        const taken = sample(source.x, source.y);
        if (!taken) continue;

        const u = (x + 0.5) / field.step - 0.5;
        const columnBase = Math.floor(u);
        const fx = u - columnBase;
        const lowColumn = clampIndex(columnBase, field.columns - 1);
        const highColumn = clampIndex(columnBase + 1, field.columns - 1);

        const lit = carried(taken);
        const index = (py * destination.width + px) * 4;
        for (let c = 0; c < 3; c++) {
          const plane = c * cells;
          const above =
            (1 - fx) * (field.values[plane + lowRow + lowColumn] as number) +
            fx * (field.values[plane + lowRow + highColumn] as number);
          const below =
            (1 - fx) * (field.values[plane + highRow + lowColumn] as number) +
            fx * (field.values[plane + highRow + highColumn] as number);
          const g = (1 - fy) * above + fy * below;
          const under = toLinear[beneath[index + c] as number] as number;
          const mixed = under + ((lit[c] as number) * g - under) * w;
          target[index + c] = Math.round(Math.min(1, Math.max(0, transferFromLinear(mixed))) * 255);
        }
        landed = true;
      }
    }
  }

  return landed ? out : null;
}
