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
 */

import { transferFromLinear } from '../color/spaces';
import { BLUR_PASSES, boxBlur, linearTable } from '../plate/blur';
import { cutOut, pasteInto, type Region } from '../plate/region';

/**
 * Blur reach as a fraction of the circle's radius (σ/r).
 *
 * Bound by the band: a full-contrast grating of λ = r has to come back under two
 * code values, and since the average may only read light from inside the mask,
 * the window is about 2.7 wavelengths wide there and a free-space reach of r/2
 * leaves 9.5 of them. Measured, it takes 1.75 to clear the bound at every radius
 * the schema allows. One circle at the largest radius on a 4240x2832 frame
 * measures 1006-1055 ms over 192 MB of planes, the region being the whole frame;
 * a pupil-sized circle on the same frame is 57 ms over 20 MB.
 */
export const CONCEAL_REACH = 1.75;

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
 * The part of the photograph one circle is worked on.
 *
 * Wide enough to hold the mask and everything three box passes reach from it,
 * which is three radii rather than the one a single pass would take. Clamped to
 * the frame: a circle at an edge loses reach on that side, since the blur
 * extends the border rather than inventing pixels, and the guarantee is over the
 * pixels the frame actually has.
 */
export function concealRegion(
  spot: ConcealSpot,
  imageWidth: number,
  imageHeight: number,
): { region: Region; centre: [number, number]; radius: number } {
  const radius = spot.r * imageWidth;
  const reach = Math.ceil(radius * (1 + CONCEAL_FEATHER) + BLUR_PASSES * boxRadiusFor(radius));
  const cx = spot.x * imageWidth;
  const cy = spot.y * imageHeight;
  const x = Math.max(0, Math.min(imageWidth - 1, Math.round(cx - reach)));
  const y = Math.max(0, Math.min(imageHeight - 1, Math.round(cy - reach)));
  const right = Math.max(x + 1, Math.min(imageWidth, Math.round(cx + reach)));
  const bottom = Math.max(y + 1, Math.min(imageHeight, Math.round(cy + reach)));
  return {
    region: { x, y, width: right - x, height: bottom - y },
    centre: [cx - x, cy - y],
    radius,
  };
}

/**
 * Conceal one circle: read the pristine source, write the plate.
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
  const { region, centre, radius } = concealRegion(spot, imageWidth, imageHeight);
  const count = region.width * region.height;
  const patch = cutOut(pristine, imageWidth, region);

  const outer = radius * (1 + CONCEAL_FEATHER);
  const mask = new Float32Array(count);
  const [cx, cy] = centre;
  for (let y = 0; y < region.height; y++) {
    for (let x = 0; x < region.width; x++) {
      const dx = x + 0.5 - cx;
      const dy = y + 0.5 - cy;
      const distance = Math.sqrt(dx * dx + dy * dy);
      const index = y * region.width + x;
      if (distance <= radius) {
        mask[index] = 1;
      } else if (distance < outer) {
        const t = (outer - distance) / (outer - radius);
        mask[index] = t * t * (3 - 2 * t);
      }
    }
  }

  const box = boxRadiusFor(radius);
  const scratch = new Float32Array(count);
  const weight = new Float32Array(mask);
  boxBlur(weight, region.width, region.height, box, scratch);

  const toLinear = linearTable();
  const carried = new Float32Array(count);
  for (let c = 0; c < 3; c++) {
    for (let i = 0; i < count; i++) {
      carried[i] = (toLinear[patch[i * 4 + c] as number] as number) * (mask[i] as number);
    }
    boxBlur(carried, region.width, region.height, box, scratch);

    for (let i = 0; i < count; i++) {
      const m = mask[i] as number;
      // Outside the mask the pixel is left as it was read, which also keeps the
      // byte exact rather than sending it through the transfer and back.
      if (m <= 0) continue;
      // A pixel can carry mask and still have no blurred weight under it only at
      // the very rim of the region, where dividing would be by nothing.
      const w = weight[i] as number;
      if (w <= 0) continue;
      const v = toLinear[patch[i * 4 + c] as number] as number;
      const mixed = m * ((carried[i] as number) / w) + (1 - m) * v;
      patch[i * 4 + c] = Math.round(Math.min(1, Math.max(0, transferFromLinear(mixed))) * 255);
    }
  }

  pasteInto(plate, imageWidth, region, patch);
  return region;
}
