/**
 * Tone curve sampling.
 *
 * Interpolation is monotone (Fritsch–Carlson): a plain cubic spline overshoots
 * between control points, and an overshoot in a tone curve is a dark ring around
 * a highlight, which reads as a defect rather than a grade.
 */

export type CurvePoint = readonly [number, number];

/** Build a lookup table over the 0..1 display-referred domain. */
export function buildCurveLut(points: readonly CurvePoint[], size = 256): Float32Array {
  const pts = [...points].sort((a, b) => a[0] - b[0]);
  const n = pts.length;
  const lut = new Float32Array(size);
  if (n < 2) {
    for (let i = 0; i < size; i++) lut[i] = i / (size - 1);
    return lut;
  }

  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);

  // Secant slopes between neighbouring points.
  const delta = new Array<number>(n - 1);
  for (let i = 0; i < n - 1; i++) {
    const dx = (xs[i + 1] as number) - (xs[i] as number);
    delta[i] = dx > 1e-9 ? ((ys[i + 1] as number) - (ys[i] as number)) / dx : 0;
  }

  // Tangents, then the Fritsch–Carlson correction that keeps them monotone.
  const m = new Array<number>(n);
  m[0] = delta[0] as number;
  m[n - 1] = delta[n - 2] as number;
  for (let i = 1; i < n - 1; i++) {
    const d0 = delta[i - 1] as number;
    const d1 = delta[i] as number;
    m[i] = d0 * d1 <= 0 ? 0 : (d0 + d1) / 2;
  }
  for (let i = 0; i < n - 1; i++) {
    const d = delta[i] as number;
    if (d === 0) {
      m[i] = 0;
      m[i + 1] = 0;
      continue;
    }
    const a = (m[i] as number) / d;
    const b = (m[i + 1] as number) / d;
    const s = a * a + b * b;
    if (s > 9) {
      const t = 3 / Math.sqrt(s);
      m[i] = t * a * d;
      m[i + 1] = t * b * d;
    }
  }

  let seg = 0;
  for (let i = 0; i < size; i++) {
    const x = i / (size - 1);
    while (seg < n - 2 && x > (xs[seg + 1] as number)) seg++;
    const x0 = xs[seg] as number;
    const x1 = xs[seg + 1] as number;
    const h = x1 - x0;
    if (h <= 1e-9) {
      lut[i] = ys[seg + 1] as number;
      continue;
    }
    const t = Math.min(1, Math.max(0, (x - x0) / h));
    const t2 = t * t;
    const t3 = t2 * t;
    const h00 = 2 * t3 - 3 * t2 + 1;
    const h10 = t3 - 2 * t2 + t;
    const h01 = -2 * t3 + 3 * t2;
    const h11 = t3 - t2;
    lut[i] =
      h00 * (ys[seg] as number) +
      h10 * h * (m[seg] as number) +
      h01 * (ys[seg + 1] as number) +
      h11 * h * (m[seg + 1] as number);
  }
  return lut;
}
