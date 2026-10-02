/**
 * The photograph the CPU stages accumulate in, and how it is kept in line with
 * the recipe.
 *
 * The plate is a second copy of the pixels the stage under it left — the
 * restored frame where there is one, the decoded photograph otherwise — with
 * the fills and the concealed circles in it. It exists because neither of those
 * is a shader: they are lists somebody edits, and the result has to be
 * accumulated somewhere rather than recomputed per frame from the recipe.
 *
 * The two are applied in that order, fills and then circles, because inside a
 * circle the conceal is the last word: a fill placed under one must not put
 * sharp structure back into a ring the user blurred. Each circle reads
 * the pristine source rather than the plate, so the result depends only on the
 * two lists and never on the order they were built up in.
 *
 * The copy is only made when the first spot or circle is placed. A photograph
 * nobody works on pays nothing for the stages existing, which matters at twelve
 * megapixels: the plate is as large as the decoded image.
 */

import { type ConcealSpot, concealRegion, concealSpot } from '../conceal/conceal';
import { type HealSpot, healSpot, regionFor } from '../heal/inpaint';
import type { Region } from './region';

/** What changed in the plate, for whoever has to get it onto the GPU. */
export interface PlateUpdate {
  /**
   * The whole plate was rewritten and the rectangles say nothing useful.
   *
   * True when a spot was removed or moved rather than added, and true of any
   * change to the circles or to how far they were blurred. There is no inverse
   * of a fill — the pixels it replaced are gone from the plate — so undoing one
   * means starting from the photograph again and replaying the rest.
   */
  rebuilt: boolean;
  /** The parts of the plate the new fills and the circles over them reached. */
  rects: readonly Region[];
}

/** What both lists hold: a normalised centre and a radius in image widths. */
type Circle = HealSpot | ConcealSpot;

function same(a: Circle, b: Circle): boolean {
  return a.x === b.x && a.y === b.y && a.r === b.r;
}

/** Whether `applied` is what `spots` begins with. */
function prefixOf(applied: readonly Circle[], spots: readonly Circle[]): boolean {
  return (
    applied.length <= spots.length && applied.every((spot, i) => same(spot, spots[i] as Circle))
  );
}

/** Whether two rectangles of the plate share a pixel. */
function overlaps(a: Region, b: Region): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

export class SourcePlate {
  /** Null until the first spot or circle: the plate is the photograph so far. */
  private plate: Uint8ClampedArray | null = null;
  private appliedHeal: HealSpot[] = [];
  private appliedConceal: ConcealSpot[] = [];
  /** The amount the applied circles were blurred by. Meaningless while the list is empty. */
  private appliedAmount = 0;

  /**
   * @param pristine The pixels the stage under this one left, held rather than
   * copied. They are the only record of what was under a fill, so a spot can be
   * taken away again, and they are what every circle is concealed from.
   */
  constructor(
    private readonly pristine: Uint8ClampedArray,
    readonly width: number,
    readonly height: number,
  ) {}

  /** The worked pixels, or null while nothing has been filled or concealed. */
  get pixels(): Uint8ClampedArray | null {
    return this.plate;
  }

  /**
   * Whether the plate already says what the two lists ask for.
   *
   * The common answer, and the cheap one: it is true on the way to every settled
   * render that did not place anything, which is almost all of them. Both lists
   * are compared in order, since a plate that agrees about the contents of one
   * of them and not about its order is not the picture the recipe describes.
   *
   * The amount is compared only while there are circles for it to apply to,
   * which is what keeps moving that slider with an empty list from dropping a
   * plate full of fills.
   */
  matches(conceal: readonly ConcealSpot[], amount: number, heal: readonly HealSpot[]): boolean {
    return (
      conceal.length === this.appliedConceal.length &&
      heal.length === this.appliedHeal.length &&
      (conceal.length === 0 || amount === this.appliedAmount) &&
      prefixOf(this.appliedConceal, conceal) &&
      prefixOf(this.appliedHeal, heal)
    );
  }

  /**
   * Bring the plate in line with the recipe's circles and spots.
   *
   * Returns null when it already was, so the answer is the same whether or not
   * the caller asked {@link matches} first.
   *
   * Appending a fill is the fast path and the one that happens while working —
   * the new spots are filled into the plate as it stands, and their own
   * rectangles are most of what has to be uploaded. Anything else is a rebuild,
   * including every change to the circles and to the amount they were blurred
   * by: a circle is applied over the pristine source, so there is nothing to
   * undo it with short of starting again.
   *
   * A fill whose region reaches a circle is a rebuild as well. The search copies
   * from the plate as it stands, and in a rebuild that is the photograph before
   * the circle, so appending would copy from blurred pixels and the same recipe
   * would come out differently after a reload.
   */
  apply(
    conceal: readonly ConcealSpot[],
    amount: number,
    heal: readonly HealSpot[],
  ): PlateUpdate | null {
    if (this.matches(conceal, amount, heal)) return null;

    if (conceal.length === 0 && heal.length === 0) {
      this.drop();
      return { rebuilt: true, rects: [] };
    }

    let appended =
      conceal.length === this.appliedConceal.length &&
      // Same reason {@link matches} skips it: with no circle in the list there
      // is nothing the amount has applied to, so moving it is not a change.
      (conceal.length === 0 || amount === this.appliedAmount) &&
      prefixOf(this.appliedConceal, conceal) &&
      heal.length > this.appliedHeal.length &&
      prefixOf(this.appliedHeal, heal);
    if (appended && this.appliedConceal.length > 0) {
      const writes = this.appliedConceal.map(
        (spot) => concealRegion(spot, this.width, this.height, amount).written,
      );
      appended = !heal
        .slice(this.appliedHeal.length)
        .some((spot) =>
          writes.some((written) =>
            overlaps(regionFor(spot, this.width, this.height).region, written),
          ),
        );
    }
    if (!appended) this.drop();
    this.appliedAmount = amount;

    const from = this.appliedHeal.length;
    if (!this.plate) this.plate = new Uint8ClampedArray(this.pristine);
    const plate = this.plate;

    const filled: Region[] = [];
    for (let i = from; i < heal.length; i++) {
      const spot = heal[i] as HealSpot;
      this.appliedHeal.push(spot);
      // A spot too small to have a pixel in it fills nothing, and reporting a
      // rectangle for it would upload bytes that did not change.
      if (healSpot(plate, this.width, this.height, spot) === 0) continue;
      filled.push(regionFor(spot, this.width, this.height).region);
    }

    if (appended) return { rebuilt: false, rects: filled };

    for (const spot of conceal) {
      this.appliedConceal.push(spot);
      concealSpot(plate, this.pristine, this.width, this.height, spot, amount);
    }
    return { rebuilt: true, rects: filled };
  }

  /** Back to the photograph, and back to costing nothing. */
  private drop(): void {
    this.plate = null;
    this.appliedHeal = [];
    this.appliedConceal = [];
    this.appliedAmount = 0;
  }
}
