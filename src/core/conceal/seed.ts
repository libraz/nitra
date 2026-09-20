/**
 * Placing conceal circles from the irises face analysis already found.
 *
 * Pure arithmetic only: no state, no DOM. `Disc` (`face/geometry.ts`) holds
 * both axes in image-width units, isotropic on purpose; a conceal circle's `y`
 * is a fraction of the image's *height* instead, so the two are different
 * spaces and the axis conversion is the one thing this file cannot skip.
 */

import type { Disc } from '../face/geometry';
import { CONCEAL_LIMIT, paramDef } from '../recipe/schema';
import type { ConcealSpot } from './conceal';

export interface ConcealSeedResult {
  /** Circles to append to the recipe's existing conceal list. */
  added: ConcealSpot[];
  /** Irises that would have exceeded {@link CONCEAL_LIMIT} and were left unplaced. */
  overflow: number;
}

/**
 * Turn detected irises into conceal circles.
 *
 * An eye already covered by an existing circle is skipped, so a second click
 * does not duplicate it. Circles beyond {@link CONCEAL_LIMIT} are not placed;
 * how many were skipped for that reason comes back in `overflow` rather than
 * being placed anyway and silently exceeding the schema's range.
 *
 * @param irises Iris discs from face analysis, in image-width units.
 * @param aspect Image height divided by its width — the conversion `Disc`'s
 *   own doc comment calls for between width units and a height fraction.
 * @param existing The recipe's current conceal list. Read only, never mutated.
 */
export function seedConcealFromIrises(
  irises: readonly Disc[],
  aspect: number,
  existing: readonly ConcealSpot[],
): ConcealSeedResult {
  const { min, max } = paramDef('conceal.r');
  const added: ConcealSpot[] = [];
  let overflow = 0;

  for (const iris of irises) {
    // Rule 4: compare in the isotropic space irises already live in, not the
    // schema's mixed one — an existing spot's y is converted back to width
    // units rather than the iris's y converted to a height fraction twice.
    const covered = [...existing, ...added].some((spot) => {
      const dx = spot.x - iris.centre.x;
      const dy = spot.y * aspect - iris.centre.y;
      return Math.hypot(dx, dy) <= iris.radius;
    });
    if (covered) continue;

    if (existing.length + added.length >= CONCEAL_LIMIT) {
      overflow++;
      continue;
    }

    added.push({
      x: iris.centre.x, // rule 1: x is already a width fraction, unchanged
      y: iris.centre.y / aspect, // rule 1: width units back to a height fraction
      r: Math.min(max, Math.max(min, iris.radius)), // rules 2-3: iris width, clamped safe-side
    });
  }

  return { added, overflow };
}
