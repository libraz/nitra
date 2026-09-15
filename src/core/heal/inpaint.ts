/**
 * The Heal stage's host side: cutting a region out, and putting it back.
 *
 * The inpainting itself is the one piece of hand-written WebAssembly in the
 * project (`crates/heal`), and everything here is the arithmetic around it: how
 * large a region one spot needs, where that region sits in the photograph, and
 * the copy across the module boundary.
 *
 * It never runs inside the drag loop. A module that reads pixels has to be given
 * them, and giving it pixels while a slider is moving means a synchronous read
 * that stops the pipeline — the slider stops following the pointer, which is the
 * one thing the whole proxy renderer exists to prevent. So this runs once per
 * spot, against the photograph as it was decoded, and what the renderer samples
 * afterwards is the result.
 */

/** Where the compiled module is served from. See `scripts/build-wasm.ts`. */
const MODULE_URL = 'wasm/heal.wasm';

/**
 * How far past the spot the region reaches, in multiples of its radius.
 *
 * The region is the only place the fill can copy from, so this is not a margin
 * for safety — it is the entire library of skin available to the search. Too
 * narrow and there is nothing to copy; much wider and the search wanders off
 * onto a different part of the face, and the cost grows with the area.
 */
const REGION_MARGIN = 1.6;

/** Softness of the join, as a fraction of the spot's radius. */
const FEATHER = 0.35;

/** Smallest spot worth running the module for, in pixels of radius. */
const LEAST_RADIUS = 1.5;

export class HealError extends Error {}

/** The module's exports, as the host uses them. */
export interface Healer {
  memory: WebAssembly.Memory;
  allocate: (len: number) => number;
  release: (ptr: number, len: number) => void;
  heal: (
    ptr: number,
    width: number,
    height: number,
    cx: number,
    cy: number,
    radius: number,
    feather: number,
  ) => number;
}

let loading: Promise<Healer> | null = null;

/**
 * Load the module, once per session.
 *
 * Held as the pending promise rather than the resolved value, so two spots
 * placed in quick succession wait on one fetch instead of starting two. A failed
 * load is not remembered as a load: the next spot tries again rather than
 * inheriting a rejected promise for the rest of the session.
 */
export function loadHealer(): Promise<Healer> {
  if (loading) return loading;
  loading = (async () => {
    const response = await fetch(MODULE_URL);
    if (!response.ok) {
      throw new HealError(`${MODULE_URL}: ${response.status} ${response.statusText}`);
    }
    const { instance } = await WebAssembly.instantiate(await response.arrayBuffer(), {});
    const exports = instance.exports as unknown as Healer;
    for (const name of ['memory', 'allocate', 'release', 'heal'] as const) {
      if (!exports[name]) throw new HealError(`the inpainting module has no ${name}`);
    }
    return exports;
  })().catch((cause) => {
    loading = null;
    throw cause instanceof HealError
      ? cause
      : new HealError(cause instanceof Error ? cause.message : 'the inpainting module failed');
  });
  return loading;
}

/** A spot as the recipe holds it: normalised centre, radius in image widths. */
export interface HealSpot {
  x: number;
  y: number;
  r: number;
}

/** A rectangle of the photograph, in whole pixels. */
export interface Region {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * The part of the photograph one spot is worked on.
 *
 * Clamped to the frame rather than centred on the spot at all costs: a blemish
 * near an edge gets a region that reaches further the other way, which is the
 * only place there is anything to copy from.
 */
export function regionFor(
  spot: HealSpot,
  imageWidth: number,
  imageHeight: number,
): { region: Region; centre: [number, number]; radius: number } {
  const radius = Math.max(1, spot.r * imageWidth);
  const reach = Math.ceil(radius * (1 + REGION_MARGIN));
  const cx = spot.x * imageWidth;
  const cy = spot.y * imageHeight;
  const x = Math.max(0, Math.min(imageWidth - 1, Math.round(cx - reach)));
  const y = Math.max(0, Math.min(imageHeight - 1, Math.round(cy - reach)));
  const right = Math.max(x + 1, Math.min(imageWidth, Math.round(cx + reach)));
  const bottom = Math.max(y + 1, Math.min(imageHeight, Math.round(cy + reach)));
  return {
    region: { x, y, width: right - x, height: bottom - y },
    centre: [cx - x, cy - y],
    radius,
  };
}

/** Copy one rectangle out of an RGBA image. */
export function cutOut(
  pixels: Uint8ClampedArray,
  imageWidth: number,
  region: Region,
): Uint8ClampedArray {
  const out = new Uint8ClampedArray(region.width * region.height * 4);
  for (let row = 0; row < region.height; row++) {
    const from = ((region.y + row) * imageWidth + region.x) * 4;
    out.set(pixels.subarray(from, from + region.width * 4), row * region.width * 4);
  }
  return out;
}

/** Write one rectangle back into an RGBA image. */
export function pasteInto(
  pixels: Uint8ClampedArray,
  imageWidth: number,
  region: Region,
  patch: Uint8ClampedArray,
): void {
  for (let row = 0; row < region.height; row++) {
    const to = ((region.y + row) * imageWidth + region.x) * 4;
    pixels.set(patch.subarray(row * region.width * 4, (row + 1) * region.width * 4), to);
  }
}

/**
 * Fill one spot, in place, in the photograph's own pixels.
 *
 * The plate is mutated rather than copied per spot, which is what lets two
 * overlapping spots compose: the second one reads what the first left behind, the
 * same way it would if a person had healed them one after the other.
 *
 * @returns How many pixels the fill reached, or zero when there was nothing to
 * do — a spot smaller than a pixel, or one whose region is filled by the hole
 * and so has no photograph left to copy from.
 */
export function healSpot(
  module: Healer,
  plate: Uint8ClampedArray,
  imageWidth: number,
  imageHeight: number,
  spot: HealSpot,
): number {
  const { region, centre, radius } = regionFor(spot, imageWidth, imageHeight);
  if (radius < LEAST_RADIUS) return 0;

  const patch = cutOut(plate, imageWidth, region);
  const ptr = module.allocate(patch.length);
  try {
    new Uint8Array(module.memory.buffer, ptr, patch.length).set(patch);
    const touched = module.heal(
      ptr,
      region.width,
      region.height,
      centre[0],
      centre[1],
      radius,
      radius * FEATHER,
    );
    if (touched === 0) return 0;
    // Read back before the buffer is handed over, and copy rather than view:
    // the module's memory can move under a later allocation, and a view into it
    // would then be pointing at somebody else's bytes.
    pasteInto(
      plate,
      imageWidth,
      region,
      new Uint8ClampedArray(new Uint8Array(module.memory.buffer, ptr, patch.length)),
    );
    return touched;
  } finally {
    module.release(ptr, patch.length);
  }
}
