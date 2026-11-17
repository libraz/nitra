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

/** Slack on the covering test, in image widths: the round trip of `y` through the aspect is not exact. */
const COVER_SLACK = 1e-9;

/**
 * Turn detected irises into conceal circles.
 *
 * An eye is skipped only when an existing circle already holds the whole of
 * what would be placed, so a second click does not duplicate it. A smaller
 * circle somebody drew inside the iris does not count: the reflection can be
 * anywhere on the cornea, and the circle that covers it is laid over the small
 * one — crossing circles blur their union. Circles beyond {@link CONCEAL_LIMIT}
 * are not placed; how many were skipped for that reason comes back in
 * `overflow` rather than being placed anyway and silently exceeding the
 * schema's range.
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
    // The iris's own width, held to what the recipe can carry.
    const r = Math.min(max, Math.max(min, iris.radius));
    // Compared in the isotropic space the irises live in: an existing circle's
    // y goes back to width units rather than the iris's going to a height
    // fraction.
    const covered = [...existing, ...added].some((spot) => {
      const dx = spot.x - iris.centre.x;
      const dy = spot.y * aspect - iris.centre.y;
      return Math.hypot(dx, dy) + r <= spot.r + COVER_SLACK;
    });
    if (covered) continue;

    if (existing.length + added.length >= CONCEAL_LIMIT) {
      overflow++;
      continue;
    }

    // x is a width fraction already; y goes from width units to a height fraction.
    added.push({ x: iris.centre.x, y: iris.centre.y / aspect, r });
  }

  return { added, overflow };
}
