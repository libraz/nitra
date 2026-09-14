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

import { useEffect, useRef } from 'react';
import type { TileRect } from '../../core/geometry/tiles';
import type { CropHandle } from '../../core/geometry/transform';
import { resizeCrop } from '../../core/geometry/transform';
import type { GeometryParams, TextLayer } from '../../core/recipe/schema';

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
