/**
 * The conceal stage, asserted by what is left of a reflection rather than by
 * stored bytes.
 *
 * The stage is a blur whose strength the user sets, so what is asserted is what
 * a given strength does to detail of a given size, measured in code values
 * inside the ring. Both ends of the slider are pinned, because both are claims
 * the panel makes: at the default the reflection's own detail is gone while the
 * circle still looks like what it was drawn over, and at the top what comes back
 * is close to one flat tone.
 *
 * Everything else here defends one claim each, and each is measured against what
 * the alternative would have done — a plain convolution for the light outside
 * the mask, a gamma-space average for the mean — since a number on its own says
 * nothing about why the arithmetic is shaped the way it is. The counterfactuals
 * are built from the same shared box blur rather than a second blur written for
 * the test, so what they differ in is the one step being argued about.
 */

import { describe, expect, it } from 'vitest';
import { transferFromLinear, transferToLinear } from '../src/core/color/spaces';
import {
  CONCEAL_FEATHER,
  type ConcealSpot,
  concealDecimation,
  concealRegion,
  concealSpot,
} from '../src/core/conceal/conceal';
import { boxBlur } from '../src/core/plate/blur';
import { cutOut } from '../src/core/plate/region';
import { paramDef } from '../src/core/recipe/schema';

/**
 * Residual amplitude a grating is called gone at, in code values.
 *
 * Two of them is under what an eye resolves on a photograph, and a unit-contrast
 * grating is the worst case a real reflection is bounded by.
 */
const GONE = 2;

/** The two ends of the slider, read from the schema rather than repeated here. */
const DEFAULT_AMOUNT = paramDef('conceal.amount').neutral;
const FULL_AMOUNT = paramDef('conceal.amount').max;

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

/**
 * Worst peak-to-peak swing over the part of the circle the mask fully covers.
 *
 * Not the whole circle: the outer band is where the mask feathers back to the
 * photograph, so a grating there survives on purpose and reading it would be
 * measuring the join rather than the blur.
 */
