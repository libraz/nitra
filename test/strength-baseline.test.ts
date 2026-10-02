import { describe, expect, it } from 'vitest';
import {
  applyBaseline,
  type Baseline,
  EMPTY_BASELINE,
  lookBaseline,
  lookByKey,
  mergeBaselines,
  REFERENCE_STRENGTH,
  releaseParam,
} from '../src/core/recipe/presets';
import { neutralRecipe, type Recipe } from '../src/core/recipe/schema';
import { readParam, writeParam } from '../src/ui/params';

/** The editor's three routes into the dial, as `useEditor` drives them. */
class Session {
  recipe: Recipe = neutralRecipe();
  baseline: Baseline = EMPTY_BASELINE;
  strength = REFERENCE_STRENGTH;

  private apply(next: Baseline): void {
    this.recipe = applyBaseline(this.recipe, this.baseline, next, this.strength);
    this.baseline = next;
  }

  pick(key: string): void {
    const look = lookByKey(key);
    if (!look) throw new Error(key);
    this.apply(lookBaseline(look));
  }

  dial(strength: number): void {
    this.strength = strength;
    this.apply(this.baseline);
  }

  auto(suggestion: Baseline): void {
    this.apply(mergeBaselines(this.baseline, suggestion));
  }

  edit(path: string, value: number): void {
    this.recipe = writeParam(this.recipe, path, value);
    this.baseline = releaseParam(this.baseline, path);
  }
}

/** Edits a finish never names, nested groups and the reshaping included. */
const HAND_EDITS: readonly [string, number][] = [
  ['global.vignette.amount', 0.4],
  ['global.hsl.red.saturation', -0.3],
  ['global.glow.amount', 0.2],
  ['global.mono.amount', 0.5],
  ['face.warp.faceSlim', 0.35],
  ['face.lip.amount', 0.25],
  ['face.lip.hue', 12],
];

describe('the strength baseline', () => {
  it('keeps every hand edit through the dial, a finish and Auto', () => {
    const session = new Session();
    session.pick('natural');
    for (const [path, value] of HAND_EDITS) session.edit(path, value);
    // Hand edits to fields the finish does name, scaled and exempt alike.
    session.edit('global.contrast', 0.33);
    session.edit('global.grain.amount', 0.21);
    session.edit('global.exposure', -0.2);
    session.edit('face.smooth', 0.6);

    const kept = [
      ...HAND_EDITS,
      ['global.contrast', 0.33],
      ['global.grain.amount', 0.21],
      ['global.exposure', -0.2],
      ['face.smooth', 0.6],
    ] as const;
    const check = (when: string) => {
      for (const [path, value] of kept) {
        expect(readParam(session.recipe, path), `${path} after ${when}`).toBeCloseTo(value, 9);
      }
    };

    for (const strength of [0, 0.1, 1, REFERENCE_STRENGTH]) {
      session.dial(strength);
      check(`strength ${strength}`);
    }
    session.auto({ global: { vibrance: 0.2 }, face: { undereye: 0.3 } });
    check('Auto');
    expect(session.recipe.global.vibrance).toBeCloseTo(0.2, 9);
    session.pick('none');
    check('the empty finish');
  });

  it('still scales the finish fields nobody touched', () => {
    const session = new Session();
    session.pick('natural');
    session.edit('global.contrast', 0.5);
    session.dial(REFERENCE_STRENGTH / 2);
    expect(session.recipe.global.vibrance).toBeCloseTo(0.06, 9);
    expect(session.recipe.global.grain.amount).toBeCloseTo(0.03, 9);
    // The grain size is what the grain is, not how much: neither scaled nor lost.
    expect(session.recipe.global.grain.size).toBe(1);
    expect(session.recipe.face.smooth).toBeCloseTo(0.14, 9);
    expect(session.recipe.global.contrast).toBe(0.5);
  });

  it('round-trips through strength 0', () => {
    const session = new Session();
    session.pick('film');
    session.edit('face.warp.chin', -0.2);
    session.dial(0.8);
    const before = structuredClone(session.recipe);
    session.dial(0);
    expect(session.recipe.global.split.shadowAmount).toBe(0);
    session.dial(0.8);
    expect(session.recipe).toEqual(before);
  });

  it('holds a value set at strength 0 when the dial is raised', () => {
    // A value set where the dial scales everything to nothing has no value at
    // the reference strength; recording one by division blew it up to the end
    // of its range.
    for (const strength of [0, 0.005, 0.05]) {
      const session = new Session();
      session.pick('clear');
      session.dial(strength);
      session.edit('global.clarity', 0.1);
      session.edit('face.eyes', 0.15);
      for (const next of [0.2, REFERENCE_STRENGTH, 1, strength]) {
        session.dial(next);
        expect(session.recipe.global.clarity, `from ${strength} to ${next}`).toBe(0.1);
        expect(session.recipe.face.eyes, `from ${strength} to ${next}`).toBe(0.15);
      }
    }
  });

  it('puts what only the previous finish named back to neutral', () => {
    const session = new Session();
    session.pick('retro');
    session.pick('natural');
    const fresh = neutralRecipe();
    expect(session.recipe.global.split).toEqual(fresh.global.split);
    expect(session.recipe.global.vignette).toEqual(fresh.global.vignette);
    expect(session.recipe.global.fade).toBe(fresh.global.fade);
    expect(session.recipe.global.temperature).toBe(fresh.global.temperature);

    session.pick('none');
    expect(session.recipe).toEqual(fresh);
  });

  it('lets a finish take back a field it names', () => {
    const session = new Session();
    session.edit('global.contrast', 0.7);
    session.pick('vivid');
    expect(session.recipe.global.contrast).toBe(lookByKey('vivid')?.params.contrast);
    session.dial(REFERENCE_STRENGTH / 2);
    expect(session.recipe.global.contrast).toBeCloseTo(0.14, 9);
  });

  it('leaves everything outside the grade and the face alone', () => {
    const session = new Session();
    session.recipe = writeParam(session.recipe, 'hair.sheen', 0.4);
    session.recipe = { ...session.recipe, heal: [{ x: 0.5, y: 0.5, r: 0.01 }] };
    session.pick('dreamy');
    session.dial(0.9);
    session.auto({ global: { blacks: -0.1 }, face: {} });
    expect(session.recipe.hair.sheen).toBe(0.4);
    expect(session.recipe.heal).toHaveLength(1);
  });
});
