import { memo } from 'react';
import { useI18n } from '@/i18n';
import RenderableCodeBlock, { type CodeBlockRendererConfig } from './RenderableCodeBlock';
import { MERMAID_THEME_VARIABLES } from './mermaidTheme';
import { diagramHeightKey, recallDiagramHeight, useRenderMemoryStore } from '@/stores/renderMemoryStore';
import DiagramViewer from './DiagramViewer';

// --- Mermaid-specific rendering logic ---

let mermaidInitPromise: Promise<typeof import('mermaid')['default']> | null = null;

/** Cache rendered SVGs for copy and download. */
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
        themeVariables: MERMAID_THEME_VARIABLES,
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
    // Retain the rendered SVG for copy and download.
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

function renderFullscreen(container: HTMLDivElement) {
  const svg = container.querySelector('svg');
  if (!svg) throw new Error('Rendered Mermaid SVG is unavailable');
  const { width, height } = svg.viewBox.baseVal;
  if (width <= 0 || height <= 0) throw new Error('Rendered Mermaid SVG has no valid viewBox');
  return <DiagramViewer svg={svg.outerHTML} naturalSize={{ width, height }} />;
}

async function captureMermaidImage(code: string): Promise<string | null> {
  return svgCache.get(code) ?? null;
}

// --- Component ---

// Memoized so a finished diagram does not re-render while the reply around it streams.
export default memo(function MermaidBlock({ code }: { code: string }) {
  const { t } = useI18n();

  const config: CodeBlockRendererConfig = {
    label: 'mermaid',
    fallbackLanguage: 'mermaid',
    render: renderMermaid,
    captureImage: captureMermaidImage,
    renderFullscreen,
    debounceMs: 300,
    errorSettleMs: 1000,
    maxHeight: 400,
    heightMemory: {
      recall: (diagram) => recallDiagramHeight('mermaid', diagram),
      remember: (diagram, height) => useRenderMemoryStore.getState().rememberDiagramHeight(diagramHeightKey('mermaid', diagram), height),
    },
    i18n: {
      loading: t.chat.mermaidLoading,
      renderError: t.chat.mermaidRenderError,
      expand: t.chat.mermaidExpand,
      collapse: t.chat.mermaidCollapse,
    },
  };

  return <RenderableCodeBlock code={code} config={config} />;
});
