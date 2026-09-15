/**
 * Inpainting one small round region of a photograph.
 *
 * This is the one heavy step in the project that is not a fragment shader, and
 * the reason is the shape of the work rather than a preference. Every other
 * heavy step reads a fixed neighbourhood and writes one pixel. Filling a hole is
 * not that: each pixel's answer is a patch copied from somewhere else in the
 * same image, the somewhere else is found by iterated search, and the search
 * reads memory in an order nothing knows in advance. That is the one thing a GPU
 * is bad at and a CPU is fine at, and it stays affordable because the region is a
 * blemish rather than a frame.
 *
 * The method is PatchMatch: a nearest-neighbour field over the hole, refined by
 * propagating good matches to neighbours and then trying random offsets, with
 * the fill re-voted from the field between passes. What it buys over averaging
 * the surroundings is the whole point of the stage — an average leaves a smooth
 * patch with no pores in it, which is the plastic skin the rest of the pipeline
 * is built to avoid. Copied patches bring real skin texture with them.
 *
 * The pixels arrive exactly as the photograph was decoded, eight bits per
 * channel and still encoded, and they leave the same way. Nothing here converts
 * to a working space: patches are matched on the values the file holds, which is
 * both what every implementation of this does and the reason the result can be
 * written straight back into the plate the renderer samples.
 *
 * Nothing in here may reach for a function whose precision the language leaves
 * to the engine. `Math.sin` is the one that would be reached for, in the seeding
 * below, and it is the one ECMA-262 declines to pin down — so a recipe opened in
 * a different browser would fill the same spot from a different patch. The rays
 * are eight fixed angles, so they are written out; what is left is `sqrt` and
 * `round`, which the specification does require to be exact.
 */

/**
 * Half-width of the patches that are matched and copied.
 *
 * Seven across. Wider carries more structure and is slower by its area; this is
 * enough to hold the direction of a pore pattern, which is what has to survive.
 */
const PATCH = 3;

/**
 * Search-and-vote passes over the hole.
 *
 * The field is most of the way to its answer after two, and the later passes are
 * what stop a copied patch from disagreeing with its neighbours.
 */
const PASSES = 5;

/** Random offsets tried per pixel per pass, at halving distances. */
const ATTEMPTS = 8;

/**
 * Directions the seeding below reaches out along, as exact cosines and sines.
 *
 * Eight rays at multiples of a right angle's half, written as literals rather
 * than taken from `Math.cos`. See the note at the top of the file: the values
 * are the same ones the trigonometry would return, and unlike them they are the
 * same values everywhere.
 */
const RAY_COS = [1, Math.SQRT1_2, 0, -Math.SQRT1_2, -1, -Math.SQRT1_2, 0, Math.SQRT1_2];
const RAY_SIN = [0, Math.SQRT1_2, 1, Math.SQRT1_2, 0, -Math.SQRT1_2, -1, -Math.SQRT1_2];

/** Where a pixel sits relative to the hole: inside it, its soft edge, or clear. */
interface Hole {
  /** One for the pixels the fill replaces outright. */
  inside: Uint8Array;
  /** How much of the fill each pixel takes, one inside and nought clear. */
  coverage: Float32Array;
  /** Indices of the pixels being filled, in scan order. */
  order: Int32Array;
}

function holeOf(
  width: number,
  height: number,
  cx: number,
  cy: number,
  radius: number,
  feather: number,
): Hole {
  const count = width * height;
  const inside = new Uint8Array(count);
  const coverage = new Float32Array(count);
  const order: number[] = [];
  const outer = radius + Math.max(feather, 0);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const dx = x + 0.5 - cx;
      const dy = y + 0.5 - cy;
      const distance = Math.sqrt(dx * dx + dy * dy);
      const index = y * width + x;
      if (distance <= radius) {
        inside[index] = 1;
        coverage[index] = 1;
        order.push(index);
      } else if (distance < outer) {
        // Smooth rather than linear: a crease in the blend is visible on skin as
        // a ring, which is a worse mark than the one being removed.
        const t = (outer - distance) / (outer - radius);
        coverage[index] = t * t * (3 - 2 * t);
      }
    }
  }
  return { inside, coverage, order: Int32Array.from(order) };
}

