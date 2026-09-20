/**
 * The plate: the copy of the photograph the CPU stages accumulate in.
 *
 * What is asserted here is the bookkeeping rather than the fill — that a
 * photograph nobody works on is never copied, that appending a spot does not
 * redo the ones before it, and that taking one away puts back what was
 * underneath. The last of those is the only way a fill is undoable at all: there
 * is no inverse of a fill, so the pixels have to come from the decoded
 * photograph.
 *
 * The circles are asserted as an order and a re-application: they go over the
 * fills, they read what the stage under the plate left rather than the plate
 * itself, and a fill that reaches one has to run it again — otherwise a ring
 * that promises the identifying frequencies are gone has sharp structure put
 * back inside it.
 */

import { describe, expect, it } from 'vitest';
import { CONCEAL_FEATHER, type ConcealSpot, concealRegion } from '../src/core/conceal/conceal';
import { type HealSpot, regionFor } from '../src/core/heal/inpaint';
import { SourcePlate } from '../src/core/plate/plate';

const SIZE = 192;

/** Flat skin with grain, and a dark mark wherever one is asked for. */
function photograph(marks: readonly { x: number; y: number; r: number }[]): Uint8ClampedArray {
  const out = new Uint8ClampedArray(SIZE * SIZE * 4);
  let state = 7919;
  const noise = () => {
    state = (state * 1103515245 + 12345) >>> 0;
    return state / 4294967296 - 0.5;
  };
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const i = (y * SIZE + x) * 4;
      const grain = noise() * 20;
      const marked = marks.some((m) => Math.hypot(x - m.x * SIZE, y - m.y * SIZE) < m.r * SIZE);
      const value = 176 + grain + (marked ? -60 : 0);
      out[i] = value;
      out[i + 1] = value * 0.84;
      out[i + 2] = value * 0.74;
      out[i + 3] = 255;
    }
  }
  return out;
}

/** Mean red over a disc, which is what a dark mark shows up in. */
function meanAt(pixels: Uint8ClampedArray, spot: HealSpot): number {
  const cx = spot.x * SIZE;
  const cy = spot.y * SIZE;
  const r = spot.r * SIZE;
  let total = 0;
  let count = 0;
  for (let y = Math.max(0, Math.floor(cy - r)); y < Math.min(SIZE, Math.ceil(cy + r)); y++) {
    for (let x = Math.max(0, Math.floor(cx - r)); x < Math.min(SIZE, Math.ceil(cx + r)); x++) {
      if (Math.hypot(x - cx, y - cy) > r) continue;
      total += pixels[(y * SIZE + x) * 4] as number;
      count += 1;
    }
  }
  return total / Math.max(count, 1);
}

// The largest radius the recipe will hold, so the arithmetic under test is the
// arithmetic a real spot goes through.
const LEFT: HealSpot = { x: 0.3, y: 0.4, r: 0.03 };
const RIGHT: HealSpot = { x: 0.7, y: 0.6, r: 0.03 };

function plateOf(marks: readonly HealSpot[] = [LEFT, RIGHT]) {
  const pristine = photograph(marks);
  return { pristine, plate: new SourcePlate(pristine, SIZE, SIZE) };
}

