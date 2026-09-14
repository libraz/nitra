import { describe, expect, it } from 'vitest';
import { type AutoNote, suggestGrade } from '../src/core/analysis/auto';
import {
  applyFaceStrength,
  applyStrength,
  LOOKS,
  REFERENCE_STRENGTH,
} from '../src/core/recipe/presets';
import { paramDefs } from '../src/core/recipe/schema';
import type { FaceStats, RenderStats } from '../src/core/render/pipeline';

/**
 * A histogram weighted around `level` that still reaches both ends.
 *
 * The floor matters: a photo using its whole range is what "already exposed
 * correctly" means, and a bulge with no tails would read as flat.
 */
function histogramAt(level: number, spread = 10): Uint32Array {
  const histogram = new Uint32Array(64);
  const centre = level * 63;
  for (let i = 0; i < 64; i++) {
    const d = (i - centre) / spread;
    histogram[i] = 30 + Math.round(1000 * Math.exp(-d * d));
  }
  return histogram;
}

function stats(partial: Partial<RenderStats> = {}): RenderStats {
  return {
    highlightClip: 0,
    shadowClip: 0,
    chromaClip: 0,
    histogram: histogramAt(0.46),
    meanLuma: 0.46,
    textureRetention: null,
    ...partial,
  };
}

function faceStats(partial: Partial<FaceStats> = {}): FaceStats {
  return {
    faceCount: 1,
    coverage: 0.14,
    skinLightness: 0.62,
    surroundLightness: 0.6,
    unevenness: 0.05,
    specular: 0,
    ...partial,
  };
}

const kinds = (notes: readonly AutoNote[]) => notes.map((note) => note.kind);

describe('automatic starting values', () => {
  it('leaves a well-exposed photo alone', () => {
    const { params, notes } = suggestGrade(stats());
    expect(params.exposure).toBeUndefined();
    expect(params.highlights).toBeUndefined();
    expect(params.shadows).toBeUndefined();
    expect(notes).toContainEqual({ kind: 'balanced' });
  });

  it('lifts a dark photo and says by how much', () => {
    const { params, notes } = suggestGrade(stats({ meanLuma: 0.18, histogram: histogramAt(0.18) }));
    expect(params.exposure).toBeGreaterThan(0);
    const note = notes.find((n) => n.kind === 'exposure');
    expect(note?.kind === 'exposure' && note.stops).toBeGreaterThan(0);
  });

  it('pulls a bright photo down', () => {
    const { params } = suggestGrade(stats({ meanLuma: 0.8, histogram: histogramAt(0.8) }));
    expect(params.exposure).toBeLessThan(0);
  });

  it('never suggests more than it can defend', () => {
    const { params } = suggestGrade(stats({ meanLuma: 0.01, histogram: histogramAt(0) }));
    expect(params.exposure).toBeLessThanOrEqual(0.6);
  });

  it('recovers clipped highlights', () => {
    const { params, notes } = suggestGrade(stats({ highlightClip: 0.09 }));
    expect(params.highlights).toBeLessThan(0);
    expect(notes.some((n) => n.kind === 'highlightClip')).toBe(true);
  });

  it('deepens a black point that never reaches the bottom', () => {
    // A photo whose darkest pixel is mid-grey is flat, and pulling the end point
    // in is the correction with the largest effect for the least risk.
    const lifted = new Uint32Array(64);
    lifted.fill(100, 20, 60);
    const { params } = suggestGrade(stats({ histogram: lifted, meanLuma: 0.46 }));
    expect(params.blacks).toBeLessThan(0);
  });

  it('lifts colour through vibrance rather than saturation', () => {
    // A flat saturation lift is what turns a photo garish, and vibrance is the
    // weighted version of the same control.
    const { params } = suggestGrade(stats());
    expect(params.vibrance).toBeGreaterThan(0);
    expect(params.saturation).toBeUndefined();
  });
});

/**
 * The branch on whether there is a face.
 *
 * Not two strengths of the same suggestion. With a face the frame stops being
 * the authority on exposure and the skin hues stop being fair game for a colour
 * lift; without one, holding saturation off those hues would only be holding it
 * off a sunset.
 */
