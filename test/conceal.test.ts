/**
 * The conceal stage, asserted by what is left of a reflection rather than by
 * stored bytes.
 *
 * What the stage promises is a band, not a look: a grating finer than the circle
 * it was drawn on has to come back under the eye's threshold, measured in code
 * values inside the ring the user saw, because the ring is the range being
 * guaranteed. Everything else here defends one claim each, and each is measured
 * against what the alternative would have done — a plain convolution for the
 * light outside the mask, a gamma-space average for the mean — since a number
 * on its own says nothing about why the arithmetic is shaped the way it is.
 *
 * The counterfactuals are built from the same shared box blur rather than a
 * second blur written for the test, so what they differ in is the one step
 * being argued about.
 */

import { describe, expect, it } from 'vitest';
import { transferToLinear } from '../src/core/color/spaces';
import {
  CONCEAL_FEATHER,
  CONCEAL_REACH,
  type ConcealSpot,
  concealRegion,
  concealSpot,
} from '../src/core/conceal/conceal';
import { boxBlur } from '../src/core/plate/blur';
import { cutOut } from '../src/core/plate/region';

/**
 * Residual amplitude the test allows, in code values.
 *
 * A reflected face is a few tens of pixels across, and a known one survives at
 * 7x10 of them; a circle placed on the reflection makes that band λ ≈ 0.29r, so
 * clearing λ ≤ r is several times more than identification needs. The bound is
 * what a unit-contrast grating may come back as.
 */
const BAND_LIMIT = 2;

/** An RGBA frame, opaque, painted per channel. */
function frame(
  width: number,
  height: number,
  paint: (x: number, y: number, channel: number) => number,
): Uint8ClampedArray {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      for (let c = 0; c < 3; c++) data[i + c] = Math.round(paint(x, y, c));
      data[i + 3] = 255;
    }
  }
  return data;
}

/**
 * A full-contrast grating, running a different way in each channel.
 *
 * Three orientations rather than one, because a conceal that crossed its
 * channels or blurred along one axis only would pass a single orientation.
 */
function grating(lambda: number) {
  return (x: number, y: number, c: number) => {
    const u = c === 0 ? x + 0.5 : c === 1 ? y + 0.5 : (x + y + 1) / Math.SQRT2;
    return 127.5 + 127.5 * Math.sin((2 * Math.PI * u) / lambda);
  };
}

/** Visit every pixel of an image whose centre is within `radius` of (cx, cy). */
function insideDisc(
  width: number,
  height: number,
  cx: number,
  cy: number,
  radius: number,
  visit: (index: number, x: number, y: number) => void,
): void {
  const from = Math.max(0, Math.floor(cy - radius));
  const to = Math.min(height, Math.ceil(cy + radius));
  const left = Math.max(0, Math.floor(cx - radius));
  const right = Math.min(width, Math.ceil(cx + radius));
  for (let y = from; y < to; y++) {
    for (let x = left; x < right; x++) {
      const dx = x + 0.5 - cx;
      const dy = y + 0.5 - cy;
      if (dx * dx + dy * dy <= radius * radius) visit((y * width + x) * 4, x, y);
    }
  }
}

/** Worst peak-to-peak swing inside the ring, per channel, in code values. */
function residual(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
  spot: ConcealSpot,
  keep: (x: number, y: number) => boolean = () => true,
): number[] {
  const low = [255, 255, 255];
  const high = [0, 0, 0];
  insideDisc(width, height, spot.x * width, spot.y * height, spot.r * width, (i, x, y) => {
    if (!keep(x, y)) return;
    for (let c = 0; c < 3; c++) {
      const v = pixels[i + c] as number;
      if (v < (low[c] as number)) low[c] = v;
      if (v > (high[c] as number)) high[c] = v;
    }
  });
  return [0, 1, 2].map((c) => ((high[c] as number) - (low[c] as number)) / 2);
}

/** Mean light inside the ring, in linear light. */
function linearMean(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
  spot: ConcealSpot,
  channel = 0,
): number {
  let sum = 0;
  let count = 0;
  insideDisc(width, height, spot.x * width, spot.y * height, spot.r * width, (i) => {
    sum += transferToLinear((pixels[i + channel] as number) / 255);
    count++;
  });
  return sum / count;
}

