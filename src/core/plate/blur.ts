/** Box blur and the small pieces of arithmetic it shares with its callers. */

import { transferToLinear } from '../color/spaces';

/** Box blur passes. Three is where a box stops looking like a box. */
export const BLUR_PASSES = 3;

export function clampIndex(value: number, limit: number): number {
  return value < 0 ? 0 : value > limit ? limit : value;
}

/**
 * Blur in place, separably, by repeated box.
 *
 * A running sum per row and per column, so the cost is the same whatever the
 * radius — which matters because the radius is a fraction of a face and a face
 * can be most of the frame.
 *
 * @param scratch A buffer the same length as `data`, owned by the caller. A
 * blur run for every spot in a list would otherwise allocate one per spot.
 */
export function boxBlur(
  data: Float32Array,
  width: number,
  height: number,
  radius: number,
  scratch: Float32Array,
): void {
  if (radius < 1) return;
  const span = radius * 2 + 1;

  for (let pass = 0; pass < BLUR_PASSES; pass++) {
    for (let y = 0; y < height; y++) {
      const row = y * width;
      let sum = 0;
      for (let i = -radius; i <= radius; i++) sum += data[row + clampIndex(i, width - 1)] as number;
      for (let x = 0; x < width; x++) {
        scratch[row + x] = sum / span;
        sum -= data[row + clampIndex(x - radius, width - 1)] as number;
        sum += data[row + clampIndex(x + radius + 1, width - 1)] as number;
      }
    }
    for (let x = 0; x < width; x++) {
      let sum = 0;
      for (let i = -radius; i <= radius; i++) {
        sum += scratch[clampIndex(i, height - 1) * width + x] as number;
      }
      for (let y = 0; y < height; y++) {
        data[y * width + x] = sum / span;
        sum -= scratch[clampIndex(y - radius, height - 1) * width + x] as number;
        sum += scratch[clampIndex(y + radius + 1, height - 1) * width + x] as number;
      }
    }
  }
}

/** Non-linear bytes to linear, for all 256 of them. */
export function linearTable(): Float32Array {
  const table = new Float32Array(256);
  for (let i = 0; i < 256; i++) table[i] = transferToLinear(i / 255);
  return table;
}
