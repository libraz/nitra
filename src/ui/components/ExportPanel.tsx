/**
 * What leaves the browser.
 *
 * The size shown is the size that will be written, measured from the framing and
 * the ceiling together rather than repeated back from the preset that was
 * picked. A photo too small to reach the ceiling is exported at the size it has,
 * and saying so here is the whole reason the number is measured.
 */

import type { ExportPlan } from '../../core/geometry/tiles';
import type { Recipe } from '../../core/recipe/schema';
import { useI18n } from '../../i18n';
import { Choice, Segmented } from './controls';
import { MetadataRow } from './MetadataRow';

const FORMATS = [
  { key: 'jpeg', name: 'JPEG' },
  { key: 'png', name: 'PNG' },
  { key: 'webp', name: 'WebP' },
] as const;

const SPACES = [
  { key: 'display-p3', name: 'Display-P3' },
  { key: 'srgb', name: 'sRGB' },
] as const;

const QUALITIES = [
  { key: '0.75', name: '75' },
  { key: '0.85', name: '85' },
  { key: '0.92', name: '92' },
  { key: '1', name: '100' },
] as const;

/** Sizes worth offering. A service preset may add one of its own to the list. */
const SIZES = [0, 640, 1080, 1350, 1600, 1920, 2048, 2560, 4096];

interface ExportPanelProps {
  output: Recipe['output'];
  plan: ExportPlan | null;
  hasImage: boolean;
  exporting: boolean;
  onOutput: (patch: Partial<Recipe['output']>) => void;
  onExport: () => void;
  onMetadataTool: () => void;
}

export function ExportPanel({
  output,
  plan,
  hasImage,
  exporting,
  onOutput,
  onExport,
  onMetadataTool,
}: ExportPanelProps) {
  const { t } = useI18n();
  const sizes = SIZES.includes(output.longEdge)
    ? SIZES
    : [...SIZES, output.longEdge].sort((a, b) => a - b);
  const tiles = plan?.tiles.length ?? 1;
  const first = plan?.tiles[0];

  return (
    <div className="pane">
      <div className="pane-scroll">
        <div className="tool-body">
          <Segmented
            label={t('output.format')}
            options={FORMATS}
            value={output.format}
            onChange={(format) => onOutput({ format })}
          />

          {output.format !== 'png' && (
            <Segmented
              label={t('output.quality')}
              options={QUALITIES}
              value={String(output.quality)}
              onChange={(quality) => onOutput({ quality: Number(quality) })}
            />
          )}

          <Segmented
            label={t('output.space')}
            options={SPACES}
            value={output.space}
            onChange={(space) => onOutput({ space })}
          />

          <Choice
            label={t('output.longEdge')}
            value={String(output.longEdge)}
            items={sizes.map((size) => ({
              key: String(size),
              name: size === 0 ? t('output.longEdgeFree') : `${size} px`,
            }))}
            onChange={(value) => onOutput({ longEdge: Number(value) })}
          />
          <p className="mini">{t('output.longEdgeNote')}</p>

          {first && (
            <div className="readout">
              <span>{t('output.result')}</span>
              <b className="mono">
                {first.width}×{first.height}
              </b>
            </div>
          )}
          {tiles > 1 && <p className="mini">{t('output.bundle')}</p>}

          <MetadataRow
            detail
            mode={output.metadata.mode}
            onMode={(mode) => onOutput({ metadata: { ...output.metadata, mode } })}
          />
          <button type="button" className="tomore" onClick={onMetadataTool}>
            {t('metadata.toTool')}
          </button>

          <button
            type="button"
            className="auto primary"
            disabled={!hasImage || exporting}
            onClick={onExport}
          >
            {t(exporting ? 'topbar.exporting' : 'topbar.export')}
          </button>
        </div>
      </div>
    </div>
  );
}
