/**
 * Shared controls.
 *
 * The detail slider and the simple-mode slider are deliberately separate
 * components rather than one with a `showValue` flag. Simple mode shows no
 * numbers at all, and keeping that as a property of a shared component is how it
 * ends up switched on "just for this one".
 */

import { useCallback, useState } from 'react';
import { useI18n } from '../../i18n';
import type { ParamSpec } from '../params';
import { Menu } from './menu';

function format(value: number, bipolar: boolean): string {
  return `${bipolar && value > 0 ? '+' : ''}${value.toFixed(2)}`;
}

interface SliderProps {
  spec: ParamSpec;
  value: number;
  onChange: (value: number) => void;
}

/**
 * Detail-mode slider: labelled, numeric, and resettable by double click.
 *
 * The number is an input, not a readout. A slider is for finding a value and
 * typing is for knowing one already — matching a setting across two photos, or
 * entering the figure someone else wrote down, is not something a drag can do at
 * all. While the box has focus its text is left exactly as typed, so a
 * half-entered `-0.` is not rewritten under the cursor.
 */
export function Slider({ spec, value, onChange }: SliderProps) {
  const { t } = useI18n();
  const [active, setActive] = useState(false);
  const [draft, setDraft] = useState<string | null>(null);
  const span = spec.max - spec.min;
  const neutralAt = ((spec.neutral - spec.min) / span) * 100;
  const valueAt = ((value - spec.min) / span) * 100;
  const left = Math.min(neutralAt, valueAt);
  const width = Math.abs(valueAt - neutralAt);
  const touched = Math.abs(value - spec.neutral) > 1e-6;

  const reset = useCallback(() => onChange(spec.neutral), [onChange, spec.neutral]);

  return (
    <div className="sl" data-active={active} data-touched={touched}>
      <div className="sl-h">
        <label htmlFor={`r_${spec.path}`}>{t(spec.labelKey)}</label>
        <input
          className="sl-v mono"
          type="text"
          inputMode="decimal"
          aria-label={`${t(spec.labelKey)} — ${spec.min} … ${spec.max}`}
          value={draft ?? format(value, spec.bipolar)}
          onFocus={(event) => event.currentTarget.select()}
          onBlur={() => setDraft(null)}
          onChange={(event) => {
            const next = event.target.value;
            setDraft(next);
            const parsed = Number.parseFloat(next);
            if (Number.isFinite(parsed)) {
              onChange(Math.min(spec.max, Math.max(spec.min, parsed)));
            }
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') event.currentTarget.blur();
            if (event.key === 'Escape') {
              setDraft(null);
              event.currentTarget.blur();
            }
          }}
        />
      </div>
      <div className="sl-t">
        {spec.bipolar && <div className="sl-tick" style={{ left: `${neutralAt}%` }} />}
        <div
          className="sl-f"
          style={{ left: `${left}%`, width: `${width}%`, opacity: width < 0.3 ? 0 : 1 }}
        />
        <input
          id={`r_${spec.path}`}
          type="range"
          min={spec.min}
          max={spec.max}
          step={0.01}
          value={value}
          onChange={(event) => onChange(Number.parseFloat(event.target.value))}
          onDoubleClick={reset}
          onPointerDown={() => setActive(true)}
          onPointerUp={() => setActive(false)}
          onFocus={() => setActive(true)}
          onBlur={() => setActive(false)}
        />
      </div>
    </div>
  );
}

interface BigSliderProps {
  label: string;
  low: string;
  high: string;
  value: number;
  onChange: (value: number) => void;
}

/** Simple-mode slider: a name, two words at the ends, and no number. */
export function BigSlider({ label, low, high, value, onChange }: BigSliderProps) {
  return (
    <div className="big">
      <b>{label}</b>
      <div className="sl">
        <div className="sl-t">
          <div
            className="sl-f"
            style={{ left: 0, width: `${value * 100}%`, opacity: value < 0.005 ? 0 : 1 }}
          />
          <input
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={value}
            aria-label={label}
            onChange={(event) => onChange(Number.parseFloat(event.target.value))}
          />
        </div>
      </div>
      <div className="ends">
        <span>{low}</span>
        <span>{high}</span>
      </div>
    </div>
  );
}

interface SegmentedProps<T extends string> {
  label: string;
  options: readonly { key: T; name: string }[];
  value: T;
  onChange: (value: T) => void;
}

/** Segmented control. Three or more options are always laid out equal width. */
export function Segmented<T extends string>({
  label,
  options,
  value,
  onChange,
}: SegmentedProps<T>) {
  return (
    <div className="seg-w">
      <span className="seg-l">{label}</span>
      <div className="seg">
        {options.map((option) => (
          <button
            key={option.key}
            type="button"
            aria-pressed={option.key === value}
            onClick={() => onChange(option.key)}
          >
            {option.name}
          </button>
        ))}
      </div>
    </div>
  );
}

export interface ChoiceItem {
  key: string;
  name: string;
  /** The figure that comes with the choice — a pixel size, a ratio. */
  hint?: string;
  /** Heading the item sits under. */
  group?: string;
}

interface ChoiceProps<T extends string> {
  label: string;
  value: T;
  items: readonly ChoiceItem[];
  onChange: (value: T) => void;
  disabled?: boolean;
}

