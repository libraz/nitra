/**
 * Where the added light stands.
 *
 * A disc rather than two sliders, because the two numbers behind it are one
 * decision. "Above and to the left, fairly frontal" is a place, and a person
 * finds a place by pointing at it; finding it by moving an angle and then a
 * second number means reading both back and imagining the result, which is the
 * work the control is supposed to do.
 *
 * The disc is the sphere of directions seen from the camera. The middle is the
 * lens itself — light straight down the axis, no shadows, no modelling — and the
 * rim is the picture's own plane, where the light rakes across the face from the
 * side. So the radius is what the recipe calls `frontal`, inverted: the further
 * out, the less of the light comes from the camera's direction.
 *
 * The face on it is not decoration. A direction on a sphere has no up until
 * something in the picture does, and the whole point of the control is which
 * side of *a face* the light falls on.
 */

import { useCallback, useRef } from 'react';
import { useI18n } from '../../i18n';

interface LightPadProps {
  /** Clock angle, degrees, zero at the top and running clockwise. */
  angle: number;
  /** How far round towards the camera, 0 at the rim and 1 in the middle. */
  frontal: number;
  disabled?: boolean;
  onChange: (angle: number, frontal: number) => void;
}

/** Keyboard steps, in degrees around and in fractions towards the lens. */
const STEP_ANGLE = 15;
const STEP_FRONTAL = 0.05;

export function LightPad({ angle, frontal, disabled = false, onChange }: LightPadProps) {
  const { t } = useI18n();
  const pad = useRef<HTMLDivElement | null>(null);

  // Straight up is zero and the clock runs clockwise, which on a screen whose y
  // grows downward means the sine goes to x and the cosine comes back negated.
  const radius = 1 - frontal;
  const radians = (angle * Math.PI) / 180;
  const left = 50 + Math.sin(radians) * radius * 50;
  const top = 50 - Math.cos(radians) * radius * 50;

  const place = useCallback(
    (event: React.PointerEvent) => {
      const box = pad.current?.getBoundingClientRect();
      if (!box) return;
      const x = ((event.clientX - box.left) / box.width) * 2 - 1;
      const y = ((event.clientY - box.top) / box.height) * 2 - 1;
      const reach = Math.min(1, Math.hypot(x, y));
      // Dead centre has no direction to report, so the angle is left where it
      // was rather than snapping to whatever the arctangent of nothing is.
      const next = reach < 1e-3 ? angle : ((Math.atan2(x, -y) * 180) / Math.PI + 360) % 360;
      onChange(next, 1 - reach);
    },
    [angle, onChange],
  );

  return (
    <div className="lightpad" data-off={disabled}>
      <div
        className="lightpad-d"
        ref={pad}
        role="application"
        aria-label={t('light.place')}
        tabIndex={disabled ? -1 : 0}
        onPointerDown={(event) => {
          if (disabled) return;
          event.currentTarget.setPointerCapture(event.pointerId);
          place(event);
        }}
        onPointerMove={(event) => {
          if (disabled || !event.currentTarget.hasPointerCapture(event.pointerId)) return;
          place(event);
        }}
        onKeyDown={(event) => {
          if (disabled) return;
          const moves: Record<string, [number, number]> = {
            ArrowLeft: [-STEP_ANGLE, 0],
            ArrowRight: [STEP_ANGLE, 0],
            ArrowUp: [0, STEP_FRONTAL],
            ArrowDown: [0, -STEP_FRONTAL],
          };
          const move = moves[event.key];
          if (!move) return;
          event.preventDefault();
          onChange((angle + move[0] + 360) % 360, Math.min(1, Math.max(0, frontal + move[1])));
        }}
      >
        <svg viewBox="-50 -50 100 100" aria-hidden="true">
          {/* A face, so the direction has a subject to be relative to. */}
          <ellipse className="lightpad-face" cx="0" cy="2" rx="21" ry="28" />
          <circle className="lightpad-eye" cx="-8" cy="-5" r="2.2" />
          <circle className="lightpad-eye" cx="8" cy="-5" r="2.2" />
          <path className="lightpad-mouth" d="M-7 14 Q0 19 7 14" />
          {/* The rim, where the light is in the plane of the picture. */}
          <circle className="lightpad-rim" cx="0" cy="0" r="48" />
        </svg>
        <i className="lightpad-dot" style={{ left: `${left}%`, top: `${top}%` }} />
      </div>
      <p className="lightpad-n">{t('light.placeNote')}</p>
    </div>
  );
}