describe('the plate', () => {
  it('is not copied until something is filled', () => {
    const { plate } = plateOf();
    expect(plate.pixels).toBeNull();
    // An empty list is not a change to apply; the photograph is already it.
    expect(plate.apply([], [])).toBeNull();
    expect(plate.pixels).toBeNull();
  });

  it('fills a spot and leaves the photograph it was given alone', () => {
    const { pristine, plate } = plateOf();
    const before = pristine.slice();
    const dark = meanAt(pristine, LEFT);

    const update = plate.apply([], [LEFT]);
    expect(update).not.toBeNull();
    expect(update?.rebuilt).toBe(false);
    expect(update?.rects).toHaveLength(1);
    expect(plate.pixels).not.toBeNull();

    // The mark is gone from the plate, and still there in what it was copied
    // from: the decoded pixels are the only record of what was underneath.
    expect(meanAt(plate.pixels as Uint8ClampedArray, LEFT)).toBeGreaterThan(dark + 20);
    expect(pristine).toEqual(before);
  });

  it('reports the rectangle the fill reached, not the whole frame', () => {
    const { plate } = plateOf();
    const update = plate.apply([], [LEFT]);
    const rect = update?.rects[0] as { x: number; y: number; width: number; height: number };
    // The region reaches past the spot on every side, because the surrounding
    // skin is the only place the fill has to copy from.
    expect(rect.width).toBeGreaterThan(LEFT.r * SIZE * 2);
    expect(rect.width).toBeLessThan(SIZE);
    expect(rect.x).toBeGreaterThan(0);
    expect(rect.x + rect.width).toBeLessThan(SIZE);
  });

  it('does nothing when asked for what it has already done', () => {
    const { plate } = plateOf();
    expect(plate.apply([], [LEFT, RIGHT])).not.toBeNull();
    expect(plate.apply([], [LEFT, RIGHT])).toBeNull();
    // A separate object with the same numbers is the same edit: the recipe is
    // replaced on every change, so identity would report work on every render.
    expect(plate.apply([], [{ ...LEFT }, { ...RIGHT }])).toBeNull();
  });

  it('appends without redoing what is already in the plate', () => {
    const { plate } = plateOf();
    plate.apply([], [LEFT]);
    const filled = (plate.pixels as Uint8ClampedArray).slice();

    const update = plate.apply([], [LEFT, RIGHT]);
    expect(update?.rebuilt).toBe(false);
    expect(update?.rects).toHaveLength(1);

    const pixels = plate.pixels as Uint8ClampedArray;
    // The first fill came through untouched — byte for byte, not approximately.
    const rect = update?.rects[0] as { x: number; y: number; width: number; height: number };
    for (let y = 0; y < SIZE; y++) {
      for (let x = 0; x < SIZE; x++) {
        const inside =
          x >= rect.x && x < rect.x + rect.width && y >= rect.y && y < rect.y + rect.height;
        if (inside) continue;
        expect(pixels[(y * SIZE + x) * 4]).toBe(filled[(y * SIZE + x) * 4]);
      }
    }
  });

  it('puts back what was under a spot that is taken away', () => {
    const { pristine, plate } = plateOf();
    plate.apply([], [LEFT, RIGHT]);

    const update = plate.apply([], [LEFT]);
    // There is no inverse of a fill, so the plate is built again from the
    // photograph and the remaining spots are replayed.
    expect(update?.rebuilt).toBe(true);
    expect(update?.rects).toHaveLength(1);

    const pixels = plate.pixels as Uint8ClampedArray;
    expect(meanAt(pixels, RIGHT)).toBeCloseTo(meanAt(pristine, RIGHT), 5);
    expect(meanAt(pixels, LEFT)).toBeGreaterThan(meanAt(pristine, LEFT) + 20);
  });

  it('rebuilds when a spot moves rather than treating it as a new one', () => {
    const { plate } = plateOf();
    plate.apply([], [LEFT, RIGHT]);
    const update = plate.apply([], [LEFT, { ...RIGHT, x: 0.66 }]);
    expect(update?.rebuilt).toBe(true);
    expect(update?.rects).toHaveLength(2);
  });

  it('goes back to costing nothing when the last spot is removed', () => {
    const { plate } = plateOf();
    plate.apply([], [LEFT]);
    const update = plate.apply([], []);
    expect(update).toEqual({ rebuilt: true, rects: [] });
    // The plate is dropped rather than refilled: the photograph is already the
    // answer, and holding a copy of it is holding the decoded image twice.
    expect(plate.pixels).toBeNull();
  });

  it('composes two spots that overlap', () => {
    const near: HealSpot = { x: 0.32, y: 0.4, r: 0.03 };
    const { pristine, plate } = plateOf([LEFT, near]);
    plate.apply([], [LEFT, near]);
    const pixels = plate.pixels as Uint8ClampedArray;
    // The second fill read what the first left behind, so neither mark is left
    // in the overlap — which is what would happen if a person had healed them
    // one after the other.
    expect(meanAt(pixels, LEFT)).toBeGreaterThan(meanAt(pristine, LEFT) + 20);
    expect(meanAt(pixels, near)).toBeGreaterThan(meanAt(pristine, near) + 20);
  });

  it('remembers a spot too small to fill anything', () => {
    const { plate } = plateOf();
    const speck: HealSpot = { x: 0.5, y: 0.5, r: 0.002 };
    const update = plate.apply([], [speck]);
    // Under a pixel and a half of radius there is nothing to fill, so there is
    // nothing to upload either — but the spot is in the recipe, and asking again
    // must not run it a second time.
    expect(update).toEqual({ rebuilt: false, rects: [] });
    expect(plate.apply([], [speck])).toBeNull();
  });
});