function residual(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
  spot: ConcealSpot,
  keep: (x: number, y: number) => boolean = () => true,
): number[] {
  const low = [255, 255, 255];
  const high = [0, 0, 0];
  const covered = spot.r * width * (1 - CONCEAL_FEATHER);
  insideDisc(width, height, spot.x * width, spot.y * height, covered, (i, x, y) => {
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
function boxRadius(radius: number, amount: number): number {
  return Math.max(1, Math.round(radius * amount));
}

/** The stage's mask: one inside, feathered in to zero at the ring. */
function maskOf(width: number, height: number, cx: number, cy: number, radius: number) {
  const inner = radius * (1 - CONCEAL_FEATHER);
  const mask = new Float32Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
      if (d <= inner) mask[y * width + x] = 1;
      else if (d < radius) {
        const t = (radius - d) / (radius - inner);
        mask[y * width + x] = t * t * (3 - 2 * t);
      }
    }
  }
  return mask;
}

/** Left in place of a transfer, for the counterfactual that does without one. */
const identity = (value: number) => value;

/**
 * Blur one circle with every average taken per pixel.
 *
 * Two claims read this. It is the arithmetic the shipped path decimates, so it
 * is the answer that path is approximating; and with the transfer replaced by
 * {@link identity} it is the gamma-space counterfactual, which then differs from
 * the reference in the one step being argued about and in nothing else.
 *
 * `weigh` is the third: given the mask it makes the average a normalised
 * convolution over the light inside the ring, which is the shape this stage was
 * built with and the one the plate of iris colour came from.
 */
function concealPerPixel(
  pristine: Uint8ClampedArray,
  imageWidth: number,
  imageHeight: number,
  spot: ConcealSpot,
  amount: number,
  toLinear: (code: number) => number = transferToLinear,
  fromLinear: (light: number) => number = transferFromLinear,
  weigh = false,
): Uint8ClampedArray {
  const out = new Uint8ClampedArray(pristine);
  const { region, centre, radius } = concealRegion(spot, imageWidth, imageHeight, amount);
  const patch = cutOut(pristine, imageWidth, region);
  const count = region.width * region.height;
  const box = boxRadius(radius, amount);
  const mask = maskOf(region.width, region.height, centre[0], centre[1], radius);
  const scratch = new Float32Array(count);
  const weight = new Float32Array(mask);
  if (weigh) boxBlur(weight, region.width, region.height, box, scratch);
  const carried = new Float32Array(count);
  for (let c = 0; c < 3; c++) {
    for (let i = 0; i < count; i++) {
      const v = toLinear((patch[i * 4 + c] as number) / 255);
      carried[i] = weigh ? v * (mask[i] as number) : v;
    }
    boxBlur(carried, region.width, region.height, box, scratch);
    for (let i = 0; i < count; i++) {
      const m = mask[i] as number;
      if (m <= 0) continue;
      const blurred = weigh
        ? (carried[i] as number) / (weight[i] as number)
        : (carried[i] as number);
      if (!Number.isFinite(blurred)) continue;
      const v = toLinear((patch[i * 4 + c] as number) / 255);
      const mixed = m * blurred + (1 - m) * v;
      const x = (i % region.width) + region.x;
      const y = Math.floor(i / region.width) + region.y;
      out[(y * imageWidth + x) * 4 + c] = Math.round(
        Math.min(1, Math.max(0, fromLinear(mixed))) * 255,
      );
    }
  }
  return out;
}

/** Worst difference between two frames inside the ring, per channel. */
function widestGap(
  a: Uint8ClampedArray,
  b: Uint8ClampedArray,
  width: number,
  height: number,
  spot: ConcealSpot,
): number {
  let worst = 0;
  insideDisc(width, height, spot.x * width, spot.y * height, spot.r * width, (i) => {
    for (let c = 0; c < 3; c++) {
      worst = Math.max(worst, Math.abs((a[i + c] as number) - (b[i + c] as number)));
    }
  });
  return worst;
}

describe('what a circle takes out at each end of the slider', () => {
  const WIDTH = 512;
  const HEIGHT = 512;
  const SPOT: ConcealSpot = { x: 0.5, y: 0.5, r: 0.15 };

  /** Worst residual over the three orientations, for a grating of `ratio·r`. */
  function left(ratio: number, amount: number, spot = SPOT, w = WIDTH, h = HEIGHT): number {
    const pristine = frame(w, h, grating(spot.r * w * ratio));
    const plate = new Uint8ClampedArray(pristine);
    concealSpot(plate, pristine, w, h, spot, amount);
    return Math.max(...residual(plate, w, h, spot));
  }

  it('is measured by something that can see a grating', () => {
    // A residual of zero means nothing until the measurement is known to report
    // the full swing of a grating it is given.
    for (const ratio of [0.25, 0.5, 1]) {
      const pristine = frame(WIDTH, HEIGHT, grating(SPOT.r * WIDTH * ratio));
      for (const seen of residual(pristine, WIDTH, HEIGHT, SPOT)) {
        expect.soft(seen, `unblurred lambda = ${ratio}r`).toBeGreaterThan(100);
      }
    }
  });

  it('clears the reflection at the default without flattening the circle', () => {
    // Both halves are the product claim, and the second is the one worth
    // guarding: an amount wide enough to reach across the circle leaves a flat
    // disc, which on an eye reads as a hole rather than as a blurred eye. The
    // detail of a reflected face is a fraction of the circle drawn over it, so
    // taking it out and keeping the circle's own shape is not a contradiction.
    for (const ratio of [0.05, 0.1, 0.2]) {
      expect.soft(left(ratio, DEFAULT_AMOUNT), `lambda = ${ratio}r`).toBeLessThanOrEqual(GONE);
    }
    // Half of a unit-contrast grating at the circle's own scale still standing:
    // a pupil against an iris survives a default-strength circle over it.
    expect(left(1, DEFAULT_AMOUNT)).toBeGreaterThan(60);
  });

  it('comes back close to one tone at the top', () => {
    for (const ratio of [0.2, 0.35, 0.5]) {
      expect.soft(left(ratio, FULL_AMOUNT), `lambda = ${ratio}r`).toBeLessThanOrEqual(GONE);
    }
    // And what is left at the circle's own scale, where the average's window is
    // wider than the mask and the normalisation weights the mask almost evenly.
    expect(left(1, FULL_AMOUNT)).toBeLessThan(4);
  });

  it('takes out more the further the slider goes, at every scale', () => {
    // The two ends above are the claims; this is what makes the control between
    // them a control. A blur whose reach did not follow the amount would pass
    // either end alone.
    for (const ratio of [0.35, 0.5, 0.7, 1]) {
      const sweep = [0.05, 0.1, 0.25, 0.5, 1].map((amount) => left(ratio, amount));
      for (let i = 1; i < sweep.length; i++) {
        const step = `lambda = ${ratio}r, step ${i}`;
        // Half a code value of slack: once a reading is at zero the next one
        // rounds either side of it, which is quantisation rather than a rise.
        expect.soft(sweep[i] as number, step).toBeLessThanOrEqual((sweep[i - 1] as number) + 0.5);
      }
    }
  });

  it('holds at the smallest circle the schema allows', () => {
    // The schema's floor is r = 0.004. The frame is wide enough that detail
    // under that radius still has a period of two pixels to be sampled at, and
    // the blur's box comes out well above the one pixel it is clamped up to.
    const WIDE = 2000;
    const TALL = 64;
    const spot: ConcealSpot = { x: 0.5, y: 0.5, r: 0.004 };
    const radius = spot.r * WIDE;
    expect(boxRadius(radius, FULL_AMOUNT)).toBeGreaterThan(1);
    for (const ratio of [0.25, 0.35, 0.5]) {
      expect(radius * ratio).toBeGreaterThanOrEqual(2);
      const where = `smallest circle, lambda = ${ratio}r`;
      expect.soft(left(ratio, FULL_AMOUNT, spot, WIDE, TALL), where).toBeLessThanOrEqual(GONE);
    }
  });

  it('leaves nothing at the period the decimated average samples at', () => {
    // The average is built one sample per `step` pixels and read back between
    // those samples, so anything the grid folded down, or any seam left where
    // the reconstruction crosses from one sample to the next, would come back at
    // that period or a multiple of it. The sweep is over the lattice rather than
    // over fractions of the radius because it is the lattice being asked about,
    // and it runs at the top of the amount, which is where the grid is thinnest.
    const radius = SPOT.r * WIDTH;
    const step = concealDecimation(radius, FULL_AMOUNT);
    expect(step).toBeGreaterThan(1);
    for (const multiple of [1, 1.5, 2, 3, 4, 6]) {
      const lambda = step * multiple;
      expect(lambda).toBeLessThanOrEqual(radius / 2);
      const pristine = frame(WIDTH, HEIGHT, grating(lambda));
      const plate = new Uint8ClampedArray(pristine);
      concealSpot(plate, pristine, WIDTH, HEIGHT, SPOT, FULL_AMOUNT);
      for (const seen of residual(plate, WIDTH, HEIGHT, SPOT)) {
        expect.soft(seen, `lambda = ${multiple} steps`).toBeLessThanOrEqual(GONE);
      }
    }
  });
});

describe('the average the decimated grid stands in for', () => {
  const WIDTH = 512;
  const HEIGHT = 512;

  /**
   * Difference the decimation is allowed against the same average taken per
   * pixel, in code values. What it bounds is the approximation rather than the
   * concealing, and it is what decides how far the grid may be thinned: the
   * reconstruction's error falls as the square of the samples left across the
   * blur's own radius, so this is the number the reach the grid is thinned to
   * answers to.
   */
  const GRID_LIMIT = 2;

  /**
   * The same bound for a circle the frame cuts off, which is looser and not by
   * approximation: where the region meets the edge of the photograph the blur
   * repeats its border, and the decimated pass repeats a cell's mean there while
   * the per-pixel pass repeats a pixel. Nothing on the far side exists for
   * either of them to agree about.
   */
  const CLIPPED_LIMIT = 3;

  /** A cliff in each channel, in three directions, at the extreme of contrast. */
  const cliff = (x: number, y: number, c: number) => {
    const u = c === 0 ? x : c === 1 ? y : x + y;
    return u > (c === 2 ? 320 : 200) ? 250 : 8;
  };

  /** A catchlight: the whole range inside an eighth of the circle. */
  const point = (x: number, y: number, c: number) => {
    const d = Math.hypot(x + 0.5 - WIDTH / 2, y + 0.5 - HEIGHT / 2);
    return d < 12 ? ([255, 250, 245][c] as number) : ([10, 14, 20][c] as number);
  };

  it('lands within two code values of the same average taken per pixel', () => {
    // A cliff and a point rather than a grating: what a decimated average risks
    // is what happens between its samples, and the field a grating leaves inside
    // the ring is flat enough to agree for the wrong reason. Across a cliff the
    // blurred field runs its whole range over about one reach, and a point is
    // the one input whose every sample of the grid but one is empty.
    for (const paint of [cliff, point]) {
      for (const spot of [
        { x: 0.5, y: 0.5, r: 0.15 },
        { x: 0.5, y: 0.5, r: 0.2 },
        // Cut off by the left edge of the frame, which is the one case the
        // two paths cannot be asked to agree to the code value.
        { x: 0.12, y: 0.5, r: 0.15 },
      ]) {
        expect(concealDecimation(spot.r * WIDTH, FULL_AMOUNT)).toBeGreaterThan(1);
        const pristine = frame(WIDTH, HEIGHT, paint);
        const plate = new Uint8ClampedArray(pristine);
        concealSpot(plate, pristine, WIDTH, HEIGHT, spot, FULL_AMOUNT);
        const perPixel = concealPerPixel(pristine, WIDTH, HEIGHT, spot, FULL_AMOUNT);
        const gap = widestGap(plate, perPixel, WIDTH, HEIGHT, spot);
        const bound = spot.x * WIDTH < spot.r * WIDTH ? CLIPPED_LIMIT : GRID_LIMIT;
        expect.soft(gap, `r = ${spot.r} at ${spot.x}`).toBeLessThanOrEqual(bound);
      }
    }
  });
});

describe('the edge of the circle, where a plate of colour would show', () => {
  const WIDTH = 256;
  const HEIGHT = 256;
  const SPOT: ConcealSpot = { x: 0.5, y: 0.5, r: 0.125 };
  const IRIS = 36;
  const SCLERA = 235;

  /** A dark iris filling the circle exactly, on bright sclera. */
  function eye(): Uint8ClampedArray {
    const radius = SPOT.r * WIDTH;
    return frame(WIDTH, HEIGHT, (x, y) => {
      const d = Math.hypot(x + 0.5 - WIDTH / 2, y + 0.5 - HEIGHT / 2);
      return d <= radius ? IRIS : SCLERA;
    });
  }

  /** Mean over the ring between two fractions of the radius. */
  function band(pixels: Uint8ClampedArray, from: number, to: number): number {
    const cx = SPOT.x * WIDTH;
    const cy = SPOT.y * HEIGHT;
    const radius = SPOT.r * WIDTH;
    let sum = 0;
    let n = 0;
    insideDisc(WIDTH, HEIGHT, cx, cy, radius * to, (i, x, y) => {
      if (Math.hypot(x + 0.5 - cx, y + 0.5 - cy) < radius * from) return;
      sum += pixels[i] as number;
      n++;
    });
    return sum / n;
  }

  it('blends into what is around it rather than holding its own colour', () => {
    // The blur reads the photograph and only the compositing is masked, so at
    // the rim the average is over iris and sclera alike and lands between them.
    // That is what makes the join invisible without a wide feather.
    const pristine = eye();
    const plate = new Uint8ClampedArray(pristine);
    concealSpot(plate, pristine, WIDTH, HEIGHT, SPOT, 0.3);
    const rim = band(plate, 0.65, 0.85);
    expect(rim).toBeGreaterThan(IRIS + 20);
    expect(rim).toBeLessThan(SCLERA);

    // What that is worth: holding the average to the light inside the mask
    // leaves the rim within a few code values of the iris it started as, so the
    // disc keeps its own colour to the very edge and reads as something laid on
    // top of the eye. That is the shape this stage used to have.
    const held = concealPerPixel(
      pristine,
      WIDTH,
      HEIGHT,
      SPOT,
      0.3,
      transferToLinear,
      transferFromLinear,
      true,
    );
    expect(band(held, 0.65, 0.85)).toBeLessThan(IRIS + 6);
  });

  it('changes nothing outside the ring, at any amount', () => {
    // The other half of the same failure: a mask that feathered outward pushed
    // iris colour over the sclera, and the eye grew a halo the wider the reach
    // went. Nothing beyond the drawn circle may move, however far the slider is.
    const pristine = eye();
    const radius = SPOT.r * WIDTH;
    for (const amount of [DEFAULT_AMOUNT, 0.5, FULL_AMOUNT]) {
      const plate = new Uint8ClampedArray(pristine);
      concealSpot(plate, pristine, WIDTH, HEIGHT, SPOT, amount);
      for (let y = 0; y < HEIGHT; y++) {
        for (let x = 0; x < WIDTH; x++) {
          if (Math.hypot(x + 0.5 - WIDTH / 2, y + 0.5 - HEIGHT / 2) < radius) continue;
          const i = (y * WIDTH + x) * 4;
          expect.soft(plate[i], `outside the ring at ${amount}`).toBe(pristine[i]);
        }
      }
    }
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
    concealSpot(plate, pristine, WIDTH, HEIGHT, SPOT, FULL_AMOUNT);

    const before = linearMean(pristine, WIDTH, HEIGHT, SPOT);
    const after = linearMean(plate, WIDTH, HEIGHT, SPOT);
    expect(Math.abs(after - before) / before).toBeLessThanOrEqual(0.01);

    // What the transfer is worth: averaging the code values instead sinks the
    // ring by 57%, leaving 43% of the light — the mean of gamma-encoded values
    // is not the mean of the light, and the error grows with the contrast.
    const gamma = linearMean(
      concealPerPixel(pristine, WIDTH, HEIGHT, SPOT, FULL_AMOUNT, identity, identity),
      WIDTH,
      HEIGHT,
      SPOT,
    );
    expect((before - gamma) / before).toBeGreaterThan(0.5);
  });
});

describe('the catchlight a circle at the top of the slider loses', () => {
  const WIDTH = 512;
  const HEIGHT = 512;
  const SPOT: ConcealSpot = { x: 0.5, y: 0.5, r: 0.1875 };

  it('is left at the rate the reach predicts', () => {
    const radius = SPOT.r * WIDTH;
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
    concealSpot(plate, pristine, WIDTH, HEIGHT, SPOT, FULL_AMOUNT);

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
    // assumed: the peak of the blur's own impulse response, times the area the
    // point covers. It comes from the shipped blur.
    const { region, centre, radius: drawnRadius } = concealRegion(SPOT, WIDTH, HEIGHT, FULL_AMOUNT);
    const count = region.width * region.height;
    const scratch = new Float32Array(count);
    const impulse = new Float32Array(count);
    impulse[Math.round(centre[1]) * region.width + Math.round(centre[0])] = 1;
    boxBlur(impulse, region.width, region.height, boxRadius(drawnRadius, FULL_AMOUNT), scratch);
    const middle = Math.round(centre[1]) * region.width + Math.round(centre[0]);
    const predicted = area * (impulse[middle] as number);
    expect(measured / predicted).toBeGreaterThan(0.9);
    expect(measured / predicted).toBeLessThan(1.1);

    // And what that comes to: a catchlight an eighth of the circle across is
    // left at under a twentieth of its own peak once the slider is at the top.
    expect(measured).toBeLessThan(0.05);
  });
});

describe('a circle at the edge of the frame', () => {
  const WIDTH = 400;
  const HEIGHT = 400;
  const SPOT: ConcealSpot = { x: 0.1, y: 0.1, r: 0.1 };

  it('keeps its region inside the frame and writes nothing beyond it', () => {
    for (const spot of [SPOT, { x: 0, y: 0, r: 0.1 }, { x: 1, y: 1, r: 0.2 }]) {
      const { region } = concealRegion(spot, WIDTH, HEIGHT, FULL_AMOUNT);
      expect(region.x).toBeGreaterThanOrEqual(0);
      expect(region.y).toBeGreaterThanOrEqual(0);
      expect(region.x + region.width).toBeLessThanOrEqual(WIDTH);
      expect(region.y + region.height).toBeLessThanOrEqual(HEIGHT);

      const pristine = frame(WIDTH, HEIGHT, grating(spot.r * WIDTH));
      const plate = new Uint8ClampedArray(pristine);
      const written = concealSpot(plate, pristine, WIDTH, HEIGHT, spot, FULL_AMOUNT);
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

  it('still blurs the pixels the frame actually has', () => {
    // A circle at the corner loses half its reach: the blur repeats the border
    // rather than inventing anything beyond it, so what is averaged there is
    // one-sided, and less is taken out at the circle's own scale than in the
    // middle of a frame. What has to hold either way is the detail a reflection
    // carries, well under the radius. Both placements are measured — one
    // touching the corner and one centred on it.
    for (const spot of [SPOT, { x: 0, y: 0, r: 0.1 }]) {
      const radius = spot.r * WIDTH;
      for (const ratio of [0.2, 0.35, 0.5]) {
        const pristine = frame(WIDTH, HEIGHT, grating(radius * ratio));
        const plate = new Uint8ClampedArray(pristine);
        concealSpot(plate, pristine, WIDTH, HEIGHT, spot, FULL_AMOUNT);
        for (const seen of residual(plate, WIDTH, HEIGHT, spot)) {
          const where = `corner circle at ${spot.x}, lambda = ${ratio}r`;
          expect.soft(seen, where).toBeLessThanOrEqual(GONE);
        }
      }
    }
  });
});

describe('the part of the plate a circle writes', () => {
  const WIDTH = 256;
  const HEIGHT = 256;
  const SPOT: ConcealSpot = { x: 0.5, y: 0.5, r: 0.1 };

  /** A plate whose every colour byte differs from the source it was made from. */
  function dirtied(pristine: Uint8ClampedArray): Uint8ClampedArray {
    const out = new Uint8ClampedArray(pristine);
    for (let i = 0; i < out.length; i += 4) {
      for (let c = 0; c < 3; c++) out[i + c] = ((out[i + c] as number) + 128) % 256;
    }
    return out;
  }

  it('writes no pixel the mask does not reach', () => {
    // The region is as wide as three box passes reach, which at the shipped
    // reach is some twenty times the mask's own area. Everything in it that the
    // mask does not touch is somebody else's work — the fills the stage under
    // this one left — and writing the source back over it would take them out.
    const pristine = frame(WIDTH, HEIGHT, grating(SPOT.r * WIDTH * 0.5));
    const plate = dirtied(pristine);
    const before = plate.slice();
    const written = concealSpot(plate, pristine, WIDTH, HEIGHT, SPOT, FULL_AMOUNT);

    const cx = SPOT.x * WIDTH;
    const cy = SPOT.y * HEIGHT;
    const radius = SPOT.r * WIDTH;
    const outer = radius * (1 + CONCEAL_FEATHER);
    let changed = 0;
    for (let y = 0; y < HEIGHT; y++) {
      for (let x = 0; x < WIDTH; x++) {
        const i = (y * WIDTH + x) * 4;
        const touched = [0, 1, 2, 3].some((c) => plate[i + c] !== before[i + c]);
        if (!touched) continue;
        changed++;
        expect
          .soft(Math.hypot(x + 0.5 - cx, y + 0.5 - cy), `written at ${x}, ${y}`)
          .toBeLessThan(outer);
        // And the rectangle the caller re-uploads holds every one of them.
        expect.soft(x, `column ${x} against the rectangle`).toBeGreaterThanOrEqual(written.x);
        expect.soft(x, `column ${x} against the rectangle`).toBeLessThan(written.x + written.width);
        expect.soft(y, `row ${y} against the rectangle`).toBeGreaterThanOrEqual(written.y);
        expect.soft(y, `row ${y} against the rectangle`).toBeLessThan(written.y + written.height);
      }
    }
    // The circle did its work: a measurement that wrote nothing would pass every
    // assertion above.
    expect(changed).toBeGreaterThan(Math.PI * radius * radius * 0.5);
  });

  it('reports the mask around the circle rather than the region the blur needed', () => {
    const pristine = frame(WIDTH, HEIGHT, grating(SPOT.r * WIDTH * 0.5));
    const written = concealSpot(dirtied(pristine), pristine, WIDTH, HEIGHT, SPOT, FULL_AMOUNT);
    const { region } = concealRegion(SPOT, WIDTH, HEIGHT, FULL_AMOUNT);

    // The region has to hold what the blur reads; the rectangle only has to hold
    // what was laid down, and uploading the difference is uploading bytes that
    // did not change.
    expect(written.width * written.height).toBeLessThan((region.width * region.height) / 4);
    expect(written.x).toBeGreaterThanOrEqual(region.x);
    expect(written.y).toBeGreaterThanOrEqual(region.y);
    expect(written.x + written.width).toBeLessThanOrEqual(region.x + region.width);
    expect(written.y + written.height).toBeLessThanOrEqual(region.y + region.height);
  });
});

describe('a circle that has been concealed', () => {
  it('reads the pristine source rather than the plate', () => {
    const WIDTH = 256;
    const HEIGHT = 256;
    const SPOT: ConcealSpot = { x: 0.5, y: 0.5, r: 0.1 };
    const pristine = frame(WIDTH, HEIGHT, grating(SPOT.r * WIDTH * 0.5));

    const once = new Uint8ClampedArray(pristine);
    concealSpot(once, pristine, WIDTH, HEIGHT, SPOT, DEFAULT_AMOUNT);

    // Applied again over its own result, which is what a rebuilt plate does, and
    // over a plate somebody else has already written on. Neither can change the
    // answer, because the circle never reads what is under it.
    const twice = new Uint8ClampedArray(once);
    concealSpot(twice, pristine, WIDTH, HEIGHT, SPOT, DEFAULT_AMOUNT);
    expect(twice).toEqual(once);

    const dirty = new Uint8ClampedArray(pristine.length).fill(200);
    concealSpot(dirty, pristine, WIDTH, HEIGHT, SPOT, DEFAULT_AMOUNT);
    insideDisc(WIDTH, HEIGHT, SPOT.x * WIDTH, SPOT.y * HEIGHT, SPOT.r * WIDTH, (i) => {
      expect(dirty[i]).toBe(once[i]);
    });
  });
});
