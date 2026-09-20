/**
 * The Heal stage around the fill: cutting a region out, and putting it back.
 *
 * The fill itself is in `patchmatch.ts`; everything here is the arithmetic
 * around it — how large a region one spot needs, and where that region sits in
 * the photograph.
 *
 * It never runs inside the drag loop. The fill reads pixels, and reading pixels
 * while a slider is moving means a synchronous read that stops the pipeline —
 * the slider stops following the pointer, which is the one thing the whole proxy
 * renderer exists to prevent. So this runs once per spot, against the photograph
 * as it was decoded, and what the renderer samples afterwards is the result.
 */

import { cutOut, pasteInto, type Region } from '../plate/region';
import { inpaint } from './patchmatch';

/**
 * How far past the spot the region reaches, in multiples of its radius.
 *
 * The region is the only place the fill can copy from, so this is not a margin
 * for safety — it is the entire library of skin available to the search. Too
 * narrow and there is nothing to copy; much wider and the search wanders off
 * onto a different part of the face, and the cost grows with the area.
 */
const REGION_MARGIN = 1.6;

/** Softness of the join, as a fraction of the spot's radius. */
const FEATHER = 0.35;

/** Smallest spot worth running the fill for, in pixels of radius. */
const LEAST_RADIUS = 1.5;

/** A spot as the recipe holds it: normalised centre, radius in image widths. */
export interface HealSpot {
  x: number;
  y: number;
  r: number;
}

/**
 * The part of the photograph one spot is worked on.
 *
 * Clamped to the frame rather than centred on the spot at all costs: a blemish
 * near an edge gets a region that reaches further the other way, which is the
 * only place there is anything to copy from.
 */
export function regionFor(
  spot: HealSpot,
  imageWidth: number,
  imageHeight: number,
): { region: Region; centre: [number, number]; radius: number } {
  const radius = Math.max(1, spot.r * imageWidth);
  const reach = Math.ceil(radius * (1 + REGION_MARGIN));
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
 * Fill one spot, in place, in the photograph's own pixels.
 *
 * The plate is mutated rather than copied per spot, which is what lets two
 * overlapping spots compose: the second one reads what the first left behind, the
 * same way it would if a person had healed them one after the other.
 *
 * @returns How many pixels the fill reached, or zero when there was nothing to
 * do — a spot smaller than a pixel, or one whose region is filled by the hole
 * and so has no photograph left to copy from.
 */
export function healSpot(
  plate: Uint8ClampedArray,
  imageWidth: number,
  imageHeight: number,
  spot: HealSpot,
): number {
  const { region, centre, radius } = regionFor(spot, imageWidth, imageHeight);
  if (radius < LEAST_RADIUS) return 0;

  // Cut out rather than filled where it lies. The region is not a working copy
  // the fill happens to need — it is the bound on what the search may copy from,
  // and handing over exactly those pixels is what states that bound.
  const patch = cutOut(plate, imageWidth, region);
  const touched = inpaint(
    patch,
    region.width,
    region.height,
    centre[0],
    centre[1],
    radius,
    radius * FEATHER,
  );
  if (touched === 0) return 0;
  pasteInto(plate, imageWidth, region, patch);
  return touched;
}
