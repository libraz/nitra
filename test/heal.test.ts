/**
 * The Heal stage, both halves of it.
 *
 * The arithmetic around the module is asserted over the whole cross-product of
 * where a spot can sit and how large it can be, rather than over cases chosen by
 * hand: a region that slips outside the frame or loses the spot it was cut for
 * is a crash or a fill in the wrong place, and the combination that does it is
 * the one nobody would think to try.
 *
 * The module itself is loaded from the build tree. It is compiled rather than
 * committed, so `bun run test` builds it first — unconditionally, because the
 * alternative is a suite that skips the only test of the only hand-written
 * WebAssembly in the project and reports the same green either way.
 */

import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  cutOut,
  type Healer,
  type HealSpot,
  healSpot,
  pasteInto,
  type Region,
  regionFor,
} from '../src/core/heal/inpaint';

const WASM = new URL('../public/wasm/heal.wasm', import.meta.url);

let healer: Healer;

beforeAll(async () => {
  const { instance } = await WebAssembly.instantiate(readFileSync(WASM), {});
  healer = instance.exports as unknown as Healer;
});

/**
 * A patch of synthetic skin with a dark blemish in the middle of it.
 *
 * Slow shading, fine grain on top of it, and a round mark. All three are needed:
 * the shading is what a fill has to follow rather than flatten, the grain is
 * what it has to bring with it, and the mark is what has to go.
 */
function skin(
  size: number,
  blemish: { cx: number; cy: number; r: number } | null = null,
): Uint8ClampedArray {
  const out = new Uint8ClampedArray(size * size * 4);
  let state = 12345;
  const noise = () => {
    state = (state * 1103515245 + 12345) >>> 0;
    return state / 4294967296 - 0.5;
  };
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const shade = 170 + 25 * Math.sin(x / 28) + 15 * Math.cos(y / 22);
      const grain = noise() * 26;
      const mark = blemish && Math.hypot(x - blemish.cx, y - blemish.cy) < blemish.r ? -55 : 0;
      out[i] = shade + grain + mark;
      out[i + 1] = shade * 0.82 + grain + mark;
      out[i + 2] = shade * 0.72 + grain + mark;
      out[i + 3] = 255;
    }
  }
  return out;
}

/** Mean lightness over the pixels a predicate picks out. */
function mean(
  pixels: Uint8ClampedArray,
  size: number,
  pick: (x: number, y: number) => boolean,
): number {
  let total = 0;
  let count = 0;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (!pick(x, y)) continue;
      const i = (y * size + x) * 4;
      total += ((pixels[i] as number) + (pixels[i + 1] as number) + (pixels[i + 2] as number)) / 3;
      count += 1;
    }
  }
  return count > 0 ? total / count : 0;
}

/** How much high frequency there is, which on skin is the pores. */
function detail(
  pixels: Uint8ClampedArray,
  size: number,
  pick: (x: number, y: number) => boolean,
): number {
  let total = 0;
  let count = 0;
  for (let y = 1; y < size - 1; y++) {
    for (let x = 1; x < size - 1; x++) {
      if (!pick(x, y)) continue;
      const i = (y * size + x) * 4;
      const around =
        ((pixels[i - 4] as number) +
          (pixels[i + 4] as number) +
          (pixels[i - size * 4] as number) +
          (pixels[i + size * 4] as number)) /
        4;
      total += Math.abs((pixels[i] as number) - around);
      count += 1;
    }
  }
  return count > 0 ? total / count : 0;
}

