/**
 * What is drawn on top of the picture.
 *
 * These are handles, not pixels. Everything the overlays show is already being
 * rendered by the pipeline underneath them — the crop is a rectangle over a
 * frame the renderer is drawing whole, the caption is real type on the canvas,
 * the grid lines sit over the cuts the export will make. Nothing here is a
 * preview standing in for the result.
 *
 * Coordinates are normalised against the picture, so the overlay and the shader
 * are reading the same numbers out of the same recipe.
 */

import { useEffect, useMemo, useRef } from 'react';
import { type Mat3, mat3Apply, mat3Inverse } from '../../core/color/matrix';
import type { TileRect } from '../../core/geometry/tiles';
import type { CropHandle } from '../../core/geometry/transform';
import { resizeCrop } from '../../core/geometry/transform';
import type { GeometryParams, Recipe, TextLayer } from '../../core/recipe/schema';
import { PAN_THRESHOLD } from '../gestures';

type CropRect = GeometryParams['crop'];

const HANDLES: readonly CropHandle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];

interface CropOverlayProps {
  crop: CropRect;
  /** Locked shape in the crop's own normalised space, or null when free. */
  ratio: number | null;
  onChange: (crop: CropRect) => void;
}

/**
 * The crop rectangle.
 *
 * Pointer handling is delegated from the container rather than bound per
 * handle: a drag that starts on a corner has to keep receiving moves after the
 * pointer has left that corner, which is what pointer capture on one element
 * gives and eight separately bound elements do not.
 */
export function CropOverlay({ crop, ratio, onChange }: CropOverlayProps) {
  const host = useRef<HTMLDivElement | null>(null);
  const state = useRef<{
    mode: 'move' | CropHandle;
    start: CropRect;
    dx: number;
    dy: number;
  } | null>(null);
  // Read through a ref so the listeners can stay bound across a drag instead of
  // being torn down and rebound on every frame of it.
  const latest = useRef({ crop, ratio, onChange });
  latest.current = { crop, ratio, onChange };

  useEffect(() => {
    const node = host.current;
    if (!node) return;

    const normalise = (event: PointerEvent): [number, number] => {
      const box = node.getBoundingClientRect();
      if (box.width < 1 || box.height < 1) return [0, 0];
      return [(event.clientX - box.left) / box.width, (event.clientY - box.top) / box.height];
    };

    const down = (event: PointerEvent) => {
      const target = event.target as HTMLElement | null;
      const handle = target?.dataset.handle;
      if (!handle) return;
      const [px, py] = normalise(event);
      const start = latest.current.crop;
      state.current = {
        mode: handle === 'move' ? 'move' : (handle as CropHandle),
        start,
        dx: px - start.x,
        dy: py - start.y,
      };
      node.setPointerCapture(event.pointerId);
      event.preventDefault();
    };

    const move = (event: PointerEvent) => {
      const drag = state.current;
      if (!drag) return;
      const [px, py] = normalise(event);
      const { start } = drag;
      if (drag.mode === 'move') {
        latest.current.onChange({
          ...start,
          x: Math.min(Math.max(px - drag.dx, 0), 1 - start.w),
          y: Math.min(Math.max(py - drag.dy, 0), 1 - start.h),
        });
      } else {
        latest.current.onChange(resizeCrop(start, drag.mode, px, py, latest.current.ratio));
      }
    };

    const up = (event: PointerEvent) => {
      if (!state.current) return;
      state.current = null;
      if (node.hasPointerCapture(event.pointerId)) node.releasePointerCapture(event.pointerId);
    };

    node.addEventListener('pointerdown', down);
    node.addEventListener('pointermove', move);
    node.addEventListener('pointerup', up);
    node.addEventListener('pointercancel', up);
    return () => {
      node.removeEventListener('pointerdown', down);
      node.removeEventListener('pointermove', move);
      node.removeEventListener('pointerup', up);
      node.removeEventListener('pointercancel', up);
    };
  }, []);

  // No label and no role: this is a pointer affordance, not a control. Framing
  // without a pointer goes through the shape presets in the panel, which are
  // real buttons and set the same rectangle.
  return (
    <div className="cropov" ref={host}>
      <div
        className="cropov-rect"
        data-handle="move"
        style={{
          left: `${crop.x * 100}%`,
          top: `${crop.y * 100}%`,
          width: `${crop.w * 100}%`,
          height: `${crop.h * 100}%`,
        }}
      >
        <div className="cropov-thirds" />
        {HANDLES.map((handle) => (
          <i key={handle} className={`cropov-h h-${handle}`} data-handle={handle} />
        ))}
      </div>
    </div>
  );
}

interface SpotOverlayProps {
  /** Which circles these are. The ring means a different thing in each. */
  variant: 'heal' | 'conceal';
  spots: Recipe['heal'] | Recipe['conceal']['spots'];
  /** Radius the next spot gets, as a fraction of the image width. */
  radius: number;
  /** Output coordinate back to source coordinate, both normalised. */
  toSource: Mat3;
  /** Source height over width, which makes a radius in widths isotropic. */
  aspect: number;
  onPlace: (x: number, y: number) => void;
  onRemove: (index: number) => void;
}

