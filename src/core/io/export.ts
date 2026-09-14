/**
 * Turning a rendered picture into the files the user walks away with.
 *
 * One edit does not always mean one file. A picture split across a grid of posts
 * is still one edit, and cutting it after the render rather than rendering each
 * tile separately is what keeps the grain, the vignette and the tone identical
 * across the seams — evaluate a tile on its own and its vignette is centred on
 * the tile instead of on the photo.
 */

import type { TileRect } from '../geometry/tiles';
import { tileFileName } from '../geometry/tiles';
import type { OutputParams, Recipe } from '../recipe/schema';
import { encodeImage, type MetadataOutcome } from './encode';
import type { SourceExif } from './exif';
import { metadataFields } from './metadata';
import { buildZip, type ZipEntry } from './zip';

const EXTENSION: Record<OutputParams['format'], string> = {
  jpeg: 'jpg',
  png: 'png',
  webp: 'webp',
};

export interface ExportedFile {
  name: string;
  blob: Blob;
}

export interface ExportResult {
  files: ExportedFile[];
  /** Every file in one archive, or null when there is only one of them. */
  archive: ExportedFile | null;
  mime: string;
  metadata: MetadataOutcome;
  /** Size of one file, which is the size of one tile when the picture is split. */
  width: number;
  height: number;
}

/** The stem every exported file is named from. */
function exportStem(sourceName: string): string {
  return `${sourceName.replace(/\.[^.]+$/, '') || 'nitra'}-nitra`;
}

/**
 * Cut one tile out of a rendered picture.
 *
 * Copying row by row rather than through a canvas keeps the pixels exactly as
 * the renderer produced them: a round trip through a 2D context would resample
 * and re-encode work that is already finished.
 */
export function sliceImageData(image: ImageData, rect: TileRect): ImageData {
  const out = new Uint8ClampedArray(rect.width * rect.height * 4);
  const stride = image.width * 4;
  for (let row = 0; row < rect.height; row++) {
    const from = (rect.y + row) * stride + rect.x * 4;
    out.set(image.data.subarray(from, from + rect.width * 4), row * rect.width * 4);
  }
  return new ImageData(out, rect.width, rect.height, { colorSpace: image.colorSpace });
}

/**
 * Encode a rendered picture, split into tiles if the recipe asks for it.
 *
 * Metadata removal runs per file and is verified per file, because a promise
 * that holds for the first tile and not the ninth is not a promise. When a
 * block is being written instead, every tile gets the same one: the tiles are
 * one photograph, so the time and the place are the same for all of them.
 */
export async function exportImage(
  pixels: ImageData,
  recipe: Recipe,
  sourceName: string,
  tiles: readonly TileRect[],
  sourceExif: SourceExif | null = null,
): Promise<ExportResult> {
  const stem = exportStem(sourceName);
  const extension = EXTENSION[recipe.output.format];
  const files: ExportedFile[] = [];
  let mime = '';
  let metadata: MetadataOutcome = 'removed';

  if (tiles.length <= 1) {
    const fields = metadataFields(recipe.output.metadata, sourceExif, pixels.width, pixels.height);
    const encoded = await encodeImage(pixels, recipe.output, fields);
    files.push({ name: `${stem}.${extension}`, blob: encoded.blob });
    return {
      files,
      archive: null,
      mime: encoded.mime,
      metadata: encoded.metadata,
      width: pixels.width,
      height: pixels.height,
    };
  }

  const entries: ZipEntry[] = [];
  for (const tile of tiles) {
    const fields = metadataFields(recipe.output.metadata, sourceExif, tile.width, tile.height);
    const encoded = await encodeImage(sliceImageData(pixels, tile), recipe.output, fields);
    const name = tileFileName(stem, extension, tile, tiles.length);
    files.push({ name, blob: encoded.blob });
    entries.push({ name, data: new Uint8Array(await encoded.blob.arrayBuffer()) });
    mime = encoded.mime;
    metadata = encoded.metadata;
  }

  const first = tiles[0] as TileRect;
  return {
    files,
    archive: {
      name: `${stem}-${tiles.length}.zip`,
      blob: new Blob([buildZip(entries) as BlobPart], { type: 'application/zip' }),
    },
    mime,
    metadata,
    width: first.width,
    height: first.height,
  };
}
