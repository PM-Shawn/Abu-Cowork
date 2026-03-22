/**
 * Generic renderable code block shell.
 *
 * Handles: debounce, caching, loading/error/success states, expand/collapse,
 * toolbar (label, copy source, toggle source view), error fallback.
 *
 * Each renderer only needs to provide:
 * - render(code, container): produce output into a DOM container
 * - cleanup(container): optional cleanup on unmount
 */
import { useState, useEffect, useRef, useCallback } from 'react';
import { Copy, Check, ChevronDown, ChevronUp, Code, Eye, Maximize2, X, Download } from 'lucide-react';
import { createPortal } from 'react-dom';
import { cn } from '@/lib/utils';
import { useI18n } from '@/i18n';
import { CollapsibleCodeBlock } from './MarkdownRenderer';


type RenderState =
  | { status: 'loading' }
  | { status: 'previewing' }
  | { status: 'success' }
  | { status: 'error'; message: string };

/** Configuration for a code block renderer */
export interface CodeBlockRendererConfig {
  /** Unique label shown in the toolbar (e.g. "mermaid", "html") */
  label: string;
  /** Language name used for CollapsibleCodeBlock fallback */
  fallbackLanguage: string;
  /** Render code into a container element. Return HTML string for caching, or void if container is already populated. */
  render: (code: string, container: HTMLDivElement) => Promise<string | void>;
  /** Optional cleanup when the component unmounts. Receives the container element. */
  cleanup?: (container: HTMLDivElement) => void;
  /** Max collapsed height in px (default 400) */
  maxHeight?: number;
  /** Debounce ms before rendering (default 300) */
  debounceMs?: number;
  /** Ms to wait after render failure before showing error (default 1000) */
  errorSettleMs?: number;
  /** Seamless mode: no border/toolbar, widget blends into chat. Actions in hover menu.
   *  Used by HtmlWidgetBlock for Claude-like inline experience. */
  seamless?: boolean;
  /** Optional image capture for visualization mode copy/download.
   *  Returns SVG string of the rendered content, or null if capture failed. */
  captureImage?: (code: string, container: HTMLDivElement) => Promise<string | null>;
  /** Optional fullscreen content builder. If provided, a maximize button appears in the toolbar.
   *  Should return an HTML string to render in the fullscreen iframe. */
  buildFullscreenHtml?: (code: string) => string;
  /** Optional streaming preview. Called synchronously on every code change so the
   *  user sees content build up instead of a loading overlay. The function should
   *  be lightweight (e.g. postMessage, no heavy DOM work).
   *  Renderers that don't provide this keep the existing loading behavior. */
  preview?: {
    /** Lightweight preview render. Return false to skip (content not ready yet). */
    render: (code: string, container: HTMLDivElement) => void | boolean;
  };
  /** i18n strings */
  i18n: {
    loading: string;
    renderError: string;
    expand: string;
    collapse: string;
    // Seamless mode menu labels (optional, only needed when seamless=true)
    fullscreen?: string;
    copyCode?: string;
    copied?: string;
    download?: string;
    viewCode?: string;
    viewPreview?: string;
  };
}

// Per-label caches (shared across component instances)
const cacheMap = new Map<string, Map<string, string>>();
const CACHE_MAX = 50;

function getCache(label: string): Map<string, string> {
  let cache = cacheMap.get(label);
  if (!cache) {
    cache = new Map();
    cacheMap.set(label, cache);
  }
  return cache;
}

