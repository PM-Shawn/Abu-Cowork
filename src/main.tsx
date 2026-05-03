import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './styles/index.css'
import App from './App.tsx'

// Diagnostic: surface JS errors visually on the page so Windows users can
// report them without needing DevTools. Removed once root cause is confirmed.
function showError(msg: string): void {
  const div = document.createElement('div');
  div.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;padding:24px;background:#1a1a1a;color:#ff6b6b;font:13px/1.6 monospace;z-index:99999;overflow:auto;white-space:pre-wrap;word-break:break-all;';
  div.textContent = msg;
  document.body.appendChild(div);
}
window.addEventListener('error', (e) => {
  showError(`Error: ${e.message}\n\nFile: ${e.filename}\nLine: ${e.lineno}:${e.colno}\n\nStack:\n${e.error?.stack ?? '(no stack)'}`);
});
window.addEventListener('unhandledrejection', (e) => {
  const reason = e.reason instanceof Error ? `${e.reason.message}\n\nStack:\n${e.reason.stack}` : String(e.reason);
  showError(`Unhandled Promise Rejection:\n\n${reason}`);
});

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

try {
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
} catch (err) {
  const msg = err instanceof Error ? `${err.message}\n\nStack:\n${err.stack}` : String(err);
  showError(`React render failed:\n\n${msg}`);
}
