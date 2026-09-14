/**
 * Framing maths: flips, rotation, straightening and the crop rectangle.
 *
 * Everything here is worked out in normalised coordinates with the origin at the
 * top left, which is what the sampler reads and what the overlay draws, so the
 * panel and the shader cannot end up disagreeing about where the crop is.
 *
 * The whole chain collapses into one 3x3 affine matrix taking an output
 * coordinate back to the source it came from. Composing it here rather than
 * writing the steps out in GLSL keeps the transform testable without a GPU, and
 * keeps the sampler to a single matrix multiply however many steps it stands
 * for.
 */

import { type Mat3, mat3Mul } from '../color/matrix';
import type { GeometryParams } from '../recipe/schema';

/** Size of the frame once whole 90° turns have been applied. */
export function quarterTurnedSize(
  width: number,
  height: number,
  quarterTurns: number,
): [number, number] {
  return quarterTurns % 2 === 0 ? [width, height] : [height, width];
}

/**
 * How far the frame has to shrink for a straightened crop to stay filled.
 *
 * Rotating a rectangle leaves wedges of nothing at the corners. Rather than
 * letting them through as transparent edges, the frame becomes the largest
 * rectangle of the same shape that still fits inside the rotated one — which is
 * what makes straightening feel like levelling the photo rather than adding a
 * border to it.
 */
