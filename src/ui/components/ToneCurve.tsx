/**
 * The tone response of the current grade.
 *
 * The samples are measured, not modelled: a ramp is pushed through the same
 * shader the photo goes through and read back. Drawing an approximation instead
 * would be a second copy of the tone maths, and the copy nobody notices drifting
 * is the one on screen.
 */

import { useI18n } from '../../i18n';

interface ToneCurveProps {
  /** 256 RGBA samples of output level against input level, or null before the
   * first measurement. */
  response: Uint8Array | null;
}

export function ToneCurve({ response }: ToneCurveProps) {
  const { t } = useI18n();
  const path = response ? buildPath(response) : null;
  return (
    <div className="curve">
      <svg
        className="curve-plot"
        viewBox="0 0 100 100"
        preserveAspectRatio="none"
        aria-label={t('curve.title')}
      >
        <title>{t('curve.title')}</title>
        <path
          d="M0 100 L100 0"
          stroke="#333"
          strokeWidth="1"
          fill="none"
          strokeDasharray="3 3"
          vectorEffect="non-scaling-stroke"
        />
        {path && (
          <path
            d={path}
            stroke="#d9a05c"
            strokeWidth="1.4"
            fill="none"
            vectorEffect="non-scaling-stroke"
          />
        )}
      </svg>
    </div>
  );
}

function buildPath(response: Uint8Array): string {
  const points: string[] = [];
  for (let i = 0; i < 256; i += 4) {
    const out = (response[i * 4 + 1] ?? 0) / 255;
    points.push(`${((i / 255) * 100).toFixed(2)} ${((1 - out) * 100).toFixed(2)}`);
  }
  const last = (response[255 * 4 + 1] ?? 0) / 255;
  points.push(`100 ${((1 - last) * 100).toFixed(2)}`);
  return `M${points.join(' L')}`;
}