/** The box the stage blurs with, as `conceal.ts` rounds it. */
function boxRadius(radius: number): number {
  return Math.max(1, Math.round(radius * CONCEAL_REACH));
}

/** The stage's mask: one inside the ring, feathered outward to zero. */
function maskOf(width: number, height: number, cx: number, cy: number, radius: number) {
  const outer = radius * (1 + CONCEAL_FEATHER);
  const mask = new Float32Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
      if (d <= radius) mask[y * width + x] = 1;
      else if (d < outer) {
        const t = (outer - d) / (outer - radius);
        mask[y * width + x] = t * t * (3 - 2 * t);
      }
    }
  }
  return mask;
}

/** Conceal one circle with the transfer left out: the mean of the code values. */
function concealInGamma(
  pristine: Uint8ClampedArray,
  imageWidth: number,
  imageHeight: number,
  spot: ConcealSpot,
): Uint8ClampedArray {
  const out = new Uint8ClampedArray(pristine);
  const { region, centre, radius } = concealRegion(spot, imageWidth, imageHeight);
  const patch = cutOut(pristine, imageWidth, region);
  const count = region.width * region.height;
  const box = boxRadius(radius);
  const mask = maskOf(region.width, region.height, centre[0], centre[1], radius);
  const scratch = new Float32Array(count);
  const weight = new Float32Array(mask);
  boxBlur(weight, region.width, region.height, box, scratch);
  const carried = new Float32Array(count);
  for (let c = 0; c < 3; c++) {
    for (let i = 0; i < count; i++) {
      carried[i] = ((patch[i * 4 + c] as number) / 255) * (mask[i] as number);
    }
    boxBlur(carried, region.width, region.height, box, scratch);
    for (let i = 0; i < count; i++) {
      const m = mask[i] as number;
      const w = weight[i] as number;
      if (m <= 0 || w <= 0) continue;
      const v = (patch[i * 4 + c] as number) / 255;
      const mixed = m * ((carried[i] as number) / w) + (1 - m) * v;
      const x = (i % region.width) + region.x;
      const y = Math.floor(i / region.width) + region.y;
      out[(y * imageWidth + x) * 4 + c] = Math.round(Math.min(1, Math.max(0, mixed)) * 255);
    }
  }
  return out;
}

/** Mean light inside the ring after a plain blur: no mask, so no normalisation. */
function plainConvolutionMean(
  pristine: Uint8ClampedArray,
  imageWidth: number,
  imageHeight: number,
  spot: ConcealSpot,
): number {
  const { region, centre, radius } = concealRegion(spot, imageWidth, imageHeight);
  const patch = cutOut(pristine, imageWidth, region);
  const count = region.width * region.height;
  const value = new Float32Array(count);
  for (let i = 0; i < count; i++) value[i] = transferToLinear((patch[i * 4] as number) / 255);
  boxBlur(value, region.width, region.height, boxRadius(radius), new Float32Array(count));
  let sum = 0;
  let n = 0;
  insideDisc(region.width, region.height, centre[0], centre[1], radius, (i) => {
    sum += value[i / 4] as number;
    n++;
  });
  return sum / n;
}

