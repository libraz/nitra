/**
 * Where the picture is being looked at from.
 *
 * This is a property of the screen, not of the photograph, so it lives beside
 * the panel state rather than in the recipe: two people opening the same recipe
 * get the same picture, and one of them having been zoomed into a cheek when
 * they saved it is not part of what the recipe says. It is the same reason a
 * supplied typeface and a restore reference are held outside it.
 *
 * The centre is in the displayed picture's own normalised coordinates, which is
 * what makes it survive a window resize: the point being looked at is a place on
 * the photograph, not a scroll offset in pixels that means something different
 * once the stage has changed shape.
 */

/** Fit. Below this the picture would be smaller than the room it has. */
export const ZOOM_FIT = 1;

export interface View {
  /** Multiple of the fit size. 1 shows the whole picture. */
  zoom: number;
  /** The point at the centre of the window, as a fraction of the picture. */
  x: number;
  y: number;
}

export const FIT_VIEW: View = { zoom: ZOOM_FIT, x: 0.5, y: 0.5 };

/**
 * How far in the slider may go.
 *
 * Far enough to pass 1:1 by a factor of four, because the point of going past
 * the photograph's own pixels is to judge an edge, and bounded either side so a
 * small photo does not offer sixty-four steps of nothing and a panorama is not
 * cut off before its own pixels are on screen.
 *
 * @param fitScale CSS pixels the picture occupies per output pixel at fit, or
 * null before the first render has measured it.
 */
export function maxZoom(fitScale: number | null): number {
  if (!fitScale || fitScale <= 0) return 8;
  return Math.min(64, Math.max(8, 4 / fitScale));
}

/** The zoom at which one output pixel covers one CSS pixel, or null if fit is already past it. */
export function oneToOneZoom(fitScale: number | null): number | null {
  if (!fitScale || fitScale <= 0) return null;
  const zoom = 1 / fitScale;
  return zoom > 1.001 ? zoom : null;
}

/**
 * Bring a view inside what the window can show.
 *
 * The picture always covers the window: a zoomed view that could be dragged
 * until the frame held a band of nothing would be showing the stage through the
 * photograph, and the frame's own edge is what says where the picture stops.
 */
export function clampView(view: View, limit: number): View {
  const zoom = Math.min(Math.max(view.zoom, ZOOM_FIT), Math.max(limit, ZOOM_FIT));
  const half = 0.5 / zoom;
  return {
    zoom,
    x: Math.min(Math.max(view.x, half), 1 - half),
    y: Math.min(Math.max(view.y, half), 1 - half),
  };
}

/**
 * Zoom while holding one point of the picture still.
 *
 * `px` and `py` are where the pointer is inside the window, as a fraction of it.
 * Keeping what is under the pointer under the pointer is what makes a wheel feel
 * like it is moving the picture rather than resetting the view each notch; the
 * clamp afterwards is what stops the edge of the photograph from being dragged
 * into the middle of the frame by a zoom near a corner.
 */
export function zoomAbout(view: View, factor: number, px: number, py: number, limit: number): View {
  const next = clampView({ ...view, zoom: view.zoom * factor }, limit);
  // The picture coordinate under the pointer, read before the zoom and put back
  // after it. Both readings use the window fraction, so the arithmetic is the
  // same on either side and only the scale between them differs.
  const u = view.x + (px - 0.5) / view.zoom;
  const v = view.y + (py - 0.5) / view.zoom;
  return clampView(
    { zoom: next.zoom, x: u - (px - 0.5) / next.zoom, y: v - (py - 0.5) / next.zoom },
    limit,
  );
}

/**
 * Move the picture under a drag.
 *
 * The deltas are in fractions of the window, and dividing by the zoom is what
 * makes a hand drag move the photograph exactly as far as the pointer went at
 * every magnification.
 */
export function panBy(view: View, dx: number, dy: number, limit: number): View {
  return clampView(
    { zoom: view.zoom, x: view.x - dx / view.zoom, y: view.y - dy / view.zoom },
    limit,
  );
}

/**
 * The transform that puts the view on screen.
 *
 * The plate is laid out at the fit size and scaled from its own top left, so the
 * translation is in per cent of that size and the whole thing is one string the
 * browser composites. Overlays inside the plate are positioned in per cent of
 * it, so they are carried along without knowing the view exists — which is what
 * keeps the overlay the only place the two coordinate systems meet.
 */
export function viewTransform(view: View): string {
  if (view.zoom <= ZOOM_FIT + 1e-6) return 'none';
  const tx = (0.5 - view.x * view.zoom) * 100;
  const ty = (0.5 - view.y * view.zoom) * 100;
  return `translate(${tx.toFixed(4)}%, ${ty.toFixed(4)}%) scale(${view.zoom.toFixed(6)})`;
}
