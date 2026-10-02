/**
 * What loading does to a value that is out of range: it writes one of the same
 * kind, records exactly what it wrote, and leaves anything else to fail.
 */

import { describe, expect, it } from 'vitest';
import { buildCurveLut } from '../src/core/recipe/curve';
import { loadRecipe } from '../src/core/recipe/load';
import { HEAL_LIMIT, isIdentityCurve, neutralRecipe, paramDefs } from '../src/core/recipe/schema';

const STRING_FIELDS = [
  ['restore', 'reference', 260],
  ['output.metadata.capture', 'make', 64],
  ['output.metadata.credit', 'copyright', 128],
  ['output.metadata.credit', 'description', 512],
] as const;

/** A recipe holding `value` at a dotted section path and key. */
function recipeWith(section: string, key: string, value: unknown): Record<string, unknown> {
  const root: Record<string, unknown> = { version: 1 };
  let cur = root;
  for (const part of section.split('.')) {
    const next: Record<string, unknown> = {};
    cur[part] = next;
    cur = next;
  }
  cur[key] = value;
  return root;
}

describe('repairing a value that runs over', () => {
  it('truncates an overlong string to its maximum and records the string written', () => {
    for (const [section, key, max] of STRING_FIELDS) {
      const long = 'x'.repeat(max + 40);
      const loaded = loadRecipe(recipeWith(section, key, long));
      expect(loaded.ok, `${section}.${key}`).toBe(true);
      if (!loaded.ok) continue;
      expect(loaded.repairs).toEqual([
        { path: `${section}.${key}`, from: long, to: 'x'.repeat(max) },
      ]);
    }
  });

  it('never writes a number into a string field', () => {
    for (const [section, key, max] of STRING_FIELDS) {
      const loaded = loadRecipe(recipeWith(section, key, 'y'.repeat(max * 3)));
      if (!loaded.ok) throw new Error(`${section}.${key}`);
      for (const repair of loaded.repairs) expect(typeof repair.to).toBe('string');
    }
  });

  it('clamps a number to its bound, as before', () => {
    const loaded = loadRecipe({ version: 1, global: { exposure: 99 } });
    const { max } = paramDefs().get('global.exposure') ?? { max: NaN };
    expect(loaded.ok && loaded.repairs).toEqual([{ path: 'global.exposure', from: 99, to: max }]);
  });

  it('truncates a list that runs over and records the list written', () => {
    const spots = Array.from({ length: HEAL_LIMIT + 50 }, () => ({ x: 0.5, y: 0.5, r: 0.01 }));
    const loaded = loadRecipe({ version: 1, heal: spots });
    if (!loaded.ok) throw new Error(loaded.issues.join('; '));
    const [repair] = loaded.repairs;
    expect(Array.isArray(repair?.to)).toBe(true);
    expect(repair?.to).toHaveLength(loaded.recipe.heal.length);
  });

  it('leaves a value that is not a range problem to fail with its own message', () => {
    const loaded = loadRecipe({ version: 1, global: { exposure: 'bright' } });
    expect(loaded.ok).toBe(false);
  });
});

describe('the identity curve', () => {
  it('is only claimed for a curve whose table is the ramp', () => {
    const curves: [number, number][][] = [
      [
        [0, 0],
        [1, 1],
      ],
      [
        [0, 0],
        [0.5, 0.5],
        [1, 1],
      ],
      [
        [0.2, 0.2],
        [0.8, 0.8],
      ],
      [
        [0, 0.1],
        [1, 1],
      ],
      [
        [0, 0],
        [0.9, 0.9],
      ],
      [
        [0.3, 0.3],
        [0.5, 0.5],
        [1, 1],
      ],
      [
        [1, 1],
        [0, 0],
      ],
      [
        [0, 0],
        [0.5, 0.6],
        [1, 1],
      ],
    ];
    for (const points of curves) {
      const lut = buildCurveLut(points);
      const ramp = lut.every((y, i) => Math.abs(y - i / (lut.length - 1)) < 1e-3);
      if (isIdentityCurve(points)) expect(ramp, JSON.stringify(points)).toBe(true);
    }
  });

  it('rejects a curve that holds its end points flat', () => {
    expect(
      isIdentityCurve([
        [0.2, 0.2],
        [0.8, 0.8],
      ]),
    ).toBe(false);
    expect(
      isIdentityCurve([
        [0, 0],
        [0.9, 0.9],
      ]),
    ).toBe(false);
  });

  it('still accepts the default and its unsorted spelling', () => {
    expect(isIdentityCurve(neutralRecipe().global.curve)).toBe(true);
    expect(
      isIdentityCurve([
        [1, 1],
        [0, 0],
      ]),
    ).toBe(true);
  });
});
