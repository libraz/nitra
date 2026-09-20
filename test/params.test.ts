/**
 * The panel against the schema.
 *
 * Ranges live in the recipe schema and the sliders read them back, so the two
 * cannot disagree about what a value may be. What they can disagree about is
 * which values inside the range a slider can reach, and which parameters reach
 * the panel at all.
 */

import { describe, expect, it } from 'vitest';
import { paramDefs } from '../src/core/recipe/schema';
import { GROUPS, granularity } from '../src/ui/params';

describe('slider granularity', () => {
  it('leaves the thumb where the recipe says it is', () => {
    // A range input snaps its value to `min + n * step`, so a step too coarse
    // for the range puts the thumb somewhere the recipe never said. For a brush
    // running from 0.002 to 0.03 a fixed hundredth put the default a seventh of
    // the way from where it belongs — at the very bottom of the track.
    for (const def of paramDefs().values()) {
      const span = def.max - def.min;
      const { step } = granularity(span);
      const snapped = def.min + Math.round((def.neutral - def.min) / step) * step;
      expect(Math.abs(snapped - def.neutral) / span, def.path).toBeLessThan(0.01);
    }
  });

  it('can reach both ends of every parameter, in useful steps', () => {
    for (const def of paramDefs().values()) {
      const span = def.max - def.min;
      const { step } = granularity(span);
      const stops = span / step;
      expect(Math.abs(stops - Math.round(stops)), `${def.path} at ${step}`).toBeLessThan(1e-6);
      // Fewer than this and a drag skips over values somebody would want.
      expect(stops, def.path).toBeGreaterThanOrEqual(100);
    }
  });

  it('shows enough decimals to tell one step from the next', () => {
    for (const def of paramDefs().values()) {
      const { step, decimals } = granularity(def.max - def.min);
      // A readout rounded coarser than the step is a number that stops moving
      // while the slider is still moving.
      expect(10 ** -decimals, `${def.path} at ${step}`).toBeLessThanOrEqual(step);
    }
  });
});

describe('the detail panel', () => {
  /**
   * Parameters the detail panel is not where you set.
   *
   * Not exceptions to the rule that everything is reachable — each of these has
   * its own control somewhere else, because a path is not the only way to
   * address a value. The colour mixer draws its own bands, the framing and the
   * grid have their own tools, and the fields of a list are per entry.
   */
  const ELSEWHERE = [
    'global.hsl.',
    'geometry.',
    'tiles.',
    'text.',
    'heal.',
    // Both amounts describe a patch taken from a second photograph, and that
    // photograph is opened in the tool rather than named by a path. A slider for
    // the edge of a patch that does not exist is a control with nothing under
    // it, which is what the detail panel is not for.
    'restore.',
    // Where the light stands is one decision written as two numbers, and the
    // disc is how it is made. Two sliders for a direction is a control somebody
    // has to read back and imagine the result of.
    'relight.angle',
    'relight.frontal',
  ];

  it('offers every parameter the schema declares, once', () => {
    // A parameter nobody can reach is a parameter that silently does nothing,
    // which is what the schema's own rule against placeholder fields exists to
    // prevent; the panel is the other half of that promise.
    const offered = GROUPS.flatMap((group) => group.params.map((param) => param.path));
    expect(new Set(offered).size, 'a path appears in two groups').toBe(offered.length);

    const missing = [...paramDefs().keys()].filter(
      (path) => !offered.includes(path) && !ELSEWHERE.some((prefix) => path.startsWith(prefix)),
    );
    expect(missing).toEqual([]);
  });

  it('offers nothing the schema has not declared', () => {
    // `spec()` throws on an unknown path, so this cannot fail while the groups
    // are built through it — which is the point of asserting it: the day
    // somebody assembles a ParamSpec by hand, this is what notices.
    for (const path of GROUPS.flatMap((group) => group.params.map((param) => param.path))) {
      expect(paramDefs().has(path), path).toBe(true);
    }
  });
});
