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
  body { display:flex; justify-content:center; align-items:flex-start;
         padding:40px; background:#fff; margin:0; overflow:auto; }
  svg { max-width:100%; height:auto; }
</style>
</head><body>${svg}</body></html>`;
}

// --- Component ---

export default function MermaidBlock({ code }: { code: string }) {
  const { t } = useI18n();

  const config: CodeBlockRendererConfig = {
    label: 'mermaid',
    fallbackLanguage: 'mermaid',
    render: renderMermaid,
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
