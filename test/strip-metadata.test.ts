/**
 * Metadata removal is a promise the product makes, so it is asserted against the
 * bytes that would be written to disk rather than against the fact that the
 * removal function was called.
 */

import { describe, expect, it } from 'vitest';
import {
  detectFormat,
  remainingMetadataBlocks,
  stripJpegMetadata,
  stripMetadata,
  stripPngMetadata,
  stripWebpMetadata,
} from '../src/core/io/strip-metadata';
import {
  ascii,
  cleanJpeg,
  concat,
  ICC_PAYLOAD,
  indexOfBytes,
  jpegWithMetadata,
  pngWithMetadata,
  webpWithMetadata,
} from './helpers/images';

describe('format detection', () => {
  it('identifies containers by their magic bytes', () => {
    expect(detectFormat(jpegWithMetadata().bytes)).toBe('jpeg');
    expect(detectFormat(pngWithMetadata())).toBe('png');
    expect(detectFormat(webpWithMetadata())).toBe('webp');
    expect(detectFormat(ascii('not an image at all'))).toBeNull();
  });

  it('refuses to pass an unknown container through untouched', () => {
    // Returning the input would look like success while shipping whatever the
    // file happened to contain.
    expect(() => stripMetadata(ascii('not an image at all'))).toThrow(/unrecognised/);
  });
});

describe('JPEG', () => {
  it('removes the EXIF block, GPS included', () => {
    const { bytes, tiff } = jpegWithMetadata();
    expect(indexOfBytes(bytes, tiff)).toBeGreaterThan(-1);

    const stripped = stripJpegMetadata(bytes);

    expect(indexOfBytes(stripped, tiff)).toBe(-1);
    expect(indexOfBytes(stripped, ascii('Exif\0\0'))).toBe(-1);
    expect(remainingMetadataBlocks(stripped)).toEqual([]);
  });

  it('removes the embedded thumbnail while keeping the JFIF density fields', () => {
    const stripped = stripJpegMetadata(jpegWithMetadata().bytes);
    expect(indexOfBytes(stripped, ascii('JFIF\0'))).toBeGreaterThan(-1);
    // A 2x2 thumbnail is twelve bytes of 0x7f; the dimensions must read zero.
    expect(indexOfBytes(stripped, new Uint8Array(12).fill(0x7f))).toBe(-1);
  });

  it('removes comments and application blocks other than the colour profile', () => {
    const stripped = stripJpegMetadata(jpegWithMetadata().bytes);
    expect(indexOfBytes(stripped, ascii('Photoshop 3.0'))).toBe(-1);
    expect(indexOfBytes(stripped, ascii('shot with a camera'))).toBe(-1);
  });

  it('keeps the colour profile', () => {
    // Dropping it would leave the file displayed against the wrong primaries,
    // which undoes the whole colour pipeline.
    const stripped = stripJpegMetadata(jpegWithMetadata().bytes);
    expect(indexOfBytes(stripped, ICC_PAYLOAD)).toBeGreaterThan(-1);
  });

  it('preserves the scan and cuts everything after the end-of-image marker', () => {
    const { bytes, scan } = jpegWithMetadata();
    const stripped = stripJpegMetadata(bytes);

    const at = indexOfBytes(stripped, scan);
    expect(at).toBeGreaterThan(-1);
    expect(at + scan.length).toBe(stripped.length);
    expect(indexOfBytes(stripped, ascii('trailing junk'))).toBe(-1);
  });

  it('is idempotent', () => {
    const once = stripJpegMetadata(jpegWithMetadata().bytes);
    expect(Array.from(stripJpegMetadata(once))).toEqual(Array.from(once));
  });
});

