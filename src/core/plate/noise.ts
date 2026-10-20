/**
 * How much sensor noise a photograph carries, and putting that much back.
 *
 * A blur takes the noise out with the detail, and a disc with no noise in a
 * photograph that has some reads as a smudge — and as a region somebody worked
 * on, to anyone who looks. What is put back is noise of the photograph's own
 * level, generated rather than copied, so none of the structure the blur removed
 * returns with it.
 *
 * The level is Immerkær's estimator (1996) taken per block, and the photograph's
 * level is a low percentile of the blocks (after Liu et al. 2006): the operator
 * is the product of a second difference across and one down, so a straight edge
 * or a grating running along either axis gives it nothing, and the blocks that
 * still hold texture sit above the percentile rather than in it. It under-reports
 * on a photograph with no smooth area at all rather than inventing grain.
 *
 * Arithmetic and `sqrt` only, and the noise is a hash of the pixel's position,
 * so the same recipe writes the same bytes in every browser and a circle can be
 * replayed without the noise in it moving.
 */

/** Pixels per side of one block the level is measured over. */
const BLOCK = 16;

/**
 * Which of the blocks' levels is taken as the photograph's.
 *
 * Low, because texture only ever adds to a block's reading. Not the lowest: a
 * block's own estimate scatters by about 5% over 196 samples, and the minimum of
 * thousands of them is that scatter's tail rather than the noise.
 */
const PERCENTILE = 0.1;

/** Blocks skipped between measured ones, each way. Every block is not needed for a percentile. */
const BLOCK_STRIDE = 2;

/** sqrt(π/2) / 6: Immerkær's mean absolute response to unit noise, inverted. */
const IMMERKAER = Math.sqrt(Math.PI / 2) / 6;

/** Fewer blocks than this and the frame is too small to say anything. */
const MIN_BLOCKS = 8;

/** Luma in code values, weighted 1:2:1 so it stays exact in integers. */
function luma(pixels: Uint8ClampedArray, index: number): number {
  return (
    ((pixels[index] as number) +
      2 * (pixels[index + 1] as number) +
      (pixels[index + 2] as number)) /
    4
  );
}

/**
 * How close to either end of the code range a value may sit before the block
 * holding it says nothing about noise. A blown highlight or a crushed shadow has
 * none left to measure, and a frame with a white wall in it would otherwise put
 * its level at zero.
 */
const CLIP_MARGIN = 3;

/** Whether any pixel of a block is at, or within a few codes of, either end of the range. */
function clipped(pixels: Uint8ClampedArray, width: number, x0: number, y0: number): boolean {
  for (let y = y0; y < y0 + BLOCK; y++) {
    for (let x = x0; x < x0 + BLOCK; x++) {
      const i = (y * width + x) * 4;
      for (let c = 0; c < 3; c++) {
        const v = pixels[i + c] as number;
        if (v < CLIP_MARGIN || v > 255 - CLIP_MARGIN) return true;
      }
    }
  }
  return false;
}

/**
 * The photograph's noise, as the standard deviation of its luma in code values.
 *
 * @returns Zero when the frame is too small to hold enough blocks.
 */
export function noiseLevel(pixels: Uint8ClampedArray, width: number, height: number): number {
  const across = Math.floor(width / BLOCK);
  const down = Math.floor(height / BLOCK);
  const levels: number[] = [];
  for (let by = 0; by < down; by += BLOCK_STRIDE) {
    for (let bx = 0; bx < across; bx += BLOCK_STRIDE) {
      const x0 = bx * BLOCK;
      const y0 = by * BLOCK;
      if (clipped(pixels, width, x0, y0)) continue;
      let total = 0;
      for (let y = y0 + 1; y < y0 + BLOCK - 1; y++) {
        for (let x = x0 + 1; x < x0 + BLOCK - 1; x++) {
          const at = (dx: number, dy: number) => luma(pixels, ((y + dy) * width + x + dx) * 4);
          const response =
            at(-1, -1) -
            2 * at(0, -1) +
            at(1, -1) -
            2 * at(-1, 0) +
            4 * at(0, 0) -
            2 * at(1, 0) +
            at(-1, 1) -
            2 * at(0, 1) +
            at(1, 1);
          total += response < 0 ? -response : response;
        }
      }
      levels.push((IMMERKAER * total) / ((BLOCK - 2) * (BLOCK - 2)));
    }
  }
  if (levels.length < MIN_BLOCKS) return 0;
  levels.sort((a, b) => a - b);
  return levels[Math.floor(PERCENTILE * (levels.length - 1))] as number;
}

/** The spread of a sum of four bytes, which is what {@link grainAt} draws. */
const SUM_SPREAD = Math.sqrt((4 * (256 * 256 - 1)) / 12);

/**
 * Unit-variance noise for one pixel, from its position alone.
 *
 * Four bytes of one integer hash, summed: close enough to normal for grain and
 * free of the logarithm and cosine a Box–Muller draw would need, whose precision
 * the language leaves to the engine.
 */
export function grainAt(index: number): number {
  let h = Math.imul(index ^ 0x9e3779b9, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  const sum = (h & 0xff) + ((h >>> 8) & 0xff) + ((h >>> 16) & 0xff) + ((h >>> 24) & 0xff);
  return (sum - 510) / SUM_SPREAD;
}