export default function RenderableCodeBlock({
  code,
  config,
}: {
  code: string;
  config: CodeBlockRendererConfig;
}) {
  const cache = getCache(config.label);
  const maxHeight = config.maxHeight ?? 400;
  const debounceMs = config.debounceMs ?? 300;
  const errorSettleMs = config.errorSettleMs ?? 1000;

  const [state, setState] = useState<RenderState>(() => {
    if (cache.has(code)) return { status: 'success' };
    return { status: 'loading' };
  });
  const [expanded, setExpanded] = useState(false);
  const [showSource, setShowSource] = useState(false);
  const [copied, setCopied] = useState(false);
  const [overflows, setOverflows] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);


  const containerRef = useRef<HTMLDivElement>(null);
  const codeRef = useRef(code);
  const configRef = useRef(config);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const settleRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  codeRef.current = code;
  configRef.current = config;

  useEffect(() => {
    if (!code.trim()) {
      setState({ status: 'loading' });
      return;
    }

    // Restore from cache
    const cached = cache.get(code);
    if (cached && containerRef.current) {
      containerRef.current.innerHTML = cached;
      setState({ status: 'success' });
      return;
    }

    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (settleRef.current) clearTimeout(settleRef.current);

    // Immediate preview (if renderer supports it).
    // Called synchronously on every code change — postMessage is cheap enough
    // for 60fps updates. Using debounce here would starve the preview because
    // streaming tokens reset the timer faster (~16ms) than it can fire (~120ms).
    const previewConfig = configRef.current.preview;
    if (previewConfig && containerRef.current) {
      const shown = previewConfig.render(code, containerRef.current);
      // Only transition to previewing if render didn't explicitly skip (return false)
      if (shown !== false) {
        setState(prev => prev.status === 'previewing' ? prev : { status: 'previewing' });
      }
    }

    // Full render path (existing logic)
    debounceRef.current = setTimeout(async () => {
      if (!containerRef.current || codeRef.current !== code) return;

      try {
        // Only clear container if no preview is active — preview renderers
        // (e.g. HtmlWidgetBlock) manage the container contents themselves
        // and clearing would destroy their iframe/state.
        if (!configRef.current.preview) {
          containerRef.current.innerHTML = '';
        }
        const html = await configRef.current.render(code, containerRef.current);

        if (codeRef.current !== code) return;

        // Cache the result
        const toCache = html ?? containerRef.current.innerHTML;
        if (toCache) {
          if (cache.size >= CACHE_MAX) {
            const firstKey = cache.keys().next().value;
            if (firstKey !== undefined) cache.delete(firstKey);
          }
          cache.set(code, toCache);
        }
        setState({ status: 'success' });
      } catch (err) {
        if (codeRef.current !== code) return;

        settleRef.current = setTimeout(() => {
          if (codeRef.current === code) {
            setState({
              status: 'error',
              message: err instanceof Error ? err.message : String(err),
            });
          }
        }, errorSettleMs);
      }
    }, debounceMs);

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      if (settleRef.current) clearTimeout(settleRef.current);
    };
  }, [code, cache, debounceMs, errorSettleMs]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      // Read ref at cleanup time — container may not exist at mount time
      // due to conditional rendering (loading/error states)
      // eslint-disable-next-line react-hooks/exhaustive-deps
      const container = containerRef.current;
      if (container) {
        configRef.current.cleanup?.(container);
      }
    };
  }, []);

  // Check overflow — use MutationObserver to catch async content changes
  // (e.g. iframe height set via postMessage after React render)
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const check = () => {
      if (state.status === 'success' || state.status === 'previewing') {
        // Check first child's actual height (iframe) rather than scrollHeight,
        // because scrollHeight may be clipped by overflow:hidden when collapsed.
        const child = container.firstElementChild;
        const contentHeight = child instanceof HTMLElement
          ? child.offsetHeight
          : container.scrollHeight;
        setOverflows(contentHeight > maxHeight);
      }
    };

    check();

    // Watch for child style.height changes (iframe resize via postMessage)
    const observer = new MutationObserver(check);
    observer.observe(container, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['style'],
    });

    return () => observer.disconnect();
  }, [state, maxHeight]);

  const { t } = useI18n();

  const handleDownloadSource = useCallback(async () => {
    try {
      const ext = config.fallbackLanguage === 'mermaid' ? 'mmd' : 'html';
      const { save } = await import('@tauri-apps/plugin-dialog');
      const { writeTextFile } = await import('@tauri-apps/plugin-fs');
      const filePath = await save({
        defaultPath: `${config.label}-${Date.now().toString(36)}.${ext}`,
        filters: [{ name: 'Source File', extensions: [ext] }],
      });
      if (filePath) await writeTextFile(filePath, code);
    } catch { /* ignore in non-Tauri env */ }
  }, [code, config.label, config.fallbackLanguage]);

  const handleCopy = useCallback(async () => {
    await navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [code]);

  const handleDownload = useCallback(async () => {
    await handleDownloadSource();
  }, [handleDownloadSource]);

  if (!code.trim()) return null;

  const isLoading = state.status === 'loading';
  const isPreviewing = state.status === 'previewing';
  const isError = state.status === 'error';
  const showFallback = isError || showSource;
  const isSuccess = state.status === 'success' && !showFallback;
  const isVisible = isSuccess || isPreviewing;
  const seamless = config.seamless ?? false;
  // Seamless mode: no collapse — widget grows with streaming content
  const isCollapsed = !seamless && isVisible && overflows && !expanded;

  // --- Shared pieces ---

  const renderContainer = (
    <div
      ref={containerRef}
      className={cn(
        'flex justify-center overflow-x-auto [&>svg]:max-w-full',
        seamless ? 'p-0' : 'p-4',
        isCollapsed && 'overflow-hidden',
        isLoading && 'min-h-[100px] invisible',
      )}
      style={isCollapsed ? { maxHeight: `${maxHeight}px` } : undefined}
    />
  );

  const shimmerOverlay = isPreviewing && (
    <div className="absolute inset-0 z-[5] pointer-events-none">
      <div className="absolute inset-0 bg-gradient-to-r from-transparent via-white/40 to-transparent"
        style={{ backgroundSize: '200% 100%', animation: 'shimmer 3s infinite linear' }} />
      <style>{`@keyframes shimmer { 0% { background-position: 200% 0; } 100% { background-position: -200% 0; } }`}</style>
    </div>
  );

  const expandButton = isCollapsed && (
    <div className="absolute bottom-0 left-0 right-0 h-20 bg-gradient-to-t from-white to-transparent flex items-end justify-center pb-2">
      <button
        onClick={() => setExpanded(true)}
        className="flex items-center gap-1 px-3 py-1 rounded-full bg-black/5 hover:bg-black/10 text-xs text-[var(--abu-text-muted)] transition-colors"
      >
        <ChevronDown className="h-3.5 w-3.5" />
        {config.i18n.expand}
      </button>
    </div>
  );

  const collapseButton = overflows && expanded && (
    <button
      onClick={() => setExpanded(false)}
      className="flex items-center gap-0.5 text-xs text-[var(--abu-text-muted)] hover:text-[var(--abu-text-primary)] transition-colors"
    >
      <ChevronUp className="h-3.5 w-3.5" />
      {config.i18n.collapse}
    </button>
  );

  const loadingOverlay = isLoading && (seamless ? (
    // Skeleton placeholder for seamless mode — pulse animation instead of blank white
    <div className="rounded-lg bg-[var(--abu-bg-muted)] p-5 space-y-3 animate-pulse">
      <div className="h-5 w-2/5 rounded bg-[var(--abu-bg-pressed)]" />
      <div className="h-3 w-4/5 rounded bg-[var(--abu-bg-pressed)]" />
      <div className="h-3 w-3/5 rounded bg-[var(--abu-bg-pressed)]" />
      <div className="flex gap-3 mt-4">
        <div className="h-16 flex-1 rounded bg-[var(--abu-bg-pressed)]" />
        <div className="h-16 flex-1 rounded bg-[var(--abu-bg-pressed)]" />
        <div className="h-16 flex-1 rounded bg-[var(--abu-bg-pressed)]" />
      </div>
    </div>
  ) : (
    <div className="absolute inset-0 z-10 flex items-center justify-center rounded-lg bg-[var(--abu-bg-muted)] text-sm text-[var(--abu-text-muted)]">
      {config.i18n.loading}
    </div>
  ));

  // --- Right-top hover toolbar (visualization mode) ---
  const btnClass = 'p-1.5 rounded-lg hover:bg-black/5 transition-colors text-[var(--abu-text-muted)] hover:text-[var(--abu-text-primary)]';
  const vizToolbar = !isLoading && !showSource && (
    <div className="absolute top-2 right-2 z-10 opacity-0 group-hover/widget:opacity-100 transition-opacity">
      <div className="flex items-center gap-0.5 bg-white/90 rounded-lg shadow-sm border border-[var(--abu-bg-pressed)] p-0.5 relative">
        <button onClick={handleCopy} className={btnClass} title={copied ? '✓' : 'Copy'}>
          {copied ? <Check className="h-3.5 w-3.5 text-green-600" /> : <Copy className="h-3.5 w-3.5" />}
        </button>
        <button onClick={handleDownload} className={btnClass} title="Download">
          <Download className="h-3.5 w-3.5" />
        </button>
        {config.buildFullscreenHtml && (
          <button onClick={() => setFullscreen(true)} className={btnClass} title="Fullscreen">
            <Maximize2 className="h-3.5 w-3.5" />
          </button>
        )}
        <button onClick={() => setShowSource(true)} className={btnClass} title="View source">
          <Code className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );

  // --- "Back to visual" button for source code view ---
  const backToVisualBtn = showSource && state.status === 'success' && (
    <div className="absolute top-2 right-2 z-10">
      <button
        onClick={() => setShowSource(false)}
        className="flex items-center gap-1 px-2 py-1 rounded-lg bg-white/90 shadow-sm border border-[var(--abu-bg-pressed)]
          text-xs text-[var(--abu-text-muted)] hover:text-[var(--abu-text-primary)] hover:bg-[var(--abu-bg-muted)] transition-colors"
      >
        <Eye className="h-3 w-3" />
        {config.i18n.viewPreview ?? t.chat.htmlWidgetViewPreview}
      </button>
    </div>
  );

  const fullscreenOverlay = fullscreen && config.buildFullscreenHtml && createPortal(
    <div
      className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-6"
      onClick={() => setFullscreen(false)}
    >
      <div
        className="relative bg-white rounded-xl shadow-2xl w-full max-w-5xl"
        style={{ height: '85vh' }}
        onClick={e => e.stopPropagation()}
      >
        <button
          onClick={() => setFullscreen(false)}
          className="absolute -top-3 -right-3 z-10 p-1.5 rounded-full bg-white shadow-md
            hover:bg-[var(--abu-bg-muted)] transition-colors"
        >
          <X className="h-4 w-4 text-[var(--abu-text-muted)]" />
        </button>
        <iframe
          srcDoc={config.buildFullscreenHtml(code)}
          sandbox="allow-scripts"
          className="w-full h-full rounded-xl border-none"
        />
      </div>
    </div>,
    document.body,
  );

  // --- Seamless mode (Claude-like) ---

  if (seamless) {
    // Error-only fallback for seamless mode
    const seamlessErrorFallback = isError && !showSource && (
      <div>
        <div className="rounded-t-lg bg-red-50 border border-red-200 border-b-0 px-3 py-2 text-xs text-red-600">
          {config.i18n.renderError}
        </div>
        <CollapsibleCodeBlock codeString={code} language={config.fallbackLanguage} />
      </div>
    );

    return (
      <div className="my-3 group/widget">
        {seamlessErrorFallback}
        <div className={cn('rounded-lg overflow-hidden', isError && !showSource && 'hidden')}>
          <div className="relative">
            {/* Source code view with "back to visual" button */}
            {showSource && (
              <div className="relative">
                <CollapsibleCodeBlock codeString={code} language={config.fallbackLanguage} />
                {backToVisualBtn}
              </div>
            )}
            {/* Seamless skeleton */}
            {isLoading && !showSource && loadingOverlay}
            <div className={cn((isLoading || showSource) && 'hidden')}>
              {renderContainer}
              {shimmerOverlay}
              {expandButton}
            </div>
            {/* Right-top hover toolbar */}
            {vizToolbar}
          </div>
          {/* Collapse button */}
          {collapseButton && !showSource && (
            <div className="flex justify-center mt-1">{collapseButton}</div>
          )}
        </div>
        {fullscreenOverlay}
      </div>
    );
  }

  // --- Bordered mode (Mermaid, SVG) ---

  // Error-only fallback (showSource is handled inside the bordered container)
  const errorFallback = isError && !showSource && (
    <div>
      <div className="rounded-t-lg bg-red-50 border border-red-200 border-b-0 px-3 py-2 text-xs text-red-600">
        {config.i18n.renderError}
      </div>
      <CollapsibleCodeBlock codeString={code} language={config.fallbackLanguage} />
    </div>
  );

  return (
    <div className="my-3 group/widget">
      {errorFallback}
      <div className={cn('rounded-lg overflow-hidden border border-[var(--abu-bg-pressed)]', isError && !showSource && 'hidden')}>
        <div className="relative bg-white">
          {/* Source code view with "back to visual" button */}
          {showSource && (
            <div className="relative">
              <CollapsibleCodeBlock codeString={code} language={config.fallbackLanguage} />
              {backToVisualBtn}
            </div>
          )}
          <div className={cn(showSource && 'hidden')}>
            {loadingOverlay}
            {renderContainer}
            {shimmerOverlay}
            {expandButton}
          </div>
          {/* Right-top hover toolbar */}
          {vizToolbar}
        </div>
        {/* Collapse button */}
        {collapseButton && !showSource && (
          <div className="flex justify-center py-1 border-t border-[var(--abu-bg-pressed)]">{collapseButton}</div>
        )}
      </div>
      {fullscreenOverlay}
    </div>
  );
}