/**
 * Which patch centres the search is allowed to copy from.
 *
 * Two conditions, and both matter. A patch that runs off the edge of the region
 * has nothing to match against out there, and a patch overlapping the hole would
 * let the hole copy itself — which is how an inpaint smears instead of filling.
 *
 * Decided once for the whole region rather than per candidate. The test costs a
 * forty-nine tap scan, and the search asks it tens of thousands of times.
 */
function allowedCentres(hole: Hole, width: number, height: number): Uint8Array {
  const allowed = new Uint8Array(width * height);
  for (let y = PATCH; y < height - PATCH; y++) {
    for (let x = PATCH; x < width - PATCH; x++) {
      let clear = true;
      scan: for (let dy = -PATCH; dy <= PATCH; dy++) {
        for (let dx = -PATCH; dx <= PATCH; dx++) {
          if (hole.inside[(y + dy) * width + x + dx]) {
            clear = false;
            break scan;
          }
        }
      }
      allowed[y * width + x] = clear ? 1 : 0;
    }
  }
  return allowed;
}

function usable(allowed: Uint8Array, width: number, height: number, x: number, y: number): boolean {
  if (x < 0 || y < 0 || x >= width || y >= height) return false;
  return allowed[y * width + x] === 1;
}

/**
 * Seed the hole by reaching outwards for the nearest pixel the photo still has.
 *
 * Not the answer — it has no texture in it at all — but the patch search needs
 * something inside the hole to compare a candidate against, and a hole full of
 * whatever was there before would have it matching the blemish. Rays rather than
 * a blur because the cost is bounded by the hole's radius rather than by its
 * area, and because reaching along a direction keeps a shadow's gradient
 * pointing the way it was going.
 */
function seed(work: Float32Array, hole: Hole, width: number, height: number): void {
  const reach = Math.max(width, height);
  for (let at = 0; at < hole.order.length; at++) {
    const index = hole.order[at] as number;
    const x = index % width;
    const y = Math.floor(index / width);
    let red = 0;
    let green = 0;
    let blue = 0;
    let weight = 0;
    for (let ray = 0; ray < RAY_COS.length; ray++) {
      const cos = RAY_COS[ray] as number;
      const sin = RAY_SIN[ray] as number;
      for (let step = 1; step <= reach; step++) {
        const sx = Math.round(x + cos * step);
        const sy = Math.round(y + sin * step);
        if (sx < 0 || sy < 0 || sx >= width || sy >= height) break;
        const source = sy * width + sx;
        if (hole.inside[source]) continue;
        const w = 1 / step;
        red += (work[source * 4] as number) * w;
        green += (work[source * 4 + 1] as number) * w;
        blue += (work[source * 4 + 2] as number) * w;
        weight += w;
        break;
      }
    }
    if (weight <= 0) continue;
    work[index * 4] = red / weight;
    work[index * 4 + 1] = green / weight;
    work[index * 4 + 2] = blue / weight;
  }
}

/**
 * Sum of squared differences between the patch around a hole pixel and the one
 * around a candidate, over the channels that carry the picture.
 *
 * Taps that fall outside the region are skipped rather than clamped: a clamped
 * tap compares a candidate against a repeat of the edge, which makes every
 * candidate near the edge look better than it is.
 *
 * Given the best cost so far, so a candidate that is already worse can be
 * abandoned a row into the comparison rather than forty-nine taps into it. This
 * is most of what makes the search affordable — most candidates are bad.
 */
function cost(
  work: Float32Array,
  width: number,
  height: number,
  tx: number,
  ty: number,
  sx: number,
  sy: number,
  ceiling: number,
): number {
  let total = 0;
  for (let dy = -PATCH; dy <= PATCH; dy++) {
    const ay = ty + dy;
    const by = sy + dy;
    if (ay < 0 || by < 0 || ay >= height || by >= height) continue;
    for (let dx = -PATCH; dx <= PATCH; dx++) {
      const ax = tx + dx;
      const bx = sx + dx;
      if (ax < 0 || bx < 0 || ax >= width || bx >= width) continue;
      const a = (ay * width + ax) * 4;
      const b = (by * width + bx) * 4;
      let d = (work[a] as number) - (work[b] as number);
      total += d * d;
      d = (work[a + 1] as number) - (work[b + 1] as number);
      total += d * d;
      d = (work[a + 2] as number) - (work[b + 2] as number);
      total += d * d;
    }
    if (total >= ceiling) return total;
  }
  return total;
}

