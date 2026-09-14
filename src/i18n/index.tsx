/**
 * Localisation.
 *
 * Adding a language is adding one file under `locales/` and one entry in
 * {@link LOCALES}. The catalogue is typed against the English one, so a locale
 * that is missing a message does not compile — which is the only way a blank
 * label reliably gets caught before it ships.
 *
 * There is no translation library here on purpose. The app is served as static
 * files with no backend, so its first load is its entire startup cost, and a
 * runtime for eighty strings is weight the user pays for on every visit.
 */

import { createContext, type ReactNode, useCallback, useContext, useMemo, useState } from 'react';
import { en, type MessageKey, type Messages } from './locales/en';
import { ja } from './locales/ja';

export const LOCALES = {
  en,
  ja,
} satisfies Record<string, Messages>;

export type Locale = keyof typeof LOCALES;

export const LOCALE_ORDER = Object.keys(LOCALES) as Locale[];

/** Fallback when the browser asks for a language that is not translated yet. */
export const DEFAULT_LOCALE: Locale = 'en';

const STORAGE_KEY = 'nitra.locale';

export type Translate = (key: MessageKey, params?: Record<string, string | number>) => string;

interface I18nValue {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  t: Translate;
}

const I18nContext = createContext<I18nValue | null>(null);

function isLocale(value: string): value is Locale {
  return value in LOCALES;
}

/**
 * Pick a locale from a stored preference, then the browser's languages.
 *
 * Region subtags are matched by their base language, so `ja-JP` finds `ja`.
 */
export function detectLocale(stored: string | null, preferred: readonly string[] = []): Locale {
  if (stored && isLocale(stored)) return stored;
  for (const tag of preferred) {
    const base = tag.toLowerCase().split('-')[0];
    if (base && isLocale(base)) return base;
  }
  return DEFAULT_LOCALE;
}

/** Substitute `{name}` placeholders. */
export function interpolate(template: string, params?: Record<string, string | number>): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    name in params ? String(params[name]) : match,
  );
}

function readStored(): string | null {
  try {
    return globalThis.localStorage?.getItem(STORAGE_KEY) ?? null;
  } catch {
    return null;
  }
}

function writeStored(locale: Locale): void {
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, locale);
  } catch {
    // A browser with storage disabled still gets a working editor; the language
    // choice simply does not survive a reload.
  }
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(() =>
    detectLocale(readStored(), globalThis.navigator?.languages ?? []),
  );

  const setLocale = useCallback((next: Locale) => {
    setLocaleState(next);
    writeStored(next);
    if (typeof document !== 'undefined') document.documentElement.lang = next;
  }, []);

  const value = useMemo<I18nValue>(() => {
    const table = LOCALES[locale];
    return {
      locale,
      setLocale,
      t: (key, params) => interpolate(table[key] ?? en[key], params),
    };
  }, [locale, setLocale]);

  if (typeof document !== 'undefined' && document.documentElement.lang !== locale) {
    document.documentElement.lang = locale;
  }

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nValue {
  const value = useContext(I18nContext);
  if (!value) throw new Error('useI18n used outside I18nProvider');
  return value;
}

export type { MessageKey } from './locales/en';