describe('a photo with no face in it', () => {
  it('says so, and treats the frame as the subject', () => {
    const { notes } = suggestGrade(stats(), null);
    expect(kinds(notes)).toContain('scene');
    expect(kinds(notes)).not.toContain('faces');
  });

  it('leaves the skin hues unprotected', () => {
    // The hues a face would need holding back from are the ones autumn leaves
    // and a sunset live in.
    const { params } = suggestGrade(stats(), null);
    expect(params.skinHueProtect).toBeUndefined();
  });

  it('lifts colour further than it would on a person', () => {
    const scene = suggestGrade(stats(), null).params.vibrance ?? 0;
    const portrait = suggestGrade(stats(), faceStats()).params.vibrance ?? 0;
    expect(scene).toBeGreaterThan(portrait);
  });

  it('suggests nothing at all for the skin', () => {
    expect(suggestGrade(stats(), null).face).toEqual({});
  });
});

describe('a photo with a face in it', () => {
  it('protects the skin hues from the colour lift', () => {
    const { params } = suggestGrade(stats(), faceStats());
    expect(params.skinHueProtect).toBeGreaterThan(0.5);
  });

  it('counts the faces it found', () => {
    const { notes } = suggestGrade(stats(), faceStats({ faceCount: 3 }));
    expect(notes).toContainEqual({ kind: 'faces', count: 3 });
  });

  it('opens the shadows for a subject the background exposed for', () => {
    // A person against a bright window is a correctly exposed photograph of an
    // underexposed subject, and the frame's own histogram cannot say so.
    const backlit = suggestGrade(
      stats(),
      faceStats({ skinLightness: 0.4, surroundLightness: 0.82 }),
    );
    expect(kinds(backlit.notes)).toContain('backlit');
    expect(backlit.params.shadows ?? 0).toBeGreaterThan(0);
    // The same frame statistics with an evenly lit face get none of it.
    const even = suggestGrade(stats(), faceStats());
    expect(kinds(even.notes)).not.toContain('backlit');
    expect(even.params.shadows).toBeUndefined();
  });

  it('holds back the highlights on a face lit harder than its scene', () => {
    const spotlit = suggestGrade(
      stats(),
      faceStats({ skinLightness: 0.85, surroundLightness: 0.42 }),
    );
    expect(kinds(spotlit.notes)).toContain('spotlit');
    expect(spotlit.params.highlights ?? 0).toBeLessThan(0);
  });

  it('does not aim the skin at a lightness', () => {
    // How light somebody's skin is, is what they look like. Two faces lit the
    // same way relative to their surroundings get the same correction.
    const lighter = suggestGrade(
      stats(),
      faceStats({ skinLightness: 0.78, surroundLightness: 0.76 }),
    );
    const darker = suggestGrade(
      stats(),
      faceStats({ skinLightness: 0.34, surroundLightness: 0.32 }),
    );
    expect(lighter.params.exposure).toBe(darker.params.exposure);
    expect(lighter.params.shadows).toBe(darker.params.shadows);
    expect(lighter.face).toEqual(darker.face);
  });

  it('smooths blotchy skin and says how blotchy it was', () => {
    const { face, notes } = suggestGrade(stats(), faceStats({ unevenness: 0.55 }));
    expect(face.smooth ?? 0).toBeGreaterThan(0);
    expect(kinds(notes)).toContain('uneven');
  });

  it('leaves even skin alone', () => {
    const { face } = suggestGrade(stats(), faceStats({ unevenness: 0.04 }));
    expect(face.smooth).toBeUndefined();
    expect(face.blemish).toBeUndefined();
  });

  it('stops well short of what the measurement would justify', () => {
    // A first press that has already gone too far is worse than one that has
    // not gone far enough: the second is an invitation, the first is something
    // to undo.
    const { face } = suggestGrade(stats(), faceStats({ unevenness: 1 }));
    expect(face.smooth ?? 0).toBeLessThanOrEqual(0.5);
  });

  it('puts grain back in proportion to the smoothing', () => {
    // Smoothing takes the texture off the skin. Putting some back is the
    // difference between skin and plastic, and it happens without being asked.
    const mild = suggestGrade(stats(), faceStats({ unevenness: 0.3 }));
    const heavy = suggestGrade(stats(), faceStats({ unevenness: 0.8 }));
    expect(mild.params.grain?.amount ?? 0).toBeGreaterThan(0);
    expect(heavy.params.grain?.amount ?? 0).toBeGreaterThan(mild.params.grain?.amount ?? 0);
    expect(suggestGrade(stats(), faceStats({ unevenness: 0.04 })).params.grain).toBeUndefined();
  });

  it('reduces shine only when there is some', () => {
    expect(suggestGrade(stats(), faceStats({ specular: 0.28 })).face.shine ?? 0).toBeGreaterThan(0);
    expect(suggestGrade(stats(), faceStats({ specular: 0 })).face.shine).toBeUndefined();
  });

  it('never suggests taking the texture out', () => {
    // The texture trim is a repair the user reaches for, not something the
    // first press should have done to them.
    for (const unevenness of [0, 0.3, 0.6, 1]) {
      expect(suggestGrade(stats(), faceStats({ unevenness })).face.texture).toBeUndefined();
    }
  });
});

