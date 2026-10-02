/**
 * What the scheduler promises about when the expensive work happens.
 *
 * The proxy is what a moving slider sees, so nothing on that path may read
 * pixels or touch the plate; magnifying is a redraw and never a settle; and a
 * settle the recipe moved under must not draw or measure the recipe it started
 * with. Each of these is invisible when broken except as lag or a stale frame.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { neutralRecipe, type Recipe } from '../src/core/recipe/schema';
import type { Pipeline } from '../src/core/render/pipeline';
import { RenderScheduler } from '../src/core/render/scheduler';

interface Call {
  method: string;
  recipe?: Recipe;
  scale?: string;
}

function mockPipeline(calls: Call[]) {
  let release: (() => void) | null = null;
  const pipeline = {
    hasSource: true,
    holdPlate: false,
    renderToCanvas(recipe: Recipe, scale: string) {
      calls.push({ method: 'renderToCanvas', recipe, scale });
    },
    syncPlate(recipe: Recipe) {
      calls.push({ method: 'syncPlate', recipe });
      if (!pipeline.holdPlate) return Promise.resolve();
      return new Promise<void>((resolve) => {
        release = resolve;
      });
    },
    measure(recipe: Recipe) {
      calls.push({ method: 'measure', recipe });
      return {};
    },
    releaseIdle() {
      calls.push({ method: 'releaseIdle' });
    },
  };
  return { pipeline, finishPlate: () => release?.() };
}

let frames: FrameRequestCallback[] = [];

function runFrames(): void {
  const pending = frames;
  frames = [];
  for (const frame of pending) frame(0);
}

beforeEach(() => {
  vi.useFakeTimers();
  frames = [];
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frames.push(callback);
    return frames.length;
  });
  vi.stubGlobal('cancelAnimationFrame', () => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function setup() {
  const calls: Call[] = [];
  const mock = mockPipeline(calls);
  let recipe = neutralRecipe();
  const stats: unknown[] = [];
  const scheduler = new RenderScheduler(mock.pipeline as unknown as Pipeline, {
    recipe: () => recipe,
    stats: (value) => stats.push(value),
  });
  return {
    calls,
    stats,
    scheduler,
    mock,
    setRecipe: (next: Recipe) => {
      recipe = next;
    },
  };
}

describe('the proxy path', () => {
  it('draws without reaching the plate or reading anything back', () => {
    const { calls, scheduler } = setup();
    scheduler.markDirty();
    runFrames();
    expect(calls.map((call) => call.method)).toEqual(['renderToCanvas']);
    expect(calls[0]?.scale).toBe('proxy');
  });

  it('settles only once the recipe has been still', async () => {
    const { calls, scheduler } = setup();
    for (let i = 0; i < 5; i++) {
      scheduler.markDirty();
      runFrames();
      await vi.advanceTimersByTimeAsync(50);
    }
    expect(calls.some((call) => call.method === 'syncPlate')).toBe(false);
    await vi.advanceTimersByTimeAsync(500);
    expect(calls.map((call) => call.method).slice(-4)).toEqual([
      'syncPlate',
      'renderToCanvas',
      'measure',
      'releaseIdle',
    ]);
  });
});

describe('magnifying', () => {
  it('redraws at the current resolution and never settles', async () => {
    const { calls, scheduler } = setup();
    scheduler.markDirty();
    runFrames();
    await vi.advanceTimersByTimeAsync(500);
    calls.length = 0;

    scheduler.setZoom(2);
    runFrames();
    scheduler.setZoom(3);
    runFrames();
    await vi.advanceTimersByTimeAsync(500);
    expect(calls.map((call) => call.method)).toEqual(['renderToCanvas', 'renderToCanvas']);
    expect(calls.every((call) => call.scale === 'full')).toBe(true);
  });
});

describe('a settle the recipe moved under', () => {
  it('neither draws nor measures the recipe it started with', async () => {
    const { calls, scheduler, mock, setRecipe, stats } = setup();
    mock.pipeline.holdPlate = true;
    const first = neutralRecipe();
    setRecipe(first);
    scheduler.markDirty();
    runFrames();
    await vi.advanceTimersByTimeAsync(200);
    expect(calls.some((call) => call.method === 'syncPlate')).toBe(true);

    // The recipe moves while the fill is still running.
    setRecipe({ ...first, global: { ...first.global, exposure: 0.5 } } as Recipe);
    calls.length = 0;
    mock.finishPlate();
    await vi.advanceTimersByTimeAsync(0);

    expect(calls.filter((call) => call.method === 'renderToCanvas')).toEqual([]);
    expect(calls.some((call) => call.method === 'measure')).toBe(false);
    expect(stats).toEqual([]);
  });
});
