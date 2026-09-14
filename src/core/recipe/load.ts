/**
 * The trust boundary for recipes.
 *
 * Recipes arrive from a URL, a file or local storage — all outside the program —
 * so validation happens here and only here. Out-of-range numbers are the reason:
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
  to: number;
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

/** The bound an out-of-range issue was measured against, if it carries one. */
function boundOf(issue: ZodIssue): number | undefined {
  if (issue.code === 'too_big' && typeof issue.maximum === 'number') return issue.maximum;
  if (issue.code === 'too_small' && typeof issue.minimum === 'number') return issue.minimum;
  return undefined;
}

/**
 * Read a recipe from outside the program.
 *
 * A shared preset written against a build with wider ranges should not be lost
 * wholesale over one slider, so values that merely sit outside their range are
 * clamped and reported. Anything that is not a range problem — a string where a
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
    const bound = boundOf(issue);
    if (bound === undefined) continue;
    const from = readAtPath(migrated, issue.path as PropertyKey[]);
    setAtPath(migrated, issue.path as PropertyKey[], bound);
    repairs.push({ path: issue.path.join('.'), from, to: bound });
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
 * Everything saved or shared goes through a strict parse so a file on disk is
 * always a file this program can read back.
 */
export function serializeRecipe(recipe: Recipe): string {
  return JSON.stringify(recipeSchema.parse(recipe));
}
