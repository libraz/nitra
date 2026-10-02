/**
 * The trust boundary for recipes.
 *
 * A recipe is read from outside the program, so validation happens here and
 * only here. Out-of-range numbers are the reason:
 * left alone they travel straight into a shader uniform and the render falls
 * apart somewhere far from the input that caused it.
 *
 * The slider path deliberately does not come through here. Validation is already
 * done by the time a slider exists; re-running it every frame would buy nothing.
 */

import type { ZodIssue } from 'zod';
import { migrateRecipe } from './migrate';
import { type Recipe, recipeSchema } from './schema';

/** A value that was outside its declared range and got pulled back in. */
export interface Repair {
  path: string;
  from: unknown;
  /** The value that was written: the clamped number, or the truncated string or array. */
  to: unknown;
}

export type LoadResult =
  | { ok: true; recipe: Recipe; repairs: Repair[]; notes: string[] }
  | { ok: false; issues: string[] };

function setAtPath(root: Record<string, unknown>, path: PropertyKey[], value: unknown): void {
  let cur: unknown = root;
  for (const key of path.slice(0, -1)) {
    if (typeof cur !== 'object' || cur === null) return;
    cur = (cur as Record<PropertyKey, unknown>)[key];
  }
  const last = path.at(-1);
  if (last === undefined || typeof cur !== 'object' || cur === null) return;
  (cur as Record<PropertyKey, unknown>)[last] = value;
}

function readAtPath(root: Record<string, unknown>, path: PropertyKey[]): unknown {
  let cur: unknown = root;
  for (const key of path) {
    if (typeof cur !== 'object' || cur === null) return undefined;
    cur = (cur as Record<PropertyKey, unknown>)[key];
  }
  return cur;
}

/**
 * The in-range value for an out-of-range one, of the same type as the original.
 *
 * Numbers are clamped; strings and arrays that run over are truncated. A string
 * or array that is too short cannot be lengthened without inventing content, so
 * it is left to fail with its own message.
 */
function repairedValue(issue: ZodIssue, from: unknown): { to: unknown } | undefined {
  if (issue.code === 'too_big' && typeof issue.maximum === 'number') {
    if (typeof from === 'number') return { to: issue.maximum };
    if (typeof from === 'string' || Array.isArray(from))
      return { to: from.slice(0, issue.maximum) };
  }
  if (issue.code === 'too_small' && typeof issue.minimum === 'number' && typeof from === 'number') {
    return { to: issue.minimum };
  }
  return undefined;
}

/**
 * Read a recipe from outside the program.
 *
 * A recipe written against a build with wider ranges should not be lost
 * wholesale over one slider, so values that merely sit outside their range are
 * clamped or truncated and reported. Anything that is not a range problem — a string where a
 * number belongs, a missing anchor — still fails.
 */
export function loadRecipe(input: unknown): LoadResult {
  let migrated: Record<string, unknown>;
  let notes: string[];
  try {
    const m = migrateRecipe(input);
    migrated = structuredClone(m.value);
    notes = m.notes;
  } catch (err) {
    return { ok: false, issues: [err instanceof Error ? err.message : String(err)] };
  }

  const first = recipeSchema.safeParse(migrated);
  if (first.success) return { ok: true, recipe: first.data, repairs: [], notes };

  const repairs: Repair[] = [];
  for (const issue of first.error.issues) {
    const path = issue.path as PropertyKey[];
    const from = readAtPath(migrated, path);
    const fix = repairedValue(issue, from);
    if (fix === undefined) continue;
    setAtPath(migrated, path, fix.to);
    repairs.push({ path: issue.path.join('.'), from, to: fix.to });
  }

  const second = recipeSchema.safeParse(migrated);
  if (second.success) return { ok: true, recipe: second.data, repairs, notes };

  return {
    ok: false,
    issues: second.error.issues.map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`),
  };
}

/**
 * Validate on the way out.
 *
 * Everything written out goes through a strict parse so what is stored is
 * always something this program can read back.
 */
export function serializeRecipe(recipe: Recipe): string {
  return JSON.stringify(recipeSchema.parse(recipe));
}
