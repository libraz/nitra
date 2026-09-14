/**
 * JPEG segment walking.
 *
 * Shared by orientation reading and metadata removal so both agree on where a
 * segment starts and ends.
 */

export const SOI = 0xd8;
export const EOI = 0xd9;
export const SOS = 0xda;
export const APP0 = 0xe0;
export const APP1 = 0xe1;
export const APP2 = 0xe2;
export const APP13 = 0xed;
export const APP14 = 0xee;
export const COM = 0xfe;

export interface JpegSegment {
  marker: number;
  /** Offset of the `0xFF` that introduces the marker. */
  start: number;
  /** Offset one past the segment's payload. */
  end: number;
  /** Payload without the two-byte length field. */
  payload: Uint8Array;
}

/** Markers that stand alone and carry no length field. */
function isStandalone(marker: number): boolean {
  return marker === SOI || marker === EOI || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7);
}

export function isJpeg(bytes: Uint8Array): boolean {
  return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === SOI && bytes[2] === 0xff;
}

/**
 * Walk the segments ahead of the first scan.
 *
 * Iteration stops at `SOS`: past that point the file is entropy-coded data with
 * no segment structure to walk.
 */
export function* jpegSegments(bytes: Uint8Array): Generator<JpegSegment> {
  if (!isJpeg(bytes)) throw new Error('not a JPEG');
  let pos = 2;
  while (pos + 1 < bytes.length) {
    if (bytes[pos] !== 0xff) {
      // Fill bytes are legal between segments; skip to the next marker.
      pos++;
      continue;
    }
    let marker = bytes[pos + 1] as number;
    let markerAt = pos;
    while (marker === 0xff && markerAt + 2 < bytes.length) {
      markerAt++;
      marker = bytes[markerAt + 1] as number;
    }
    if (isStandalone(marker)) {
      yield { marker, start: markerAt, end: markerAt + 2, payload: new Uint8Array(0) };
      pos = markerAt + 2;
      continue;
    }
    if (markerAt + 4 > bytes.length) return;
    const length = ((bytes[markerAt + 2] as number) << 8) | (bytes[markerAt + 3] as number);
    if (length < 2) return;
    const end = Math.min(markerAt + 2 + length, bytes.length);
    yield {
      marker,
      start: markerAt,
      end,
      payload: bytes.subarray(markerAt + 4, end),
    };
    if (marker === SOS) return;
    pos = end;
  }
}

/** Offset one past the end-of-image marker, or the file length if absent. */
export function jpegEndOfImage(bytes: Uint8Array, from: number): number {
  for (let i = from; i + 1 < bytes.length; i++) {
    if (bytes[i] === 0xff && bytes[i + 1] === EOI) return i + 2;
  }
  return bytes.length;
}

/** True when a segment payload starts with the given ASCII identifier. */
export function payloadStartsWith(payload: Uint8Array, ascii: string): boolean {
  if (payload.length < ascii.length) return false;
  for (let i = 0; i < ascii.length; i++) {
    if (payload[i] !== ascii.charCodeAt(i)) return false;
  }
  return true;
}
