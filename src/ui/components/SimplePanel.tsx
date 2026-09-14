/**
 * Simple mode.
 *
 * Not the detail panel with sliders removed. The constraint that makes it a
 * different thing is that it shows no numbers at all — once numbers are off the
 * table, the only way left to offer a choice is to show the result, which is why
 * a finish is picked from thumbnails of the user's own photo.
 */

import { useEffect, useRef } from 'react';
import { LOOKS } from '../../core/recipe/presets';
import type { MetadataParams } from '../../core/recipe/schema';
import type { MessageKey } from '../../i18n';
import { useI18n } from '../../i18n';
import { BigSlider } from './controls';
import { MetadataRow } from './MetadataRow';

function LookThumb({ image }: { image: ImageData | null }) {
  const ref = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas || !image) return;
    canvas.width = image.width;
    canvas.height = image.height;
    const ctx = canvas.getContext('2d', { colorSpace: image.colorSpace });
    ctx?.putImageData(image, 0, 0);
  }, [image]);

  return (
    <div className="thumb">
      <canvas ref={ref} />
    </div>
  );
}

interface SimplePanelProps {
  thumbnails: ReadonlyMap<string, ImageData>;
  look: string;
  strength: number;
  metadataMode: MetadataParams['mode'];
  hasImage: boolean;
  onLook: (key: string) => void;
  onStrength: (value: number) => void;
  onAuto: () => void;
  onMetadataMode: (mode: MetadataParams['mode']) => void;
  onDetail: () => void;
}

export function SimplePanel({
  thumbnails,
  look,
  strength,
  metadataMode,
  hasImage,
  onLook,
  onStrength,
  onAuto,
  onMetadataMode,
  onDetail,
}: SimplePanelProps) {
  const { t } = useI18n();
  return (
    <div className="pane">
      <div className="pane-scroll">
        <div className="simple-body">
          <button type="button" className="auto" onClick={onAuto} disabled={!hasImage}>
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M12 3l1.9 5.4L19 10l-5.1 1.6L12 17l-1.9-5.4L5 10l5.1-1.6z" />
              <path d="M18 15l.9 2.4L21 18l-2.1.6L18 21l-.9-2.4L15 18l2.1-.6z" />
            </svg>
            {t('simple.auto')}
          </button>

          <div className="seclabel">{t('simple.looks')}</div>
          <div className="looks">
            {LOOKS.map((entry) => (
              <button
                key={entry.key}
                type="button"
                className="look"
                aria-pressed={entry.key === look}
                onClick={() => onLook(entry.key)}
                disabled={!hasImage}
              >
                <LookThumb image={thumbnails.get(entry.key) ?? null} />
                <span className="ln">{t(`looks.${entry.key}` as MessageKey)}</span>
              </button>
            ))}
          </div>

          <BigSlider
            label={t('simple.strength')}
            low={t('simple.strengthLow')}
            high={t('simple.strengthHigh')}
            value={strength}
            onChange={onStrength}
          />

          <MetadataRow mode={metadataMode} onMode={onMetadataMode} />

          <button type="button" className="tomore" onClick={onDetail}>
            {t('simple.toDetail')}
          </button>
        </div>
      </div>
    </div>
  );
}
