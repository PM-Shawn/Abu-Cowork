import { useI18n } from '@/i18n';
import RenderableCodeBlock, { type CodeBlockRendererConfig } from './RenderableCodeBlock';

// --- Mermaid-specific rendering logic ---

let mermaidInitPromise: Promise<typeof import('mermaid')['default']> | null = null;
let offscreenContainer: HTMLDivElement | null = null;

function getOffscreenContainer(): HTMLDivElement {
  if (!offscreenContainer) {
    offscreenContainer = document.createElement('div');
    offscreenContainer.style.cssText = 'position:absolute;left:-9999px;top:-9999px;width:0;height:0;overflow:hidden';
    offscreenContainer.setAttribute('aria-hidden', 'true');
    document.body.appendChild(offscreenContainer);
  }
  return offscreenContainer;
}

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
          secondaryColor: '#f5f3ee',
          tertiaryColor: '#e5e2db',
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
    const { svg } = await mermaid.render(id, code, getOffscreenContainer());
    cleanupMermaidArtifacts(id);
    container.innerHTML = svg;
    return svg;
  } catch (err) {
    cleanupMermaidArtifacts(id);
    throw err;
  }
}

// --- Component ---

export default function MermaidBlock({ code }: { code: string }) {
  const { t } = useI18n();

  const config: CodeBlockRendererConfig = {
    label: 'mermaid',
    fallbackLanguage: 'mermaid',
    render: renderMermaid,
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