describe('the region one spot is worked on', () => {
  // Every position, size and frame shape a spot can arrive with, as a
  // cross-product. Exhaustive because it is arithmetic and costs nothing, and
  // because it removes the question of whether the case that breaks an invariant
  // was one of the ones picked.
  const positions = [0, 0.5, 1];
  const radii = [0, 0.0005, 0.02, 0.3];
  const shapes: [number, number][] = [
    [4240, 2832],
    [2832, 4240],
    [800, 800],
  ];
  const cases: { spot: HealSpot; width: number; height: number }[] = [];
  for (const x of positions) {
    for (const y of positions) {
      for (const r of radii) {
        for (const [width, height] of shapes) cases.push({ spot: { x, y, r }, width, height });
      }
    }
  }

  it('covers the cross-product it claims to', () => {
    expect(cases).toHaveLength(positions.length * positions.length * radii.length * shapes.length);
  });

  it('stays inside the photograph', () => {
    for (const { spot, width, height } of cases) {
      const { region } = regionFor(spot, width, height);
      const where = `${JSON.stringify(spot)} on ${width}x${height}`;
      expect(region.x, where).toBeGreaterThanOrEqual(0);
      expect(region.y, where).toBeGreaterThanOrEqual(0);
      expect(region.x + region.width, where).toBeLessThanOrEqual(width);
      expect(region.y + region.height, where).toBeLessThanOrEqual(height);
      expect(region.width, where).toBeGreaterThan(0);
      expect(region.height, where).toBeGreaterThan(0);
    }
  });

  it('puts the spot where the region says it is', () => {
    // The centre is handed to the module in the region's own coordinates. Off by
    // the region's offset, the fill lands somewhere else entirely — and on a
    // spot near an edge, where the region is no longer centred on it, that is
    // exactly the mistake available to make.
    for (const { spot, width, height } of cases) {
      const { region, centre } = regionFor(spot, width, height);
      const where = `${JSON.stringify(spot)} on ${width}x${height}`;
      expect(centre[0] + region.x, where).toBeCloseTo(spot.x * width, 6);
      expect(centre[1] + region.y, where).toBeCloseTo(spot.y * height, 6);
    }
  });

  it('keeps the radius a fraction of the width on any frame shape', () => {
    // Of the width, not of the longest edge: a blemish is a size on a face, and
    // the same recipe has to mean the same size on a portrait and a landscape.
    const tall = regionFor({ x: 0.5, y: 0.5, r: 0.02 }, 1000, 2000).radius;
    const wide = regionFor({ x: 0.5, y: 0.5, r: 0.02 }, 1000, 500).radius;
    expect(tall).toBeCloseTo(wide, 6);
    expect(tall).toBeCloseTo(20, 6);
  });

  it('gives the fill somewhere to copy from', () => {
    // The region is not a margin for safety, it is the entire library of skin
    // the search has. A region only as large as the hole leaves nothing.
    for (const { spot, width, height } of cases) {
      const { region, radius } = regionFor(spot, width, height);
      const area = region.width * region.height;
      const hole = Math.PI * radius * radius;
      // Clamped at an edge the region loses at most half of each axis, so a
      // quarter of the full area is the worst case worth asserting.
      expect(area, `${JSON.stringify(spot)} on ${width}x${height}`).toBeGreaterThan(hole);
    }
  });
});

describe('cutting a region out and putting it back', () => {
  it('round-trips a rectangle that is not the whole image', () => {
    const size = 16;
    const image = skin(size);
    const region: Region = { x: 3, y: 5, width: 7, height: 4 };
    const patch = cutOut(image, size, region);
    expect(patch).toHaveLength(region.width * region.height * 4);

    const blank = new Uint8ClampedArray(image.length);
    pasteInto(blank, size, region, patch);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const i = (y * size + x) * 4;
        const inside =
          x >= region.x &&
          x < region.x + region.width &&
          y >= region.y &&
          y < region.y + region.height;
        expect(blank[i], `${x},${y}`).toBe(inside ? image[i] : 0);
      }
    }
  });
});

