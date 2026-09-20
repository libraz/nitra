/**
 * A rectangle of a photograph, and moving pixels in and out of it.
 *
 * Shared by every CPU stage that works on a sub-rectangle of the plate rather
 * than the whole frame: cut a region out, hand it to whatever fills it, paste
 * the result back.
 */

/** A rectangle of the photograph, in whole pixels. */
export interface Region {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Copy one rectangle out of an RGBA image. */
export function cutOut(
  pixels: Uint8ClampedArray,
  imageWidth: number,
  region: Region,
): Uint8ClampedArray {
  const out = new Uint8ClampedArray(region.width * region.height * 4);
  for (let row = 0; row < region.height; row++) {
    const from = ((region.y + row) * imageWidth + region.x) * 4;
    out.set(pixels.subarray(from, from + region.width * 4), row * region.width * 4);
  }
  return out;
}

/** Write one rectangle back into an RGBA image. */
export function pasteInto(
  pixels: Uint8ClampedArray,
  imageWidth: number,
  region: Region,
  patch: Uint8ClampedArray,
): void {
  for (let row = 0; row < region.height; row++) {
    const to = ((region.y + row) * imageWidth + region.x) * 4;
    pixels.set(patch.subarray(row * region.width * 4, (row + 1) * region.width * 4), to);
  }
}
