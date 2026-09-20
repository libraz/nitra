/**
 * Concealing a reflection: a low pass held inside the circle the user drew.
 *
 * What the stage buys is not a blur but the absence of the band that carries
 * identity, so its reach is a fraction of the circle's own radius. One rule then
 * covers a mirror and a pupil, whose radii differ by two orders of magnitude.
 *
 * Two things about the arithmetic are load-bearing. The average is taken in
 * linear light and composited there too, because a catchlight is the extreme of
 * contrast and the mean of gamma-encoded values is not the mean of the light.
 * And it is a normalised convolution, `blur(v·m)/blur(m)`: a plain blur takes
 * about half its kernel mass from outside the circle, which on an iris is
 * sclera, and the edge of the disc comes back white.
 *
 * Each circle reads the pristine source rather than the plate, so the order of
 * the list cannot change a pixel and a circle can be re-applied as often as the
 * stages under it are rebuilt. The mask's feather points outward: the ring the
 * user sees is the range being guaranteed, and a feather reaching inward would
 * leave the original structure inside it.
 *
 * The average itself is taken on a decimated grid. A reach of 1.75r makes the
 * largest circle's region the whole frame, and four full-resolution planes of it
 * is where both the second and the hundreds of megabytes went; the field being
 * built varies over a span of about that reach, so carrying it at one sample per
 * pixel is carrying nothing. What the decimation may not touch is the mask used
 * to composite, which stays at full resolution: the ring is the range being
 * guaranteed, so its edge lands where the user drew it.
 */

import { transferFromLinear } from '../color/spaces';
import { BLUR_PASSES, boxBlur, clampIndex, linearTable } from '../plate/blur';
import type { Region } from '../plate/region';

/**
 * Blur reach as a fraction of the circle's radius (σ/r).
 *
 * Bound by the band: a full-contrast grating of λ = r has to come back under two
 * code values, and since the average may only read light from inside the mask,
 * the window is about 2.7 wavelengths wide there and a free-space reach of r/2
 * leaves 9.5 of them. Measured, it takes 1.75 to clear the bound at every radius
 * the schema allows. One circle at the largest radius on a 4240x2832 frame
 * measures 140-172 ms over 14 MB, the region being the whole frame while what is
 * written is a fifth of it; a pupil-sized circle there is 8-24 ms over 7 MB.
 */
export const CONCEAL_REACH = 1.75;

/**
 * Box radius the blur is left with after the decimation, in decimated samples.
 *
 * Two things set it and neither is cost: the decimated field is reconstructed
 * bilinearly, whose error falls as the square of this, and the reach that
 * survives is `box·step`, which rounding moves by at most half a step — 1/(2·32)
 * of the reach here, against the 10% the catchlight's residual is predicted to.
 * The blur is the one part of the stage whose cost the decimation makes free, so
 * spending samples on it is spending nothing: at the largest circle on a
 * twelve-megapixel frame the grid is 93x62 and the four planes over it are 92 kB.
 */
const DECIMATED_BOX = 32;

/**
 * Where the mask reaches zero, as a fraction past the radius.
 *
 * The same width as the heal stage's join and the opposite sign: what the ring
 * marks is the range being guaranteed, so the softening is outside it.
 */
export const CONCEAL_FEATHER = 0.35;

/** A circle as the recipe holds it: normalised centre, radius in image widths. */
export interface ConcealSpot {
  x: number;
  y: number;
  r: number;
}

/** Radius of the box whose three passes approximate a Gaussian of σ = reach·r. */
function boxRadiusFor(radius: number): number {
  // Kovesi's wIdeal = sqrt(12σ²/n + 1) is a width, and at n = BLUR_PASSES with
  // σ = CONCEAL_REACH·r it comes to about r — so the radius is about σ. Under one
  // pixel the blur returns in silence, which the ring would then be lying about.
  return Math.max(1, Math.round(radius * CONCEAL_REACH));
}

/**
 * How many pixels of the source one sample of the average stands for.
 *
 * Tied to the reach rather than to the frame: what is being sampled is the
 * blur's own field, so the number of samples across the kernel is what has to
 * hold, and the decimation follows the radius the way everything else here
 * does. A circle small enough that its box would be left under
 * {@link DECIMATED_BOX} samples is worked at full resolution, where it costs
 * nothing anyway.
 */
export function concealDecimation(radius: number): number {
  return Math.max(1, Math.floor(boxRadiusFor(radius) / DECIMATED_BOX));
}

