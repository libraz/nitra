/**
 * Cutting one picture into the several files a feed will show as a grid.
 *
 * A profile grid is filled newest first, left to right: the post made last sits
 * at the top left. So the tile that belongs at the top left has to be uploaded
 * last, and the bottom right one first. That ordering is the whole trick, and
 * getting it wrong is only discovered after the posts are public — which is why
 * it is computed here and written into the file names rather than left as an
 * instruction to follow by hand.
 */

import type { Recipe, TileParams } from '../recipe/schema';
import { croppedSize } from './transform';

/**
 * The shape one tile is shown at.
 *
 * A grid assembles into the picture that was cut up only if each tile is
 * displayed at the shape it was cut to. A profile grid that previews posts at
 * 3:4 will take a square tile and crop it, so a picture split into squares
 * comes back together with a slice missing from every seam — which is only
 * visible once all of the posts are up.
 */
export interface TileShape {
  /** Message key suffix. */
  key: string;
  /** Width over height of one tile. */
  ratio: number;
}

export const TILE_SHAPES: readonly TileShape[] = [
  { key: 'grid', ratio: 3 / 4 },
  { key: 'square', ratio: 1 },
  { key: 'portrait', ratio: 4 / 5 },
  { key: 'landscape', ratio: 16 / 9 },
];

/**
 * The shape the whole picture has to be for every tile of a grid to come out at
 * `tileRatio`, with the gutter `tileRects` takes out of it.
 *
 * The gutter is a fraction of the short edge, so which edge is short decides
 * the equation; the two solutions meet at a square picture.
 */
export function cropRatioForTiles(tileRatio: number, tiles: TileParams): number {
  const { cols, rows, gap } = tiles;
  // Landscape: the gutter is a fraction of the height.
  const wide = (tileRatio * cols * (1 - gap * (rows - 1))) / rows + gap * (cols - 1);
  if (wide >= 1) return wide;
  // Portrait: the gutter is a fraction of the width.
  return (tileRatio * cols) / (rows * (1 - gap * (cols - 1)) + tileRatio * cols * gap * (rows - 1));
}

export interface TileRect {
  row: number;
  col: number;
  /** Upload order, 1 first. The grid only assembles if this order is kept. */
  post: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ExportPlan {
  /** Size the whole picture is rendered at before it is cut. */
  width: number;
  height: number;
  tiles: TileRect[];
}

function tileCount(tiles: TileParams): number {
  return tiles.cols * tiles.rows;
}

/**
 * Divide a rendered picture into tiles.
 *
 * The gutter is taken out of the picture rather than added around it, so the
 * assembled grid is a continuous photo with the feed's own gaps falling on parts
 * that were never shown.
 */
export function tileRects(width: number, height: number, tiles: TileParams): TileRect[] {
  const gap = Math.round(tiles.gap * Math.min(width, height));
  const cellW = (width - gap * (tiles.cols - 1)) / tiles.cols;
  const cellH = (height - gap * (tiles.rows - 1)) / tiles.rows;
  const total = tileCount(tiles);
  const rects: TileRect[] = [];

  for (let row = 0; row < tiles.rows; row++) {
    for (let col = 0; col < tiles.cols; col++) {
      const x = Math.round(col * (cellW + gap));
      const y = Math.round(row * (cellH + gap));
      rects.push({
        row,
        col,
        post: total - (row * tiles.cols + col),
        x,
        y,
        width: Math.max(1, Math.round(x + cellW) - x),
        height: Math.max(1, Math.round(y + cellH) - y),
      });
    }
  }
  return rects;
}

/**
 * Work out what the export will actually produce.
 *
 * The size ceiling applies to each file, not to the assembled picture: a feed
 * that wants 1080 pixels wants it per post, and a nine-tile grid capped at 1080
 * overall would arrive at a third of the resolution the photo could have given.
 */
export function planExport(sourceWidth: number, sourceHeight: number, recipe: Recipe): ExportPlan {
  const [cropW, cropH] = croppedSize(sourceWidth, sourceHeight, recipe.geometry);
  const tiles = recipe.tiles;
  const limit = recipe.output.longEdge;

  const width = Math.max(tiles.cols, Math.round(cropW));
  const height = Math.max(tiles.rows, Math.round(cropH));
  if (limit > 0) {
    const gap = tiles.gap * Math.min(cropW, cropH);
    const cellW = (cropW - gap * (tiles.cols - 1)) / tiles.cols;
    const cellH = (cropH - gap * (tiles.rows - 1)) / tiles.rows;
    // Never enlarged: a photo that cannot reach the ceiling is exported at the
    // size it has, and the panel reports that size rather than the one asked for.
    if (Math.max(cellW, cellH) > limit) {
      const shrunk = sizeForCell(cellW, cellH, limit, tiles);
      if (shrunk[0] <= width && shrunk[1] <= height) {
        return { width: shrunk[0], height: shrunk[1], tiles: tileRects(...shrunk, tiles) };
      }
    }
  }
  return { width, height, tiles: tileRects(width, height, tiles) };
}

/**
 * The whole-picture size at which every tile's long edge is exactly `limit`.
 *
 * Built from the tile outwards rather than by scaling the picture, because
 * rounding the picture and then the gutter can leave a tile a pixel short of
 * the ceiling, which the panel would report as a photo too small to reach it.
 */
function sizeForCell(
  cellW: number,
  cellH: number,
  limit: number,
  tiles: TileParams,
): [number, number] {
  const tileW = cellW >= cellH ? limit : Math.max(1, Math.round((limit * cellW) / cellH));
  const tileH = cellW >= cellH ? Math.max(1, Math.round((limit * cellH) / cellW)) : limit;
  const at = (gap: number): [number, number] => [
    tiles.cols * tileW + (tiles.cols - 1) * gap,
    tiles.rows * tileH + (tiles.rows - 1) * gap,
  ];
  // The gutter is a fraction of the short edge it is part of; it settles in a
  // step or two because it is at most a few tenths of that edge.
  let gap = 0;
  for (let step = 0; step < 8; step++) {
    const next = Math.round(tiles.gap * Math.min(...at(gap)));
    if (next === gap) break;
    gap = next;
  }
  return at(gap);
}

/**
 * Name one exported tile.
 *
 * The upload order leads the suffix because it is the only part that has to be
 * obeyed; the row and column follow so a file can still be placed by eye.
 */
export function tileFileName(
  stem: string,
  extension: string,
  tile: TileRect,
  total: number,
): string {
  const width = String(total).length;
  const order = String(tile.post).padStart(width, '0');
  return `${stem}-${order}-r${tile.row + 1}c${tile.col + 1}.${extension}`;
}
