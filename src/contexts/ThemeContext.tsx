import { createContext, useContext, useState, useEffect, useCallback, ReactNode } from 'react';
import { Religion, ColorMode, RELIGIONS } from '../types';
import { buildCssVarsMap, getThemeColors, ThemeColors } from '../themes';
import { storage } from '../utils/storage';

interface ThemeContextType {
  religion: Religion;
  setReligion: (religion: Religion) => void;
  colorMode: ColorMode;
  setColorMode: (mode: ColorMode) => void;
  toggleColorMode: () => void;
  isDark: boolean;
  /** Legacy compat – returns a JS object with all token values */
  theme: ThemeColors;
  religionInfo: typeof RELIGIONS[number];
}

const ThemeContext = createContext<ThemeContextType | undefined>(undefined);

const DEFAULT_RELIGION: Religion = 'default';
const DEFAULT_COLOR_MODE: ColorMode = 'light';

/** Inject / update CSS custom-properties on <html> */
function applyCssVars(religion: Religion, mode: ColorMode) {
  const varsMap = buildCssVarsMap(religion, mode);
  Object.entries(varsMap).forEach(([name, value]) => {
    document.documentElement.style.setProperty(name, value);
  });
  document.documentElement.style.colorScheme = mode;
  document.documentElement.dataset.theme = mode;
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [religion, setReligionState] = useState<Religion>(DEFAULT_RELIGION);
  const [colorMode, setColorModeState] = useState<ColorMode>(DEFAULT_COLOR_MODE);

  // Apply CSS vars whenever religion or colorMode changes
  useEffect(() => {
    applyCssVars(religion, colorMode);
  }, [religion, colorMode]);

  // Initialise from storage / system pref
  useEffect(() => {
    const savedReligion = storage.getCurrentReligion();
    if (savedReligion) setReligionState(savedReligion);
    else storage.setCurrentReligion(DEFAULT_RELIGION);

    const savedMode = storage.getColorMode();
    if (savedMode) setColorModeState(savedMode);
    else {
      // Default to light mode when no preference is saved
      setColorModeState(DEFAULT_COLOR_MODE);
      storage.setColorMode(DEFAULT_COLOR_MODE);
    }

    // Watch system preference
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = (e: MediaQueryListEvent) => {
      if (!storage.getColorMode()) {
        setColorModeState(e.matches ? 'dark' : 'light');
      }
    };
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  const setReligion = useCallback((r: Religion) => {
    setReligionState(r);
    storage.setCurrentReligion(r);
  }, []);

  const setColorMode = useCallback((m: ColorMode) => {
    setColorModeState(m);
    storage.setColorMode(m);
  }, []);

  const toggleColorMode = useCallback(() => {
    setColorMode(colorMode === 'dark' ? 'light' : 'dark');
  }, [colorMode, setColorMode]);

  const theme = getThemeColors(religion, colorMode);
  const religionInfo = RELIGIONS.find((r) => r.id === religion) || RELIGIONS[0];
  const isDark = colorMode === 'dark';

  return (
    <ThemeContext.Provider value={{
      religion, setReligion,
      colorMode, setColorMode, toggleColorMode,
      isDark, theme, religionInfo,
    }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme must be used within a ThemeProvider');
  return ctx;
}
