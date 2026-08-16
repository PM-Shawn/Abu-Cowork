import { useEffect, useState } from 'react';

/**
 * Tracks the app's effective (resolved) theme by reading the `.dark` class
 * App.tsx toggles on `<html>` (see `src/App.tsx` `root.classList.toggle('dark', dark)`,
 * which already resolves the 'system' setting into that class). Subscribes via
 * a MutationObserver so callers live-update if the user switches theme.
 */
export function useEffectiveThemeIsDark(): boolean {
  const [isDark, setIsDark] = useState(() => document.documentElement.classList.contains('dark'));

  useEffect(() => {
    const root = document.documentElement;
    const observer = new MutationObserver(() => {
      setIsDark(root.classList.contains('dark'));
    });
    observer.observe(root, { attributes: true, attributeFilter: ['class'] });
    return () => observer.disconnect();
  }, []);

  return isDark;
}
