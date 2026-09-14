// @vitest-environment happy-dom
//
// The slicing test builds a real ImageData, which the default node environment
// does not provide. Everything else here is pure arithmetic and would run either
// way.

import { describe, expect, it } from 'vitest';
import {
  cropRatioForTiles,
  planExport,
  TILE_SHAPES,
  type TileRect,
  tileFileName,
  tileRects,
} from '../src/core/geometry/tiles';
import { fitCropToAspect } from '../src/core/geometry/transform';
import { sliceImageData } from '../src/core/io/export';
import { neutralRecipe, type Recipe } from '../src/core/recipe/schema';

function recipe(patch: {
  cols?: number;
  rows?: number;
  gap?: number;
  longEdge?: number;
  crop?: { x: number; y: number; w: number; h: number };
}): Recipe {
  const base = neutralRecipe();
  return {
    ...base,
    geometry: { ...base.geometry, crop: patch.crop ?? base.geometry.crop },
    tiles: {
      cols: patch.cols ?? 1,
      rows: patch.rows ?? 1,
      gap: patch.gap ?? 0,
    },
    output: { ...base.output, longEdge: patch.longEdge ?? 0 },
  };
}

describe('cutting a picture into tiles', () => {
  it('uses every pixel when there is no gutter', () => {
    const tiles = tileRects(1200, 900, { cols: 3, rows: 3, gap: 0 });
    expect(tiles).toHaveLength(9);
    for (let row = 0; row < 3; row++) {
      const inRow = tiles.filter((tile) => tile.row === row);
      const covered = inRow.reduce((sum, tile) => sum + tile.width, 0);
      expect(covered).toBe(1200);
      // Each tile starts exactly where the last one ended: a rounding error here
      // is a seam running down the assembled grid.
      for (let col = 1; col < 3; col++) {
        const left = inRow[col - 1];
        const right = inRow[col];
        expect(right?.x).toBe((left?.x ?? 0) + (left?.width ?? 0));
      }
    }
    const column = tiles.filter((tile) => tile.col === 0);
    expect(column.reduce((sum, tile) => sum + tile.height, 0)).toBe(900);
  });

  it('takes the gutter out of the picture rather than adding it around', () => {
    const tiles = tileRects(1000, 1000, { cols: 2, rows: 1, gap: 0.05 });
    const [left, right] = tiles;
    expect(left?.width).toBe(475);
    expect(right?.x).toBe(525);
    expect((right?.x ?? 0) + (right?.width ?? 0)).toBe(1000);
  });

  it('numbers the tiles in the order they have to be uploaded', () => {
    // A profile grid fills newest first, so the tile that belongs at the top
    // left is the last one posted and the bottom right one is posted first.
    const tiles = tileRects(900, 900, { cols: 3, rows: 3, gap: 0 });
    const topLeft = tiles.find((tile) => tile.row === 0 && tile.col === 0);
    const bottomRight = tiles.find((tile) => tile.row === 2 && tile.col === 2);
    expect(topLeft?.post).toBe(9);
    expect(bottomRight?.post).toBe(1);

    const posts = tiles.map((tile) => tile.post).sort((a, b) => a - b);
    expect(posts).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it('numbers a wide grid along its rows, not its columns', () => {
    const tiles = tileRects(900, 600, { cols: 3, rows: 2, gap: 0 });
    const second = tiles.find((tile) => tile.row === 0 && tile.col === 1);
    expect(second?.post).toBe(5);
  });
});

describe('planning an export', () => {
  it('exports the whole photo when nothing was asked of it', () => {
    const plan = planExport(4000, 3000, recipe({}));
    expect(plan.width).toBe(4000);
    expect(plan.height).toBe(3000);
    expect(plan.tiles).toHaveLength(1);
  });

  it('measures the crop, not the photo', () => {
    const plan = planExport(4000, 3000, recipe({ crop: { x: 0, y: 0, w: 0.5, h: 0.5 } }));
    expect(plan.width).toBe(2000);
    expect(plan.height).toBe(1500);
  });

  it('applies the size ceiling to each file, not to the picture', () => {
    // Nine tiles capped at 1080 means nine files of 1080, not a 1080-pixel
    // picture cut into nine thumbnails.
    const plan = planExport(9000, 9000, recipe({ cols: 3, rows: 3, longEdge: 1080 }));
    expect(plan.width).toBe(3240);
    expect(plan.tiles[0]?.width).toBe(1080);
    expect(plan.tiles[0]?.height).toBe(1080);
  });

  it('never enlarges to reach the ceiling', () => {
    const plan = planExport(800, 600, recipe({ longEdge: 4096 }));
    expect(plan.width).toBe(800);
    expect(plan.height).toBe(600);
  });

  it('keeps the shape while shrinking to the ceiling', () => {
    const plan = planExport(4000, 2000, recipe({ longEdge: 1600 }));
    expect(plan.width).toBe(1600);
    expect(plan.height).toBe(800);
  });
});

describe('naming an exported tile', () => {
  it('leads with the upload order and pads it to a common width', () => {
    const tiles = tileRects(900, 900, { cols: 3, rows: 3, gap: 0 });
    const topLeft = tiles.find((tile) => tile.row === 0 && tile.col === 0);
    const bottomRight = tiles.find((tile) => tile.row === 2 && tile.col === 2);
    expect(tileFileName('holiday-nitra', 'jpg', topLeft as never, 9)).toBe(
      'holiday-nitra-9-r1c1.jpg',
    );
    expect(tileFileName('holiday-nitra', 'jpg', bottomRight as never, 9)).toBe(
      'holiday-nitra-1-r3c3.jpg',
    );
  });

  it('pads wide enough that the files sort into upload order', () => {
    const tiles = tileRects(1200, 1200, { cols: 4, rows: 3, gap: 0 });
    const names = tiles
      .map((tile) => tileFileName('x', 'jpg', tile, tiles.length))
      .sort((a, b) => a.localeCompare(b));
    expect(names[0]).toBe('x-01-r3c4.jpg');
    expect(names.at(-1)).toBe('x-12-r1c1.jpg');
  });
});

describe('cutting a tile out of a rendered picture', () => {
  it('takes the pixels the rectangle names, unchanged', () => {
    // Every pixel is its own row/column pair, so a slice that is off by one row
    // or reads the wrong stride shows up as the wrong coordinates rather than as
    // a subtly shifted image nobody notices.
    const width = 6;
    const height = 4;
    const data = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = (y * width + x) * 4;
        data[i] = x * 10;
        data[i + 1] = y * 10;
        data[i + 2] = 0;
        data[i + 3] = 255;
      }
    }
    const source = new ImageData(data, width, height);
    const tile = sliceImageData(source, {
      row: 1,
      col: 1,
      post: 1,
      x: 3,
      y: 2,
      width: 3,
      height: 2,
    });

    expect(tile.width).toBe(3);
    expect(tile.height).toBe(2);
    for (let y = 0; y < 2; y++) {
      for (let x = 0; x < 3; x++) {
        const i = (y * 3 + x) * 4;
        expect(tile.data[i], `x ${x},${y}`).toBe((x + 3) * 10);
        expect(tile.data[i + 1], `y ${x},${y}`).toBe((y + 2) * 10);
      }
    }
  });
});

