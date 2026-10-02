/**
 * Ingest: file bytes to upright, colour-tagged pixels.
 *
 * Two things are settled here and never revisited downstream. Orientation is
 * baked into the pixels, so every later stage may assume the image is upright.
 * And the source is resolved onto one known encoding, so the renderer converts
 * from a space it was told about rather than one it guessed.
 */

import type { ColorSpaceName } from '../color/spaces';
import {
  type Orientation,
  orientationMatrix,
  orientationSwapsAxes,
  readImageExif,
  readImageOrientation,
  type SourceExif,
} from './exif';
import { detectFormat } from './strip-metadata';

export interface SourceImage {
  width: number;
  height: number;
  /** Non-linear RGBA, 8 bits per channel, encoded in {@link space}. */
  data: Uint8ClampedArray;
  space: ColorSpaceName;
  /** Orientation found in the file; already applied to `data`. */
  orientation: Orientation;
  /**
   * The editable tags the file arrived with.
   *
   * Held so the metadata panel can show them and offer to carry them across. It
   * is a copy of the fields, not of the file's block: nothing else in the
   * original metadata survives being opened.
   */
  exif: SourceExif;
  fileName: string;
  byteSize: number;
}

type Canvas2D = OffscreenCanvas | HTMLCanvasElement;

function makeCanvas(width: number, height: number): Canvas2D {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(width, height);
  const el = document.createElement('canvas');
  el.width = width;
  el.height = height;
  return el;
}

function context2d(canvas: Canvas2D, space: ColorSpaceName): CanvasRenderingContext2D | null {
  const ctx = canvas.getContext('2d', {
    colorSpace: space,
    willReadFrequently: true,
  }) as CanvasRenderingContext2D | null;
  return ctx;
}

/** True when the runtime can actually hold Display-P3 in a canvas. */
function canvasSupportsP3(): boolean {
  try {
    const probe = makeCanvas(1, 1);
    const ctx = context2d(probe, 'display-p3');
    if (!ctx) return false;
    const settings = ctx.getContextAttributes?.() as { colorSpace?: string } | undefined;
    return settings?.colorSpace === 'display-p3';
  } catch {
    return false;
  }
}

