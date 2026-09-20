/**
 * Where the picture is being looked at from.
 *
 * Two properties carry the whole stage and everything else here is a corollary
 * of one of them. The picture covers the window at every magnification, which is
 * what keeps a band of the surround from being dragged into the middle of the
 * frame; and a magnification about a point leaves that point where it was, which
 * is what makes a wheel feel like it is moving the photograph rather than
 * resetting the view on every notch.
 *
 * The combinations are a covering array rather than a handful chosen by eye,
 * because what breaks a viewer is the interaction between two of these and not
 * any one of them: a zoom near a corner at the limit clamps on one axis and not
 * the other, and that is exactly the case nobody writes down.
 */

import { describe, expect, it } from 'vitest';
import {
  clampView,
  FIT_VIEW,
  maxZoom,
  oneToOneZoom,
  panBy,
  type View,
  viewTransform,
  ZOOM_FIT,
  zoomAbout,
} from '../src/ui/view';

/** Bounds the centre has to stay inside for the picture to cover the window. */
function bounds(zoom: number): [number, number] {
  return [0.5 / zoom, 1 - 0.5 / zoom];
}

/** The picture coordinate under a point of the window, which is what a zoom holds still. */
function under(view: View, p: number, axis: 'x' | 'y'): number {
  return view[axis] + (p - 0.5) / view.zoom;
}

/**
 * Where a plate point lands in the window, read back out of the CSS transform.
 *
 * Parsed rather than recomputed: the string is what the browser is handed, so a
 * sign lost on the way into it is a picture off the side of the frame and no
 * arithmetic in this file would have noticed.
 */
function applyTransform(transform: string, u: number, v: number): [number, number] {
  if (transform === 'none') return [u, v];
  const numbers = transform.match(/-?\d+\.?\d*/g);
  expect(numbers).not.toBeNull();
  const [tx, ty, zoom] = (numbers as string[]).map(Number) as [number, number, number];
  return [tx / 100 + u * zoom, ty / 100 + v * zoom];
}

// startZoom × factor × px × py × startX × startY × limit, pairwise.
const CASES: [number, number, number, number, number, number, number][] = [
  [1, 1.25, 0, 0.5, 0.1, 0.5, 4],
  [4, 8, 1, 0, 0.5, 0.2, 4],
  [1.5, 1, 0.5, 0.75, 0.5, 0.5, 16],
  [1.5, 0.25, 0.35, 1, 0.9, 0.8, 4],
  [16, 0.8, 0.5, 0, 0.1, 0.8, 4],
  [16, 0.25, 0, 0.5, 0.5, 0.2, 16],
  [4, 1.25, 0.35, 0.75, 0.9, 0.8, 16],
  [1, 0.8, 1, 1, 0.5, 0.8, 16],
  [4, 8, 0.5, 1, 0.1, 0.2, 16],
  [1, 1, 0.35, 0.75, 0.9, 0.2, 4],
  [16, 0.25, 1, 0.75, 0.1, 0.5, 16],
  [1, 8, 0.35, 0, 0.5, 0.5, 16],
  [16, 8, 1, 0.5, 0.9, 0.8, 16],
  [4, 0.25, 0, 0, 0.9, 0.5, 4],
  [1.5, 0.8, 0.35, 0.5, 0.9, 0.2, 4],
  [1.5, 8, 0, 0.75, 0.1, 0.8, 16],
  [4, 1, 0.35, 0.5, 0.1, 0.8, 16],
  [16, 1, 0, 1, 0.9, 0.8, 4],
  [1, 0.25, 0.5, 0.5, 0.9, 0.5, 16],
  [4, 0.8, 0, 1, 0.9, 0.5, 16],
  [1.5, 1.25, 1, 0, 0.5, 0.5, 4],
  [16, 0.8, 0.35, 0.75, 0.1, 0.5, 16],
  [1.5, 1.25, 0.5, 1, 0.5, 0.5, 4],
  [4, 1, 1, 1, 0.9, 0.5, 4],
  [16, 1.25, 0.5, 0.5, 0.1, 0.5, 4],
  [4, 1, 0.5, 0, 0.9, 0.5, 16],
  [1, 1.25, 0, 1, 0.9, 0.2, 16],
];

describe('the view always covers the window', () => {
  it.each(CASES)(
    'zoom %f by %f about (%f, %f) from (%f, %f) under a limit of %i',
    (startZoom, factor, px, py, startX, startY, limit) => {
      // Every view the app holds has been through the clamp, so the starting
      // point for this is one that has: a zoom about an impossible view would be
      // measuring a state that cannot happen.
      const start = clampView({ zoom: startZoom, x: startX, y: startY }, limit);
      const next = zoomAbout(start, factor, px, py, limit);

      expect(next.zoom).toBeGreaterThanOrEqual(ZOOM_FIT);
      expect(next.zoom).toBeLessThanOrEqual(limit + 1e-12);

      const [low, high] = bounds(next.zoom);
      expect(next.x).toBeGreaterThanOrEqual(low - 1e-9);
      expect(next.x).toBeLessThanOrEqual(high + 1e-9);
      expect(next.y).toBeGreaterThanOrEqual(low - 1e-9);
      expect(next.y).toBeLessThanOrEqual(high + 1e-9);

      // The point under the pointer stays under the pointer — except on an axis
      // that ran into an edge, where holding it would mean showing the surround
      // through the photograph. Which of the two happened is asserted rather
      // than assumed: a centre sitting strictly inside its bounds had no edge to
      // blame, so there the anchor is owed exactly.
      for (const axis of ['x', 'y'] as const) {
        const p = axis === 'x' ? px : py;
        if (next[axis] > low + 1e-6 && next[axis] < high - 1e-6) {
          expect(under(next, p, axis)).toBeCloseTo(under(start, p, axis), 6);
        }
      }
    },
  );
});

