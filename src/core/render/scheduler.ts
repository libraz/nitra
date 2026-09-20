/**
 * Resolution scheduling.
 *
 * The same graph is evaluated at two sizes. While a slider is moving, a proxy
 * capped at 1024 pixels keeps the image following the finger; once it settles,
 * the full-size evaluation runs and replaces it.
 *
 * The measurement pass is pinned to the settled state on purpose. Reading pixels
 * back stalls the GPU, and a stall inside a drag is exactly the lag the proxy
 * exists to avoid.
 */

import type { Recipe } from '../recipe/schema';
import type { Pipeline, RenderStats } from './pipeline';

export interface SchedulerHooks {
  recipe(): Recipe;
  /** Called after the settled full-resolution render has been measured. */
  stats?(stats: RenderStats): void;
  /** Called whenever the displayed resolution changes. */
  scaleChanged?(scale: 'proxy' | 'full'): void;
  /**
   * Called when the plate, or the texture it has to go into, could not be made.
   *
   * Named for the plate rather than for the fill because every CPU stage
   * accumulates in it: a circle that failed to conceal a reflection reported as
   * a brush that did not work would send somebody looking in the wrong place.
   */
  plateFailed?(error: unknown): void;
}

/** How long the recipe has to stay still before the full render is worth it. */
const SETTLE_MS = 180;

export class RenderScheduler {
  private frame = 0;
  private settleTimer: ReturnType<typeof setTimeout> | null = null;
  private showOriginal = false;
  private fullFrame = false;
  private atFullResolution = false;
  private zoom = 1;
  private disposed = false;

  constructor(
    private readonly pipeline: Pipeline,
    private readonly hooks: SchedulerHooks,
  ) {}

  /** The recipe changed: show the proxy now, schedule the full render. */
  markDirty(): void {
    this.atFullResolution = false;
    this.schedulePreview();
    this.scheduleSettled();
  }

  /** Redraw at whatever resolution is already current, e.g. after a resize. */
  refresh(): void {
    this.schedulePreview();
  }

  /**
   * Magnify the view.
   *
   * A redraw at the resolution already current, never a new settle: the recipe
   * has not moved, so the fills and the restore have nothing to redo and the
   * measurement would come back with the numbers it already has. What changes is
   * how many pixels the canvas is given.
   */
  setZoom(zoom: number): void {
    if (this.zoom === zoom) return;
    this.zoom = zoom;
    this.schedulePreview();
  }

  setShowOriginal(on: boolean): void {
    if (this.showOriginal === on) return;
    this.showOriginal = on;
    this.schedulePreview();
  }

  /**
   * Show the whole frame rather than the crop.
   *
   * Entering this drops back to the proxy: the frame is a different size from
   * the crop, so the settled render on screen is of the wrong picture and
   * leaving it up until the next settle would show a stale crop underneath a
   * live rectangle.
   */
  setFullFrame(on: boolean): void {
    if (this.fullFrame === on) return;
    this.fullFrame = on;
    this.markDirty();
  }

  dispose(): void {
    this.disposed = true;
    if (this.frame) cancelAnimationFrame(this.frame);
    if (this.settleTimer) clearTimeout(this.settleTimer);
  }

  private schedulePreview(): void {
    // Nothing to draw is a state, not a failure: a window resize or the fonts
    // finishing arrive on their own schedule and can land before a photo has
    // been opened at all.
    if (this.disposed || this.frame || !this.pipeline.hasSource) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      if (this.disposed) return;
      const scale = this.atFullResolution ? 'full' : 'proxy';
      this.pipeline.renderToCanvas(this.hooks.recipe(), scale, {
        original: this.showOriginal,
        fullFrame: this.fullFrame,
        zoom: this.zoom,
      });
      this.hooks.scaleChanged?.(scale);
    });
  }

  private scheduleSettled(): void {
    if (this.settleTimer) clearTimeout(this.settleTimer);
    this.settleTimer = setTimeout(() => {
      this.settleTimer = null;
      void this.renderSettled();
    }, SETTLE_MS);
  }

  /**
   * The full-resolution render, once the recipe has stopped moving.
   *
   * The two stages that work on pixels rather than in a shader — the restore
   * and the fills — run here and nowhere else, which is what keeps them out of
   * the drag loop by construction rather than by everyone remembering: this
   * function is only reachable from a recipe that has been still for
   * {@link SETTLE_MS}, and the proxy path — the one a moving slider goes through
   * — cannot call it. Until it has run, the proxy shows the photograph with the
   * spot still in it, which is what has actually happened so far.
   */
  private async renderSettled(): Promise<void> {
    if (this.disposed || !this.pipeline.hasSource) return;
    const recipe = this.hooks.recipe();
    try {
      await this.pipeline.syncPlate(recipe);
    } catch (error) {
      this.hooks.plateFailed?.(error);
    }
    // Something moved while the fill was running, and there is a settle of its
    // own on the way for whatever it was.
    if (this.disposed || !this.pipeline.hasSource || this.hooks.recipe() !== recipe) return;
    this.atFullResolution = true;
    this.pipeline.renderToCanvas(recipe, 'full', {
      original: this.showOriginal,
      fullFrame: this.fullFrame,
      zoom: this.zoom,
    });
    this.hooks.scaleChanged?.('full');
    if (this.hooks.stats) this.hooks.stats(this.pipeline.measure(recipe));
  }
}
