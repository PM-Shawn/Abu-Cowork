import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './styles/index.css'
import App from './App.tsx'

// Overlay scrollbar: show only while scrolling, then fade out
;(() => {
  const timers = new WeakMap<HTMLElement, number>();
  document.addEventListener('scroll', (e) => {
    const el = e.target as HTMLElement;
    if (!el?.classList?.contains('overlay-scroll')) return;
    el.classList.add('is-scrolling');
    const prev = timers.get(el);
    if (prev) clearTimeout(prev);
    timers.set(el, window.setTimeout(() => {
      el.classList.remove('is-scrolling');
      timers.delete(el);
    }, 1000));
  }, true);
})();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
