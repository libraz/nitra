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
 * Each circle reads the pristine source rather than the plate, so a circle can
 * be re-applied as often as the stages under it are rebuilt. Circles that cross
 * are laid down together, so the order of the list cannot change a pixel and
 * one circle's feather cannot put back what another blurred.
 *
 * The blur takes the photograph's own noise out along with the reflection, and a
 * noiseless disc in a photograph that has some is a smudge however soft its
 * edge. So noise of the photograph's measured level ({@link ./../plate/noise}) is
 * put back over the blurred part, scaled with the mask so the sum of what is
 * kept and what is added holds the level constant across the feather. It is
 * generated, not copied, so nothing the blur removed comes back with it.
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
import { grainAt } from '../plate/noise';
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

/** One circle's blurred field, held until every circle sharing pixels with it is laid down. */
interface ConcealField {
  region: Region;
  written: Region;
  /** The centre, relative to the region's corner. */
  cx: number;
  cy: number;
  radius: number;
  inner: number;
  /** Source pixels per sample of {@link carried}. */
  step: number;
  gridWidth: number;
  gridHeight: number;
  /** Three planes of linear light, one per channel, each `gridWidth·gridHeight` long. */
  carried: Float32Array;
}

/** The blur of the photograph around one circle, on the grid its reach allows. */
function blurField(
  pristine: Uint8ClampedArray,
  imageWidth: number,
  imageHeight: number,
  spot: ConcealSpot,
  amount: number,
  toLinear: Float32Array,
): ConcealField {
  const { region, written, centre, radius } = concealRegion(spot, imageWidth, imageHeight, amount);
  const step = concealDecimation(radius, amount);
  const box = Math.max(1, Math.round(boxRadiusFor(radius, amount) / step));
  const gridWidth = Math.ceil(region.width / step);
  const gridHeight = Math.ceil(region.height / step);
  const cells = gridWidth * gridHeight;
  const carried = new Float32Array(cells * 3);

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

  return {
    region,
    written,
    cx: centre[0],
    cy: centre[1],
    radius,
    inner: radius * (1 - CONCEAL_FEATHER),
    step,
    gridWidth,
    gridHeight,
    carried,
  };
}

/**
 * Lay one circle of a group down: read the pristine source, write the plate.
 *
 * Where no other circle of the group reaches, the pixel is the circle's own
 * blur mixed with the source by its mask. Where several do, the blurs are
 * averaged by their masks and the source keeps only the share no circle covers,
 * `Π(1−m)`: a feather mixing with the source on its own would put the
 * photograph back inside a neighbour that had blurred it. Such a pixel is
 * written by the first circle of the group that covers it, with the sums taken
 * in the group's order.
 */