/** Spread of red over a disc: what a low pass is there to take out. */
function spreadAt(pixels: Uint8ClampedArray, spot: ConcealSpot): number {
  const mean = meanAt(pixels, spot);
  const cx = spot.x * SIZE;
  const cy = spot.y * SIZE;
  const r = spot.r * SIZE;
  let total = 0;
  let count = 0;
  for (let y = Math.max(0, Math.floor(cy - r)); y < Math.min(SIZE, Math.ceil(cy + r)); y++) {
    for (let x = Math.max(0, Math.floor(cx - r)); x < Math.min(SIZE, Math.ceil(cx + r)); x++) {
      if (Math.hypot(x - cx, y - cy) > r) continue;
      total += ((pixels[(y * SIZE + x) * 4] as number) - mean) ** 2;
      count += 1;
    }
  }
  return Math.sqrt(total / Math.max(count, 1));
}

/** Every byte inside a circle: the range the ring is a promise about. */
function disc(pixels: Uint8ClampedArray, spot: ConcealSpot): number[] {
  const cx = spot.x * SIZE;
  const cy = spot.y * SIZE;
  const r = spot.r * SIZE;
  const out: number[] = [];
  for (let y = Math.max(0, Math.floor(cy - r)); y < Math.min(SIZE, Math.ceil(cy + r)); y++) {
    for (let x = Math.max(0, Math.floor(cx - r)); x < Math.min(SIZE, Math.ceil(cx + r)); x++) {
      if (Math.hypot(x - cx, y - cy) > r) continue;
      out.push(...pixels.slice((y * SIZE + x) * 4, (y * SIZE + x) * 4 + 4));
    }
  }
  return out;
}

// One circle over a mark and one well away from it, and the fills placed with
// respect to them. Whether a fill lands under a circle is what decides if
// placing it has to run that circle again, so there is one of each.
const CIRCLE: ConcealSpot = { x: 0.3, y: 0.4, r: 0.03 };
const OTHER_CIRCLE: ConcealSpot = { x: 0.7, y: 0.25, r: 0.03 };
const UNDER: HealSpot = { x: 0.3, y: 0.4, r: 0.02 };
const BESIDE: HealSpot = { x: 0.8, y: 0.8, r: 0.03 };
// Clear of the mask but inside the region the circle's blur reads, which is the
// ring that a circle pasting its whole region back would wipe.
const AROUND: HealSpot = { x: 0.4, y: 0.4, r: 0.03 };

/**
 * The photograph as it was decoded, and the frame a restore would have left.
 *
 * They differ where the generated face was: the mark under the circle is gone
 * from the restored one. Which of them the plate holds is the whole of what the
 * restore means down here — the plate is handed the output of the stage under
 * it, so everything it does reads that and nothing reaches past it.
 */
const DECODED = photograph([CIRCLE, BESIDE]);
const RESTORED = photograph([BESIDE]);

