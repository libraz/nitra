/**
 * A HEIF photo is declared in the space its file names, because libheif hands
 * its pixels back in those primaries without converting them.
 */

import { describe, expect, it, vi } from 'vitest';
import { iccSpace } from '../src/core/color/profile';
import { decodeSourceFile, heifColorSpace } from '../src/core/io/decode';

vi.mock('libheif-js/wasm-bundle', () => {
  class HeifDecoder {
    decode() {
      return [
        {
          get_width: () => 2,
          get_height: () => 1,
          display(
            target: { data: Uint8ClampedArray },
            done: (result: { data: Uint8ClampedArray } | null) => void,
          ) {
            target.data.set([255, 0, 0, 255, 0, 255, 0, 255]);
            done(target);
          },
        },
      ];
    }
  }
  return { default: { HeifDecoder } };
});

type Xyz = [number, number, number];

/** Colorants as the published profiles carry them, adapted to D50. */
const SRGB_ICC: Xyz[] = [
  [0.4361, 0.2225, 0.0139],
  [0.3851, 0.7169, 0.0971],
  [0.1431, 0.0606, 0.7141],
];
const DISPLAY_P3_ICC: Xyz[] = [
  [0.5151, 0.2412, -0.0011],
  [0.2919, 0.6922, 0.0419],
  [0.1571, 0.0666, 0.7841],
];
const ADOBE_RGB_ICC: Xyz[] = [
  [0.6097, 0.3111, 0.0195],
  [0.2053, 0.6257, 0.0609],
  [0.1492, 0.0632, 0.7446],
];

const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));
const u16 = (v: number) => [(v >> 8) & 0xff, v & 0xff];
const u32 = (v: number) => [(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff];

function box(type: string, ...payload: number[][]): number[] {
  const body = payload.flat();
  return [...u32(body.length + 8), ...ascii(type), ...body];
}

function icc(colorants: Xyz[]): number[] {
  const tags = ['rXYZ', 'gXYZ', 'bXYZ'];
  const out = new Array<number>(128).fill(0);
  out.push(...u32(tags.length));
  const dataStart = 132 + tags.length * 12;
  for (const [i, tag] of tags.entries()) {
    out.push(...ascii(tag), ...u32(dataStart + i * 20), ...u32(20));
  }
  for (const xyz of colorants) {
    out.push(...ascii('XYZ '), 0, 0, 0, 0);
    for (const v of xyz) out.push(...u32(Math.round(v * 65536) >>> 0));
  }
  return out;
}

const nclx = (primaries: number) =>
  box('colr', ascii('nclx'), u16(primaries), u16(13), u16(1), [0x80]);
const prof = (colorants: Xyz[]) => box('colr', ascii('prof'), icc(colorants));

/** A HEIF file whose items are associated with the given properties, by one-based index. */
function heif(
  properties: number[][],
  associations: [item: number, indices: number[]][],
  tiles: number[] = [],
): Uint8Array {
  const ipma = box(
    'ipma',
    [0, 0, 0, 0],
    u32(associations.length),
    ...associations.map(([item, indices]) => [...u16(item), indices.length, ...indices]),
  );
  const iref = tiles.length
    ? [box('iref', [0, 0, 0, 0], box('dimg', u16(1), u16(tiles.length), ...tiles.map(u16)))]
    : [];
  const meta = box(
    'meta',
    [0, 0, 0, 0],
    box('pitm', [0, 0, 0, 0], u16(1)),
    ...iref,
    box('iprp', box('ipco', ...properties), ipma),
  );
  return new Uint8Array([...box('ftyp', ascii('heic'), u32(0), ascii('mif1heic')), ...meta]);
}

describe('ICC colorants', () => {
  it('names the two spaces the pipeline knows and nothing else', () => {
    expect(iccSpace(new Uint8Array(icc(SRGB_ICC)))).toBe('srgb');
    expect(iccSpace(new Uint8Array(icc(DISPLAY_P3_ICC)))).toBe('display-p3');
    expect(iccSpace(new Uint8Array(icc(ADOBE_RGB_ICC)))).toBeNull();
    expect(iccSpace(new Uint8Array(64))).toBeNull();
  });
});

describe('the space a HEIF file names', () => {
  it('reads a Display-P3 profile on the primary image', () => {
    expect(heifColorSpace(heif([prof(DISPLAY_P3_ICC)], [[1, [1]]]))).toBe('display-p3');
  });

  it("reads a grid's tiles when the image itself names nothing", () => {
    const file = heif(
      [prof(DISPLAY_P3_ICC)],
      [
        [1, []],
        [2, [1]],
        [3, [1]],
      ],
      [2, 3],
    );
    expect(heifColorSpace(file)).toBe('display-p3');
  });

  it('reads nclx primaries, and prefers a recognised profile over them', () => {
    expect(heifColorSpace(heif([nclx(12)], [[1, [1]]]))).toBe('display-p3');
    expect(heifColorSpace(heif([nclx(1)], [[1, [1]]]))).toBe('srgb');
    expect(heifColorSpace(heif([nclx(1), prof(DISPLAY_P3_ICC)], [[1, [1, 2]]]))).toBe('display-p3');
    expect(heifColorSpace(heif([prof(ADOBE_RGB_ICC), nclx(12)], [[1, [1, 2]]]))).toBe('display-p3');
  });

  it("falls back to BT.709's primaries when nothing is named", () => {
    expect(heifColorSpace(heif([], [[1, []]]))).toBe('srgb');
    expect(heifColorSpace(heif([nclx(9)], [[1, [1]]]))).toBe('srgb');
    expect(heifColorSpace(new Uint8Array(32))).toBe('srgb');
  });

  it('opens a Display-P3 HEIF declared as Display-P3, with its pixels unconverted', async () => {
    const file = heif([prof(DISPLAY_P3_ICC)], [[1, [1]]]);
    const image = await decodeSourceFile(new Blob([file as BlobPart]), 'photo.heic');
    expect(image.space).toBe('display-p3');
    expect([...image.data]).toEqual([255, 0, 0, 255, 0, 255, 0, 255]);
  });
});
