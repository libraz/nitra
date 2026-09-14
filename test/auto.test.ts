import { describe, expect, it } from 'vitest';
import { suggestGrade } from '../src/core/analysis/auto';
import { applyStrength, LOOKS, REFERENCE_STRENGTH } from '../src/core/recipe/presets';
import type { RenderStats } from '../src/core/render/pipeline';

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
    ...partial,
  };
}

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

  it('lifts colour through vibrance with skin protection on', () => {
    // A flat saturation lift is what turns faces red; these two together are
    // what keep a colour correction off the skin.
    const { params } = suggestGrade(stats());
    expect(params.vibrance).toBeGreaterThan(0);
    expect(params.saturation).toBeUndefined();
    expect(params.skinHueProtect).toBeGreaterThan(0.5);
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
