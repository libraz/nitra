/**
 * The destination catalogue.
 *
 * Every row here is a claim about what some service publishes at, and the rows
 * are the only place those numbers live. What can be checked without asking the
 * service is that a row is internally consistent — that the ratio it crops to is
 * the ratio it names, that a destination carries a size and a plain shape to go
 * with it — and that the list is in an order the grouped picker can draw.
 */

import { describe, expect, it } from 'vitest';
import { ASPECT_GROUPS, ASPECTS, aspectByKey, resolveAspect } from '../src/core/geometry/aspects';

/** `4:5` and `1.91:1` as the numbers they stand for. */
function spoken(shape: string): number {
  const [width, height] = shape.split(':').map(Number);
  return (width as number) / (height as number);
}

describe('the catalogue', () => {
  it('names every preset once', () => {
    const keys = ASPECTS.map((preset) => preset.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('puts each group in one unbroken run, in the order the picker walks', () => {
    // The picker draws a heading whenever the group changes, so a group split
    // across two runs comes out as the same heading twice.
    const runs = ASPECTS.map((preset) => preset.group).filter(
      (group, index, all) => group !== all[index - 1],
    );
    expect(runs).toEqual([...new Set(runs)]);
    expect(runs).toEqual(ASPECT_GROUPS.filter((group) => runs.includes(group)));
  });

  it('gives every destination a size, a ratio and a shape to say it by', () => {
    for (const preset of ASPECTS) {
      if (preset.group === 'ratio') {
        // The plain shapes are named by their ratio and take the photo's size.
        expect(preset.longEdge, preset.key).toBe(0);
        continue;
      }
      expect(preset.longEdge, preset.key).toBeGreaterThan(0);
      expect(preset.ratio, preset.key).toBeGreaterThan(0);
      expect(preset.shape, preset.key).toBeTruthy();
    }
  });

  it('crops to the shape it says it crops to', () => {
    // A row whose caption and arithmetic disagree is the one failure here that
    // nothing downstream can catch: the export is simply the wrong shape.
    for (const preset of ASPECTS) {
      if (!preset.shape || preset.ratio === null) continue;
      expect(spoken(preset.shape), preset.key).toBeCloseTo(preset.ratio, 1);
    }
  });

  it('asks for a sane number of pixels', () => {
    for (const preset of ASPECTS) {
      expect(preset.longEdge, preset.key).toBeLessThanOrEqual(4096);
    }
  });
});

describe('resolving a shape', () => {
  it('follows the frame when the preset says to', () => {
    expect(resolveAspect('original', 1.5)).toBe(1.5);
    expect(resolveAspect('original', 0.75)).toBe(0.75);
  });

  it('leaves the crop free for a shape it does not know', () => {
    // A recipe written by a build that had a preset this one does not must
    // still render; an unknown shape is an unlocked crop, not a failure.
    expect(resolveAspect('nowhere.post', 1.5)).toBeNull();
    expect(aspectByKey('nowhere.post')).toBeUndefined();
  });

  it('holds the ratio a destination asks for', () => {
    expect(resolveAspect('instagram.portrait', 1.5)).toBeCloseTo(0.8, 5);
    expect(resolveAspect('instagram.tall', 1.5)).toBeCloseTo(0.75, 5);
  });
});
