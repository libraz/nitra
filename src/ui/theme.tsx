/**
 * Light and dark appearance.
 *
 * The choice is stored, but "match system" is a real third option rather than a
 * default that gets overwritten on the first click: a photo editor gets opened
 * in daylight and again at night, and a preference recorded once in the morning
 * is wrong by the evening.
 *
 * What does not change between the two is the surround immediately around the
 * photo. Colour is judged against what is next to it, so that area stays a
 * neutral mid grey in both appearances; the chrome further out is what lightens.
 */

import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';

export type ThemeChoice = 'system' | 'light' | 'dark';
export type Appearance = 'light' | 'dark';

export const THEME_CHOICES: readonly ThemeChoice[] = ['system', 'light', 'dark'];

const STORAGE_KEY = 'nitra.theme';
const DARK_QUERY = '(prefers-color-scheme: dark)';

interface ThemeValue {
  choice: ThemeChoice;
  appearance: Appearance;
  setChoice: (choice: ThemeChoice) => void;
}

const ThemeContext = createContext<ThemeValue | null>(null);

function storedChoice(): ThemeChoice {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === 'light' || saved === 'dark' || saved === 'system') return saved;
  } catch {
    // Private browsing can refuse storage; the system preference still works.
  }
  return 'system';
}

function systemAppearance(): Appearance {
  return globalThis.matchMedia?.(DARK_QUERY).matches ? 'dark' : 'light';
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [choice, setChoiceState] = useState<ThemeChoice>(storedChoice);
  const [system, setSystem] = useState<Appearance>(systemAppearance);

  useEffect(() => {
    const media = globalThis.matchMedia?.(DARK_QUERY);
    if (!media) return;
    const update = () => setSystem(media.matches ? 'dark' : 'light');
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);

  const appearance: Appearance = choice === 'system' ? system : choice;

  useEffect(() => {
    document.documentElement.dataset.theme = appearance;
  }, [appearance]);

  const setChoice = useCallback((next: ThemeChoice) => {
    setChoiceState(next);
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // Not being able to remember the choice is not a reason to ignore it.
    }
  }, []);

  const value = useMemo(() => ({ choice, appearance, setChoice }), [choice, appearance, setChoice]);
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeValue {
  const value = useContext(ThemeContext);
  if (!value) throw new Error('useTheme used outside ThemeProvider');
  return value;
}