const AVIF_BRANDS = ['avif', 'avis'];
const HEIF_BRANDS = ['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'mif1', 'msf1'];

/** The `ftyp` major brand of an ISO base media file, or null. */
function heifBrand(bytes: Uint8Array): string | null {
  if (bytes.length < 12) return null;
  if (
    bytes[4] !== 0x66 ||
    bytes[5] !== 0x74 ||
    bytes[6] !== 0x79 ||
    bytes[7] !== 0x70 // 'ftyp'
  ) {
    return null;
  }
  return String.fromCharCode(...bytes.subarray(8, 12));
}

/** HEIF is identified by its `ftyp` brand, never by the file extension. */
export function isHeif(bytes: Uint8Array): boolean {
  const brand = heifBrand(bytes);
  return brand !== null && (HEIF_BRANDS.includes(brand) || AVIF_BRANDS.includes(brand));
}

/**
 * Which decoder a file goes to, decided once from its codec.
 *
 * `browser` is the platform's own decoder. `avif` is tried there first, because
 * libheif's wasm build is HEVC-only and cannot read AV1. `heif` is libheif
 * first, for HEVC brands that most browsers cannot open.
 */
export type DecoderRoute = 'browser' | 'avif' | 'heif';

export function routeDecoder(bytes: Uint8Array): DecoderRoute {
  if (detectFormat(bytes) !== null) return 'browser';
  const brand = heifBrand(bytes);
  if (brand !== null && AVIF_BRANDS.includes(brand)) return 'avif';
  if (brand !== null && HEIF_BRANDS.includes(brand)) return 'heif';
  return 'browser';
}

/**
 * Decode HEIF through libheif.
 *
 * Only Safari decodes HEIF natively, so the wasm build is loaded on demand — it
 * is around two megabytes and most sessions never open a HEIF file.
 */
async function decodeHeif(bytes: Uint8Array): Promise<ImageData> {
  const libheif = (await import('libheif-js/wasm-bundle')).default;
  const images = new libheif.HeifDecoder().decode(bytes);
  const image = images[0];
  if (!image) throw new Error('HEIF file contains no image');

  const width = image.get_width();
  const height = image.get_height();
  const pixels = new Uint8ClampedArray(width * height * 4);
  const ok = await new Promise<boolean>((resolve) => {
    image.display({ data: pixels, width, height }, (result) => {
      resolve(result !== null);
    });
  });
  if (!ok) throw new Error('HEIF decode failed');
  return new ImageData(pixels, width, height, { colorSpace: 'srgb' });
}

/**
 * Draw a decoded source into a canvas of the working encoding, applying the
 * orientation transform on the way in.
 */
function drawUpright(
  source: CanvasImageSource,
  sourceWidth: number,
  sourceHeight: number,
  orientation: Orientation,
  space: ColorSpaceName,
): ImageData {
  const swap = orientationSwapsAxes(orientation);
  const width = swap ? sourceHeight : sourceWidth;
  const height = swap ? sourceWidth : sourceHeight;

  const canvas = makeCanvas(width, height);
  const ctx = context2d(canvas, space);
  if (!ctx) throw new Error('2D canvas unavailable');

  // The matrix maps stored pixels onto upright ones; its translation is a
  // fraction of the output size.
  const [a, b, c, d, tx, ty] = orientationMatrix(orientation);
  ctx.transform(a, b, c, d, tx * width, ty * height);
  ctx.drawImage(source, 0, 0);
  return ctx.getImageData(0, 0, width, height, { colorSpace: space });
}

/**
 * Read a user-supplied file into the pipeline.
 *
 * Format is decided by the magic bytes rather than the name, because a photo
 * copied off a phone routinely arrives as `.jpg` holding HEIF.
 */
export async function decodeSourceFile(file: File | Blob, fileName: string): Promise<SourceImage> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const space: ColorSpaceName = canvasSupportsP3() ? 'display-p3' : 'srgb';

  let orientation: Orientation = 1;
  let source: CanvasImageSource | undefined;
  let width = 0;
  let height = 0;

  // HEIF keeps its metadata in the ISO container rather than in a block this
  // walker understands, so a HEIF photo opens with no tags to show. Nothing is
  // carried across silently either, which is the direction that matters.
  const exif = readImageExif(bytes);

  const route = routeDecoder(bytes);
  if (route === 'browser' || route === 'avif') {
    orientation = readImageOrientation(bytes);
    // Orientation is applied here rather than by the decoder so that the result
    // does not depend on which browser is running.
    try {
      const bitmap = await createImageBitmap(new Blob([bytes as BlobPart]), {
        imageOrientation: 'none',
        colorSpaceConversion: 'default',
      });
      source = bitmap;
      width = bitmap.width;
      height = bitmap.height;
    } catch (err) {
      // Only an AVIF file has a second decoder to fall back to.
      if (route === 'browser') throw err;
    }
  }
  if (!source) {
    const decoded = await decodeHeif(bytes);
    const holder = makeCanvas(decoded.width, decoded.height);
    const ctx = context2d(holder, 'srgb');
    if (!ctx) throw new Error('2D canvas unavailable');
    ctx.putImageData(decoded, 0, 0);
    source = holder as unknown as CanvasImageSource;
    width = decoded.width;
    height = decoded.height;
  }

  const imageData = drawUpright(source, width, height, orientation, space);
  if ('close' in source && typeof source.close === 'function') source.close();

  return {
    width: imageData.width,
    height: imageData.height,
    data: imageData.data,
    space,
    orientation,
    exif,
    fileName,
    byteSize: bytes.length,
  };
}
