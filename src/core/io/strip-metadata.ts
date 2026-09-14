/**
 * Metadata removal.
 *
 * A canvas encoder happens not to carry EXIF across today, so an exported file
 * currently comes out clean whether or not this module runs. That is exactly why
 * it runs anyway: the protection is incidental, and the day the encoder is
 * swapped for WebCodecs it would disappear without anything failing. Removal is
 * a step in the export path with a test behind it, not a side effect.
 *
 * The colour profile is the one thing kept. Drop it and the exported file is
 * displayed against the wrong primaries, which undoes the entire colour pipeline.
 */

import {
  APP0,
  APP1,
  APP2,
  EOI,
  isJpeg,
  jpegEndOfImage,
  jpegSegments,
  payloadStartsWith,
  SOS,
} from './jpeg';

export type ImageFormat = 'jpeg' | 'png' | 'webp';

export function detectFormat(bytes: Uint8Array): ImageFormat | null {
  if (isJpeg(bytes)) return 'jpeg';
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) {
    return 'png';
  }
  if (bytes.length >= 12 && ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP') {
    return 'webp';
  }
  return null;
}

function ascii(bytes: Uint8Array, at: number, len: number): string {
  let s = '';
  for (let i = 0; i < len; i++) s += String.fromCharCode(bytes[at + i] as number);
  return s;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/**
 * Rebuild a JFIF APP0 without its thumbnail.
 *
 * The density fields are worth keeping; the thumbnail is the classic way an
 * unedited copy of the photo escapes inside the edited one.
 */
function jfifWithoutThumbnail(payload: Uint8Array): Uint8Array | null {
  if (payload.length < 14) return null;
  const head = payload.subarray(0, 14);
  const out = new Uint8Array(14);
  out.set(head);
  out[12] = 0; // thumbnail width
  out[13] = 0; // thumbnail height
  return out;
}

function jpegSegmentBytes(marker: number, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(payload.length + 4);
  out[0] = 0xff;
  out[1] = marker;
  const length = payload.length + 2;
  out[2] = (length >> 8) & 0xff;
  out[3] = length & 0xff;
  out.set(payload, 4);
  return out;
}

/**
 * Remove every application and comment segment from a JPEG except the embedded
 * ICC profile, and cut anything appended after the end-of-image marker.
 */
export function stripJpegMetadata(bytes: Uint8Array): Uint8Array {
  const parts: Uint8Array[] = [Uint8Array.of(0xff, 0xd8)];
  let scanStart = -1;

  for (const seg of jpegSegments(bytes)) {
    if (seg.marker === 0xd8) continue;
    if (seg.marker === SOS) {
      scanStart = seg.start;
      break;
    }
    const isApp = seg.marker >= 0xe0 && seg.marker <= 0xef;
    const isComment = seg.marker === 0xfe;

    if (seg.marker === APP2 && payloadStartsWith(seg.payload, 'ICC_PROFILE\0')) {
      parts.push(jpegSegmentBytes(seg.marker, seg.payload));
      continue;
    }
    if (seg.marker === APP0 && payloadStartsWith(seg.payload, 'JFIF\0')) {
      const trimmed = jfifWithoutThumbnail(seg.payload);
      if (trimmed) parts.push(jpegSegmentBytes(APP0, trimmed));
      continue;
    }
    if (isApp || isComment) continue;
    parts.push(bytes.subarray(seg.start, seg.end));
  }

  if (scanStart < 0) throw new Error('JPEG has no scan');
  parts.push(bytes.subarray(scanStart, jpegEndOfImage(bytes, scanStart)));
  return concat(parts);
}

/** PNG chunks that can carry text, timestamps or an embedded EXIF block. */
const PNG_DROP = new Set(['eXIf', 'tEXt', 'zTXt', 'iTXt', 'tIME', 'dSIG']);

export function stripPngMetadata(bytes: Uint8Array): Uint8Array {
  const parts: Uint8Array[] = [bytes.subarray(0, 8)];
  let pos = 8;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  while (pos + 8 <= bytes.length) {
    const length = view.getUint32(pos);
    const type = ascii(bytes, pos + 4, 4);
    const end = pos + 12 + length;
    if (end > bytes.length) break;
    if (!PNG_DROP.has(type)) parts.push(bytes.subarray(pos, end));
    pos = end;
    if (type === 'IEND') break;
  }
  return concat(parts);
}

/** RIFF chunks that carry metadata rather than picture data. */
const WEBP_DROP = new Set(['EXIF', 'XMP ']);

export function stripWebpMetadata(bytes: Uint8Array): Uint8Array {
  const body: Uint8Array[] = [];
  let pos = 12;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  while (pos + 8 <= bytes.length) {
    const fourcc = ascii(bytes, pos, 4);
    const size = view.getUint32(pos + 4, true);
    const padded = size + (size & 1);
    const end = pos + 8 + padded;
    if (end > bytes.length) break;

    if (!WEBP_DROP.has(fourcc)) {
      const chunk = bytes.slice(pos, end);
      // The extended header advertises which metadata chunks follow; leaving the
      // flags set after dropping the chunks makes the file inconsistent.
      if (fourcc === 'VP8X' && chunk.length > 8) {
        chunk[8] = (chunk[8] as number) & ~0x0c;
      }
      body.push(chunk);
    }
    pos = end;
  }

  const size = 4 + body.reduce((n, c) => n + c.length, 0);
  const header = new Uint8Array(12);
  header.set(bytes.subarray(0, 12));
  new DataView(header.buffer).setUint32(4, size, true);
  return concat([header, ...body]);
}

/**
 * Remove identifying metadata from an encoded image.
 *
 * Throws on a format it cannot walk. Returning the input untouched would look
 * like success while shipping the photo's GPS coordinates.
 */
export function stripMetadata(bytes: Uint8Array): Uint8Array {
  const format = detectFormat(bytes);
  switch (format) {
    case 'jpeg':
      return stripJpegMetadata(bytes);
    case 'png':
      return stripPngMetadata(bytes);
    case 'webp':
      return stripWebpMetadata(bytes);
    default:
      throw new Error('cannot strip metadata: unrecognised image format');
  }
}

/**
 * Names of metadata containers still present in an encoded image.
 *
 * Used by the export tests to assert the removal actually happened rather than
 * trusting that it was called.
 */
export function remainingMetadataBlocks(bytes: Uint8Array): string[] {
  const found: string[] = [];
  const format = detectFormat(bytes);

  if (format === 'jpeg') {
    for (const seg of jpegSegments(bytes)) {
      if (seg.marker === SOS || seg.marker === EOI) break;
      if (seg.marker === APP1 && payloadStartsWith(seg.payload, 'Exif\0\0')) found.push('Exif');
      else if (seg.marker === APP1 && payloadStartsWith(seg.payload, 'http://ns.adobe.com/xap'))
        found.push('XMP');
      else if (seg.marker === 0xed) found.push('Photoshop');
      else if (seg.marker === 0xfe) found.push('Comment');
      else if (seg.marker === APP0 && payloadStartsWith(seg.payload, 'JFXX\0'))
        found.push('JFIF-thumbnail');
      else if (seg.marker === APP0 && payloadStartsWith(seg.payload, 'JFIF\0')) {
        if ((seg.payload[12] ?? 0) !== 0 || (seg.payload[13] ?? 0) !== 0)
          found.push('JFIF-thumbnail');
      }
    }
    return found;
  }

  if (format === 'png') {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let pos = 8;
    while (pos + 8 <= bytes.length) {
      const length = view.getUint32(pos);
      const type = ascii(bytes, pos + 4, 4);
      if (PNG_DROP.has(type)) found.push(type);
      pos += 12 + length;
      if (type === 'IEND') break;
    }
    return found;
  }

  if (format === 'webp') {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let pos = 12;
    while (pos + 8 <= bytes.length) {
      const fourcc = ascii(bytes, pos, 4);
      const size = view.getUint32(pos + 4, true);
      if (WEBP_DROP.has(fourcc)) found.push(fourcc.trim());
      pos += 8 + size + (size & 1);
    }
    return found;
  }

  throw new Error('cannot inspect metadata: unrecognised image format');
}