describe('the band a conceal has to take out', () => {
  const WIDTH = 512;
  const HEIGHT = 512;
  const SPOT: ConcealSpot = { x: 0.5, y: 0.5, r: 0.15 };

  it('leaves under two code values of a grating at or under its own radius', () => {
    const radius = SPOT.r * WIDTH;
    for (const ratio of [0.25, 0.35, 0.5, 0.7, 0.85, 1]) {
      const pristine = frame(WIDTH, HEIGHT, grating(radius * ratio));
      const plate = new Uint8ClampedArray(pristine);
      concealSpot(plate, pristine, WIDTH, HEIGHT, SPOT);
      for (const left of residual(plate, WIDTH, HEIGHT, SPOT)) {
        expect.soft(left, `grating of lambda = ${ratio}r`).toBeLessThanOrEqual(BAND_LIMIT);
      }
    }
  });

  it('is measured by something that can see a grating', () => {
    // The same reading taken before the stage runs, because a residual of zero
    // means nothing until the measurement is known to report the full swing of
    // a grating it is given.
    const radius = SPOT.r * WIDTH;
    for (const ratio of [0.25, 0.5, 1]) {
      const pristine = frame(WIDTH, HEIGHT, grating(radius * ratio));
      for (const left of residual(pristine, WIDTH, HEIGHT, SPOT)) {
        expect.soft(left, `unconcealed lambda = ${ratio}r`).toBeGreaterThan(100);
      }
    }
  });

  it('holds at the smallest circle the schema allows', () => {
    // The schema's floor is r = 0.004, and the blur's box is rounded to whole
    // pixels: a width of 750 is the narrowest frame where that box is more than
    // the one pixel it is clamped up to. Below a two-pixel period there is no
    // grating left to sample, so the sweep starts where one can exist.
    const WIDE = 750;
    const TALL = 64;
    const spot: ConcealSpot = { x: 0.5, y: 0.5, r: 0.004 };
    const radius = spot.r * WIDE;
    expect(boxRadius(radius)).toBeGreaterThan(1);
    for (const ratio of [0.7, 0.85, 1]) {
      const lambda = radius * ratio;
      expect(lambda).toBeGreaterThanOrEqual(2);
      const pristine = frame(WIDE, TALL, grating(lambda));
      const plate = new Uint8ClampedArray(pristine);
      concealSpot(plate, pristine, WIDE, TALL, spot);
      for (const left of residual(plate, WIDE, TALL, spot)) {
        expect.soft(left, `smallest circle, lambda = ${ratio}r`).toBeLessThanOrEqual(BAND_LIMIT);
      }
    }
  });
});

describe('where the colour inside the circle comes from', () => {
  const WIDTH = 256;
  const HEIGHT = 256;
  const SPOT: ConcealSpot = { x: 0.5, y: 0.5, r: 0.125 };

  /** A dark iris with a bright point in it, on sclera of the caller's choosing. */
  function eye(sclera: number) {
    const radius = SPOT.r * WIDTH;
    // The iris covers the whole mask, so what is left outside it is exactly the
    // light the normalised convolution claims not to be reading.
    const iris = radius * (1 + CONCEAL_FEATHER) + 1;
    return (x: number, y: number) => {
      const d = Math.hypot(x + 0.5 - WIDTH / 2, y + 0.5 - HEIGHT / 2);
      if (d <= radius * 0.15) return 250;
      return d <= iris ? 36 : sclera;
    };
  }

  it('does not read the light outside the mask, which a plain blur would', () => {
    const means = ([235, 0] as const).map((sclera) => {
      const pristine = frame(WIDTH, HEIGHT, eye(sclera));
      const plate = new Uint8ClampedArray(pristine);
      concealSpot(plate, pristine, WIDTH, HEIGHT, SPOT);
      return {
        normalised: linearMean(plate, WIDTH, HEIGHT, SPOT),
        plain: plainConvolutionMean(pristine, WIDTH, HEIGHT, SPOT),
      };
    });
    const [bright, dark] = means as [(typeof means)[0], (typeof means)[0]];

    const drift = Math.abs(bright.normalised - dark.normalised) / dark.normalised;
    expect(drift).toBeLessThanOrEqual(0.01);

    // What the assertion above is worth: a plain convolution takes about half
    // its kernel mass from outside the circle at the rim, and putting sclera
    // there rather than black moves the mean inside the ring by 393%.
    const plainDrift = Math.abs(bright.plain - dark.plain) / dark.plain;
    expect(plainDrift).toBeGreaterThan(0.5);
  });
});