/**
 * A dropdown, for lists that outgrow a row of buttons.
 *
 * The crop shapes are the reason this exists: there are more of them than fit
 * across the panel, and a new one arrives every time a service changes its mind.
 *
 * It is drawn rather than handed to the platform, for the same reason the font
 * picker is: a row here carries the shape's name and the size that comes with
 * it as two different weights, and a native option is one run of text in the
 * system's own styling. Which also means the list looks the same on every
 * platform the app runs on, instead of three different ones.
 */
export function Choice<T extends string>({
  label,
  value,
  items,
  onChange,
  disabled = false,
}: ChoiceProps<T>) {
  const current = items.find((item) => item.key === value);
  return (
    <div className="choice">
      <span className="choice-l">{label}</span>
      <Menu
        className="choice-m"
        align="start"
        stretch
        label={label}
        value={value}
        items={items}
        disabled={disabled}
        onSelect={(key) => onChange(key as T)}
        trigger={
          <>
            <span className="choice-c">{current?.name ?? value}</span>
            {current?.hint && <span className="choice-hint mono">{current.hint}</span>}
            <i className="choice-x" aria-hidden="true" />
          </>
        }
      />
    </div>
  );
}

interface StepperProps {
  label: string;
  value: number;
  min: number;
  max: number;
  onChange: (value: number) => void;
}

/** Whole-number control for counts small enough to reach by tapping. */
export function Stepper({ label, value, min, max, onChange }: StepperProps) {
  return (
    <div className="stepper">
      <span className="stepper-l">{label}</span>
      <div className="stepper-b">
        <button
          type="button"
          aria-label={`${label} −`}
          disabled={value <= min}
          onClick={() => onChange(Math.max(min, value - 1))}
        >
          −
        </button>
        <output className="stepper-v mono">{value}</output>
        <button
          type="button"
          aria-label={`${label} +`}
          disabled={value >= max}
          onClick={() => onChange(Math.min(max, value + 1))}
        >
          +
        </button>
      </div>
    </div>
  );
}

interface ColorFieldProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
}

export function ColorField({ label, value, onChange }: ColorFieldProps) {
  return (
    <label className="colorf">
      <span className="colorf-l">{label}</span>
      <span className="colorf-b" style={{ background: value }}>
        <input type="color" value={value} onChange={(event) => onChange(event.target.value)} />
      </span>
      <span className="colorf-v mono">{value.toUpperCase()}</span>
    </label>
  );
}

interface ToggleProps {
  on: boolean;
  label: string;
  onChange: (on: boolean) => void;
}

export function Toggle({ on, label, onChange }: ToggleProps) {
  return (
    <button
      type="button"
      className="sw"
      aria-pressed={on}
      aria-label={label}
      onClick={() => onChange(!on)}
    />
  );
}

interface TextFieldProps {
  label: string;
  value: string;
  placeholder?: string;
  /** `text` unless the browser has a better editor for it, e.g. `datetime-local`. */
  type?: 'text' | 'datetime-local';
  onChange: (value: string) => void;
}

export function TextField({ label, value, placeholder, type = 'text', onChange }: TextFieldProps) {
  return (
    <label className="tf">
      <span className="tf-l">{label}</span>
      <input
        type={type}
        value={value}
        placeholder={placeholder}
        spellCheck={false}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  );
}

interface NumberFieldProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  /** Shown after the box: `mm`, `ISO`, whatever the number is measured in. */
  unit?: string;
  placeholder?: string;
  onChange: (value: number) => void;
}

/**
 * A typed number.
 *
 * Kept as text while it is being edited so a half-finished `-` or `35.` is not
 * snapped to something else under the cursor; the value is only reported when it
 * parses. Empty reports zero, which every field here reads as "leave this out".
 */
export function NumberField({
  label,
  value,
  min,
  max,
  step,
  unit,
  placeholder,
  onChange,
}: NumberFieldProps) {
  const [draft, setDraft] = useState<string | null>(null);
  const shown = draft ?? (value === 0 ? '' : String(value));

  return (
    <label className="tf nf">
      <span className="tf-l">{label}</span>
      <input
        type="number"
        inputMode="decimal"
        value={shown}
        min={min}
        max={max}
        step={step}
        placeholder={placeholder}
        onChange={(event) => {
          const next = event.target.value;
          setDraft(next);
          if (next.trim() === '') return onChange(0);
          const parsed = Number.parseFloat(next);
          if (Number.isFinite(parsed)) onChange(Math.min(max, Math.max(min, parsed)));
        }}
        onBlur={() => setDraft(null)}
      />
      {unit && <span className="tf-u mono">{unit}</span>}
    </label>
  );
}

interface SwitchRowProps {
  label: string;
  hint?: string;
  on: boolean;
  onChange: (on: boolean) => void;
}

/** A named switch with room for the sentence that says what it does. */
export function SwitchRow({ label, hint, on, onChange }: SwitchRowProps) {
  return (
    <div className="swrow" data-on={on}>
      <span className="swrow-t">
        <b>{label}</b>
        {hint && <span>{hint}</span>}
      </span>
      <Toggle on={on} label={label} onChange={onChange} />
    </div>
  );
}
