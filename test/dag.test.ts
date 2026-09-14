/**
 * The graph's whole reason to exist is that it does not re-run work whose inputs
 * did not change, so the tests count evaluations rather than inspect results.
 */

import { describe, expect, it } from 'vitest';
import { Dag, type DagNode } from '../src/core/graph/dag';

interface Params {
  a: number;
  b: number;
}

type Node = DagNode<null, string, Params>;

function chain(runs: string[]): Node[] {
  const source: Node = {
    id: 'source',
    inputs: [],
    signature: () => 'source',
    evaluate: () => {
      runs.push('source');
      return 'source';
    },
  };
  const heavy: Node = {
    id: 'heavy',
    inputs: ['source'],
    signature: (params) => `heavy:${params.a}`,
    evaluate: (_ctx, [input], params) => {
      runs.push('heavy');
      return `${input}>heavy(${params.a})`;
    },
  };
  const light: Node = {
    id: 'light',
    inputs: ['heavy'],
    signature: (params) => `light:${params.b}`,
    evaluate: (_ctx, [input], params) => {
      runs.push('light');
      return `${input}>light(${params.b})`;
    },
  };
  return [source, heavy, light];
}

describe('differential re-evaluation', () => {
  it('runs every node the first time', () => {
    const runs: string[] = [];
    const dag = new Dag(chain(runs), () => {});
    expect(dag.evaluate(null, { a: 1, b: 1 }, 'light', 'full')).toBe('source>heavy(1)>light(1)');
    expect(runs).toEqual(['source', 'heavy', 'light']);
  });

  it('re-runs nothing when the parameters are unchanged', () => {
    const runs: string[] = [];
    const dag = new Dag(chain(runs), () => {});
    dag.evaluate(null, { a: 1, b: 1 }, 'light', 'full');
    runs.length = 0;
    dag.evaluate(null, { a: 1, b: 1 }, 'light', 'full');
    expect(runs).toEqual([]);
  });

  it('holds the expensive stage while a downstream parameter moves', () => {
    // This is what makes a slider feel attached to the image: dragging the cheap
    // control must not re-run the stage above it.
    const runs: string[] = [];
    const dag = new Dag(chain(runs), () => {});
    dag.evaluate(null, { a: 1, b: 1 }, 'light', 'full');
    runs.length = 0;
    dag.evaluate(null, { a: 1, b: 2 }, 'light', 'full');
    expect(runs).toEqual(['light']);
  });

  it('re-runs everything downstream of a changed stage', () => {
    const runs: string[] = [];
    const dag = new Dag(chain(runs), () => {});
    dag.evaluate(null, { a: 1, b: 1 }, 'light', 'full');
    runs.length = 0;
    dag.evaluate(null, { a: 2, b: 1 }, 'light', 'full');
    expect(runs).toEqual(['heavy', 'light']);
  });

  it('keeps resolutions apart so the proxy and the full render do not evict each other', () => {
    const runs: string[] = [];
    const dag = new Dag(chain(runs), () => {});
    dag.evaluate(null, { a: 1, b: 1 }, 'light', 'proxy');
    dag.evaluate(null, { a: 1, b: 1 }, 'light', 'full');
    runs.length = 0;
    dag.evaluate(null, { a: 1, b: 1 }, 'light', 'proxy');
    expect(runs).toEqual([]);
  });

  it('skips nodes the requested output does not depend on', () => {
    const runs: string[] = [];
    const dag = new Dag(chain(runs), () => {});
    dag.evaluate(null, { a: 1, b: 1 }, 'heavy', 'full');
    expect(runs).toEqual(['source', 'heavy']);
  });
});

describe('resource handover', () => {
  it('hands a superseded result back exactly once', () => {
    const released: string[] = [];
    const runs: string[] = [];
    const dag = new Dag(chain(runs), (value) => released.push(value));
    dag.evaluate(null, { a: 1, b: 1 }, 'light', 'full');
    expect(released).toEqual([]);
    dag.evaluate(null, { a: 2, b: 1 }, 'light', 'full');
    expect(released).toEqual(['source>heavy(1)', 'source>heavy(1)>light(1)']);
  });

  it('releases everything when the source is replaced', () => {
    const released: string[] = [];
    const dag = new Dag(chain([]), (value) => released.push(value));
    dag.evaluate(null, { a: 1, b: 1 }, 'light', 'full');
    dag.invalidate();
    expect(released).toHaveLength(3);
  });

  it('releases only the named resolution', () => {
    const released: string[] = [];
    const dag = new Dag(chain([]), (value) => released.push(value));
    dag.evaluate(null, { a: 1, b: 1 }, 'light', 'proxy');
    dag.evaluate(null, { a: 1, b: 1 }, 'light', 'full');
    dag.invalidate('proxy');
    expect(released).toHaveLength(3);
  });
});

/**
 * A stage that is switched off has to cost nothing, not cost a copy.
 *
 * This is what lets an expensive analysis chain hang off one stage: with the
 * stage inactive, none of what feeds it is evaluated at all. A photo with no
 * face in it therefore costs what it did before those stages existed.
 */
