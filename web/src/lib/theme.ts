import { useCallback, useEffect, useState } from 'react';

export type ThemeMode = 'dark' | 'light';

const EVENT = 'app-theme-change';

export function getTheme(): ThemeMode {
  const saved = localStorage.getItem('theme');
  if (saved === 'dark' || saved === 'light') return saved;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export function applyTheme(theme: ThemeMode) {
  localStorage.setItem('theme', theme);
  document.documentElement.classList.toggle('dark', theme === 'dark');
  document.documentElement.style.colorScheme = theme;
  window.dispatchEvent(new CustomEvent(EVENT, { detail: theme }));
}

/** Shared theme state, kept in sync across components (sidebar, settings…). */
export function useTheme() {
  const [theme, setThemeState] = useState<ThemeMode>(getTheme);

  useEffect(() => {
    const onChange = (e: Event) => setThemeState((e as CustomEvent<ThemeMode>).detail);
    window.addEventListener(EVENT, onChange);
    return () => window.removeEventListener(EVENT, onChange);
  }, []);

  const setTheme = useCallback((t: ThemeMode) => applyTheme(t), []);
  const toggleTheme = useCallback(() => applyTheme(getTheme() === 'dark' ? 'light' : 'dark'), []);

  return { theme, setTheme, toggleTheme };
}