describe('what the average is taken in', () => {
  const WIDTH = 512;
  const HEIGHT = 512;
  const SPOT: ConcealSpot = { x: 0.5, y: 0.5, r: 0.15 };

  /**
   * Single-pixel stripes at the extreme of contrast, which is what a catchlight
   * is. Vertical and centred on a column boundary, so the ring holds exactly as
   * much black as white and its mean is the pattern's mean rather than a
   * sample of it; the white level is picked so that the blurred mean lands on a
   * code value and 8-bit rounding is not part of the one per cent.
   */
  const stripes = (x: number) => (x % 2 === 0 ? 0 : 253);

  it('holds the linear-light mean that a gamma-space average would sink', () => {
    const pristine = frame(WIDTH, HEIGHT, (x) => stripes(x));
    const plate = new Uint8ClampedArray(pristine);
    concealSpot(plate, pristine, WIDTH, HEIGHT, SPOT);

    const before = linearMean(pristine, WIDTH, HEIGHT, SPOT);
    const after = linearMean(plate, WIDTH, HEIGHT, SPOT);
    expect(Math.abs(after - before) / before).toBeLessThanOrEqual(0.01);

    // What the transfer is worth: averaging the code values instead sinks the
    // ring by 57%, leaving 43% of the light — the mean of gamma-encoded values
    // is not the mean of the light, and the error grows with the contrast.
    const gamma = linearMean(concealInGamma(pristine, WIDTH, HEIGHT, SPOT), WIDTH, HEIGHT, SPOT);
    expect((before - gamma) / before).toBeGreaterThan(0.5);
  });
});

describe('the catchlight a concealed eye loses', () => {
  const WIDTH = 512;
  const HEIGHT = 512;
  const SPOT: ConcealSpot = { x: 0.5, y: 0.5, r: 0.1875 };

  it('is left at the rate the reach predicts', () => {
    const radius = SPOT.r * WIDTH;
    const sigma = radius * CONCEAL_REACH;
    const point = radius / 8;
    const dark = [10, 14, 20];
    const bright = [255, 250, 245];
    // Three levels rather than one grey, so that the three readings round
    // differently and the estimate is not one quantised number repeated.
    let area = 0;
    const pristine = frame(WIDTH, HEIGHT, (x, y, c) => {
      const d = Math.hypot(x + 0.5 - WIDTH / 2, y + 0.5 - HEIGHT / 2);
      if (d > point) return dark[c] as number;
      if (c === 0) area++;
      return bright[c] as number;
    });
    const plate = new Uint8ClampedArray(pristine);
    concealSpot(plate, pristine, WIDTH, HEIGHT, SPOT);

    let measured = 0;
    for (let c = 0; c < 3; c++) {
      let sum = 0;
      let n = 0;
      insideDisc(WIDTH, HEIGHT, WIDTH / 2, HEIGHT / 2, 3, (i) => {
        sum += transferToLinear((plate[i + c] as number) / 255);
        n++;
      });
      const base = transferToLinear((dark[c] as number) / 255);
      const peak = transferToLinear((bright[c] as number) / 255);
      measured += (sum / n - base) / (peak - base) / 3;
    }

    // What a point keeps is its light spread over the window the stage actually
    // averages with, so the prediction is taken from that window rather than
    // assumed: the peak of the blur's own impulse response, divided by the mask
    // weight the normalisation divides by. Both come from the shipped blur.
    const { region, centre, radius: drawnRadius } = concealRegion(SPOT, WIDTH, HEIGHT);
    const count = region.width * region.height;
    const scratch = new Float32Array(count);
    const impulse = new Float32Array(count);
    impulse[Math.round(centre[1]) * region.width + Math.round(centre[0])] = 1;
    boxBlur(impulse, region.width, region.height, boxRadius(drawnRadius), scratch);
    const weight = maskOf(region.width, region.height, centre[0], centre[1], drawnRadius);
    boxBlur(weight, region.width, region.height, boxRadius(drawnRadius), scratch);
    const middle = Math.round(centre[1]) * region.width + Math.round(centre[0]);
    const predicted = (area * (impulse[middle] as number)) / (weight[middle] as number);
    expect(measured / predicted).toBeGreaterThan(0.9);
    expect(measured / predicted).toBeLessThan(1.1);

    // The free-space form the cost is quoted from, a²/2σ², holds only while the
    // reach is inside the mask. Past that the mask is the window, the residual
    // stops falling with σ, and the two part company — which is the reason the
    // prediction above is taken from the window and not from σ.
    const drawn = Math.sqrt(area / Math.PI);
    const free = (drawn * drawn) / (2 * sigma * sigma);
    expect(measured).toBeGreaterThan(free);
    expect(measured).toBeLessThan(0.02);
  });
});

