/**
 * The catalogue is typed, so a missing key cannot compile. What a type cannot
 * catch is a translation that quietly drops a placeholder, which loses the
 * number it was there to show.
 */

import { describe, expect, it } from 'vitest';
import { ASPECT_GROUPS, ASPECTS } from '../src/core/geometry/aspects';
import { TILE_SHAPES } from '../src/core/geometry/tiles';
import { LOOKS } from '../src/core/recipe/presets';
import { detectLocale, interpolate, LOCALE_ORDER, LOCALES } from '../src/i18n';
import { en } from '../src/i18n/locales/en';
import { GUIDE_STEPS } from '../src/ui/components/Guide';
import { PROJECT_LINKS } from '../src/ui/project';

function placeholders(template: string): string[] {
  return [...template.matchAll(/\{(\w+)\}/g)].map((match) => match[1] as string).sort();
}

describe('catalogue', () => {
  it('covers the same keys in every locale', () => {
    const expected = Object.keys(en).sort();
    for (const [code, table] of Object.entries(LOCALES)) {
      expect(Object.keys(table).sort(), code).toEqual(expected);
    }
  });

  it('keeps the same placeholders in every locale', () => {
    for (const [code, table] of Object.entries(LOCALES)) {
      for (const key of Object.keys(en) as (keyof typeof en)[]) {
        expect(placeholders(table[key]), `${code}: ${key}`).toEqual(placeholders(en[key]));
      }
    }
  });

  it('leaves no message empty', () => {
    for (const [code, table] of Object.entries(LOCALES)) {
      for (const [key, value] of Object.entries(table)) {
        expect(value.trim().length, `${code}: ${key}`).toBeGreaterThan(0);
      }
    }
  });

  it('names every finish', () => {
    // The looks are keyed by string, so a preset added without a caption would
    // otherwise reach the panel as a raw key.
    for (const look of LOOKS) {
      expect(Object.keys(en)).toContain(`looks.${look.key}`);
    }
    expect(Object.keys(en)).toContain('looks.custom');
  });

  it('captions every crop shape, destination and tile shape', () => {
    // The picker builds its rows from the catalogue, so a destination added
    // without its caption reaches the panel as `aspect.threads.portrait`.
    for (const group of ASPECT_GROUPS) {
      expect(Object.keys(en)).toContain(`aspectGroup.${group}`);
    }
    for (const preset of ASPECTS) {
      expect(Object.keys(en), preset.key).toContain(`aspect.${preset.key}`);
      if (preset.note) expect(Object.keys(en), preset.key).toContain(preset.note);
    }
    for (const shape of TILE_SHAPES) {
      expect(Object.keys(en), shape.key).toContain(`tileShape.${shape.key}`);
    }
  });

  it('captions every link out of the about sheet', () => {
    // The rows are built from the data, so a link added without its caption
    // reaches the sheet as `about.linkRepo` — on the one screen whose whole job
    // is to say that the claims made here can be checked.
    for (const link of PROJECT_LINKS) {
      expect(Object.keys(en), link.key).toContain(link.label);
      expect(link.href.startsWith('https://github.com/libraz'), link.key).toBe(true);
    }
  });

  it('writes every step of the guide', () => {
    // A step is three messages. Adding one and translating two leaves a raw key
    // on the first screen anybody new to the app ever sees.
    for (const step of GUIDE_STEPS) {
      for (const key of [step.title, step.body, step.note]) {
        expect(Object.keys(en), step.key).toContain(key);
      }
    }
  });
});

describe('locale selection', () => {
  it('prefers a stored choice', () => {
    expect(detectLocale('ja', ['en-US'])).toBe('ja');
  });

  it('matches a browser tag by its base language', () => {
    expect(detectLocale(null, ['ja-JP'])).toBe('ja');
    expect(detectLocale(null, ['en-GB', 'ja'])).toBe('en');
  });

  it('falls back when nothing on offer is translated', () => {
    expect(detectLocale(null, ['fr-FR', 'de'])).toBe('en');
    expect(detectLocale('kb', [])).toBe('en');
    expect(detectLocale(null, [])).toBe('en');
  });

  it('exposes the locales in a stable order for the picker', () => {
    expect(LOCALE_ORDER).toEqual(Object.keys(LOCALES));
  });
});

describe('interpolation', () => {
  it('substitutes by name', () => {
    expect(interpolate('{a} and {b}', { a: 1, b: 'two' })).toBe('1 and two');
  });

  it('leaves an unknown placeholder visible rather than blanking it', () => {
    expect(interpolate('{a} and {b}', { a: 1 })).toBe('1 and {b}');
    expect(interpolate('{a}')).toBe('{a}');
  });
});
