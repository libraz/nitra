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
  orientationSwapsAxes,
  readImageExif,
  readJpegOrientation,
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

/** HEIF is identified by its `ftyp` brand, never by the file extension. */
export function isHeif(bytes: Uint8Array): boolean {
  if (bytes.length < 12) return false;
  if (
    bytes[4] !== 0x66 ||
    bytes[5] !== 0x74 ||
    bytes[6] !== 0x79 ||
    bytes[7] !== 0x70 // 'ftyp'
  ) {
    return false;
  }
  const brand = String.fromCharCode(...bytes.subarray(8, 12));
  return ['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'mif1', 'msf1', 'avif'].includes(brand);
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

  // The affine below maps stored pixels onto upright ones; it is the inverse of
  // what the orientation tag describes, expressed in device pixels.
  switch (orientation) {
    case 2:
      ctx.transform(-1, 0, 0, 1, width, 0);
      break;
    case 3:
      ctx.transform(-1, 0, 0, -1, width, height);
      break;
    case 4:
      ctx.transform(1, 0, 0, -1, 0, height);
      break;
    case 5:
      ctx.transform(0, 1, 1, 0, 0, 0);
      break;
    case 6:
      ctx.transform(0, 1, -1, 0, width, 0);
      break;
    case 7:
      ctx.transform(0, -1, -1, 0, width, height);
      break;
    case 8:
      ctx.transform(0, -1, 1, 0, 0, height);
      break;
    default:
      break;
  }
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
  let source: CanvasImageSource;
  let width: number;
  let height: number;

  // HEIF keeps its metadata in the ISO container rather than in a block this
  // walker understands, so a HEIF photo opens with no tags to show. Nothing is
  // carried across silently either, which is the direction that matters.
  const exif = readImageExif(bytes);

  if (isHeif(bytes) && detectFormat(bytes) === null) {
    const decoded = await decodeHeif(bytes);
    const holder = makeCanvas(decoded.width, decoded.height);
    const ctx = context2d(holder, 'srgb');
    if (!ctx) throw new Error('2D canvas unavailable');
    ctx.putImageData(decoded, 0, 0);
    source = holder as unknown as CanvasImageSource;
    width = decoded.width;
    height = decoded.height;
  } else {
    if (detectFormat(bytes) === 'jpeg') orientation = readJpegOrientation(bytes);
    // Orientation is applied here rather than by the decoder so that the result
    // does not depend on which browser is running.
    const bitmap = await createImageBitmap(new Blob([bytes as BlobPart]), {
      imageOrientation: 'none',
      colorSpaceConversion: 'default',
    });
    source = bitmap;
    width = bitmap.width;
    height = bitmap.height;
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
