import { afterEach, describe, expect, it, vi } from 'vitest';
import { encodeImage } from '../src/core/io/encode';
import { readImageExif } from '../src/core/io/exif';
import { exportImage } from '../src/core/io/export';
import { remainingMetadataBlocks } from '../src/core/io/strip-metadata';
import { neutralRecipe } from '../src/core/recipe/schema';
import {
  cleanJpeg,
  cleanPng,
  indexOfBytes,
  jpegWithMetadata,
  pngWithMetadata,
  webpWithMetadata,
} from './helpers/images';

/** A canvas whose encoder hands back fixed bytes whatever type is asked for. */
function stubCanvas(produce: Uint8Array, type: string) {
  class FakeCanvas {
    getContext() {
      return { putImageData() {} };
    }
    convertToBlob() {
      return Promise.resolve(new Blob([produce as BlobPart], { type }));
    }
  }
  vi.stubGlobal('OffscreenCanvas', FakeCanvas);
  vi.stubGlobal(
    'ImageData',
    class {
      constructor(
        public data: Uint8ClampedArray,
        public width: number,
        public height: number,
      ) {}
    },
  );
}

const pixels = { width: 2, height: 2, data: new Uint8ClampedArray(16) } as unknown as ImageData;

afterEach(() => vi.unstubAllGlobals());

describe('the container actually produced', () => {
  it('names a PNG fallback for a WebP request as PNG', async () => {
    stubCanvas(cleanPng(), 'image/png');
    const output = { ...neutralRecipe().output, format: 'webp' as const };
    const encoded = await encodeImage(pixels, output);
    expect(encoded.mime).toBe('image/png');
    expect(encoded.extension).toBe('png');
  });

  it('takes the file name from the produced container, not the request', async () => {
    stubCanvas(cleanPng(), 'image/png');
    const recipe = neutralRecipe();
    recipe.output = { ...recipe.output, format: 'webp' };
    const result = await exportImage(pixels, recipe, 'photo.jpg', []);
    expect(result.files[0]?.name).toBe('photo-nitra.png');
  });

  it('keeps a JPEG request a .jpg', async () => {
    stubCanvas(cleanJpeg(), 'image/jpeg');
    const recipe = neutralRecipe();
    recipe.output = { ...recipe.output, format: 'jpeg' };
    const result = await exportImage(pixels, recipe, 'photo.heic', []);
    expect(result.files[0]?.name).toBe('photo-nitra.jpg');
  });
});

describe('metadata on the real export path', () => {
  const wide = { width: 4, height: 2, data: new Uint8ClampedArray(32) } as unknown as ImageData;
  const tiles = [
    { row: 0, col: 0, post: 2, x: 0, y: 0, width: 2, height: 2 },
    { row: 0, col: 1, post: 1, x: 2, y: 0, width: 2, height: 2 },
  ];
  const cases = [
    ['jpeg', 'image/jpeg', () => jpegWithMetadata().bytes],
    ['png', 'image/png', () => pngWithMetadata()],
    ['webp', 'image/webp', () => webpWithMetadata()],
  ] as const;

  async function files(
    format: 'jpeg' | 'png' | 'webp',
    mime: string,
    produced: Uint8Array,
    metadata: ReturnType<typeof neutralRecipe>['output']['metadata'],
    split: boolean,
  ) {
    stubCanvas(produced, mime);
    const recipe = neutralRecipe();
    recipe.output = { ...recipe.output, format, metadata };
    const result = await exportImage(wide, recipe, 'photo.jpg', split ? tiles : [], null);
    return Promise.all(result.files.map(async (f) => new Uint8Array(await f.blob.arrayBuffer())));
  }

  it.each(cases)(
    'leaves nothing of the encoder output in a %s export, every tile',
    async (format, mime, make) => {
      const strip = neutralRecipe().output.metadata;
      for (const split of [false, true]) {
        const out = await files(format, mime, make(), { ...strip, mode: 'strip' }, split);
        expect(out.length).toBe(split ? 2 : 1);
        for (const bytes of out) {
          expect(remainingMetadataBlocks(bytes)).toEqual([]);
          expect(readImageExif(bytes).gps).toBeNull();
        }
      }
    },
  );

  it.each(cases.filter(([f]) => f !== 'webp'))(
    'writes only the built block into a %s export, every tile',
    async (format, mime, make) => {
      const base = neutralRecipe().output.metadata;
      const metadata = {
        ...base,
        mode: 'custom' as const,
        credit: { ...base.credit, write: true, artist: 'Somebody' },
      };
      for (const split of [false, true]) {
        const out = await files(format, mime, make(), metadata, split);
        for (const bytes of out) {
          expect(remainingMetadataBlocks(bytes)).toHaveLength(1);
          const exif = readImageExif(bytes);
          expect(exif.artist).toBe('Somebody');
          // The encoder output carried a location; only what was built may remain.
          expect(exif.gps).toBeNull();
          expect(indexOfBytes(bytes, jpegWithMetadata().tiff)).toBe(-1);
        }
      }
    },
  );
});
