/**
 * Recipe migration.
 *
 * Recipes travel: a preset lands in a URL, gets saved, and is opened again by
 * someone running a different build. A recipe that no longer loads is a piece of
 * the user's work destroyed, so a version is never rejected for being old — it
 * is walked forward one step at a time.
 *
 * Removing a field is done by ignoring it, not by deleting it from older
 * payloads, and an unknown newer version is read on a best-effort basis rather
 * than refused.
 */

import { CURRENT_RECIPE_VERSION } from './schema';

/** One step of the chain: reads version `n`, returns version `n + 1`. */
type Step = (input: Record<string, unknown>) => Record<string, unknown>;

/**
 * Migration steps keyed by the version they read.
 *
 * Empty while version 1 is the only version that has ever shipped. Adding
 * version 2 means adding a `1` entry here, never editing the schema in place.
 */
const steps = new Map<number, Step>();

export interface MigrationResult {
  value: Record<string, unknown>;
  /** Version the payload declared before migration. */
  from: number;
  notes: string[];
}

export function migrateRecipe(input: unknown): MigrationResult {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new TypeError('recipe must be a JSON object');
  }
  let value = { ...(input as Record<string, unknown>) };
  const declared = typeof value.version === 'number' ? value.version : 1;
  const notes: string[] = [];

  if (declared > CURRENT_RECIPE_VERSION) {
    notes.push(
      `recipe declares version ${declared}; this build understands ${CURRENT_RECIPE_VERSION}. ` +
        'Unknown fields are ignored.',
    );
    value.version = CURRENT_RECIPE_VERSION;
    return { value, from: declared, notes };
  }

  for (let v = declared; v < CURRENT_RECIPE_VERSION; v++) {
    const step = steps.get(v);
    if (!step) throw new Error(`no migration from recipe version ${v}`);
    value = step(value);
    notes.push(`migrated ${v} to ${v + 1}`);
  }
  value.version = CURRENT_RECIPE_VERSION;
  return { value, from: declared, notes };
}
