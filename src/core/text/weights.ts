/**
 * The weights the caption panel offers.
 *
 * Three are named; any other weight the recipe can carry — the schema's own
 * default among them — is offered under its number, so the control always shows
 * the value in force and a default is reachable again after another is picked.
 */

import { neutralTextLayer } from '../recipe/schema';

/** Weights that have a name in the message catalogue. */
export const NAMED_WEIGHTS = [300, 500, 700] as const;

/** The weight a new caption starts with. */
export const DEFAULT_WEIGHT = neutralTextLayer('').weight;

/** Every weight to offer for a caption currently set at `current`, ascending. */
export function weightChoices(current: number): number[] {
  return [...new Set<number>([...NAMED_WEIGHTS, DEFAULT_WEIGHT, current])].sort((a, b) => a - b);
}