/**
 * Every combination of what the two measurements can say.
 *
 * The function is pure and cheap, so the whole product is walked rather than a
 * sample of it: the failures worth catching here are the ones where two
 * readings interact, and those are exactly the ones a handful of chosen cases
 * would step over.
 */
describe('across every combination of the measurements', () => {
  const lighting = {
    even: { skinLightness: 0.62, surroundLightness: 0.6 },
    backlit: { skinLightness: 0.42, surroundLightness: 0.8 },
    spotlit: { skinLightness: 0.82, surroundLightness: 0.45 },
  };
  const unevenness = { clean: 0.05, moderate: 0.25, blotchy: 0.6 };
  const specular = { matte: 0, shiny: 0.2 };
  const exposure = { dark: 0.18, correct: 0.46, bright: 0.8 };
  const clipping = {
    none: {},
    highlights: { highlightClip: 0.09 },
    shadows: { shadowClip: 0.12 },
  };

  const cases: {
    name: string;
    face: FaceStats | null;
    lighting: keyof typeof lighting;
    uneven: keyof typeof unevenness;
    shine: keyof typeof specular;
    frame: RenderStats;
  }[] = [];

  for (const hasFace of [false, true]) {
    for (const light of Object.keys(lighting) as (keyof typeof lighting)[]) {
      for (const uneven of Object.keys(unevenness) as (keyof typeof unevenness)[]) {
        for (const shine of Object.keys(specular) as (keyof typeof specular)[]) {
          for (const level of Object.keys(exposure) as (keyof typeof exposure)[]) {
            for (const clip of Object.keys(clipping) as (keyof typeof clipping)[]) {
              const mean = exposure[level];
              cases.push({
                name: `${hasFace ? 'face' : 'scene'}/${light}/${uneven}/${shine}/${level}/${clip}`,
                face: hasFace
                  ? faceStats({
                      ...lighting[light],
                      unevenness: unevenness[uneven],
                      specular: specular[shine],
                    })
                  : null,
                lighting: light,
                uneven,
                shine,
                frame: stats({
                  meanLuma: mean,
                  histogram: histogramAt(mean),
                  ...clipping[clip],
                }),
              });
            }
          }
        }
      }
    }
  }

  /** Check a produced block against the ranges the schema declares. */
  function assertInRange(block: Record<string, unknown>, root: string, where: string): void {
    for (const [key, value] of Object.entries(block)) {
      if (typeof value === 'number') {
        const def = paramDefs().get(`${root}.${key}`);
        expect(def, `${root}.${key}`).toBeDefined();
        expect(value, `${where} ${root}.${key}`).toBeGreaterThanOrEqual(def?.min ?? 0);
        expect(value, `${where} ${root}.${key}`).toBeLessThanOrEqual(def?.max ?? 0);
        continue;
      }
      if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
        assertInRange(value as Record<string, unknown>, `${root}.${key}`, where);
      }
    }
  }

  it('walks the whole product', () => {
    expect(cases).toHaveLength(2 * 3 * 3 * 2 * 3 * 3);
  });

  it('never suggests a value the sliders could not hold', () => {
    for (const probe of cases) {
      const suggestion = suggestGrade(probe.frame, probe.face);
      assertInRange(suggestion.params as Record<string, unknown>, 'global', probe.name);
      assertInRange(suggestion.face as Record<string, unknown>, 'face', probe.name);
    }
  });

  it('says which branch it took, and only one of them', () => {
    for (const probe of cases) {
      const found = kinds(suggestGrade(probe.frame, probe.face).notes);
      if (probe.face === null) {
        expect(found, probe.name).toContain('scene');
        expect(found, probe.name).not.toContain('faces');
      } else {
        expect(found, probe.name).toContain('faces');
        expect(found, probe.name).not.toContain('scene');
      }
    }
  });

  it('keeps the skin suggestions behind the face, whatever the frame says', () => {
    // A dark, clipped, blotchy-looking frame with no face in it must still
    // produce nothing for the skin: there is no skin to have measured.
    for (const probe of cases.filter((entry) => entry.face === null)) {
      const suggestion = suggestGrade(probe.frame, probe.face);
      expect(suggestion.face, probe.name).toEqual({});
      expect(suggestion.params.skinHueProtect, probe.name).toBeUndefined();
      expect(kinds(suggestion.notes), probe.name).not.toContain('uneven');
      expect(kinds(suggestion.notes), probe.name).not.toContain('shine');
      expect(kinds(suggestion.notes), probe.name).not.toContain('backlit');
      expect(kinds(suggestion.notes), probe.name).not.toContain('spotlit');
    }
  });

  it('reads the lighting from the face and not from the exposure', () => {
    for (const probe of cases.filter((entry) => entry.face !== null)) {
      const found = kinds(suggestGrade(probe.frame, probe.face).notes);
      expect(found.includes('backlit'), probe.name).toBe(probe.lighting === 'backlit');
      expect(found.includes('spotlit'), probe.name).toBe(probe.lighting === 'spotlit');
    }
  });

  it('ties the skin suggestions to the skin readings and nothing else', () => {
    for (const probe of cases.filter((entry) => entry.face !== null)) {
      const { face } = suggestGrade(probe.frame, probe.face);
      expect(face.smooth !== undefined, probe.name).toBe(probe.uneven !== 'clean');
      expect(face.shine !== undefined, probe.name).toBe(probe.shine === 'shiny');
    }
  });

  it('protects the skin hues on every photo that has skin in it', () => {
    for (const probe of cases.filter((entry) => entry.face !== null)) {
      expect(
        suggestGrade(probe.frame, probe.face).params.skinHueProtect,
        probe.name,
      ).toBeGreaterThan(0.5);
    }
  });
});