/**
 * The circles placed on the photograph, and where the next one goes.
 *
 * The overlay is the one place the two coordinate systems meet. A spot is in the
 * photograph's own frame, because a mark is on the photograph and a crop must not
 * move it; the overlay is stretched over the cropped picture on screen. So a
 * click is mapped one way and every existing spot the other, both through the
 * renderer's own framing matrix rather than through a second copy of it.
 *
 * A placed circle stays visible as a ring, and clicking the ring takes it back.
 * Nothing else in the app has to be undone to be judged — a slider goes back by
 * moving it — so these are the one edit that needs somewhere to be seen.
 *
 * Both stages place circles on the photograph the same way, so they are one
 * component. What the ring says differs, and only the stylesheet knows it: on a
 * fill it marks where skin was copied in, and on a conceal it marks the range
 * being guaranteed.
 */
export function SpotOverlay({
  variant,
  spots,
  radius,
  toSource,
  aspect,
  onPlace,
  onRemove,
}: SpotOverlayProps) {
  const host = useRef<HTMLDivElement | null>(null);
  const brush = useRef<HTMLDivElement | null>(null);
  const fromSource = useMemo(() => mat3Inverse(toSource), [toSource]);
  const style = variant === 'heal' ? 'healov' : 'concealov';
  /**
   * A press that has landed but not yet said what it is.
   *
   * A press on the picture is a circle being placed, or it is the start of a
   * pinch or of dragging a magnified photograph around — and which one it is
   * only becomes known once it has stayed still or travelled. So the circle goes
   * down when the press lifts, and a press that moved is not a placement at all.
   *
   * It is the same discrimination the stage makes, applied here because this is
   * where the consequence lands: a fill placed by a gesture that was on its way
   * somewhere else is an edit to the photograph nobody asked for. Mouse and
   * finger take the same path, because they are the same ambiguity.
   */
  const pending = useRef<{ id: number; x: number; y: number; ox: number; oy: number } | null>(null);
  /** The same, for a ring that has been pressed but not yet taken back. */
  const removing = useRef<{ id: number; index: number; ox: number; oy: number } | null>(null);

  // How much of the photograph one step across the picture covers, in image
  // widths. It comes out of the matrix rather than out of the crop rectangle
  // because a turned or straightened frame does not run along the source's axes.
  const reach = Math.max(Math.hypot(toSource[0], (toSource[3] as number) * aspect), 1e-6);
  // The true width of the fill, with no minimum: a ring wider than what it
  // marks is a ring that says the wrong thing about the photograph. Being seen
  // and being grabbable are handled in the stylesheet, where a floor belongs —
  // both are properties of the screen rather than of the picture.
  const across = (r: number) => (2 * r) / reach;

  return (
    // No label and no role: this is a pointer affordance. What it does is also
    // said in the panel, which counts the spots and can take them all back.
    <div
      className={style}
      ref={host}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        const box = host.current?.getBoundingClientRect();
        if (!box || box.width < 1 || box.height < 1) return;
        const [x, y] = mat3Apply(toSource, [
          (event.clientX - box.left) / box.width,
          (event.clientY - box.top) / box.height,
          1,
        ]);
        // A straightened frame maps its corners outside the photograph, and
        // there is nothing there to fill.
        if (x < 0 || x > 1 || y < 0 || y > 1) return;
        pending.current = { id: event.pointerId, x, y, ox: event.clientX, oy: event.clientY };
      }}
      onPointerUp={(event) => {
        const press = pending.current;
        pending.current = null;
        if (!press || press.id !== event.pointerId) return;
        // The stage's own threshold rather than one of this overlay's: a press
        // either places a circle or moves the picture, and two numbers would
        // leave a band of travel where it did both, or neither.
        if (Math.hypot(event.clientX - press.ox, event.clientY - press.oy) >= PAN_THRESHOLD) {
          return;
        }
        onPlace(press.x, press.y);
      }}
      onPointerCancel={() => {
        pending.current = null;
        removing.current = null;
      }}
      // The brush ring is moved by writing to the element rather than through
      // state: a pointer move is a stream of events, and re-rendering the
      // overlay on each one would rebuild every spot to move one ring.
      onPointerMove={(event) => {
        const box = host.current?.getBoundingClientRect();
        const node = brush.current;
        if (!box || !node || box.width < 1 || box.height < 1) return;
        node.style.left = `${((event.clientX - box.left) / box.width) * 100}%`;
        node.style.top = `${((event.clientY - box.top) / box.height) * 100}%`;
        node.style.opacity = '1';
      }}
      onPointerLeave={() => {
        if (brush.current) brush.current.style.opacity = '0';
      }}
    >
      <div className={`${style}-brush`} ref={brush} style={{ width: `${across(radius) * 100}%` }} />
      {spots.map((spot, index) => {
        const [u, v] = mat3Apply(fromSource, [spot.x, spot.y, 1]);
        // Drawn whenever the circle reaches the crop, not only when its centre
        // is inside it. A circle wide enough to cover most of the picture has
        // its centre outside the crop easily, and one that is not drawn is one
        // that cannot be clicked to take back. The half-extent is the circle's
        // own, in the same units as the coordinates being tested.
        const half = across(spot.r) / 2;
        if (u < -half || u > 1 + half || v < -half || v > 1 + half) return null;
        return (
          <button
            // A spot carries no id of its own: the order is what makes two
            // overlapping fills compose, and the same point can legitimately be
            // filled twice, so the coordinates alone would collide. Nothing
            // here holds state across a re-render, so a reused ring is a ring
            // drawn somewhere else and nothing more.
            // biome-ignore lint/suspicious/noArrayIndexKey: the position in the list is the identity
            key={`${spot.x}-${spot.y}-${index}`}
            type="button"
            className={`${style}-spot`}
            style={{
              left: `${u * 100}%`,
              top: `${v * 100}%`,
              width: `${across(spot.r) * 100}%`,
            }}
            // Taken back on release and only if the press stayed still, for the
            // same reason a circle is placed that way: a ring is a small target
            // sitting on a photograph that can be dragged around, so a press
            // that landed on one is as likely to be the start of a hand.
            onPointerDown={(event) => {
              event.stopPropagation();
              pending.current = null;
              removing.current = {
                id: event.pointerId,
                index,
                ox: event.clientX,
                oy: event.clientY,
              };
            }}
            onPointerUp={(event) => {
              const press = removing.current;
              removing.current = null;
              if (!press || press.id !== event.pointerId) return;
              if (Math.hypot(event.clientX - press.ox, event.clientY - press.oy) >= PAN_THRESHOLD) {
                return;
              }
              onRemove(press.index);
            }}
          />
        );
      })}
    </div>
  );
}