describe('filling a blemish', () => {
  const SIZE = 64;
  const SPOT = { cx: 32, cy: 32, r: 7 };
  const inside = (x: number, y: number) => Math.hypot(x - SPOT.cx, y - SPOT.cy) < 6;
  const around = (x: number, y: number) => {
    const d = Math.hypot(x - SPOT.cx, y - SPOT.cy);
    return d > 14 && d < 26;
  };
  // A spot in image coordinates that lands on the synthetic blemish. The region
  // is the whole patch, so the module sees exactly what is built above.
  const spot: HealSpot = { x: 0.5078125, y: 0.5078125, r: 8 / SIZE };

  it('takes the mark back to the skin around it', () => {
    const marked = skin(SIZE, SPOT);
    const plate = new Uint8ClampedArray(marked);
    expect(healSpot(healer, plate, SIZE, SIZE, spot)).toBeGreaterThan(0);
    const surround = mean(marked, SIZE, around);
    expect(mean(marked, SIZE, inside)).toBeLessThan(surround - 30);
    expect(mean(plate, SIZE, inside)).toBeCloseTo(surround, -1);
  });

  it('leaves the pores behind rather than a smooth patch', () => {
    // The assertion this stage exists for. Averaging the surroundings would
    // clear the mark just as well and come back with a fraction of the detail,
    // which is the plastic skin the rest of the pipeline is built to avoid — so
    // the fill is measured against the texture of the skin it sits in.
    const plate = skin(SIZE, SPOT);
    healSpot(healer, plate, SIZE, SIZE, spot);
    const kept = detail(plate, SIZE, inside) / detail(skin(SIZE), SIZE, around);
    expect(kept).toBeGreaterThan(0.8);
  });

  it('touches nothing outside the spot and its join', () => {
    const marked = skin(SIZE, SPOT);
    const plate = new Uint8ClampedArray(marked);
    const { radius } = regionFor(spot, SIZE, SIZE);
    healSpot(healer, plate, SIZE, SIZE, spot);
    for (let y = 0; y < SIZE; y++) {
      for (let x = 0; x < SIZE; x++) {
        // The join reaches a little past the radius; beyond that the photograph
        // has to be untouched, or a spot brush is a global adjustment.
        if (Math.hypot(x - SPOT.cx, y - SPOT.cy) <= radius * 1.5) continue;
        const i = (y * SIZE + x) * 4;
        expect(plate[i], `${x},${y}`).toBe(marked[i]);
      }
    }
  });

  it('comes out the same way twice', () => {
    // An export that did not match the preview it was approved from would be a
    // different photograph, so the search is seeded rather than random.
    const first = skin(SIZE, SPOT);
    const second = skin(SIZE, SPOT);
    healSpot(healer, first, SIZE, SIZE, spot);
    healSpot(healer, second, SIZE, SIZE, spot);
    expect([...first]).toEqual([...second]);
  });

  it('lets two spots compose rather than fighting', () => {
    // The second reads what the first left behind, the same way it would if a
    // person had healed them one after the other.
    const plate = skin(SIZE, SPOT);
    healSpot(healer, plate, SIZE, SIZE, spot);
    const once = new Uint8ClampedArray(plate);
    const overlapping: HealSpot = { x: 0.55, y: 0.5078125, r: 8 / SIZE };
    expect(healSpot(healer, plate, SIZE, SIZE, overlapping)).toBeGreaterThan(0);
    expect([...plate]).not.toEqual([...once]);
    expect(mean(plate, SIZE, inside)).toBeCloseTo(mean(skin(SIZE), SIZE, around), -1);
  });

  it('does nothing for a spot smaller than a pixel', () => {
    const plate = skin(SIZE, SPOT);
    const before = new Uint8ClampedArray(plate);
    expect(healSpot(healer, plate, SIZE, SIZE, { x: 0.5, y: 0.5, r: 0.0001 })).toBe(0);
    expect([...plate]).toEqual([...before]);
  });

  it('refuses a hole that leaves no photograph to copy from', () => {
    // Asked directly, because the region the host cuts always leaves room. A
    // hole filling its own region has nothing to be filled from, and inventing
    // something is the one answer worth refusing.
    const size = 12;
    const patch = skin(size);
    const ptr = healer.allocate(patch.length);
    new Uint8Array(healer.memory.buffer, ptr, patch.length).set(patch);
    const touched = healer.heal(ptr, size, size, size / 2, size / 2, size, 1);
    const after = new Uint8ClampedArray(new Uint8Array(healer.memory.buffer, ptr, patch.length));
    healer.release(ptr, patch.length);
    expect(touched).toBe(0);
    expect([...after]).toEqual([...patch]);
  });
});