describe('the plate and the circles over it', () => {
  it('conceals the frame the restore left rather than the one that was decoded', () => {
    const plate = new SourcePlate(RESTORED, SIZE, SIZE);
    plate.apply([CIRCLE], []);
    const pixels = plate.pixels as Uint8ClampedArray;
    // The disc comes back at the level of the face that was put back, not of
    // the mark the generator left there.
    expect(meanAt(pixels, CIRCLE)).toBeGreaterThan(meanAt(DECODED, CIRCLE) + 40);
    expect(Math.abs(meanAt(pixels, CIRCLE) - meanAt(RESTORED, CIRCLE))).toBeLessThan(3);
  });

  it('flattens what is inside the circle and leaves the frame around it alone', () => {
    const plate = new SourcePlate(RESTORED, SIZE, SIZE);
    const update = plate.apply([CIRCLE], []);
    // A circle is applied over the pristine source, so there is nothing to undo
    // it with: every change to the list is a rebuild, and the rectangles of a
    // rebuild say nothing the caller can use.
    expect(update).toEqual({ rebuilt: true, rects: [] });

    const pixels = plate.pixels as Uint8ClampedArray;
    expect(spreadAt(pixels, CIRCLE)).toBeLessThan(spreadAt(RESTORED, CIRCLE) / 4);
    expect(meanAt(pixels, BESIDE)).toBeCloseTo(meanAt(RESTORED, BESIDE), 5);
  });

  it('conceals the source under the fills rather than the fills', () => {
    const alone = new SourcePlate(RESTORED, SIZE, SIZE);
    alone.apply([CIRCLE], []);

    const both = new SourcePlate(RESTORED, SIZE, SIZE);
    both.apply([CIRCLE], [UNDER, BESIDE]);
    const pixels = both.pixels as Uint8ClampedArray;

    // Byte for byte the same inside the ring, with a fill under it and without.
    // The circle is applied last and reads the pristine source, so what it
    // leaves inside the ring cannot depend on what was filled underneath — and
    // the fill is not left showing through a range that promises it is gone.
    expect(disc(pixels, CIRCLE)).toEqual(disc(alone.pixels as Uint8ClampedArray, CIRCLE));
    // The same apply did fill: the mark no circle covers is gone.
    expect(meanAt(pixels, BESIDE)).toBeGreaterThan(meanAt(RESTORED, BESIDE) + 20);
  });

  it('runs a circle again when a fill reaches it', () => {
    const plate = new SourcePlate(RESTORED, SIZE, SIZE);
    plate.apply([CIRCLE, OTHER_CIRCLE], []);
    const concealed = disc(plate.pixels as Uint8ClampedArray, CIRCLE);

    const update = plate.apply([CIRCLE, OTHER_CIRCLE], [UNDER]);
    // Still the append path — the fill is not redone and the circles are not
    // all replayed. What comes back is the fill's own rectangle and the one
    // circle it reached; the other circle is not in the list, because nothing
    // near it changed.
    expect(update?.rebuilt).toBe(false);
    expect(update?.rects).toEqual([
      regionFor(UNDER, SIZE, SIZE).region,
      concealRegion(CIRCLE, SIZE, SIZE).written,
    ]);
    // And the ring holds what it held before the fill went under it.
    expect(disc(plate.pixels as Uint8ClampedArray, CIRCLE)).toEqual(concealed);
  });

  it('keeps a fill that sits outside a circle but inside its reach', () => {
    const restored = photograph([AROUND]);
    const plate = new SourcePlate(restored, SIZE, SIZE);
    plate.apply([CIRCLE], []);

    // The fill is outside the ring and its feather, so the circle has no claim
    // on it, and inside the region the circle's blur reads, so it is in reach of
    // being written over. Both have to hold for the assertion to mean anything.
    const gap = Math.hypot(AROUND.x - CIRCLE.x, AROUND.y - CIRCLE.y) * SIZE;
    expect(gap - AROUND.r * SIZE).toBeGreaterThan(CIRCLE.r * SIZE * (1 + CONCEAL_FEATHER));
    const { region, written } = concealRegion(CIRCLE, SIZE, SIZE);
    expect(gap + AROUND.r * SIZE).toBeLessThan(region.x + region.width - CIRCLE.x * SIZE);
    // And the fill's own rectangle still meets the box the circle writes, which
    // is what puts the circle back on the list below.
    const reached = regionFor(AROUND, SIZE, SIZE).region;
    expect(reached.x).toBeLessThan(written.x + written.width);
    expect(written.x).toBeLessThan(reached.x + reached.width);
    expect(reached.y).toBeLessThan(written.y + written.height);
    expect(written.y).toBeLessThan(reached.y + reached.height);

    const update = plate.apply([CIRCLE], [AROUND]);
    // The circle is applied again — and what it writes must not take the fill
    // with it.
    expect(update?.rebuilt).toBe(false);
    expect(update?.rects).toHaveLength(2);
    const pixels = plate.pixels as Uint8ClampedArray;
    expect(meanAt(pixels, AROUND)).toBeGreaterThan(meanAt(restored, AROUND) + 20);
  });

  it('leaves a circle alone when the fill is nowhere near it', () => {
    const plate = new SourcePlate(RESTORED, SIZE, SIZE);
    plate.apply([CIRCLE], []);
    const update = plate.apply([CIRCLE], [BESIDE]);
    expect(update?.rebuilt).toBe(false);
    expect(update?.rects).toEqual([regionFor(BESIDE, SIZE, SIZE).region]);
  });

  it('is the photograph itself while both lists are empty', () => {
    const decoded = photograph([CIRCLE, BESIDE]);
    const before = decoded.slice();
    const plate = new SourcePlate(decoded, SIZE, SIZE);

    expect(plate.apply([], [])).toBeNull();
    expect(plate.pixels).toBeNull();
    // What the renderer uploads is the plate's pixels or, while there are none,
    // the ones it was given. So a recipe with neither a circle nor a spot in it
    // renders the decoded bytes themselves rather than a copy that has been
    // through a stage.
    expect(plate.pixels ?? decoded).toBe(decoded);

    // The same once a circle has been placed and taken away again, which is the
    // other way of arriving at a recipe that asks for nothing.
    plate.apply([CIRCLE], []);
    expect(plate.apply([], [])).toEqual({ rebuilt: true, rects: [] });
    expect(plate.pixels).toBeNull();
    expect(decoded).toEqual(before);
  });
});

