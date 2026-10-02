/**
 * Export: rendered pixels to a file the user can keep.
 *
 * Metadata removal runs as a step of this path and its result is checked before
 * the bytes are handed back, so "no location data in the export" is enforced
 * here rather than assumed of the encoder.
 *
 * Removal runs on every export, including the ones that go on to write a
 * metadata block of their own. A file carries what the recipe asked it to carry
 * and nothing the encoder happened to leave behind, and the only way to be sure
 * of that is to clear the slate first and check that it is clear.
 */

import type { OutputParams } from '../recipe/schema';
import { buildExifTiff, type ExifFields, embedExif, hasExifFields } from './exif-write';
import {
  detectFormat,
  type ImageFormat,
  remainingMetadataBlocks,
  stripMetadata,
} from './strip-metadata';

/** The one place a container's MIME type and file extension are written down. */
const CONTAINER: Record<ImageFormat, { mime: string; extension: string }> = {
  jpeg: { mime: 'image/jpeg', extension: 'jpg' },
  png: { mime: 'image/png', extension: 'png' },
  webp: { mime: 'image/webp', extension: 'webp' },
};

/** What happened to the exported file's metadata block. */
export type MetadataOutcome = 'removed' | 'written';

export interface EncodedImage {
  blob: Blob;
  /** What the encoder actually produced, which may not be what was asked for. */
  mime: string;
  /** File extension of the container actually produced. */
  extension: string;
  metadata: MetadataOutcome;
}

function makeCanvas(width: number, height: number): OffscreenCanvas | HTMLCanvasElement {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(width, height);
  const el = document.createElement('canvas');
  el.width = width;
  el.height = height;
  return el;
}

async function toBlob(
  canvas: OffscreenCanvas | HTMLCanvasElement,
  type: string,
  quality: number,
): Promise<Blob> {
  if ('convertToBlob' in canvas) return canvas.convertToBlob({ type, quality });
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('encoding failed'))),
      type,
      quality,
    );
  });
}

/**
 * Encode rendered pixels.
 *
 * `pixels` is already in `output.space`; the render pipeline converted and
 * dithered it, so nothing here touches colour.
 *
 * `fields` is the metadata block to write, or null to write none. It arrives
 * already resolved: deciding what a recipe means is the recipe's business, and
 * this function's business is that the bytes come out matching.
 */
export async function encodeImage(
  pixels: ImageData,
  output: OutputParams,
  fields: ExifFields | null = null,
): Promise<EncodedImage> {
  const canvas = makeCanvas(pixels.width, pixels.height);
  const ctx = canvas.getContext('2d', {
    colorSpace: output.space,
  }) as CanvasRenderingContext2D | null;
  if (!ctx) throw new Error('2D canvas unavailable');
  ctx.putImageData(pixels, 0, 0);

  const encoded = await toBlob(canvas, CONTAINER[output.format].mime, output.quality);

  // A browser that cannot encode the requested type hands back another one, so
  // everything downstream follows the bytes rather than the request.
  const raw = new Uint8Array(await encoded.arrayBuffer());
  const container = detectFormat(raw);
  if (!container) throw new Error('encoder produced an unrecognised image format');
  const { mime, extension } = CONTAINER[container];

  const cleaned = stripMetadata(raw);
  const left = remainingMetadataBlocks(cleaned);
  if (left.length > 0) {
    throw new Error(`metadata removal incomplete: ${left.join(', ')}`);
  }

  if (fields && hasExifFields(fields)) {
    const written = embedExif(cleaned, buildExifTiff(fields));
    return {
      blob: new Blob([written as BlobPart], { type: mime }),
      mime,
      extension,
      metadata: 'written',
    };
  }

  return {
    blob: new Blob([cleaned as BlobPart], { type: mime }),
    mime,
    extension,
    metadata: 'removed',
  };
}

/** Suggested file name for an export, derived from the source name. */
export function exportFileName(sourceName: string, format: OutputParams['format']): string {
  const stem = sourceName.replace(/\.[^.]+$/, '') || 'nitra';
  return `${stem}-nitra.${CONTAINER[format].extension}`;
}
