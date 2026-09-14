/**
 * Splitting one picture across a grid of posts.
 *
 * The upload order is the part that is easy to get wrong and impossible to fix
 * afterwards, so it is stated here, drawn on the photo, and written into every
 * file name. Three places is not redundancy: the panel is read once, the overlay
 * while framing, and the file names at the moment the posts are actually made.
 */

import { useState } from 'react';
import { type ExportPlan, TILE_SHAPES, type TileRect } from '../../core/geometry/tiles';
import type { Recipe } from '../../core/recipe/schema';
import { type MessageKey, useI18n } from '../../i18n';
import { spec } from '../params';
import { Choice, Segmented, Slider, Stepper } from './controls';

const GAP = spec('tiles.gap', 'tiles.gap');

/** The grids a picture actually gets cut into, as one tap each. */
const GRIDS = [
  { key: '3x1', cols: 3, rows: 1 },
  { key: '3x2', cols: 3, rows: 2 },
  { key: '3x3', cols: 3, rows: 3 },
  { key: '2x2', cols: 2, rows: 2 },
] as const;

/** One decimal is enough to tell 3:4 from 4:5 and reads as a shape. */
function ratioLabel(width: number, height: number): string {
  return (width / height).toFixed(2);
}

interface TilesPanelProps {
  tiles: Recipe['tiles'];
  plan: ExportPlan | null;
  hasImage: boolean;
  onTiles: (patch: Partial<Recipe['tiles']>) => void;
  onMatchCrop: (tileRatio: number) => void;
}

/** A miniature of the grid, numbered in upload order. */
function GridPreview({ tiles, plan }: { tiles: Recipe['tiles']; plan: ExportPlan | null }) {
  if (!plan) return null;
  const aspect = plan.width / plan.height;
  return (
    <div
      className="gridprev"
      style={{
        gridTemplateColumns: `repeat(${tiles.cols}, 1fr)`,
        gridTemplateRows: `repeat(${tiles.rows}, 1fr)`,
        aspectRatio: `${aspect}`,
      }}
    >
      {plan.tiles.map((tile: TileRect) => (
        <span key={`${tile.row}-${tile.col}`} className="mono">
          {tile.post}
        </span>
      ))}
    </div>
  );
}

export function TilesPanel({ tiles, plan, hasImage, onTiles, onMatchCrop }: TilesPanelProps) {
  const { t } = useI18n();
  const count = tiles.cols * tiles.rows;
  const first = plan?.tiles[0];

  // The shape is an argument to the action rather than part of the recipe: what
  // gets stored is the crop it produces, and the crop is what the render reads.
  const [shape, setShape] = useState(TILE_SHAPES[0]?.key ?? 'grid');
  const tileRatio = TILE_SHAPES.find((entry) => entry.key === shape)?.ratio ?? 1;

  return (
    <div className="pane">
      <div className="pane-scroll">
        <div className="tool-body">
          <div className="seclabel">{t('tiles.grid')}</div>

          <Segmented
            label={t('tiles.presets')}
            options={GRIDS.map((grid) => ({ key: grid.key, name: `${grid.cols}×${grid.rows}` }))}
            value={`${tiles.cols}x${tiles.rows}`}
            onChange={(key) => {
              const grid = GRIDS.find((entry) => entry.key === key);
              if (grid) onTiles({ cols: grid.cols, rows: grid.rows });
            }}
          />

          <Stepper
            label={t('tiles.cols')}
            value={tiles.cols}
            min={1}
            max={6}
            onChange={(cols) => onTiles({ cols })}
          />
          <Stepper
            label={t('tiles.rows')}
            value={tiles.rows}
            min={1}
            max={6}
            onChange={(rows) => onTiles({ rows })}
          />

          {count > 1 ? (
            <>
              <GridPreview tiles={tiles} plan={plan} />

              <Slider spec={GAP} value={tiles.gap} onChange={(gap) => onTiles({ gap })} />
              <p className="mini">{t('tiles.gapNote')}</p>

              <Choice
                label={t('tiles.shape')}
                value={shape}
                items={TILE_SHAPES.map((entry) => ({
                  key: entry.key,
                  name: t(`tileShape.${entry.key}` as MessageKey),
                }))}
                onChange={setShape}
              />
              <p className="mini">{t('tiles.shapeNote')}</p>

              <button
                type="button"
                className="tomore"
                disabled={!hasImage}
                onClick={() => onMatchCrop(tileRatio)}
              >
                {t('tiles.matchCrop')}
              </button>

              {first && (
                <div className="readout">
                  <span>{t('tiles.count', { count })}</span>
                  <b className="mono">
                    {first.width}×{first.height} · {ratioLabel(first.width, first.height)}
                  </b>
                </div>
              )}

              <div className="note">
                <b>{t('tiles.orderTitle')}</b>
                <span>{t('tiles.orderBody')}</span>
              </div>

              <button
                type="button"
                className="tomore"
                onClick={() => onTiles({ cols: 1, rows: 1, gap: 0 })}
              >
                {t('tiles.reset')}
              </button>
            </>
          ) : (
            <p className="mini">{t('tiles.single')}</p>
          )}
        </div>
      </div>
    </div>
  );
}
