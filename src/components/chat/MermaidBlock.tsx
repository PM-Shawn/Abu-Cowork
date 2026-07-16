import { useI18n } from '@/i18n';
import RenderableCodeBlock, { type CodeBlockRendererConfig } from './RenderableCodeBlock';

// --- Mermaid-specific rendering logic ---

let mermaidInitPromise: Promise<typeof import('mermaid')['default']> | null = null;

/** Cache rendered SVGs for fullscreen view */
const svgCache = new Map<string, string>();
const SVG_CACHE_MAX = 30;

/** Remove temporary DOM elements that mermaid.render() leaves behind */
function cleanupMermaidArtifacts(id: string) {
  for (const sel of [`#${id}`, `#d${id}`, `[data-id="${id}"]`]) {
    try { document.querySelector(sel)?.remove(); } catch { /* skip */ }
  }
  document.querySelectorAll('#d-mermaid, .error-icon, [id^="dmermaid-"]').forEach((el) => {
    if (el.parentElement === document.body) el.remove();
  });
}

function getMermaid() {
  if (!mermaidInitPromise) {
    mermaidInitPromise = import('mermaid').then((mod) => {
      const mermaid = mod.default;
      mermaid.initialize({
        startOnLoad: false,
        theme: 'base',
        themeVariables: {
          primaryColor: '#faf0e6',
          primaryTextColor: '#29261b',
          primaryBorderColor: '#d97757',
          lineColor: '#888579',
          secondaryColor: '#f5f0ea',
          tertiaryColor: '#ebe6df',
          fontFamily: 'system-ui, -apple-system, sans-serif',
        },
        securityLevel: 'strict',
        fontFamily: 'system-ui, -apple-system, sans-serif',
      });
      return mermaid;
    });
  }
  return mermaidInitPromise;
}

async function renderMermaid(code: string, container: HTMLDivElement): Promise<string> {
  const id = `mermaid-${Date.now().toString(36)}${Math.random().toString(36).substring(2, 8)}`;
  try {
    const mermaid = await getMermaid();
    const { svg } = await mermaid.render(id, code);
    cleanupMermaidArtifacts(id);
    container.innerHTML = svg;
    // Cache SVG for fullscreen view
    if (svgCache.size >= SVG_CACHE_MAX) {
      const firstKey = svgCache.keys().next().value;
      if (firstKey !== undefined) svgCache.delete(firstKey);
    }
    svgCache.set(code, svg);
    return svg;
  } catch (err) {
    cleanupMermaidArtifacts(id);
    console.error('[MermaidBlock] render failed:', err instanceof Error ? err.message : err);
    throw err;
  }
}

function buildFullscreenHtml(code: string): string {
  const svg = svgCache.get(code) || '';
  return `<!DOCTYPE html><html><head>
<meta charset="utf-8">
<style>
  /* margin:auto (not align-items) centers when the diagram fits and stays
     scrollable-from-top when it's taller than the viewport. */
  body { display:flex; min-height:100vh; box-sizing:border-box;
         padding:40px; background:#fff; margin:0; overflow:auto; }
  #zoom-stage { margin:auto; transform-origin:top center; }
  #zoom-stage svg { max-width:100%; height:auto; display:block; }
  #zoom-controls {
    position:fixed; top:12px; right:12px; z-index:10;
    display:flex; align-items:center; gap:2px;
    background:rgba(255,255,255,0.95); border:1px solid #e5e0d8;
    border-radius:8px; padding:2px; box-shadow:0 1px 4px rgba(0,0,0,0.08);
    font-family:system-ui,-apple-system,sans-serif;
  }
  #zoom-controls button {
    all:unset; cursor:pointer; padding:5px 8px; font-size:14px; line-height:1;
    color:#6b6558; border-radius:6px;
  }
  #zoom-controls button:hover { background:rgba(0,0,0,0.05); color:#29261b; }
  #zoom-controls button:disabled { opacity:0.4; cursor:not-allowed; }
  #zoom-pct {
    min-width:38px; text-align:center; font-size:11px; color:#6b6558;
    user-select:none; padding:5px 2px;
  }
</style>
</head><body>
<div id="zoom-controls">
  <button id="zoom-out" title="Zoom out">−</button>
  <span id="zoom-pct">100%</span>
  <button id="zoom-in" title="Zoom in">+</button>
</div>
<div id="zoom-stage">${svg}</div>
<script>
(function () {
  var ZOOM_MIN = 0.25, ZOOM_MAX = 4, ZOOM_STEP = 0.25;
  var stage = document.getElementById('zoom-stage');
  var pctEl = document.getElementById('zoom-pct');
  var outBtn = document.getElementById('zoom-out');
  var inBtn = document.getElementById('zoom-in');
  var scale = 1;
  var gestureBase = 1;

  function clamp(n) { return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, n)); }

  function apply() {
    stage.style.transform = scale === 1 ? '' : 'scale(' + scale + ')';
    pctEl.textContent = Math.round(scale * 100) + '%';
    outBtn.disabled = scale <= ZOOM_MIN;
    inBtn.disabled = scale >= ZOOM_MAX;
  }

  outBtn.addEventListener('click', function () {
    scale = clamp(Math.round((scale - ZOOM_STEP) * 100) / 100);
    apply();
  });
  inBtn.addEventListener('click', function () {
    scale = clamp(Math.round((scale + ZOOM_STEP) * 100) / 100);
    apply();
  });
  pctEl.addEventListener('click', function () {
    scale = 1;
    apply();
  });

  // Plain wheel keeps scrolling; Cmd/Ctrl+wheel zooms (Windows WebView2 pinch
  // arrives as ctrl+wheel too).
  document.addEventListener('wheel', function (e) {
    if (!(e.ctrlKey || e.metaKey)) return;
    e.preventDefault();
    scale = clamp(scale * (1 - e.deltaY * 0.002));
    apply();
  }, { passive: false });

  // macOS trackpad pinch on WebKit fires non-standard gesture events instead
  // of ctrl+wheel.
  document.addEventListener('gesturestart', function (e) {
    e.preventDefault();
    gestureBase = scale;
  }, { passive: false });
  document.addEventListener('gesturechange', function (e) {
    e.preventDefault();
    scale = clamp(gestureBase * e.scale);
    apply();
  }, { passive: false });
  document.addEventListener('gestureend', function (e) {
    e.preventDefault();
  }, { passive: false });
})();
</script>
</body></html>`;
}

async function captureMermaidImage(code: string): Promise<string | null> {
  return svgCache.get(code) ?? null;
}

// --- Component ---

export default function MermaidBlock({ code }: { code: string }) {
  const { t } = useI18n();

  const config: CodeBlockRendererConfig = {
    label: 'mermaid',
    fallbackLanguage: 'mermaid',
    render: renderMermaid,
    captureImage: captureMermaidImage,
    buildFullscreenHtml,
    debounceMs: 300,
    errorSettleMs: 1000,
    maxHeight: 400,
    i18n: {
      loading: t.chat.mermaidLoading,
      renderError: t.chat.mermaidRenderError,
      expand: t.chat.mermaidExpand,
      collapse: t.chat.mermaidCollapse,
    },
  };

  return <RenderableCodeBlock code={code} config={config} />;
}