describe('the strength dial', () => {
  const natural = LOOKS.find((look) => look.key === 'natural');

  it('reproduces a finish exactly at its reference strength', () => {
    if (!natural) throw new Error('missing fixture');
    expect(applyStrength(natural.params, REFERENCE_STRENGTH)).toEqual(natural.params);
  });

  it('scales the character of the finish', () => {
    if (!natural) throw new Error('missing fixture');
    const weak = applyStrength(natural.params, REFERENCE_STRENGTH / 2);
    expect(weak.vibrance).toBeCloseTo((natural.params.vibrance ?? 0) / 2, 6);
    expect(weak.clarity).toBeCloseTo((natural.params.clarity ?? 0) / 2, 6);
    expect(weak.grain?.amount).toBeCloseTo((natural.params.grain?.amount ?? 0) / 2, 6);
  });

  it('leaves the photo-specific corrections where they are', () => {
    // How bright a photo is, and how it was lit, are facts about the photo.
    // Turning the finish down must not undo the exposure correction.
    if (!natural) throw new Error('missing fixture');
    const weak = applyStrength(natural.params, 0.05);
    expect(weak.exposure).toBe(natural.params.exposure);
    expect(weak.highlights).toBe(natural.params.highlights);
    expect(weak.shadows).toBe(natural.params.shadows);
  });

  it('keeps the grain size, which is a look and not an amount', () => {
    if (!natural) throw new Error('missing fixture');
    expect(applyStrength(natural.params, 0.1).grain?.size).toBe(natural.params.grain?.size);
  });

  it('stays inside the parameter range at full strength', () => {
    for (const look of LOOKS) {
      const strong = applyStrength(look.params, 1);
      for (const [key, value] of Object.entries(strong)) {
        if (typeof value !== 'number') continue;
        expect(Math.abs(value), `${look.key}.${key}`).toBeLessThanOrEqual(1);
      }
    }
  });

  it('collapses to the unedited photo at zero', () => {
    if (!natural) throw new Error('missing fixture');
    const none = applyStrength(natural.params, 0);
    expect(none.vibrance).toBe(0);
    expect(none.clarity).toBe(0);
  });
});