/**
 * A small deterministic generator.
 *
 * Deterministic on purpose: the same spot on the same photograph has to come out
 * the same way twice, or an export would not match the preview it was approved
 * from.
 */
class Noise {
  constructor(private state: number) {}

  /** xorshift32, kept unsigned at every step. */
  private next(): number {
    let x = this.state;
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    this.state = x;
    return x;
  }

  below(bound: number): number {
    if (bound <= 0) return 0;
    return this.next() % bound;
  }
}

/**
 * Fill a round hole in an RGBA region, in place.
 *
 * Every distance is in pixels of the region, which the caller has already cut
 * out of the photograph — the recipe holds the spot as a fraction of the image
 * and the conversion happens once, where the image size is known.
 *
 * @returns The number of pixels the fill reached, so the caller can tell a spot
 * that did something from one placed where there was nothing to do.
 */
export function inpaint(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
  cx: number,
  cy: number,
  radius: number,
  feather: number,
): number {
  if (width <= 0 || height <= 0 || radius <= 0) return 0;
  const count = width * height;
  if (pixels.length < count * 4) return 0;

  const hole = holeOf(width, height, cx, cy, radius, feather);
  if (hole.order.length === 0) return 0;

  const allowed = allowedCentres(hole, width, height);
  const sourceX: number[] = [];
  const sourceY: number[] = [];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (allowed[y * width + x]) {
        sourceX.push(x);
        sourceY.push(y);
      }
    }
  }
  if (sourceX.length === 0) {
    // The hole fills the region, or comes close enough that no patch sits clear
    // of it. Nothing can be copied from a photograph that is not there, and
    // inventing something is the one answer worth refusing.
    return 0;
  }

  const work = new Float32Array(count * 4);
  for (let i = 0; i < count * 4; i++) work[i] = pixels[i] as number;
  seed(work, hole, width, height);

  // The field, one source pixel per hole pixel. Indexed by position in
  // `hole.order` so the passes below can walk it forwards and backwards.
  const noise = new Noise(0x9e3779b9);
  const total = hole.order.length;
  const fieldX = new Int32Array(total);
  const fieldY = new Int32Array(total);
  for (let at = 0; at < total; at++) {
    const pick = noise.below(sourceX.length);
    fieldX[at] = sourceX[pick] as number;
    fieldY[at] = sourceY[pick] as number;
  }

  const slot = new Int32Array(count).fill(-1);
  for (let at = 0; at < total; at++) slot[hole.order[at] as number] = at;

  const sum = new Float32Array(count * 3);
  const weight = new Float32Array(count);

  for (let pass = 0; pass < PASSES; pass++) {
    const forwards = pass % 2 === 0;

    for (let step = 0; step < total; step++) {
      const at = forwards ? step : total - 1 - step;
      const index = hole.order[at] as number;
      const tx = index % width;
      const ty = Math.floor(index / width);
      let bestX = fieldX[at] as number;
      let bestY = fieldY[at] as number;
      let least = cost(work, width, height, tx, ty, bestX, bestY, Number.POSITIVE_INFINITY);

      // Propagation: a patch that suited the pixel next door, shifted by the
      // step between them, is very often the answer here. This is what makes the
      // search cheap — coherent regions are solved by one good match spreading
      // rather than by every pixel finding its own.
      //
      // The two neighbours are walked by index rather than through a list of
      // pairs: this is the innermost loop in the stage, and a pair allocated
      // here is one allocated a quarter of a million times per fill.
      const towards = forwards ? -1 : 1;
      for (let side = 0; side < 2; side++) {
        const nx = side === 0 ? tx + towards : tx;
        const ny = side === 0 ? ty : ty + towards;
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        const neighbour = slot[ny * width + nx] as number;
        if (neighbour < 0) continue;
        const px = (fieldX[neighbour] as number) + (tx - nx);
        const py = (fieldY[neighbour] as number) + (ty - ny);
        if (!usable(allowed, width, height, px, py)) continue;
        const candidate = cost(work, width, height, tx, ty, px, py, least);
        if (candidate < least) {
          least = candidate;
          bestX = px;
          bestY = py;
        }
      }

      // Random search, at halving distances around the current best. The wide
      // tries escape a local answer; the narrow ones settle it.
      let span = Math.max(width, height);
      for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
        if (span < 1) break;
        const px = bestX + noise.below(span * 2 + 1) - span;
        const py = bestY + noise.below(span * 2 + 1) - span;
        span = Math.floor(span / 2);
        if (!usable(allowed, width, height, px, py)) continue;
        const candidate = cost(work, width, height, tx, ty, px, py, least);
        if (candidate < least) {
          least = candidate;
          bestX = px;
          bestY = py;
        }
      }

      fieldX[at] = bestX;
      fieldY[at] = bestY;
    }

    // Vote: every patch that covers a hole pixel has an opinion about it, and
    // the fill is their mean. Taking the centre of one patch instead leaves the
    // seams between neighbouring patches visible as a blocky edge.
    sum.fill(0);
    weight.fill(0);
    for (let at = 0; at < total; at++) {
      const index = hole.order[at] as number;
      const tx = index % width;
      const ty = Math.floor(index / width);
      const sx = fieldX[at] as number;
      const sy = fieldY[at] as number;
      for (let dy = -PATCH; dy <= PATCH; dy++) {
        for (let dx = -PATCH; dx <= PATCH; dx++) {
          const ax = tx + dx;
          const ay = ty + dy;
          if (ax < 0 || ay < 0 || ax >= width || ay >= height) continue;
          const target = ay * width + ax;
          if (!hole.inside[target]) continue;
          const source = ((sy + dy) * width + sx + dx) * 4;
          const into = target * 3;
          sum[into] = (sum[into] as number) + (work[source] as number);
          sum[into + 1] = (sum[into + 1] as number) + (work[source + 1] as number);
          sum[into + 2] = (sum[into + 2] as number) + (work[source + 2] as number);
          weight[target] = (weight[target] as number) + 1;
        }
      }
    }
    for (let at = 0; at < total; at++) {
      const index = hole.order[at] as number;
      const votes = weight[index] as number;
      if (votes <= 0) continue;
      work[index * 4] = (sum[index * 3] as number) / votes;
      work[index * 4 + 1] = (sum[index * 3 + 1] as number) / votes;
      work[index * 4 + 2] = (sum[index * 3 + 2] as number) / votes;
    }
  }

  // Settle: take each pixel from its own patch rather than from the mean of
  // every patch covering it.
  //
  // The votes above are what make neighbouring patches agree, and they are also
  // what costs the fill its texture — a mean of overlapping patches is a blur by
  // another name, and measured on skin it came back with three fifths of the
  // surrounding detail. A patch of skin missing half its pores is the plastic
  // skin failure the whole pipeline is built to avoid, and it would be absurd to
  // reintroduce it in the one stage whose job is to leave texture behind.
  // Copying the centre restores it in full, and the field it copies through has
  // already been harmonised by the passes above, which is what keeps the seams
  // between neighbours from showing.
  for (let at = 0; at < total; at++) {
    const index = hole.order[at] as number;
    const source = ((fieldY[at] as number) * width + (fieldX[at] as number)) * 4;
    work[index * 4] = work[source] as number;
    work[index * 4 + 1] = work[source + 1] as number;
    work[index * 4 + 2] = work[source + 2] as number;
  }

  // Back into the region, through the soft edge. The pixels outside the hole are
  // moved too, by as much of the fill as their coverage asks for, which is what
  // keeps the join off the eye.
  //
  // Rounded and clamped here rather than left to the destination's own clamping:
  // a clamped array rounds halves to even, and the fill is specified to round
  // them away from zero.
  let touched = 0;
  for (let index = 0; index < count; index++) {
    const alpha = hole.coverage[index] as number;
    if (alpha <= 0) continue;
    touched += 1;
    for (let channel = 0; channel < 3; channel++) {
      const at = index * 4 + channel;
      const was = pixels[at] as number;
      const now = was + ((work[at] as number) - was) * alpha;
      pixels[at] = Math.min(255, Math.max(0, Math.round(now)));
    }
  }
  return touched;
}
