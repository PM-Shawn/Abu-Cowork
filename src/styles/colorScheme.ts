// Keeps the `dark` class on <html> in step with `prefers-color-scheme`. tokens.css keys the dark
// values off that class only.
//
// The color scheme a window reports is the application's, not just the system's: the main
// window's appearance setting is handed to the host (`set_theme` → `nativeTheme.themeSource`),
// which sets it for every window of the app. So the main window uses this while its setting says
// "follow the system", and a window without settings of its own (the pet) uses it always and
// shows what the main window shows in all three settings.
const DARK_SCHEME = '(prefers-color-scheme: dark)';

/** Sets the class now, follows every change, and returns the function that stops following. */
export function followSystemColorScheme(root: HTMLElement = document.documentElement): () => void {
  const scheme = window.matchMedia(DARK_SCHEME);
  const apply = () => { root.classList.toggle('dark', scheme.matches); };
  apply();
  scheme.addEventListener('change', apply);
  return () => scheme.removeEventListener('change', apply);
}
