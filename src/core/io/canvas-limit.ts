/**
 * How many pixels this browser lets one 2D canvas hold.
 *
 * The encoder writes a file through a canvas of the file's own size, so this is
 * a ceiling on every exported file. Mobile Safari refuses a canvas past 4096²
 * pixels by handing back no context; elsewhere the ceiling is past the largest
 * texture a photo can be held in, so it never binds.
 */

/** Mobile Safari's canvas area ceiling. */
export const SAFARI_CANVAS_AREA = 4096 * 4096;

let probed: number | null = null;

/** The largest area one canvas may cover, probed once per session. */
export function canvasPixelLimit(): number {
  if (probed === null) probed = probe();
  return probed;
}

function probe(): number {
  // Just past the ceiling: a browser that grants this grants anything a photo needs.
  const side = 4097;
  try {
    if (typeof OffscreenCanvas !== 'undefined') {
      const canvas = new OffscreenCanvas(side, side);
      const held = canvas.getContext('2d') !== null;
      canvas.width = 0;
      canvas.height = 0;
      return held ? Number.POSITIVE_INFINITY : SAFARI_CANVAS_AREA;
    }
    if (typeof document !== 'undefined') {
      const canvas = document.createElement('canvas');
      canvas.width = side;
      canvas.height = side;
      const held = canvas.getContext('2d') !== null;
      canvas.width = 0;
      canvas.height = 0;
      return held ? Number.POSITIVE_INFINITY : SAFARI_CANVAS_AREA;
    }
  } catch {
    return SAFARI_CANVAS_AREA;
  }
  return Number.POSITIVE_INFINITY;
}
