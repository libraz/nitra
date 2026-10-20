/**
 * Ingest-time reduction for a photo larger than the GPU can hold.
 *
 * A source texture past `MAX_TEXTURE_SIZE` is refused by the driver and the
 * stage renders black, so a photo over it is brought down to the limit once,
 * here, rather than not opening. The average is an area average in linear
 * light, weighted by alpha, for the same reason the framing resamples in linear
 * light: the mean of encoded values is not the mean of the light.
 */

import { transferFromLinear } from '../color/spaces';
import { linearTable } from '../plate/blur';

export interface Pixels {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

/** Resolution of the linear-to-code table; a step is a twentieth of a code value at black. */
const ENCODE_STEPS = 65535;

/** Input spans and their coverage for each output index along one axis. */
function axisWeights(from: number, to: number): { start: Int32Array; weights: Float32Array[] } {
  const ratio = from / to;
  const start = new Int32Array(to);
  const weights: Float32Array[] = [];
  for (let i = 0; i < to; i++) {
    const a = i * ratio;
    const b = Math.min(from, (i + 1) * ratio);
    const first = Math.floor(a);
    const last = Math.min(from, Math.ceil(b));
    const w = new Float32Array(last - first);
    for (let j = first; j < last; j++) w[j - first] = (Math.min(b, j + 1) - Math.max(a, j)) / ratio;
    start[i] = first;
    weights.push(w);
  }
  return { start, weights };
}

/**
 * The photo with its long edge at most `maxEdge`, or the same object when it
 * already fits.
 */
export function shrinkToFit(image: Pixels, maxEdge: number): Pixels {
  const { width, height, data } = image;
  const long = Math.max(width, height);
  if (long <= maxEdge) return image;

  const scale = maxEdge / long;
  const outWidth = Math.max(1, Math.min(maxEdge, Math.round(width * scale)));
  const outHeight = Math.max(1, Math.min(maxEdge, Math.round(height * scale)));
  const cols = axisWeights(width, outWidth);
  const rows = axisWeights(height, outHeight);
  const toLinear = linearTable();
  const toCode = new Uint8ClampedArray(ENCODE_STEPS + 1);
  for (let i = 0; i <= ENCODE_STEPS; i++) {
    toCode[i] = Math.round(transferFromLinear(i / ENCODE_STEPS) * 255);
  }

  // One input row reduced horizontally, premultiplied linear RGBA. A boundary
  // row feeds two output rows, so the last one is kept.
  const line = new Float32Array(outWidth * 4);
  let lineRow = -1;
  const reduceRow = (y: number) => {
    if (y === lineRow) return;
    lineRow = y;
    line.fill(0);
    const base = y * width * 4;
    for (let ox = 0; ox < outWidth; ox++) {
      const w = cols.weights[ox] as Float32Array;
      let at = base + (cols.start[ox] as number) * 4;
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let k = 0; k < w.length; k++, at += 4) {
        const alpha = ((data[at + 3] as number) / 255) * (w[k] as number);
        r += (toLinear[data[at] as number] as number) * alpha;
        g += (toLinear[data[at + 1] as number] as number) * alpha;
        b += (toLinear[data[at + 2] as number] as number) * alpha;
        a += alpha;
      }
      line[ox * 4] = r;
      line[ox * 4 + 1] = g;
      line[ox * 4 + 2] = b;
      line[ox * 4 + 3] = a;
    }
  };

  const out = new Uint8ClampedArray(outWidth * outHeight * 4);
  const acc = new Float32Array(outWidth * 4);
  for (let oy = 0; oy < outHeight; oy++) {
    acc.fill(0);
    const w = rows.weights[oy] as Float32Array;
    const first = rows.start[oy] as number;
    for (let k = 0; k < w.length; k++) {
      reduceRow(first + k);
      const weight = w[k] as number;
      for (let i = 0; i < acc.length; i++)
        acc[i] = (acc[i] as number) + (line[i] as number) * weight;
    }
    const base = oy * outWidth * 4;
    for (let ox = 0; ox < outWidth; ox++) {
      const alpha = acc[ox * 4 + 3] as number;
      const at = base + ox * 4;
      if (alpha > 0) {
        for (let c = 0; c < 3; c++) {
          const linear = Math.min(1, (acc[ox * 4 + c] as number) / alpha);
          out[at + c] = toCode[Math.round(linear * ENCODE_STEPS)] as number;
        }
      }
      out[at + 3] = Math.round(alpha * 255);
    }
  }
  return { data: out, width: outWidth, height: outHeight };
}