/**
 * Roughly how wide a line of text is, in multiples of its size.
 *
 * An estimate is enough: this only sizes the area that can be grabbed, and the
 * type the user is looking at is the real thing on the canvas underneath. Asking
 * the browser to measure it properly would mean a second rasteriser in the
 * overlay that has to be kept in step with the one in the pipeline.
 */
function estimateWidth(text: string): number {
  let width = 0;
  for (const character of text) {
    width += /[　-鿿가-힯＀-｠]/.test(character) ? 1 : 0.54;
  }
  return width;
}

interface TextOverlayProps {
  layers: readonly TextLayer[];
  selected: string | null;
  onSelect: (id: string) => void;
  onMove: (id: string, x: number, y: number) => void;
}

export function TextOverlay({ layers, selected, onSelect, onMove }: TextOverlayProps) {
  const host = useRef<HTMLDivElement | null>(null);
  const drag = useRef<{ id: string; dx: number; dy: number } | null>(null);

  return (
    <div className="textov" ref={host}>
      {layers.map((layer) => {
        const lines = layer.content.split('\n');
        const widest = Math.max(1, ...lines.map(estimateWidth));
        return (
          <button
            key={layer.id}
            type="button"
            className="textov-handle"
            aria-pressed={layer.id === selected}
            style={{
              left: `${layer.x * 100}%`,
              top: `${layer.y * 100}%`,
              width: `${widest * layer.size * 100}%`,
              height: `${lines.length * layer.lineHeight * layer.size * 100}%`,
              transform: `translate(-50%, -50%) rotate(${layer.rotation}deg)`,
            }}
            onPointerDown={(event) => {
              const box = host.current?.getBoundingClientRect();
              if (!box || box.width < 1) return;
              onSelect(layer.id);
              drag.current = {
                id: layer.id,
                dx: (event.clientX - box.left) / box.width - layer.x,
                dy: (event.clientY - box.top) / box.height - layer.y,
              };
              event.currentTarget.setPointerCapture(event.pointerId);
            }}
            onPointerMove={(event) => {
              const active = drag.current;
              const box = host.current?.getBoundingClientRect();
              if (!active || !box || box.width < 1) return;
              onMove(
                active.id,
                Math.min(Math.max((event.clientX - box.left) / box.width - active.dx, 0), 1),
                Math.min(Math.max((event.clientY - box.top) / box.height - active.dy, 0), 1),
              );
            }}
            onPointerUp={() => {
              drag.current = null;
            }}
          />
        );
      })}
    </div>
  );
}

interface TileOverlayProps {
  tiles: readonly TileRect[];
  width: number;
  height: number;
}

/**
 * Where the picture will be cut, and in what order the pieces go up.
 *
 * The number on each tile is its upload position, not its place in the grid.
 * That is the only number that has to be obeyed, so it is the one shown.
 */
export function TileOverlay({ tiles, width, height }: TileOverlayProps) {
  if (tiles.length <= 1 || width < 1 || height < 1) return null;
  return (
    <div className="tileov">
      {tiles.map((tile) => (
        <div
          key={`${tile.row}-${tile.col}`}
          className="tileov-cell"
          style={{
            left: `${(tile.x / width) * 100}%`,
            top: `${(tile.y / height) * 100}%`,
            width: `${(tile.width / width) * 100}%`,
            height: `${(tile.height / height) * 100}%`,
          }}
        >
          <span className="mono">{tile.post}</span>
        </div>
      ))}
    </div>
  );
}
