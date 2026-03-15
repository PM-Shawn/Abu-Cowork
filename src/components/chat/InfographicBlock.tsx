import { useI18n } from '@/i18n';
import RenderableCodeBlock, { type CodeBlockRendererConfig } from './RenderableCodeBlock';

// --- Infographic-specific rendering logic ---

let infographicPromise: Promise<typeof import('@antv/infographic')> | null = null;
const instanceMap = new WeakMap<HTMLDivElement, { destroy: () => void }>();

function getInfographicModule() {
  if (!infographicPromise) {
    infographicPromise = import('@antv/infographic');
  }
  return infographicPromise;
}

async function renderInfographic(code: string, container: HTMLDivElement): Promise<void> {
  // Destroy this container's previous instance
  const prev = instanceMap.get(container);
  if (prev) {
    try { prev.destroy(); } catch { /* ignore */ }
    instanceMap.delete(container);
  }

  const mod = await getInfographicModule();
  const instance = new mod.Infographic({
    container,
    width: '100%',
    height: '100%',
  });
  instance.render(code);
  instanceMap.set(container, instance);
}

function cleanupInfographic(container: HTMLDivElement) {
  const inst = instanceMap.get(container);
  if (inst) {
    try { inst.destroy(); } catch { /* ignore */ }
    instanceMap.delete(container);
  }
}

// --- Component ---

export default function InfographicBlock({ code }: { code: string }) {
  const { t } = useI18n();

  const config: CodeBlockRendererConfig = {
    label: 'infographic',
    fallbackLanguage: 'yaml',
    render: renderInfographic,
    cleanup: cleanupInfographic,
    debounceMs: 400,
    errorSettleMs: 1200,
    maxHeight: 500,
    i18n: {
      loading: t.chat.infographicLoading,
      renderError: t.chat.infographicRenderError,
      expand: t.chat.infographicExpand,
      collapse: t.chat.infographicCollapse,
    },
  };

  return <RenderableCodeBlock code={code} config={config} />;
}