describe('the transform puts the view on screen', () => {
  it('is absent at fit, so an unzoomed stage composites nothing', () => {
    expect(viewTransform(FIT_VIEW)).toBe('none');
  });

  it.each(CASES)(
    'centres on the view from zoom %f by %f about (%f, %f) from (%f, %f) under %i',
    (startZoom, factor, px, py, startX, startY, limit) => {
      const view = zoomAbout(
        clampView({ zoom: startZoom, x: startX, y: startY }, limit),
        factor,
        px,
        py,
        limit,
      );
      const transform = viewTransform(view);

      // The point the view names is the point in the middle of the window.
      const [cx, cy] = applyTransform(transform, view.x, view.y);
      expect(cx).toBeCloseTo(0.5, 4);
      expect(cy).toBeCloseTo(0.5, 4);

      // And the picture reaches past both edges of it, which is the covering
      // property again — read this time off the string the browser is given
      // rather than off the numbers that produced it.
      const [left, top] = applyTransform(transform, 0, 0);
      const [right, bottom] = applyTransform(transform, 1, 1);
      expect(left).toBeLessThanOrEqual(1e-4);
      expect(top).toBeLessThanOrEqual(1e-4);
      expect(right).toBeGreaterThanOrEqual(1 - 1e-4);
      expect(bottom).toBeGreaterThanOrEqual(1 - 1e-4);
    },
  );
});

describe('fit is a floor, not a starting point', () => {
  it('pins the centre when the whole picture is on screen', () => {
    expect(clampView({ zoom: 0.2, x: 0.9, y: 0.1 }, 16)).toEqual(FIT_VIEW);
  });

  it('will not magnify past the limit however it is asked', () => {
    expect(clampView({ zoom: 1e6, x: 0.5, y: 0.5 }, 8).zoom).toBe(8);
    expect(zoomAbout(FIT_VIEW, 1e6, 0.5, 0.5, 8).zoom).toBe(8);
  });

  it('treats a limit below fit as fit, so a bad measurement cannot shrink the picture', () => {
    expect(clampView({ zoom: 4, x: 0.5, y: 0.5 }, 0.1).zoom).toBe(ZOOM_FIT);
  });
});

describe('a hand drag moves the picture as far as the pointer went', () => {
  it('converts a fraction of the window into a fraction of the picture', () => {
    // A tenth of the window at four times magnification is a fortieth of the
    // photograph, which is what makes a drag track the finger at every zoom.
    const dragged = panBy({ zoom: 4, x: 0.5, y: 0.5 }, 0.1, -0.2, 16);
    expect(dragged.x).toBeCloseTo(0.5 - 0.1 / 4, 9);
    expect(dragged.y).toBeCloseTo(0.5 + 0.2 / 4, 9);
  });

  it('stops at the edge rather than pulling the surround into the frame', () => {
    const dragged = panBy({ zoom: 2, x: 0.3, y: 0.5 }, 0.9, 0, 16);
    expect(dragged.x).toBeCloseTo(0.25, 9);
  });

  it('cannot move a fitted picture at all', () => {
    expect(panBy(FIT_VIEW, 0.4, 0.4, 16)).toEqual(FIT_VIEW);
  });
});

describe('what the magnification is measured against', () => {
  it("offers enough range to pass the photograph's own pixels", () => {
    // A twelve-megapixel photo fitted into a laptop stage: one to one is about
    // three and a half times the fit, and the slider has to reach past it.
    const fitScale = 1200 / 4240;
    expect(oneToOneZoom(fitScale)).toBeCloseTo(4240 / 1200, 9);
    expect(maxZoom(fitScale)).toBeGreaterThan(oneToOneZoom(fitScale) as number);
  });

  it('has no one-to-one to offer when the picture is already past its own pixels', () => {
    // A small photo shown larger than it was recorded. Fit is already a
    // magnification, so there is nothing below it to go back to.
    expect(oneToOneZoom(1.4)).toBeNull();
    expect(oneToOneZoom(1)).toBeNull();
  });

  it('falls back to a usable range before anything has been measured', () => {
    expect(maxZoom(null)).toBeGreaterThan(ZOOM_FIT);
    expect(oneToOneZoom(null)).toBeNull();
  });

  it('is bounded either side, so neither a tiny photo nor a panorama runs away', () => {
    expect(maxZoom(0.9)).toBe(8);
    expect(maxZoom(0.001)).toBe(64);
  });
});
