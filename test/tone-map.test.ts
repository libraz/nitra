/**
 * The highlight rolloff stays finite for any scene value the grade can produce.
 */

import { describe, expect, it } from 'vitest';
import { GLSL_TONEMAP } from '../src/core/render/shaders/common';

const f32 = Math.fround;

/** tanh as an implementation may write it: a ratio of exponentials in single precision. */
function tanhAsRatio(x: number): number {
  const up = f32(Math.exp(x));
  const down = f32(Math.exp(-x));
  return f32((up - down) / (up + down));
}

const reach = Number(GLSL_TONEMAP.match(/const float ROLLOFF_REACH = ([\d.]+);/)?.[1]);

describe('highlight rolloff', () => {
  it('bounds the argument it hands to tanh', () => {
    expect(GLSL_TONEMAP).toContain('tanh(min(over / max(1.0 - SHOULDER, 1e-4), ROLLOFF_REACH))');
  });

  it('bounds it where tanh is already 1 and before a ratio of exponentials overflows', () => {
    expect(Number.isFinite(reach)).toBe(true);
    expect(f32(Math.tanh(reach))).toBe(1);
    expect(Number.isNaN(tanhAsRatio(100))).toBe(true);
    for (const x of [0, 1, reach / 2, reach]) expect(Number.isFinite(tanhAsRatio(x))).toBe(true);
  });
});
