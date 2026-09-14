/**
 * Row-major 3x3 matrix helpers.
 *
 * Colour transforms are composed here rather than hand-written as a single
 * flattened constant, so the numbers that reach a shader are always the product
 * of the published primaries instead of arithmetic done once by hand.
 */

/** Row-major 3x3 matrix: `[m00, m01, m02, m10, ..., m22]`. */
export type Mat3 = readonly [
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
];

export type Vec3 = readonly [number, number, number];

export function mat3Mul(a: Mat3, b: Mat3): Mat3 {
  const out = new Array<number>(9);
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      let sum = 0;
      for (let k = 0; k < 3; k++) sum += (a[r * 3 + k] as number) * (b[k * 3 + c] as number);
      out[r * 3 + c] = sum;
    }
  }
  return out as unknown as Mat3;
}

export function mat3Apply(m: Mat3, v: Vec3): Vec3 {
  return [
    m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
    m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
    m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
  ];
}

export function mat3Det(m: Mat3): number {
  return (
    m[0] * (m[4] * m[8] - m[5] * m[7]) -
    m[1] * (m[3] * m[8] - m[5] * m[6]) +
    m[2] * (m[3] * m[7] - m[4] * m[6])
  );
}

export function mat3Inverse(m: Mat3): Mat3 {
  const det = mat3Det(m);
  if (Math.abs(det) < 1e-12) throw new Error('matrix is singular');
  const i = 1 / det;
  return [
    (m[4] * m[8] - m[5] * m[7]) * i,
    (m[2] * m[7] - m[1] * m[8]) * i,
    (m[1] * m[5] - m[2] * m[4]) * i,
    (m[5] * m[6] - m[3] * m[8]) * i,
    (m[0] * m[8] - m[2] * m[6]) * i,
    (m[2] * m[3] - m[0] * m[5]) * i,
    (m[3] * m[7] - m[4] * m[6]) * i,
    (m[1] * m[6] - m[0] * m[7]) * i,
    (m[0] * m[4] - m[1] * m[3]) * i,
  ];
}

export const MAT3_IDENTITY: Mat3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];

/**
 * Emit a matrix as a GLSL `mat3(...)` constructor.
 *
 * GLSL takes columns first, so the row-major storage is transposed here. Every
 * shader that needs a colour transform interpolates this rather than carrying a
 * literal of its own.
 */
export function mat3ToGlsl(m: Mat3): string {
  const col = [m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]];
  return `mat3(${col.map((v) => v.toPrecision(10)).join(', ')})`;
}