describe('a circle at the edge of the frame', () => {
  const WIDTH = 400;
  const HEIGHT = 400;
  const SPOT: ConcealSpot = { x: 0.1, y: 0.1, r: 0.1 };

  it('keeps its region inside the frame and writes nothing beyond it', () => {
    for (const spot of [SPOT, { x: 0, y: 0, r: 0.1 }, { x: 1, y: 1, r: 0.2 }]) {
      const { region } = concealRegion(spot, WIDTH, HEIGHT);
      expect(region.x).toBeGreaterThanOrEqual(0);
      expect(region.y).toBeGreaterThanOrEqual(0);
      expect(region.x + region.width).toBeLessThanOrEqual(WIDTH);
      expect(region.y + region.height).toBeLessThanOrEqual(HEIGHT);

      const pristine = frame(WIDTH, HEIGHT, grating(spot.r * WIDTH));
      const plate = new Uint8ClampedArray(pristine);
      const written = concealSpot(plate, pristine, WIDTH, HEIGHT, spot);
      for (let y = 0; y < HEIGHT; y++) {
        for (let x = 0; x < WIDTH; x++) {
          const i = (y * WIDTH + x) * 4;
          expect(plate[i + 3]).toBe(255);
          const inside =
            x >= written.x &&
            x < written.x + written.width &&
            y >= written.y &&
            y < written.y + written.height;
          if (!inside) expect(plate[i]).toBe(pristine[i]);
        }
      }
    }
  });

  it('holds the band for the pixels the frame actually has', () => {
    // A circle at the corner loses half its reach: the blur repeats the border
    // rather than inventing anything beyond it, so what is averaged there is
    // one-sided. The guarantee is over the pixels the frame has, which is every
    // pixel of the circle that is in it, and both placements are measured — one
    // touching the corner and one centred on it.
    for (const spot of [SPOT, { x: 0, y: 0, r: 0.1 }]) {
      const radius = spot.r * WIDTH;
      for (const ratio of [0.5, 0.7, 1]) {
        const pristine = frame(WIDTH, HEIGHT, grating(radius * ratio));
        const plate = new Uint8ClampedArray(pristine);
        concealSpot(plate, pristine, WIDTH, HEIGHT, spot);
        for (const left of residual(plate, WIDTH, HEIGHT, spot)) {
          const where = `corner circle at ${spot.x}, lambda = ${ratio}r`;
          expect.soft(left, where).toBeLessThanOrEqual(BAND_LIMIT);
        }
      }
    }
  });
});

describe('a circle that has been concealed', () => {
  it('reads the pristine source rather than the plate', () => {
    const WIDTH = 256;
    const HEIGHT = 256;
    const SPOT: ConcealSpot = { x: 0.5, y: 0.5, r: 0.1 };
    const pristine = frame(WIDTH, HEIGHT, grating(SPOT.r * WIDTH * 0.5));

    const once = new Uint8ClampedArray(pristine);
    concealSpot(once, pristine, WIDTH, HEIGHT, SPOT);

    // Applied again over its own result, which is what a rebuilt plate does, and
    // over a plate somebody else has already written on. Neither can change the
    // answer, because the circle never reads what is under it.
    const twice = new Uint8ClampedArray(once);
    concealSpot(twice, pristine, WIDTH, HEIGHT, SPOT);
    expect(twice).toEqual(once);

    const dirty = new Uint8ClampedArray(pristine.length).fill(200);
    concealSpot(dirty, pristine, WIDTH, HEIGHT, SPOT);
    insideDisc(WIDTH, HEIGHT, SPOT.x * WIDTH, SPOT.y * HEIGHT, SPOT.r * WIDTH, (i) => {
      expect(dirty[i]).toBe(once[i]);
    });
  });
});