describe('a stage with nothing to do', () => {
  interface Switchable {
    on: boolean;
    b: number;
  }

  type Node = DagNode<null, string, Switchable>;

  function branching(runs: string[]): Node[] {
    const make = (id: string, inputs: string[], active?: Node['active']): Node => ({
      id,
      inputs,
      ...(active ? { active } : {}),
      signature: () => id,
      evaluate: (_ctx, values) => {
        runs.push(id);
        return values.length > 0 ? `${id}(${values.join(',')})` : id;
      },
    });
    return [
      make('source', []),
      make('analysis', ['source']),
      make('expensive', ['analysis']),
      make('stage', ['source', 'expensive'], (params) => params.on),
      {
        id: 'after',
        inputs: ['stage'],
        signature: (params) => `after:${params.b}`,
        evaluate: (_ctx, [input], params) => {
          runs.push('after');
          return `${input}>after(${params.b})`;
        },
      },
    ];
  }

  it('passes its first input straight through', () => {
    const dag = new Dag(branching([]), () => {});
    expect(dag.evaluate(null, { on: false, b: 1 }, 'after', 'full')).toBe('source>after(1)');
  });

  it('does not evaluate the branch feeding its other inputs', () => {
    const runs: string[] = [];
    const dag = new Dag(branching(runs), () => {});
    dag.evaluate(null, { on: false, b: 1 }, 'after', 'full');
    expect(runs).toEqual(['source', 'after']);
  });

  it('runs the whole chain once it has something to do', () => {
    const runs: string[] = [];
    const dag = new Dag(branching(runs), () => {});
    dag.evaluate(null, { on: true, b: 1 }, 'after', 'full');
    expect(runs).toEqual(['source', 'analysis', 'expensive', 'stage', 'after']);
    expect(dag.evaluate(null, { on: true, b: 1 }, 'after', 'full')).toBe(
      'stage(source,expensive(analysis(source)))>after(1)',
    );
  });

  it('does not hand the same result back twice', () => {
    // The pass-through is not cached under the inactive node's own id: the value
    // stays owned by the input that produced it, and a double release would put
    // a live texture back in the pool.
    const released: string[] = [];
    const dag = new Dag(branching([]), (value) => released.push(value));
    dag.evaluate(null, { on: false, b: 1 }, 'after', 'full');
    dag.invalidate();
    expect(released).toEqual(['source', 'source>after(1)']);
  });

  it('releases what it produced when it stops doing anything', () => {
    const released: string[] = [];
    const dag = new Dag(branching([]), (value) => released.push(value));
    dag.evaluate(null, { on: true, b: 1 }, 'after', 'full');
    released.length = 0;
    dag.evaluate(null, { on: false, b: 1 }, 'after', 'full');
    expect(released).toContain('stage(source,expensive(analysis(source)))');
  });

  it('starts the chain again when it is switched back on', () => {
    const runs: string[] = [];
    const dag = new Dag(branching(runs), () => {});
    dag.evaluate(null, { on: true, b: 1 }, 'after', 'full');
    dag.evaluate(null, { on: false, b: 1 }, 'after', 'full');
    runs.length = 0;
    dag.evaluate(null, { on: true, b: 1 }, 'after', 'full');
    expect(runs).toEqual(['stage', 'after']);
  });

  it('can still be asked for a node inside the skipped branch by name', () => {
    // Which is how the skin measurement reaches the filter coefficients under a
    // neutral recipe: it asks for them, rather than for something that would
    // have pulled them in.
    const runs: string[] = [];
    const dag = new Dag(branching(runs), () => {});
    expect(dag.evaluate(null, { on: false, b: 1 }, 'expensive', 'full')).toBe(
      'expensive(analysis(source))',
    );
    expect(runs).toEqual(['source', 'analysis', 'expensive']);
  });

  it('refuses a node that is switched off with nothing to pass through', () => {
    const orphan: Node = {
      id: 'only',
      inputs: [],
      active: () => false,
      signature: () => 'only',
      evaluate: () => 'only',
    };
    const dag = new Dag([orphan], () => {});
    expect(() => dag.evaluate(null, { on: false, b: 1 }, 'only', 'full')).toThrow(
      /nothing to pass through/,
    );
  });
});

describe('structure', () => {
  it('rejects a cycle when the graph is built', () => {
    const node = (id: string, inputs: string[]): Node => ({
      id,
      inputs,
      signature: () => id,
      evaluate: () => id,
    });
    expect(() => new Dag([node('a', ['b']), node('b', ['a'])], () => {})).toThrow(/cycle/);
  });

  it('rejects a duplicate node id', () => {
    const node = (id: string): Node => ({
      id,
      inputs: [],
      signature: () => id,
      evaluate: () => id,
    });
    expect(() => new Dag([node('a'), node('a')], () => {})).toThrow(/duplicate/);
  });

  it('rejects an input that does not exist', () => {
    const orphan: Node = {
      id: 'a',
      inputs: ['missing'],
      signature: () => 'a',
      evaluate: () => 'a',
    };
    expect(() => new Dag([orphan], () => {})).toThrow(/unknown node/);
  });
});
