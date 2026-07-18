import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './styles/index.css'
import App from './App.tsx'

// Dev-only: registers window.__abuLangfuseSpike() for the Phase A transport test.
if (import.meta.env.DEV) void import('./core/observability/langfuse')

// Overlay scrollbar: show the thumb only while an element is actively scrolling,
// then fade out. Applies to EVERY scrollable element (not just those tagged
// .overlay-scroll) so no native scroll surface shows a persistent scrollbar —
// the thumb is transparent by default and revealed via the .is-scrolling class
// (see the ::-webkit-scrollbar rules in styles/index.css).
;(() => {
  const timers = new WeakMap<HTMLElement, number>();
  document.addEventListener('scroll', (e) => {
    const el = e.target as HTMLElement;
    // e.target is `document` for top-level scrolls — skip non-elements.
    if (!(el instanceof HTMLElement)) return;
    el.classList.add('is-scrolling');
    const prev = timers.get(el);
    if (prev) clearTimeout(prev);
    timers.set(el, window.setTimeout(() => {
      el.classList.remove('is-scrolling');
      timers.delete(el);
    }, 1000));
  }, true);
})();

// Signal to window.onerror in index.html that React is now mounted,
// so the fallback error page is no longer needed.
const root = createRoot(document.getElementById('root')!);
root.render(
  <StrictMode>
    <App />
  </StrictMode>,
);
(window as typeof window & { __abuRootMounted: boolean }).__abuRootMounted = true;