describe('PNG', () => {
  it('removes text, timestamp and EXIF chunks but keeps the profile', () => {
    const stripped = stripPngMetadata(pngWithMetadata());
    expect(remainingMetadataBlocks(stripped)).toEqual([]);
    expect(indexOfBytes(stripped, ascii('iCCP'))).toBeGreaterThan(-1);
    expect(indexOfBytes(stripped, ascii('IDAT'))).toBeGreaterThan(-1);
    expect(indexOfBytes(stripped, ascii('someone'))).toBe(-1);
  });
});

describe('WebP', () => {
  it('removes the EXIF and XMP chunks', () => {
    const stripped = stripWebpMetadata(webpWithMetadata());
    expect(remainingMetadataBlocks(stripped)).toEqual([]);
    expect(indexOfBytes(stripped, ascii('ICCP'))).toBeGreaterThan(-1);
    expect(indexOfBytes(stripped, ascii('<x:xmpmeta/>'))).toBe(-1);
  });

  it('clears the metadata flags the extended header advertises', () => {
    const stripped = stripWebpMetadata(webpWithMetadata());
    const at = indexOfBytes(stripped, ascii('VP8X'));
    const flags = stripped[at + 8] as number;
    expect(flags & 0x08).toBe(0); // EXIF
    expect(flags & 0x04).toBe(0); // XMP
    expect(flags & 0x20).toBe(0x20); // ICC profile is still there
  });

  it('rewrites the container length to match what is left', () => {
    const stripped = stripWebpMetadata(webpWithMetadata());
    const declared = new DataView(stripped.buffer, stripped.byteOffset).getUint32(4, true);
    expect(declared).toBe(stripped.length - 8);
  });
});

describe('JPEG segment classes', () => {
  function segmentOf(marker: number, payload: Uint8Array): Uint8Array {
    const length = payload.length + 2;
    return concat([Uint8Array.of(0xff, marker, length >> 8, length & 0xff), payload]);
  }

  /** A clean JPEG with one extra segment right behind the start-of-image marker. */
  function withSegment(marker: number, payload: Uint8Array): Uint8Array {
    const base = cleanJpeg();
    return concat([base.subarray(0, 2), segmentOf(marker, payload), base.subarray(2)]);
  }

  const dropped: [string, number, Uint8Array][] = [
    ['XMP', 0xe1, concat([ascii('http://ns.adobe.com/xap/1.0/\0'), ascii('<x:xmpmeta/>')])],
    [
      'extended XMP',
      0xe1,
      concat([ascii('http://ns.adobe.com/xmp/extension/\0'), ascii('more xmp')]),
    ],
    ['JFXX thumbnail', 0xe0, concat([ascii('JFXX\0'), Uint8Array.of(0x10), ascii('thumb')])],
    ['APP3', 0xe3, ascii('Meta\0 private')],
    ['APP12', 0xec, ascii('Ducky')],
    ['APP14', 0xee, ascii('Adobe\0 transform')],
    ['Photoshop', 0xed, concat([ascii('Photoshop 3.0\0'), ascii('8BIM')])],
    ['comment', 0xfe, ascii('a note')],
  ];

  it.each(dropped)(
    'removes %s and the verifier reports it beforehand',
    (_name, marker, payload) => {
      const bytes = withSegment(marker, payload);
      expect(remainingMetadataBlocks(bytes).length).toBeGreaterThan(0);
      const stripped = stripJpegMetadata(bytes);
      expect(remainingMetadataBlocks(stripped)).toEqual([]);
      expect(indexOfBytes(stripped, payload)).toBe(-1);
    },
  );

  it('does not report the colour profile or a thumbnail-free JFIF', () => {
    const jfif = concat([ascii('JFIF\0'), Uint8Array.of(1, 2, 1, 0, 72, 0, 72, 0, 0)]);
    const bytes = concat([
      cleanJpeg().subarray(0, 2),
      segmentOf(0xe0, jfif),
      segmentOf(0xe2, ICC_PAYLOAD),
      cleanJpeg().subarray(2),
    ]);
    expect(remainingMetadataBlocks(bytes)).toEqual([]);
  });
});
