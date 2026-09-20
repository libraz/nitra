/**
 * Blurring a reflection: a blur held inside the circle the user drew.
 *
 * Its reach is a fraction of that circle's own radius rather than a number of
 * pixels, which is what lets one amount cover a mirror and a pupil when their
 * radii differ by two orders of magnitude, and what keeps the control meaning
 * the same thing on the next photograph.
 *
 * **The blur reads the photograph around the circle, and only the compositing
 * is masked** — which is what a blur filter run inside a selection does, and
 * what makes the result look like part of the picture. Holding the average to
 * the light inside the mask instead keeps the circle's own colour from leaving
 * it: the disc then comes back as a plate of iris sitting on top of the eye,
 * and the feather needed to hide that edge pushes iris colour out over the
 * sclera, so the eye grows a halo and reads as a smudge. Reading freely, the
 * blurred value at the rim is a blur of what is actually there, so it already
 * agrees with the unblurred pixel beside it.
 *
 * The average is taken in linear light and composited there too, because a
 * catchlight is the extreme of contrast and the mean of gamma-encoded values is
 * not the mean of the light.
 *
 * The mask feathers inward, the same direction as heal's join: the ring the
 * user drew bounds everything the stage changes, and nothing outside it moves.
 * It is narrow because free reading has already made the join continuous — the
 * feather is only there so the change in sharpness does not land on one line.
 *
 * Each circle reads the pristine source rather than the plate, so the order of
 * the list cannot change a pixel and a circle can be re-applied as often as the
 * stages under it are rebuilt.
 *
 * The average itself is taken on a decimated grid, which matters at the top of
 * the amount: the field being built varies over a span of about the reach, so
 * carrying it at one sample per pixel is carrying nothing, and three
 * full-resolution planes over a region that large is where both the second and
 * the hundreds of megabytes went. What the decimation may not touch is the mask
 * used to composite, which stays at full resolution so the ring's edge lands
 * where the user drew it.
 */

import { transferFromLinear } from '../color/spaces';
import { BLUR_PASSES, boxBlur, clampIndex, linearTable } from '../plate/blur';
import type { Region } from '../plate/region';

/**
 * Box radius the blur is left with after the decimation, in decimated samples.
 *
 * Two things set it and neither is cost: the decimated field is reconstructed
 * bilinearly, whose error falls as the square of this, and the reach that
 * survives is `box·step`, which rounding moves by at most half a step — 1/(2·32)
 * of the reach here. The blur is the one part of the stage whose cost the
 * decimation makes free, so spending samples on it is spending nothing: the grid
 * is this many samples across the kernel whatever the circle and the amount are.
 * At the largest circle and the top of the amount on a 4240x2832 frame the whole
 * stage comes to about 200 ms over 11 MB; an iris-sized circle at the default
 * is 2 ms.
 */
const DECIMATED_BOX = 32;

/**
 * Where the mask starts to fade, as a fraction of the radius inside it.
 *
 * Narrower than heal's join, which is the same direction but has a different
 * job: heal is blending an invented patch back into the photograph, while this
 * is blending a blur of the photograph into the photograph, and those already
 * agree at the edge. What the feather is left doing is spreading the change in
 * sharpness over a band instead of a line. Wider costs the outer part of the
 * circle, where a ring of untouched detail then stands at the rim.
 */
export const CONCEAL_FEATHER = 0.15;

/** A circle as the recipe holds it: normalised centre, radius in image widths. */
export interface ConcealSpot {
  x: number;
  y: number;
  r: number;
}