function layDown(
  plate: Uint8ClampedArray,
  pristine: Uint8ClampedArray,
  imageWidth: number,
  group: readonly ConcealField[],
  own: number,
  noise: number,
  toLinear: Float32Array,
): void {
  const field = group[own] as ConcealField;
  const { region, written, cx, cy, radius, inner, step, gridWidth, gridHeight } = field;
  const cells = gridWidth * gridHeight;
  const left = written.x - region.x;
  const right = left + written.width;
  const top = written.y - region.y;
  const bottom = top + written.height;

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

  const sum = [0, 0, 0];
  for (let y = top; y < bottom; y++) {
    const v = (y + 0.5) / step - 0.5;
    const base = Math.floor(v);
    const fy = v - base;
    const lowRow = clampIndex(base, gridHeight - 1) * gridWidth;
    const highRow = clampIndex(base + 1, gridHeight - 1) * gridWidth;
    const dy = y + 0.5 - cy;
    const row = (region.y + y) * imageWidth + region.x;
    pixel: for (let x = left; x < right; x++) {
      const dx = x + 0.5 - cx;
      const m = maskAt(Math.sqrt(dx * dx + dy * dy), radius, inner);
      if (m <= 0) continue;
      const column = x - left;
      const lowColumn = lowColumns[column] as number;
      const highColumn = highColumns[column] as number;
      const fx = columnFractions[column] as number;
      for (let c = 0; c < 3; c++) {
        sum[c] = bilinear(field.carried, c * cells, lowRow, highRow, lowColumn, highColumn, fx, fy);
      }

      // `covered` is everything the masks take between them, `weight` what the
      // blurs are averaged by. Alone, they are both the circle's own mask.
      let covered = m;
      let weight = 0;
      let kept = 1 - m;
      for (let j = 0; j < group.length; j++) {
        if (j === own) continue;
        const other = group[j] as ConcealField;
        const ox = region.x + x - other.region.x;
        const oy = region.y + y - other.region.y;
        const odx = ox + 0.5 - other.cx;
        const ody = oy + 0.5 - other.cy;
        const om = maskAt(Math.sqrt(odx * odx + ody * ody), other.radius, other.inner);
        if (om <= 0) continue;
        if (j < own) continue pixel;
        if (weight === 0) {
          weight = m;
          for (let c = 0; c < 3; c++) sum[c] = (sum[c] as number) * m;
        }
        const ou = (ox + 0.5) / other.step - 0.5;
        const ov = (oy + 0.5) / other.step - 0.5;
        const columnBase = Math.floor(ou);
        const rowBase = Math.floor(ov);
        const otherCells = other.gridWidth * other.gridHeight;
        for (let c = 0; c < 3; c++) {
          sum[c] =
            (sum[c] as number) +
            om *
              bilinear(
                other.carried,
                c * otherCells,
                clampIndex(rowBase, other.gridHeight - 1) * other.gridWidth,
                clampIndex(rowBase + 1, other.gridHeight - 1) * other.gridWidth,
                clampIndex(columnBase, other.gridWidth - 1),
                clampIndex(columnBase + 1, other.gridWidth - 1),
                ou - columnBase,
                ov - rowBase,
              );
        }
        weight += om;
        kept *= 1 - om;
        covered = 1 - kept;
      }

      const i = (row + x) * 4;
      // What the source keeps carries (1−m) of its noise, so m(2−m) more in
      // variance brings the sum back to the photograph's own. One draw for all
      // three channels: the noise a camera file shows is mostly in its luma.
      const grain = noise > 0 ? Math.sqrt(covered * (2 - covered)) * noise * grainAt(row + x) : 0;
      for (let c = 0; c < 3; c++) {
        const mean = weight > 0 ? (sum[c] as number) / weight : (sum[c] as number);
        const source = toLinear[pristine[i + c] as number] as number;
        // Composited at full resolution and in linear light: the decimation is
        // an economy in how the average was reached, not in where it is laid.
        const mixed = covered * mean + (1 - covered) * source;
        const code = Math.min(1, Math.max(0, transferFromLinear(mixed))) * 255 + grain;
        plate[i + c] = Math.round(Math.min(255, Math.max(0, code)));
      }
    }
  }
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
 * A circle on its own: one that shares pixels with another has to be laid down
 * with it, by {@link concealSpots}.
 *
 * @param noise The photograph's noise as a standard deviation in code values,
 *   which is how much is put back where the blur took it out.
 * @returns The rectangle that was written, which is what the caller re-uploads.
 */
export function concealSpot(
  plate: Uint8ClampedArray,
  pristine: Uint8ClampedArray,
  imageWidth: number,
  imageHeight: number,
  spot: ConcealSpot,
  amount: number,
  noise: number,
): Region {
  const toLinear = linearTable();
  const field = blurField(pristine, imageWidth, imageHeight, spot, amount, toLinear);
  layDown(plate, pristine, imageWidth, [field], 0, noise, toLinear);
  return field.written;
}

/**
 * Blur every circle of a list, whatever order the list is in.
 *
 * Circles whose rings cross are laid down as one group, so the result is the
 * union of what each was drawn to blur. The list is worked in a fixed order of
 * its own — by position, then radius — which is what keeps the sums in a
 * crossing identical to the last bit when the recipe lists the same circles
 * differently.
 */
export function concealSpots(
  plate: Uint8ClampedArray,
  pristine: Uint8ClampedArray,
  imageWidth: number,
  imageHeight: number,
  spots: readonly ConcealSpot[],
  amount: number,
  noise: number,
): void {
  const ordered = [...spots].sort((a, b) => a.x - b.x || a.y - b.y || a.r - b.r);
  const toLinear = linearTable();

  // Groups are whatever crossing rings connect, found by merging labels.
  const label = ordered.map((_, i) => i);
  const find = (i: number): number => {
    let root = i;
    while (label[root] !== root) root = label[root] as number;
    return root;
  };
  for (let i = 0; i < ordered.length; i++) {
    const a = ordered[i] as ConcealSpot;
    for (let j = i + 1; j < ordered.length; j++) {
      const b = ordered[j] as ConcealSpot;
      const dx = (a.x - b.x) * imageWidth;
      const dy = (a.y - b.y) * imageHeight;
      const reach = (a.r + b.r) * imageWidth;
      // The larger label joins the smaller, so a group's root is its first circle.
      if (dx * dx + dy * dy < reach * reach) {
        const ra = find(i);
        const rb = find(j);
        label[Math.max(ra, rb)] = Math.min(ra, rb);
      }
    }
  }

  for (let root = 0; root < ordered.length; root++) {
    if (find(root) !== root) continue;
    // A group's fields are held together and let go together: only circles that
    // cross need each other's blur.
    const group: ConcealField[] = [];
    for (let i = root; i < ordered.length; i++) {
      if (find(i) !== root) continue;
      const spot = ordered[i] as ConcealSpot;
      group.push(blurField(pristine, imageWidth, imageHeight, spot, amount, toLinear));
    }
    for (let own = 0; own < group.length; own++) {
      layDown(plate, pristine, imageWidth, group, own, noise, toLinear);
    }
  }
}