/** The mask at one distance from the centre: one inside, feathered outward. */
function maskAt(distance: number, radius: number, outer: number): number {
  if (distance <= radius) return 1;
  if (distance >= outer) return 0;
  const t = (outer - distance) / (outer - radius);
  return t * t * (3 - 2 * t);
}

/**
 * One bilinear tap into a decimated plane.
 *
 * The neighbours arrive as offsets because they are the same for every plane
 * and, on the column side, for every row.
 */
function bilinear(
  plane: Float32Array,
  base: number,
  lowRow: number,
  highRow: number,
  lowColumn: number,
  highColumn: number,
  fx: number,
  fy: number,
): number {
  const above =
    (1 - fx) * (plane[base + lowRow + lowColumn] as number) +
    fx * (plane[base + lowRow + highColumn] as number);
  const below =
    (1 - fx) * (plane[base + highRow + lowColumn] as number) +
    fx * (plane[base + highRow + highColumn] as number);
  return (1 - fy) * above + fy * below;
}

/**
 * The part of the photograph one circle is worked on.
 *
 * `region` is wide enough to hold the mask and everything three box passes read
 * from it, which is three radii rather than the one a single pass would take.
 * `written` is the part of it the mask reaches, which at the shipped reach is a
 * twentieth of the area — it is what the circle changes, so it is both what the
 * caller re-uploads and what decides whether a fill landed under the ring.
 *
 * Clamped to the frame: a circle at an edge loses reach on that side, since the
 * blur extends the border rather than inventing pixels, and the guarantee is
 * over the pixels the frame actually has.
 */
export function concealRegion(
  spot: ConcealSpot,
  imageWidth: number,
  imageHeight: number,
): { region: Region; written: Region; centre: [number, number]; radius: number } {
  const radius = spot.r * imageWidth;
  const reach = Math.ceil(radius * (1 + CONCEAL_FEATHER) + BLUR_PASSES * boxRadiusFor(radius));
  const cx = spot.x * imageWidth;
  const cy = spot.y * imageHeight;
  const x = Math.max(0, Math.min(imageWidth - 1, Math.round(cx - reach)));
  const y = Math.max(0, Math.min(imageHeight - 1, Math.round(cy - reach)));
  const right = Math.max(x + 1, Math.min(imageWidth, Math.round(cx + reach)));
  const bottom = Math.max(y + 1, Math.min(imageHeight, Math.round(cy + reach)));
  const region = { x, y, width: right - x, height: bottom - y };

  const outer = radius * (1 + CONCEAL_FEATHER);
  const left = Math.max(0, Math.floor(cx - x - outer));
  const over = Math.min(region.width, Math.ceil(cx - x + outer) + 1);
  const top = Math.max(0, Math.floor(cy - y - outer));
  const under = Math.min(region.height, Math.ceil(cy - y + outer) + 1);
  return {
    region,
    written: { x: x + left, y: y + top, width: over - left, height: under - top },
    centre: [cx - x, cy - y],
    radius,
  };
}

/**
 * Conceal one circle: read the pristine source, write the plate.
 *
 * Only the pixels the mask reaches are written. The region is as wide as three
 * box passes read, which at the shipped reach is twenty times the mask's area,
 * and laying the source back over all of it would take out every fill the stage
 * under this one left around the circle.
 *
 * The `(1−m)` term reads the pristine source rather than the plate, which is
 * what keeps a circle idempotent — the plate applies one again whenever a fill
 * lands under it, and a feather reading its own output would eat into the band
 * a little more on every pass. The cost is that a fill inside the feather is
 * pulled towards the source in that proportion, over a ring outside the range
 * the drawn one guarantees.
 *
 * @returns The rectangle that was written, which is what the caller re-uploads.
 */