/**
 * The transitions between the plate's states, and what each of them costs.
 *
 * Three independent things decide the state — what the stage underneath left,
 * the fills, the circles — and the product of them is eight. The product is not
 * what has to be right, though: what has to be right is the moves between them,
 * since that is where appending is told from rebuilding and where a circle is
 * decided to need running again. So the table is the states that are reachable
 * crossed with the operations that reach another one, and the restore is an axis
 * the whole table is run over rather than an operation in it.
 */
const TRANSITIONS: readonly {
  name: string;
  start: readonly (readonly [ConcealSpot[], HealSpot[]])[];
  next: readonly [ConcealSpot[], HealSpot[]];
  update: { rebuilt: boolean; rects: number } | null;
  copied: boolean;
}[] = [
  // From a plate that has not been copied.
  {
    name: 'nothing to a fill',
    start: [],
    next: [[], [BESIDE]],
    update: { rebuilt: false, rects: 1 },
    copied: true,
  },
  {
    name: 'nothing to a circle',
    start: [],
    next: [[CIRCLE], []],
    update: { rebuilt: true, rects: 0 },
    copied: true,
  },
  {
    name: 'nothing to both at once',
    start: [],
    next: [[CIRCLE], [UNDER]],
    update: { rebuilt: true, rects: 1 },
    copied: true,
  },
  { name: 'nothing to nothing', start: [], next: [[], []], update: null, copied: false },

  // From fills alone.
  {
    name: 'a fill to a second fill',
    start: [[[], [BESIDE]]],
    next: [[], [BESIDE, UNDER]],
    update: { rebuilt: false, rects: 1 },
    copied: true,
  },
  {
    name: 'a fill to no fill',
    start: [[[], [BESIDE]]],
    next: [[], []],
    update: { rebuilt: true, rects: 0 },
    copied: false,
  },
  {
    name: 'a fill to a circle beside it',
    start: [[[], [BESIDE]]],
    next: [[CIRCLE], [BESIDE]],
    update: { rebuilt: true, rects: 1 },
    copied: true,
  },
  {
    name: 'a fill to the same fill',
    start: [[[], [BESIDE]]],
    next: [[], [BESIDE]],
    update: null,
    copied: true,
  },

  // From circles alone.
  {
    name: 'a circle to a fill under it',
    start: [[[CIRCLE], []]],
    next: [[CIRCLE], [UNDER]],
    update: { rebuilt: false, rects: 2 },
    copied: true,
  },
  {
    name: 'a circle to a fill beside it',
    start: [[[CIRCLE], []]],
    next: [[CIRCLE], [BESIDE]],
    update: { rebuilt: false, rects: 1 },
    copied: true,
  },
  {
    name: 'a circle to a speck under it',
    start: [[[CIRCLE], []]],
    next: [[CIRCLE], [{ x: 0.3, y: 0.4, r: 0.002 }]],
    update: { rebuilt: false, rects: 0 },
    copied: true,
  },
  {
    name: 'a circle to a second circle',
    start: [[[CIRCLE], []]],
    next: [[CIRCLE, OTHER_CIRCLE], []],
    update: { rebuilt: true, rects: 0 },
    copied: true,
  },
  {
    name: 'a circle to no circle',
    start: [[[CIRCLE], []]],
    next: [[], []],
    update: { rebuilt: true, rects: 0 },
    copied: false,
  },

  // From both lists.
  {
    name: 'both to a fill beside the circle',
    start: [[[CIRCLE], [UNDER]]],
    next: [[CIRCLE], [UNDER, BESIDE]],
    update: { rebuilt: false, rects: 1 },
    copied: true,
  },
  {
    name: 'both to the fill removed',
    start: [[[CIRCLE], [UNDER]]],
    next: [[CIRCLE], []],
    update: { rebuilt: true, rects: 0 },
    copied: true,
  },
  {
    name: 'both to the circle removed',
    start: [[[CIRCLE], [UNDER]]],
    next: [[], [UNDER]],
    update: { rebuilt: true, rects: 1 },
    copied: true,
  },
  {
    name: 'both to the circle moved',
    start: [[[CIRCLE], [UNDER]]],
    next: [[{ ...CIRCLE, x: 0.32 }], [UNDER]],
    update: { rebuilt: true, rects: 1 },
    copied: true,
  },
  {
    name: 'both to neither',
    start: [[[CIRCLE], [UNDER]]],
    next: [[], []],
    update: { rebuilt: true, rects: 0 },
    copied: false,
  },
  {
    name: 'both to the same two',
    start: [[[CIRCLE], [UNDER]]],
    next: [[CIRCLE], [UNDER]],
    update: null,
    copied: true,
  },
];

for (const restored of [false, true]) {
  const base = restored ? RESTORED : DECODED;
  const untouched = base.slice();
  describe(`moving the plate over ${restored ? 'a restored frame' : 'the decoded photograph'}`, () => {
    for (const step of TRANSITIONS) {
      it(step.name, () => {
        const plate = new SourcePlate(base, SIZE, SIZE);
        for (const [conceal, heal] of step.start) plate.apply(conceal, heal);
        const update = plate.apply(step.next[0], step.next[1]);
        if (step.update === null) {
          expect(update).toBeNull();
        } else {
          expect(update?.rebuilt).toBe(step.update.rebuilt);
          expect(update?.rects).toHaveLength(step.update.rects);
        }
        // A copy is made for either list and dropped only when both are empty.
        expect(plate.pixels !== null).toBe(step.copied);
        // Whatever was underneath is never written to: it is the only record of
        // what a fill covered and the only thing a circle is allowed to read.
        expect(base).toEqual(untouched);
      });
    }
  });
}
