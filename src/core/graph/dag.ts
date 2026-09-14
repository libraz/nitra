/**
 * Effect graph with differential re-evaluation.
 *
 * Only the nodes whose inputs or parameters actually changed are re-run. This is
 * what makes a slider feel attached to the image: the expensive stages hold
 * their results while a cheap one downstream is being dragged.
 *
 * It has to exist from the start. Retrofitting it means re-deriving every
 * dependency in the pipeline after the fact, and by then the stages have grown
 * assumptions about running in a fixed order.
 */

export interface DagNode<Ctx, Value, Params> {
  readonly id: string;
  /** Ids of the nodes whose results this one consumes, in argument order. */
  readonly inputs: readonly string[];
  /**
   * Stable digest of everything this node's own output depends on, apart from
   * its inputs. Two evaluations with equal signatures must produce equal pixels.
   */
  signature(params: Params, ctx: Ctx): string;
  evaluate(ctx: Ctx, inputs: readonly Value[], params: Params): Value;
}

interface CacheEntry<Value> {
  key: string;
  value: Value;
}

export class Dag<Ctx, Value, Params> {
  private readonly nodes = new Map<string, DagNode<Ctx, Value, Params>>();
  private readonly order: string[];
  private readonly cache = new Map<string, CacheEntry<Value>>();

  /**
   * @param release Hands a superseded result back to whoever owns the memory.
   */
  constructor(
    nodes: readonly DagNode<Ctx, Value, Params>[],
    private readonly release: (value: Value) => void,
  ) {
    for (const node of nodes) {
      if (this.nodes.has(node.id)) throw new Error(`duplicate node id: ${node.id}`);
      this.nodes.set(node.id, node);
    }
    this.order = topologicalOrder(this.nodes);
  }

  /**
   * Evaluate up to `outputId`.
   *
   * `variant` separates results that are the same computation at a different
   * resolution, so the proxy and the full-size render do not evict each other.
   */
  evaluate(ctx: Ctx, params: Params, outputId: string, variant: string): Value {
    const needed = this.ancestorsOf(outputId);
    const keys = new Map<string, string>();

    for (const id of this.order) {
      if (!needed.has(id)) continue;
      const node = this.nodes.get(id) as DagNode<Ctx, Value, Params>;
      const inputKeys = node.inputs.map((input) => keys.get(input) ?? '');
      const key = `${node.signature(params, ctx)}<-${inputKeys.join(',')}`;
      keys.set(id, key);

      const slot = `${variant}::${id}`;
      const cached = this.cache.get(slot);
      if (cached && cached.key === key) continue;

      const inputs = node.inputs.map((input) => {
        const entry = this.cache.get(`${variant}::${input}`);
        if (!entry) throw new Error(`node ${id} ran before its input ${input}`);
        return entry.value;
      });
      const value = node.evaluate(ctx, inputs, params);
      if (cached) this.release(cached.value);
      this.cache.set(slot, { key, value });
    }

    const result = this.cache.get(`${variant}::${outputId}`);
    if (!result) throw new Error(`node ${outputId} produced no result`);
    return result.value;
  }

  /** Drop every cached result, e.g. when the source image is replaced. */
  invalidate(variant?: string): void {
    for (const [slot, entry] of this.cache) {
      if (variant !== undefined && !slot.startsWith(`${variant}::`)) continue;
      this.release(entry.value);
      this.cache.delete(slot);
    }
  }

  private ancestorsOf(outputId: string): Set<string> {
    const needed = new Set<string>();
    const stack = [outputId];
    while (stack.length > 0) {
      const id = stack.pop() as string;
      if (needed.has(id)) continue;
      const node = this.nodes.get(id);
      if (!node) throw new Error(`unknown node: ${id}`);
      needed.add(id);
      stack.push(...node.inputs);
    }
    return needed;
  }
}

function topologicalOrder<Ctx, Value, Params>(
  nodes: ReadonlyMap<string, DagNode<Ctx, Value, Params>>,
): string[] {
  const order: string[] = [];
  const state = new Map<string, 'visiting' | 'done'>();

  const visit = (id: string, trail: string[]): void => {
    const mark = state.get(id);
    if (mark === 'done') return;
    if (mark === 'visiting')
      throw new Error(`cycle in effect graph: ${[...trail, id].join(' -> ')}`);
    const node = nodes.get(id);
    if (!node) throw new Error(`unknown node: ${id}`);
    state.set(id, 'visiting');
    for (const input of node.inputs) visit(input, [...trail, id]);
    state.set(id, 'done');
    order.push(id);
  };

  for (const id of nodes.keys()) visit(id, []);
  return order;
}
