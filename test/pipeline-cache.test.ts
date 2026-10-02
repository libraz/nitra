/**
 * The graph holds one result per node per variant, and overwriting a slot is
 * what releases its texture. A variant named after anything that varies — a
 * size, a framing — turns that into one resident chain per value ever rendered,
 * so a crop being dragged fills the GPU. Checked against the source, since the
 * failure needs a GPU to show and nothing short of running out of memory to see.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const pipelineSource = readFileSync(
  new URL('../src/core/render/pipeline.ts', import.meta.url),
  'utf8',
);

/** The last argument of every `this.dag.evaluate(...)` call. */
function variantArguments(): string[] {
  return [...pipelineSource.matchAll(/this\.dag\.evaluate\(([^;]*?)\);/g)].map((match) => {
    const args = (match[1] as string).split(',');
    return (args[args.length - 1] as string).trim();
  });
}

describe('graph cache roles', () => {
  it('names every variant by role', () => {
    const variants = variantArguments();
    expect(variants.length).toBeGreaterThan(10);
    for (const variant of variants) {
      expect(variant, 'a variant is a role or a value holding one').toMatch(/^('\w+'|variant)$/);
    }
  });

  it('computes the role from nothing that varies with the framing or the size', () => {
    const assignments = [...pipelineSource.matchAll(/const variant = ([^;]+);/g)].map(
      (match) => match[1] as string,
    );
    expect(assignments.length).toBeGreaterThan(0);
    for (const assignment of assignments) {
      expect(assignment).toMatch(/^(canvasRole\(|'\w+'$)/);
      expect(assignment).not.toMatch(/spec|geometry|width|height|key/i);
    }
    expect(pipelineSource).not.toMatch(/variantKey/);
  });

  it('builds a canvas role from a closed set', () => {
    const body = pipelineSource.slice(pipelineSource.indexOf('function canvasRole('));
    const returned = body.slice(body.indexOf('return'), body.indexOf('\n}'));
    // Only the three switches that pick a chain, never a spec or a recipe.
    expect(returned).not.toMatch(/spec|recipe|geometry/);
  });
});