describe('the strength dial over the face block', () => {
  it('reproduces a finish exactly at its reference strength', () => {
    for (const look of LOOKS) {
      expect(applyFaceStrength(look.face ?? {}, REFERENCE_STRENGTH), look.key).toEqual(
        look.face ?? {},
      );
    }
  });

  it('turns the skin retouch down with the rest of the finish', () => {
    const soft = LOOKS.find((look) => look.key === 'soft');
    if (!soft?.face) throw new Error('missing fixture');
    const weak = applyFaceStrength(soft.face, REFERENCE_STRENGTH / 2);
    expect(weak.smooth).toBeCloseTo((soft.face.smooth ?? 0) / 2, 6);
    expect(weak.shine).toBeCloseTo((soft.face.shine ?? 0) / 2, 6);
  });

  it('collapses the skin retouch to nothing at zero', () => {
    for (const look of LOOKS) {
      const none = applyFaceStrength(look.face ?? {}, 0);
      for (const [key, value] of Object.entries(none)) {
        if (key === 'radius' || typeof value !== 'number') continue;
        expect(value, `${look.key}.${key}`).toBe(0);
      }
      expect(none.lip?.amount ?? 0, `${look.key}.lip`).toBe(0);
      expect(none.cheek?.amount ?? 0, `${look.key}.cheek`).toBe(0);
    }
  });

  it('keeps a lip and cheek hue, which is a colour and not an amount', () => {
    const vivid = LOOKS.find((look) => look.key === 'vivid');
    if (!vivid?.face) throw new Error('missing fixture');
    const weak = applyFaceStrength(vivid.face, 0.1);
    expect(weak.lip?.hue).toBe(vivid.face.lip?.hue);
    expect(weak.cheek?.hue).toBe(vivid.face.cheek?.hue);
  });

  it('stays inside the parameter range at full strength', () => {
    for (const look of LOOKS) {
      const strong = applyFaceStrength(look.face ?? {}, 1) as Record<string, unknown>;
      for (const [key, value] of Object.entries(strong)) {
        if (typeof value !== 'number') continue;
        const def = paramDefs().get(`face.${key}`);
        expect(def, `face.${key}`).toBeDefined();
        expect(value, `${look.key}.${key}`).toBeGreaterThanOrEqual(def?.min ?? 0);
        expect(value, `${look.key}.${key}`).toBeLessThanOrEqual(def?.max ?? 0);
      }
    }
  });

  it('gives most finishes something to say about skin', () => {
    // The app exists to retouch a face. A finish picker where the finishes only
    // grade would be answering a different question from the one being asked.
    const withFace = LOOKS.filter((look) => Object.keys(look.face ?? {}).length > 0);
    expect(withFace.length).toBeGreaterThan(LOOKS.length / 2);
    // Except the one that means "leave it alone".
    expect(LOOKS.find((look) => look.key === 'none')?.face).toBeUndefined();
  });
});
