/**
 * The healed photograph, and how it is kept in line with the recipe.
 *
 * The plate is a second copy of the decoded pixels with the fills in it. It
 * exists because a fill is not a shader: the spots are a list somebody edits,
 * and each one has to see what the ones before it left behind, so the result has
 * to be accumulated somewhere rather than recomputed per frame from the recipe.
 *
 * Held here rather than in the renderer because none of it is a GPU concern —
 * what the renderer needs from this is a rectangle of bytes to upload and the
 * answer to whether anything changed at all.
 *
 * The copy is only made when the first spot is placed. A photograph nobody heals
 * pays nothing for the stage existing, which matters at twelve megapixels: the
 * plate is as large as the decoded image.
 */

import { type HealSpot, healSpot, type Region, regionFor } from './inpaint';

/** What changed in the plate, for whoever has to get it onto the GPU. */
export interface PlateUpdate {
  /**
   * The whole plate was rewritten and the rectangles say nothing useful.
   *
   * True when a spot was removed or moved rather than added. There is no inverse
   * of a fill — the pixels it replaced are gone from the plate — so undoing one
   * means starting from the photograph again and replaying the rest.
   */
  rebuilt: boolean;
  /** The parts of the plate the new fills reached. */
  rects: readonly Region[];
}

function same(a: HealSpot, b: HealSpot): boolean {
  return a.x === b.x && a.y === b.y && a.r === b.r;
}

export class HealPlate {
  /** Null until the first spot: the plate is the photograph until then. */
  private plate: Uint8ClampedArray | null = null;
  private applied: HealSpot[] = [];

  /**
   * @param pristine The decoded pixels, held rather than copied. They are the
   * only record of what was under a fill, so a spot can be taken away again.
   */
  constructor(
    private readonly pristine: Uint8ClampedArray,
    readonly width: number,
    readonly height: number,
  ) {}

  /** The healed pixels, or null while nothing has been healed. */
  get pixels(): Uint8ClampedArray | null {
    return this.plate;
  }

  /**
   * Whether the plate already says what `spots` asks for.
   *
   * The common answer, and the cheap one: it is true on the way to every settled
   * render that did not place a spot, which is almost all of them.
   */
  matches(spots: readonly HealSpot[]): boolean {
    return spots.length === this.applied.length && this.appends(spots);
  }

  /**
   * Bring the plate in line with `spots`.
   *
   * Returns null when it already was, so the answer is the same whether or not
   * the caller asked {@link matches} first.
   *
   * Appending is the fast path and the one that happens while working — the new
   * spots are filled into the plate as it stands, and their own rectangles are
   * all that has to be uploaded. Anything else is a rebuild.
   */
  apply(spots: readonly HealSpot[]): PlateUpdate | null {
    if (this.matches(spots)) return null;

    if (spots.length === 0) {
      this.plate = null;
      this.applied = [];
      return { rebuilt: true, rects: [] };
    }

    const appended = spots.length > this.applied.length && this.appends(spots);
    if (!appended) {
      this.plate = null;
      this.applied = [];
    }
    const from = this.applied.length;
    if (!this.plate) this.plate = new Uint8ClampedArray(this.pristine);
    const plate = this.plate;

    const rects: Region[] = [];
    for (let i = from; i < spots.length; i++) {
      const spot = spots[i] as HealSpot;
      this.applied.push(spot);
      // A spot too small to have a pixel in it fills nothing, and reporting a
      // rectangle for it would upload bytes that did not change.
      if (healSpot(plate, this.width, this.height, spot) === 0) continue;
      rects.push(regionFor(spot, this.width, this.height).region);
    }
    return { rebuilt: !appended, rects };
  }

  /** Whether `spots` is what has already been applied, plus more on the end. */
  private appends(spots: readonly HealSpot[]): boolean {
    return this.applied.every((spot, i) => same(spot, spots[i] as HealSpot));
  }
}
