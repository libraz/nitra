import { describe, expect, it } from 'vitest';
import { applyStrength, LOOKS, lookByKey, REFERENCE_STRENGTH } from '../src/core/recipe/presets';
import { type GlobalParams, neutralRecipe, recipeSchema } from '../src/core/recipe/schema';

describe('the finishes', () => {
  it('names each one once', () => {
    const keys = LOOKS.map((look) => look.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('produces a recipe the schema accepts', () => {
    // A finish is written by hand, so a value outside its parameter's range
    // would otherwise be found by a shader rather than by anything that reports.
    const base = neutralRecipe();
    for (const look of LOOKS) {
      const scaled = applyStrength(look.params, 1);
      expect(() =>
        recipeSchema.parse({ ...base, global: { ...base.global, ...scaled } }),
      ).not.toThrow();
    }
  });

  it('leaves the photo alone when nothing is chosen', () => {
    expect(lookByKey('none')?.params).toEqual({});
  });
});

describe('the strength dial', () => {
  it('reproduces a finish exactly at the strength it was written at', () => {
    for (const look of LOOKS) {
      expect(applyStrength(look.params, REFERENCE_STRENGTH), look.key).toEqual(look.params);
    }
  });

  it('scales an amount but not what the amount is of', () => {
    // Turning a finish down has to make it weaker, not a different colour. The
    // hue of a split tone and the size of the grain describe the effect; only
    // the amounts say how much of it there is.
    const base: Partial<GlobalParams> = {
      contrast: 0.4,
      split: {
        shadowHue: 220,
        shadowAmount: 0.4,
        highlightHue: 48,
        highlightAmount: 0.2,
        balance: 0.3,
      },
      grain: { amount: 0.4, size: 1.8 },
      vignette: { amount: 0.5, midpoint: 0.5, feather: 0.7, roundness: 0.4 },
      glow: { amount: 0.6, threshold: 0.52 },
      mono: { amount: 0.8, red: 0.26, green: 0.62, blue: 0.12 },
    };
    const half = applyStrength(base, REFERENCE_STRENGTH / 2);

    expect(half.contrast).toBeCloseTo(0.2, 9);
    expect(half.split?.shadowAmount).toBeCloseTo(0.2, 9);
    expect(half.split?.shadowHue).toBe(220);
    expect(half.split?.balance).toBe(0.3);
    expect(half.grain?.amount).toBeCloseTo(0.2, 9);
    expect(half.grain?.size).toBe(1.8);
    expect(half.vignette?.amount).toBeCloseTo(0.25, 9);
    expect(half.vignette?.feather).toBe(0.7);
    expect(half.glow?.amount).toBeCloseTo(0.3, 9);
    expect(half.glow?.threshold).toBe(0.52);
    expect(half.mono?.amount).toBeCloseTo(0.4, 9);
    expect(half.mono?.green).toBe(0.62);
  });

  it('leaves the photo-specific corrections where they are', () => {
    // How bright the photo was and how it was lit are facts about the photo, not
    // part of the finish, so the dial must not undo a correction to them.
    const base: Partial<GlobalParams> = {
      exposure: 0.4,
      temperature: -0.3,
      shadows: 0.5,
      skinHueProtect: 0.8,
      saturation: 0.4,
    };
    const quiet = applyStrength(base, REFERENCE_STRENGTH / 4);
    expect(quiet.exposure).toBe(0.4);
    expect(quiet.temperature).toBe(-0.3);
    expect(quiet.shadows).toBe(0.5);
    expect(quiet.skinHueProtect).toBe(0.8);
    expect(quiet.saturation).toBeCloseTo(0.1, 9);
  });

  it('turns a finish off entirely at zero', () => {
    const off = applyStrength(lookByKey('film')?.params ?? {}, 0);
    // Scaling a negative amount to nothing lands on negative zero, which is the
    // same number to every consumer of it; compare by value, not by sign.
    expect(off.saturation).toBeCloseTo(0, 12);
    expect(off.fade).toBe(0);
    expect(off.grain?.amount).toBe(0);
    expect(off.split?.shadowAmount).toBe(0);
  });

  it('never drives a parameter past its range', () => {
    const strong = applyStrength({ contrast: 0.9, grain: { amount: 0.9, size: 1 } }, 1);
    expect(strong.contrast).toBeLessThanOrEqual(1);
    expect(strong.grain?.amount).toBeLessThanOrEqual(1);
  });
});