export function straightenScale(width: number, height: number, degrees: number): number {
  if (Math.abs(degrees) < 1e-6) return 1;
  const rad = (Math.abs(degrees) * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  return Math.min(width / (width * cos + height * sin), height / (width * sin + height * cos));
}

/** Size of the straightened frame the crop rectangle is measured against. */
export function frameSize(
  width: number,
  height: number,
  geometry: GeometryParams,
): [number, number] {
  const [w, h] = quarterTurnedSize(width, height, geometry.quarterTurns);
  const k = straightenScale(w, h, geometry.straighten);
  return [w * k, h * k];
}

/** Size of the cropped result, in source-scale pixels. */
export function croppedSize(
  width: number,
  height: number,
  geometry: GeometryParams,
): [number, number] {
  const [w, h] = frameSize(width, height, geometry);
  return [w * geometry.crop.w, h * geometry.crop.h];
}

function translateScale(sx: number, sy: number, tx: number, ty: number): Mat3 {
  return [sx, 0, tx, 0, sy, ty, 0, 0, 1];
}

/** Undo a whole 90° turn: display coordinate back to the untuned source. */
function inverseQuarterTurn(quarterTurns: number): Mat3 {
  switch (((quarterTurns % 4) + 4) % 4) {
    case 1:
      return [0, 1, 0, -1, 0, 1, 0, 0, 1];
    case 2:
      return [-1, 0, 1, 0, -1, 1, 0, 0, 1];
    case 3:
      return [0, -1, 1, 1, 0, 0, 0, 0, 1];
    default:
      return [1, 0, 0, 0, 1, 0, 0, 0, 1];
  }
}

function inverseFlips(geometry: GeometryParams): Mat3 {
  return translateScale(
    geometry.flipH ? -1 : 1,
    geometry.flipV ? -1 : 1,
    geometry.flipH ? 1 : 0,
    geometry.flipV ? 1 : 0,
  );
}

/** Undo the straightening rotation: frame coordinate back to the turned frame. */
function inverseStraighten(width: number, height: number, geometry: GeometryParams): Mat3 {
  if (Math.abs(geometry.straighten) < 1e-6) return [1, 0, 0, 0, 1, 0, 0, 0, 1];
  const [w, h] = quarterTurnedSize(width, height, geometry.quarterTurns);
  const k = straightenScale(w, h, geometry.straighten);
  const rad = (geometry.straighten * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const a = k * cos;
  const b = (-k * h * sin) / w;
  const c = (k * w * sin) / h;
  const d = k * cos;
  return [a, b, 0.5 - 0.5 * (a + b), c, d, 0.5 - 0.5 * (c + d), 0, 0, 1];
}

/**
 * Map a coordinate in the straightened frame back to the source.
 *
 * This is what the crop overlay draws against: the whole frame is visible while
 * the rectangle is being dragged, so the photo outside the crop has to keep
 * rendering.
 */
export function frameToSource(width: number, height: number, geometry: GeometryParams): Mat3 {
  return mat3Mul(
    mat3Mul(inverseFlips(geometry), inverseQuarterTurn(geometry.quarterTurns)),
    inverseStraighten(width, height, geometry),
  );
}

/** Map a coordinate in the cropped output back to the source. */
export function outputToSource(width: number, height: number, geometry: GeometryParams): Mat3 {
  const crop = geometry.crop;
  return mat3Mul(
    frameToSource(width, height, geometry),
    translateScale(crop.w, crop.h, crop.x, crop.y),
  );
}

/** True when the framing leaves the photo exactly as it arrived. */
export function isNeutralGeometry(geometry: GeometryParams): boolean {
  const c = geometry.crop;
  return (
    geometry.quarterTurns === 0 &&
    !geometry.flipH &&
    !geometry.flipV &&
    Math.abs(geometry.straighten) < 1e-6 &&
    Math.abs(c.x) < 1e-6 &&
    Math.abs(c.y) < 1e-6 &&
    Math.abs(c.w - 1) < 1e-6 &&
    Math.abs(c.h - 1) < 1e-6
  );
}

/**
 * Which stored flip a button labelled for the screen should toggle.
 *
 * Flips are stored in the photo's own frame, so on a photo turned a quarter turn
 * the two axes have swapped: "flip horizontally" has to reach the field that
 * mirrors what the viewer sees as horizontal, or the button does the opposite of
 * what it says.
 */
export function flipFieldFor(quarterTurns: number, axis: 'h' | 'v'): 'flipH' | 'flipV' {
  const swapped = Math.abs(quarterTurns) % 2 === 1;
  return (axis === 'h') !== swapped ? 'flipH' : 'flipV';
}

/** Cache key for the framing. Two recipes sharing it produce the same frame. */
export function geometrySignature(geometry: GeometryParams): string {
  const c = geometry.crop;
  return [
    geometry.quarterTurns,
    geometry.flipH ? 1 : 0,
    geometry.flipV ? 1 : 0,
    geometry.straighten.toFixed(4),
    c.x.toFixed(5),
    c.y.toFixed(5),
    c.w.toFixed(5),
    c.h.toFixed(5),
  ].join(',');
}

/**
 * Convert a pixel aspect ratio into the frame's normalised coordinates.
 *
 * The crop is stored as fractions of the frame, so a square crop is only a
 * normalised square on a square photo. Everything that reasons about the crop's
 * shape goes through this first.
 */
export function normalisedRatio(ratio: number, frameAspect: number): number {
  return ratio / frameAspect;
}

/**
 * Fit a crop rectangle to an aspect ratio without letting it leave the frame.
 *
 * The rectangle keeps its centre and roughly its size, so locking a shape after
 * framing by eye adjusts the crop rather than throwing the framing away. Size is
 * carried across as a fraction of the largest rectangle of that shape which
 * fits, which is what makes the operation idempotent: a rectangle already at the
 * target shape comes back unchanged, so a drag that maintained the lock is not
 * then undone by the lock being reapplied.
 *
 * @param ratio Width divided by height, measured in pixels of the frame.
 * @param frameAspect The frame's own width/height.
 */
export function fitCropToAspect(
  crop: { x: number; y: number; w: number; h: number },
  ratio: number,
  frameAspect: number,
): { x: number; y: number; w: number; h: number } {
  const cx = crop.x + crop.w / 2;
  const cy = crop.y + crop.h / 2;
  const normalised = normalisedRatio(ratio, frameAspect);
  const maxW = Math.min(1, normalised);
  const maxH = maxW / normalised;
  const scale = Math.min(1, Math.sqrt((crop.w * crop.h) / (maxW * maxH)));
  const w = maxW * scale;
  const h = maxH * scale;
  return {
    w,
    h,
    x: Math.min(Math.max(cx - w / 2, 0), 1 - w),
    y: Math.min(Math.max(cy - h / 2, 0), 1 - h),
  };
}

/** Which edges a crop handle moves. */
export type CropHandle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';

/**
 * Resize a crop rectangle by dragging one of its handles.
 *
 * With a shape locked, the edge being dragged is the one the user is looking at,
 * so it is the one that wins: the perpendicular dimension follows from it, and
 * the corner or edge opposite the handle stays put.
 */
export function resizeCrop(
  start: { x: number; y: number; w: number; h: number },
  handle: CropHandle,
  pointerX: number,
  pointerY: number,
  normalised: number | null,
): { x: number; y: number; w: number; h: number } {
  const min = 0.04;
  let left = start.x;
  let top = start.y;
  let right = start.x + start.w;
  let bottom = start.y + start.h;

  if (handle.includes('w')) left = Math.min(pointerX, right - min);
  if (handle.includes('e')) right = Math.max(pointerX, left + min);
  if (handle.includes('n')) top = Math.min(pointerY, bottom - min);
  if (handle.includes('s')) bottom = Math.max(pointerY, top + min);

  let w = right - left;
  let h = bottom - top;

  if (normalised !== null) {
    const horizontal = handle.includes('w') || handle.includes('e');
    const vertical = handle.includes('n') || handle.includes('s');
    if (horizontal && vertical) {
      if (w / normalised > h) h = w / normalised;
      else w = h * normalised;
    } else if (horizontal) {
      h = w / normalised;
    } else {
      w = h * normalised;
    }
    if (handle.includes('w')) left = right - w;
    if (handle.includes('n')) top = bottom - h;
    if (horizontal && !vertical) top = start.y + start.h / 2 - h / 2;
    if (vertical && !horizontal) left = start.x + start.w / 2 - w / 2;
  }

  return clampCrop({ x: left, y: top, w, h });
}

/** Clamp a crop rectangle back inside the frame, keeping its size where possible. */
export function clampCrop(crop: { x: number; y: number; w: number; h: number }): {
  x: number;
  y: number;
  w: number;
  h: number;
} {
  const w = Math.min(Math.max(crop.w, 0.02), 1);
  const h = Math.min(Math.max(crop.h, 0.02), 1);
  return {
    w,
    h,
    x: Math.min(Math.max(crop.x, 0), 1 - w),
    y: Math.min(Math.max(crop.y, 0), 1 - h),
  };
}