export function concealSpot(
  plate: Uint8ClampedArray,
  pristine: Uint8ClampedArray,
  imageWidth: number,
  imageHeight: number,
  spot: ConcealSpot,
): Region {
  const { region, written, centre, radius } = concealRegion(spot, imageWidth, imageHeight);
  const [cx, cy] = centre;
  const outer = radius * (1 + CONCEAL_FEATHER);

  // Outside the mask the pixel is left as the plate has it, and it carries
  // nothing into the average either, so neither pass leaves this box. The grid
  // below still spans the region, since that is the width the blur reads over.
  const left = written.x - region.x;
  const right = left + written.width;
  const top = written.y - region.y;
  const bottom = top + written.height;

  const step = concealDecimation(radius);
  const box = Math.max(1, Math.round(boxRadiusFor(radius) / step));
  const gridWidth = Math.ceil(region.width / step);
  const gridHeight = Math.ceil(region.height / step);
  const cells = gridWidth * gridHeight;
  const weight = new Float32Array(cells);
  const carried = new Float32Array(cells * 3);
  const toLinear = linearTable();

  // Both halves of the normalised convolution are decimated the same way, and by
  // the mean over each cell rather than by a sample of it: a plain subsample
  // folds the band this stage exists to remove back down into one it keeps.
  for (let y = top; y < bottom; y++) {
    const dy = y + 0.5 - cy;
    const row = (region.y + y) * imageWidth + region.x;
    const cellRow = Math.floor(y / step) * gridWidth;
    for (let x = left; x < right; x++) {
      const dx = x + 0.5 - cx;
      const m = maskAt(Math.sqrt(dx * dx + dy * dy), radius, outer);
      if (m <= 0) continue;
      const cell = cellRow + Math.floor(x / step);
      weight[cell] = (weight[cell] as number) + m;
      const i = (row + x) * 4;
      for (let c = 0; c < 3; c++) {
        const at = c * cells + cell;
        carried[at] = (carried[at] as number) + (toLinear[pristine[i + c] as number] as number) * m;
      }
    }
  }

  // The cells along the far edge hold fewer pixels than the rest, so the mean is
  // taken over the area of the region each one covers.
  for (let gy = 0; gy < gridHeight; gy++) {
    const rows = Math.min(step, region.height - gy * step);
    for (let gx = 0; gx < gridWidth; gx++) {
      const cell = gy * gridWidth + gx;
      const area = rows * Math.min(step, region.width - gx * step);
      weight[cell] = (weight[cell] as number) / area;
      for (let c = 0; c < 3; c++) {
        const at = c * cells + cell;
        carried[at] = (carried[at] as number) / area;
      }
    }
  }

  const scratch = new Float32Array(cells);
  boxBlur(weight, gridWidth, gridHeight, box, scratch);
  for (let c = 0; c < 3; c++) {
    const plane = carried.subarray(c * cells, (c + 1) * cells);
    boxBlur(plane, gridWidth, gridHeight, box, scratch);
    for (let i = 0; i < cells; i++) {
      const w = weight[i] as number;
      plane[i] = w > 0 ? (plane[i] as number) / w : 0;
    }
  }

  // Which two columns each pixel falls between is the same on every row. A cell
  // stands for the pixels from `gx·step` on, so its own centre sits half a step
  // in, which is what the half pixel on either side of this is settling.
  const span = right - left;
  const lowColumns = new Int32Array(span);
  const highColumns = new Int32Array(span);
  const columnFractions = new Float32Array(span);
  for (let x = left; x < right; x++) {
    const u = (x + 0.5) / step - 0.5;
    const base = Math.floor(u);
    lowColumns[x - left] = clampIndex(base, gridWidth - 1);
    highColumns[x - left] = clampIndex(base + 1, gridWidth - 1);
    columnFractions[x - left] = u - base;
  }

  for (let y = top; y < bottom; y++) {
    const v = (y + 0.5) / step - 0.5;
    const base = Math.floor(v);
    const fy = v - base;
    const lowRow = clampIndex(base, gridHeight - 1) * gridWidth;
    const highRow = clampIndex(base + 1, gridHeight - 1) * gridWidth;
    const dy = y + 0.5 - cy;
    const row = (region.y + y) * imageWidth + region.x;
    for (let x = left; x < right; x++) {
      const dx = x + 0.5 - cx;
      const m = maskAt(Math.sqrt(dx * dx + dy * dy), radius, outer);
      if (m <= 0) continue;
      const column = x - left;
      const lowColumn = lowColumns[column] as number;
      const highColumn = highColumns[column] as number;
      const fx = columnFractions[column] as number;
      // A pixel can carry mask and still have no blurred weight under it only at
      // the very rim of the region, where dividing would be by nothing.
      const w = bilinear(weight, 0, lowRow, highRow, lowColumn, highColumn, fx, fy);
      if (w <= 0) continue;
      const i = (row + x) * 4;
      for (let c = 0; c < 3; c++) {
        const mean = bilinear(carried, c * cells, lowRow, highRow, lowColumn, highColumn, fx, fy);
        const source = toLinear[pristine[i + c] as number] as number;
        // Composited at full resolution and in linear light: the decimation is
        // an economy in how the average was reached, not in where it is laid.
        const mixed = m * mean + (1 - m) * source;
        plate[i + c] = Math.round(Math.min(1, Math.max(0, transferFromLinear(mixed))) * 255);
      }
    }
  }

  return written;
}
