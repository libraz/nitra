import { describe, expect, it } from 'vitest';
import { isNeutralGeometry } from '../src/core/geometry/transform';
import { buildCurveLut } from '../src/core/recipe/curve';
import { loadRecipe, serializeRecipe } from '../src/core/recipe/load';
import { migrateRecipe } from '../src/core/recipe/migrate';
import {
  CURRENT_RECIPE_VERSION,
  isIdentityCurve,
  neutralRecipe,
  neutralTextLayer,
  paramDefs,
  recipeSchema,
} from '../src/core/recipe/schema';

describe('defaults', () => {
  it('gives every parameter its no-effect value', () => {
    // A recipe that has never been touched must render the photo unchanged, and
    // so must one where a field went missing.
    const recipe = neutralRecipe() as unknown as Record<string, Record<string, unknown>>;
    for (const def of paramDefs().values()) {
      // The fields of a list — text layers, heal spots — are registered once for
      // the field rather than once per entry, because entries are addressed by
      // index and a range belongs to the field. A list's own no-effect value is
      // that it is empty, which is asserted separately.
      if (def.path.startsWith('text.') || def.path.startsWith('heal.')) continue;
      const value = def.path
        .split('.')
        .reduce<unknown>((cursor, key) => (cursor as Record<string, unknown>)?.[key], recipe);
      expect(value, def.path).toBe(def.neutral);
    }
  });

  it('gives a new text layer every declared default', () => {
    const layer = neutralTextLayer('a') as unknown as Record<string, unknown>;
    for (const def of paramDefs().values()) {
      if (!def.path.startsWith('text.')) continue;
      expect(layer[def.path.slice('text.'.length)], def.path).toBe(def.neutral);
    }
    // A layer with no words in it has to render as nothing at all.
    expect(layer.content).toBe('');
  });

  it('leaves the framing alone and the picture in one piece', () => {
    const recipe = neutralRecipe();
    expect(isNeutralGeometry(recipe.geometry)).toBe(true);
    expect(recipe.geometry.quarterTurns).toBe(0);
    expect(recipe.tiles).toEqual({ cols: 1, rows: 1, gap: 0 });
    expect(recipe.text).toEqual([]);
    // Nothing is filled until somebody points at something: an empty list is
    // what makes the Heal stage cost nothing rather than cost a copy.
    expect(recipe.heal).toEqual([]);
    // Zero means "the size it already is", so an untouched recipe never resizes.
    expect(recipe.output.longEdge).toBe(0);
  });

  it('removes metadata unless told otherwise', () => {
    const metadata = neutralRecipe().output.metadata;
    expect(metadata.mode).toBe('strip');
    // Every block is off as well, so switching the mode over without filling
    // anything in still writes nothing.
    expect(metadata.gps.write).toBe(false);
    expect(metadata.capture.write).toBe(false);
    expect(metadata.credit.write).toBe(false);
    expect(metadata.software).toBe(false);

    // Omitting the field entirely must not turn the protection off.
    const loaded = loadRecipe({ version: 1, output: { format: 'png' } });
    expect(loaded.ok && loaded.recipe.output.metadata.mode).toBe('strip');

    // Nor may a recipe that carries a half-written block without a mode.
    const partial = loadRecipe({
      version: 1,
      output: { metadata: { gps: { write: true, latitude: 35.6, longitude: 139.7 } } },
    });
    expect(partial.ok && partial.recipe.output.metadata.mode).toBe('strip');
  });

  it('starts with an identity curve', () => {
    expect(isIdentityCurve(neutralRecipe().global.curve)).toBe(true);
  });
});

describe('loading', () => {
  it('fills absent sections from defaults', () => {
    const loaded = loadRecipe({ version: 1 });
    expect(loaded.ok).toBe(true);
    if (loaded.ok) expect(loaded.recipe.global.exposure).toBe(0);
  });

  it('clamps an out-of-range value and says which one it was', () => {
    // A preset written against a build with wider ranges is worth recovering;
    // letting the value through to a shader uniform is not.
    const loaded = loadRecipe({ version: 1, global: { exposure: 4.2 } });
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.recipe.global.exposure).toBe(1);
    expect(loaded.repairs).toEqual([{ path: 'global.exposure', from: 4.2, to: 1 }]);
  });

  it('rejects a value that is not a number at all', () => {
    const loaded = loadRecipe({ version: 1, global: { exposure: 'bright' } });
    expect(loaded.ok).toBe(false);
    if (!loaded.ok) expect(loaded.issues[0]).toMatch(/global\.exposure/);
  });

  it('rejects anything that is not a JSON object', () => {
    expect(loadRecipe('{}').ok).toBe(false);
    expect(loadRecipe([1, 2, 3]).ok).toBe(false);
    expect(loadRecipe(null).ok).toBe(false);
  });

  it('round-trips through serialisation', () => {
    const recipe = neutralRecipe();
    recipe.global.exposure = 0.25;
    recipe.output.format = 'webp';
    const loaded = loadRecipe(JSON.parse(serializeRecipe(recipe)));
    expect(loaded.ok && loaded.recipe).toEqual(recipe);
  });
});

describe('migration', () => {
  it('stamps the current version onto an unversioned payload', () => {
    expect(migrateRecipe({}).value.version).toBe(CURRENT_RECIPE_VERSION);
  });

  it('reads a newer recipe rather than refusing it', () => {
    // Someone else's build wrote this. Losing their work over a version number
    // is worse than ignoring the fields this build does not know.
    const result = migrateRecipe({ version: 99, global: { exposure: 0.2 }, sparkle: 3 });
    expect(result.from).toBe(99);
    expect(result.notes[0]).toMatch(/version 99/);
    expect(recipeSchema.parse(result.value).global.exposure).toBe(0.2);
  });
});

describe('tone curve sampling', () => {
  it('reproduces the identity', () => {
    const lut = buildCurveLut([
      [0, 0],
      [1, 1],
    ]);
    for (let i = 0; i < lut.length; i += 17) {
      expect(lut[i]).toBeCloseTo(i / (lut.length - 1), 6);
    }
  });

  it('stays monotone through a steep control point', () => {
    // A plain spline overshoots here, and an overshoot in a tone curve shows up
    // as a dark ring around a highlight.
    const lut = buildCurveLut([
      [0, 0],
      [0.35, 0.05],
      [0.4, 0.9],
      [1, 1],
    ]);
    for (let i = 1; i < lut.length; i++) {
      expect(lut[i] as number).toBeGreaterThanOrEqual((lut[i - 1] as number) - 1e-6);
    }
    expect(Math.max(...lut)).toBeLessThanOrEqual(1 + 1e-6);
    expect(Math.min(...lut)).toBeGreaterThanOrEqual(-1e-6);
  });

  it('passes through its control points', () => {
    const lut = buildCurveLut(
      [
        [0, 0],
        [0.5, 0.72],
        [1, 1],
      ],
      257,
    );
    expect(lut[128]).toBeCloseTo(0.72, 5);
  });
});
