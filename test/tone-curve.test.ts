/**
 * The tone curve's lookup.
 *
 * The grade shader's addressing is pinned by its text, and the same arithmetic
 * is then run against linear, edge-clamped sampling as WebGL2 specifies it, so
 * a curve passing through its own control points is a property of the shader
 * rather than of a second implementation.
 */

import { describe, expect, it } from 'vitest';
import { buildCurveLut, type CurvePoint } from '../src/core/recipe/curve';
import { GRADE_FRAGMENT } from '../src/core/render/shaders/passes';

const curveFunction = GRADE_FRAGMENT.slice(
  GRADE_FRAGMENT.indexOf('float curveAt('),
  GRADE_FRAGMENT.indexOf('void main()'),
);

/** GL_LINEAR with CLAMP_TO_EDGE: texel i is centred at (i + 0.5) / size. */
function sample(lut: Float32Array, u: number): number {
  const x = u * lut.length - 0.5;
  const i = Math.floor(x);
  const f = x - i;
  const at = (k: number) => lut[Math.min(lut.length - 1, Math.max(0, k))] as number;
  return at(i) * (1 - f) + at(i + 1) * f;
}

/** `curveAt` as the shader writes it, line for line. */
function curveAt(lut: Float32Array, d: number): number {
  const size = lut.length;
  const u = (Math.min(1, Math.max(0, d)) * (size - 1) + 0.5) / size;
  return sample(lut, u) + Math.max(d - 1, 0);
}

/** The table read at d * (size - 1), interpolating between entries. */
function tableAt(lut: Float32Array, d: number): number {
  const x = d * (lut.length - 1);
  const i = Math.min(lut.length - 2, Math.floor(x));
  const f = x - i;
  return (lut[i] as number) * (1 - f) + (lut[i + 1] as number) * f;
}

const S_CURVE: CurvePoint[] = [
  [0, 0],
  [0.25, 0.18],
  [0.75, 0.84],
  [1, 1],
];

describe('tone curve lookup', () => {
  it('is the arithmetic the shader carries', () => {
    expect(curveFunction).toContain('float size = float(textureSize(lut, 0).x);');
    expect(curveFunction).toContain('float u = (clamp(d, 0.0, 1.0) * (size - 1.0) + 0.5) / size;');
    expect(curveFunction).toContain('return texture(lut, vec2(u, 0.5)).r + max(d - 1.0, 0.0);');
  });

  it('hands every channel to the lookup unclamped', () => {
    const block = GRADE_FRAGMENT.slice(GRADE_FRAGMENT.indexOf('if (uUseCurve == 1)'));
    expect(block).toMatch(
      /curveAt\(uCurve, d\.r\), curveAt\(uCurve, d\.g\), curveAt\(uCurve, d\.b\)/,
    );
    expect(block.slice(0, block.indexOf('curveAt'))).not.toMatch(/clamp\(/);
  });

  it('reads the table at d * (size - 1) across the whole range', () => {
    for (const points of [[] as CurvePoint[], S_CURVE]) {
      const lut = buildCurveLut(points);
      for (let k = 0; k <= 1000; k++) {
        const d = k / 1000;
        expect(Math.abs(curveAt(lut, d) - tableAt(lut, d))).toBeLessThan(1e-6);
      }
    }
  });

  it('passes through its control points, and an identity curve returns d', () => {
    const lut = buildCurveLut(S_CURVE);
    for (const [x, y] of S_CURVE) expect(Math.abs(curveAt(lut, x) - y)).toBeLessThan(1e-4);
    const identity = buildCurveLut([]);
    for (let k = 0; k <= 1000; k++) {
      expect(Math.abs(curveAt(identity, k / 1000) - k / 1000)).toBeLessThan(1e-6);
    }
  });

  it('keeps highlights above white distinct and increasing', () => {
    const identity = buildCurveLut([]);
    for (const d of [1, 1.2, 1.7, 3]) expect(curveAt(identity, d)).toBeCloseTo(d, 6);

    const lowered = buildCurveLut([
      [0, 0],
      [1, 0.9],
    ]);
    expect(curveAt(lowered, 1)).toBeCloseTo(0.9, 6);
    let previous = curveAt(lowered, 0.999);
    for (let k = 0; k <= 40; k++) {
      const value = curveAt(lowered, 1 + k * 0.05);
      expect(value).toBeGreaterThan(previous);
      previous = value;
    }
  });
});
