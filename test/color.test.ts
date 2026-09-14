import { describe, expect, it } from 'vitest';
import { BAND_HUES, BAND_WIDTHS } from '../src/core/color/bands';
import { mat3Apply, mat3Inverse, mat3Mul, mat3ToGlsl } from '../src/core/color/matrix';
import {
  linearP3ToOklab,
  oklabToLinearP3,
  SKIN_HUE_CENTER,
  skinHueWeight,
} from '../src/core/color/oklab';
import {
  DISPLAY_P3_TO_SRGB,
  SRGB_TO_DISPLAY_P3,
  transferFromLinear,
  transferToLinear,
} from '../src/core/color/spaces';
import { HUE_BANDS } from '../src/core/recipe/schema';

const close = (a: number, b: number, tolerance = 1e-6) => Math.abs(a - b) < tolerance;

describe('matrices', () => {
  it('inverts', () => {
    const product = mat3Mul(DISPLAY_P3_TO_SRGB, SRGB_TO_DISPLAY_P3);
    const identity = [1, 0, 0, 0, 1, 0, 0, 0, 1];
    for (let i = 0; i < 9; i++) {
      expect(close(product[i] as number, identity[i] as number, 1e-9)).toBe(true);
    }
  });

  it('rejects a singular matrix rather than emitting infinities', () => {
    expect(() => mat3Inverse([1, 2, 3, 2, 4, 6, 7, 8, 9])).toThrow(/singular/);
  });

  it('emits GLSL in column-major order', () => {
    // GLSL takes columns first, so a matrix that was transposed on the way into
    // a shader would apply a different transform than the one tested here.
    const glsl = mat3ToGlsl([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(glsl.startsWith('mat3(1.000000000, 4.000000000, 7.000000000')).toBe(true);
  });
});

describe('primaries', () => {
  it('leaves white where it is', () => {
    const [r, g, b] = mat3Apply(DISPLAY_P3_TO_SRGB, [1, 1, 1]);
    expect(close(r, 1, 1e-6)).toBe(true);
    expect(close(g, 1, 1e-6)).toBe(true);
    expect(close(b, 1, 1e-6)).toBe(true);
  });

  it('puts saturated P3 green outside the sRGB gamut', () => {
    // This is the whole reason for holding the working space in P3: converting
    // early would clamp these colours away before anything could use them.
    const [r] = mat3Apply(DISPLAY_P3_TO_SRGB, [0, 1, 0]);
    expect(r).toBeLessThan(0);
  });
});

describe('transfer function', () => {
  it('round-trips across the whole range, including the linear toe', () => {
    for (const v of [0, 0.001, 0.0031308, 0.04045, 0.18, 0.5, 1]) {
      expect(close(transferToLinear(transferFromLinear(v)), v, 1e-9)).toBe(true);
    }
  });

  it('keeps the sign, so out-of-gamut negatives survive a round-trip', () => {
    expect(transferFromLinear(-0.5)).toBeLessThan(0);
    expect(close(transferToLinear(transferFromLinear(-0.5)), -0.5, 1e-9)).toBe(true);
  });
});

describe('Oklab', () => {
  it('round-trips linear Display-P3', () => {
    for (const rgb of [
      [0.18, 0.18, 0.18],
      [0.9, 0.4, 0.3],
      [0.02, 0.3, 0.7],
      [1, 1, 1],
    ] as const) {
      const back = oklabToLinearP3(linearP3ToOklab(rgb));
      for (let i = 0; i < 3; i++) {
        expect(close(back[i] as number, rgb[i] as number, 1e-6)).toBe(true);
      }
    }
  });

  it('gives grey no chroma', () => {
    const [, a, b] = linearP3ToOklab([0.4, 0.4, 0.4]);
    expect(close(a, 0, 1e-6)).toBe(true);
    expect(close(b, 0, 1e-6)).toBe(true);
  });

  it('weights skin hues above others', () => {
    const skin = linearP3ToOklab([0.42, 0.26, 0.19]);
    const sky = linearP3ToOklab([0.12, 0.24, 0.6]);
    const skinWeight = skinHueWeight(Math.atan2(skin[2], skin[1]));
    const skyWeight = skinHueWeight(Math.atan2(sky[2], sky[1]));
    expect(skinWeight).toBeGreaterThan(0.5);
    expect(skyWeight).toBe(0);
  });

  it('wraps the hue band across the discontinuity at pi', () => {
    expect(skinHueWeight(Math.PI * 2 + 0.68)).toBeCloseTo(skinHueWeight(0.68), 10);
  });
});

describe('hue bands', () => {
  it('names one band per declared colour', () => {
    expect(BAND_HUES).toHaveLength(HUE_BANDS.length);
    expect(BAND_WIDTHS).toHaveLength(HUE_BANDS.length);
  });

  it('places them in the order the colours actually run', () => {
    // Derived from the primaries rather than typed in, so the check that matters
    // is that the derivation puts them round the wheel in order: red, orange,
    // yellow, green, cyan, blue, purple, magenta.
    for (let i = 1; i < BAND_HUES.length; i++) {
      expect((BAND_HUES[i] as number) > (BAND_HUES[i - 1] as number), HUE_BANDS[i]).toBe(true);
    }
    for (const hue of BAND_HUES) {
      expect(hue).toBeGreaterThanOrEqual(0);
      expect(hue).toBeLessThan(2 * Math.PI);
    }
  });

  it('leaves no hue outside every band', () => {
    // Each band has to reach both its neighbours, or there is a wedge of colour
    // the per-hue sliders quietly do nothing to.
    const count = BAND_HUES.length;
    for (let i = 0; i < count; i++) {
      const hue = BAND_HUES[i] as number;
      const next = BAND_HUES[(i + 1) % count] as number;
      const gap = Math.min(
        Math.abs(next - hue) % (2 * Math.PI),
        2 * Math.PI - (Math.abs(next - hue) % (2 * Math.PI)),
      );
      const reach = Math.max(BAND_WIDTHS[i] as number, BAND_WIDTHS[(i + 1) % count] as number);
      expect(reach, `${HUE_BANDS[i]}`).toBeGreaterThanOrEqual(gap - 1e-9);
    }
  });

  it('puts the skin band between red and yellow, where faces are', () => {
    const red = BAND_HUES[0] as number;
    const yellow = BAND_HUES[2] as number;
    expect(SKIN_HUE_CENTER).toBeGreaterThan(red);
    expect(SKIN_HUE_CENTER).toBeLessThan(yellow);
  });
});