/** Radius of the box whose three passes approximate a Gaussian of σ = amount·r. */
function boxRadiusFor(radius: number, amount: number): number {
  // Kovesi's wIdeal = sqrt(12σ²/n + 1) is a width, so at n = BLUR_PASSES the box
  // radius comes to about σ itself. Under one pixel the blur returns in silence
  // and the ring would be left standing over a reflection it never touched.
  return Math.max(1, Math.round(radius * amount));
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
export function concealDecimation(radius: number, amount: number): number {
  return Math.max(1, Math.floor(boxRadiusFor(radius, amount) / DECIMATED_BOX));
}

/** The mask at one distance from the centre: one inside, feathered in to zero at the ring. */
function maskAt(distance: number, radius: number, inner: number): number {
  if (distance >= radius) return 0;
  if (distance <= inner) return 1;
  const t = (radius - distance) / (radius - inner);
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
 * `region` is the circle plus everything three box passes read past it, which is
 * three radii rather than the one a single pass would take. The padding is what
 * keeps the blur's own border handling away from the mask: inside the region the
 * average is over real pixels, and the repeated edge it falls back on sits far
 * enough out that no composited pixel sees it.
 *
 * `written` is the circle itself, since the mask reaches zero at the ring. It is
 * what the circle changes, so it is both what the caller re-uploads and what
 * decides whether a fill landed under the ring.
 *
 * Clamped to the frame: a circle at an edge loses reach on that side, since the
 * blur extends the border rather than inventing pixels.
 */
export function concealRegion(
  spot: ConcealSpot,
  imageWidth: number,
  imageHeight: number,
  amount: number,
): { region: Region; written: Region; centre: [number, number]; radius: number } {
  const radius = spot.r * imageWidth;
  const reach = Math.ceil(radius + BLUR_PASSES * boxRadiusFor(radius, amount));
  const cx = spot.x * imageWidth;
  const cy = spot.y * imageHeight;
  const x = Math.max(0, Math.min(imageWidth - 1, Math.round(cx - reach)));
  const y = Math.max(0, Math.min(imageHeight - 1, Math.round(cy - reach)));
  const right = Math.max(x + 1, Math.min(imageWidth, Math.round(cx + reach)));
  const bottom = Math.max(y + 1, Math.min(imageHeight, Math.round(cy + reach)));
  const region = { x, y, width: right - x, height: bottom - y };

  const left = Math.max(0, Math.floor(cx - x - radius));
  const over = Math.min(region.width, Math.ceil(cx - x + radius) + 1);
  const top = Math.max(0, Math.floor(cy - y - radius));
  const under = Math.min(region.height, Math.ceil(cy - y + radius) + 1);
  return {
    region,
    written: { x: x + left, y: y + top, width: over - left, height: under - top },
    centre: [cx - x, cy - y],
    radius,
  };
}

/**
 * Blur one circle: read the pristine source, write the plate.
 *
 * Only the pixels inside the ring are written. The region is as wide as three
 * box passes read, which at the top of the amount is twenty times the circle's
 * own area, and laying the source back over all of it would take out every fill
 * the stage under this one left around the circle.
 *
 * The `(1−m)` term reads the pristine source rather than the plate, which is
 * what keeps a circle idempotent — the plate applies one again whenever a fill
 * lands under it, and a feather reading its own output would eat into the band
 * a little more on every pass. The cost is that a fill inside the feather is
 * pulled towards the source in that proportion, over a narrow band just inside
 * the ring.
 *
 * @returns The rectangle that was written, which is what the caller re-uploads.
 */
export function concealSpot(
  plate: Uint8ClampedArray,
  pristine: Uint8ClampedArray,
  imageWidth: number,
  imageHeight: number,
  spot: ConcealSpot,
  amount: number,
): Region {
  const { region, written, centre, radius } = concealRegion(spot, imageWidth, imageHeight, amount);
  const [cx, cy] = centre;
  const inner = radius * (1 - CONCEAL_FEATHER);

  const left = written.x - region.x;
  const right = left + written.width;
  const top = written.y - region.y;
  const bottom = top + written.height;

  const step = concealDecimation(radius, amount);
  const box = Math.max(1, Math.round(boxRadiusFor(radius, amount) / step));
  const gridWidth = Math.ceil(region.width / step);
  const gridHeight = Math.ceil(region.height / step);
  const cells = gridWidth * gridHeight;
  const carried = new Float32Array(cells * 3);
  const toLinear = linearTable();

  // The whole region, not only the circle: the blur is over the photograph and
  // the mask is only applied when the result is laid down. Decimated by the mean
  // over each cell rather than by a sample of it, since a plain subsample folds
  // the band this stage exists to remove back down into one it keeps.
  for (let y = 0; y < region.height; y++) {
    const row = (region.y + y) * imageWidth + region.x;
    const cellRow = Math.floor(y / step) * gridWidth;
    for (let x = 0; x < region.width; x++) {
      const cell = cellRow + Math.floor(x / step);
      const i = (row + x) * 4;
      for (let c = 0; c < 3; c++) {
        const at = c * cells + cell;
        carried[at] = (carried[at] as number) + (toLinear[pristine[i + c] as number] as number);
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
      for (let c = 0; c < 3; c++) {
        const at = c * cells + cell;
        carried[at] = (carried[at] as number) / area;
      }
    }
  }

  const scratch = new Float32Array(cells);
  for (let c = 0; c < 3; c++) {
    boxBlur(carried.subarray(c * cells, (c + 1) * cells), gridWidth, gridHeight, box, scratch);
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
      const m = maskAt(Math.sqrt(dx * dx + dy * dy), radius, inner);
      if (m <= 0) continue;
      const column = x - left;
      const lowColumn = lowColumns[column] as number;
      const highColumn = highColumns[column] as number;
      const fx = columnFractions[column] as number;
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