describe('shaping a crop for a grid', () => {
  it('works out the whole shape from the shape of one tile', () => {
    expect(cropRatioForTiles(1, 3, 3)).toBeCloseTo(1, 5);
    expect(cropRatioForTiles(3 / 4, 3, 3)).toBeCloseTo(0.75, 5);
    // Three tiles across and one down at 3:4 each is a wide picture.
    expect(cropRatioForTiles(3 / 4, 3, 1)).toBeCloseTo(2.25, 5);
  });

  it('gives every tile the shape that was asked for', () => {
    // Every combination rather than a sample: the shape of a tile falls out of
    // the tile shape, the grid and the shape of the photo together, and it is
    // the interactions that go wrong. A grid cut to the wrong tile shape only
    // shows itself once all of the posts are public.
    for (const shape of TILE_SHAPES) {
      for (const cols of [1, 2, 3, 4]) {
        for (const rows of [1, 2, 3]) {
          for (const [width, height] of [
            [4000, 3000],
            [3000, 4000],
            [2000, 2000],
          ] as const) {
            const base = neutralRecipe();
            const crop = fitCropToAspect(
              base.geometry.crop,
              cropRatioForTiles(shape.ratio, cols, rows),
              width / height,
            );
            const plan = planExport(width, height, {
              ...base,
              geometry: { ...base.geometry, crop },
              tiles: { cols, rows, gap: 0 },
            });
            const tile = plan.tiles[0] as TileRect;
            const where = `${shape.key} ${cols}x${rows} ${width}x${height}`;
            expect(tile.width / tile.height, where).toBeCloseTo(shape.ratio, 1);
          }
        }
      }
    }
  });
});
