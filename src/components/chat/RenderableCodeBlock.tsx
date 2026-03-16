/**
 * Generic renderable code block shell.
 *
 * Handles: debounce, caching, loading/error/success states, expand/collapse,
 * toolbar (label, copy source, toggle source view), error fallback.
 *
 * Each renderer only needs to provide:
 * - render(code, container): produce output into a DOM container
 * - cleanup(container): optional cleanup on unmount
 *
 * TODO: Infographic (AntV) renders blank — the container needs real visible dimensions
 * when @antv/infographic calls render(). Current approach (invisible + min-height)
 * doesn't work. Need to investigate AntV's layout requirements or render into
 * a detached container first then transplant. Mermaid works fine (pure SVG).
 */
import { useState, useEffect, useRef, useCallback } from 'react';
import { Copy, Check, ChevronDown, ChevronUp, Code, Eye, Maximize2, X, Ellipsis, Download } from 'lucide-react';
import { createPortal } from 'react-dom';
import { cn } from '@/lib/utils';
import { CollapsibleCodeBlock } from './MarkdownRenderer';

type RenderState =
  | { status: 'loading' }
  | { status: 'previewing' }
  | { status: 'success' }
  | { status: 'error'; message: string };

/** Configuration for a code block renderer */
export interface CodeBlockRendererConfig {
  /** Unique label shown in the toolbar (e.g. "mermaid", "infographic") */
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
  /** Optional fullscreen content builder. If provided, a maximize button appears in the toolbar.
   *  Should return an HTML string to render in the fullscreen iframe. */
  buildFullscreenHtml?: (code: string) => string;
  /** Optional streaming preview. Called synchronously on every code change so the
   *  user sees content build up instead of a loading overlay. The function should
   *  be lightweight (e.g. postMessage, no heavy DOM work).
   *  Renderers that don't provide this keep the existing loading behavior. */
  preview?: {
    /** Lightweight preview render (e.g. visual-only, no script execution). */
    render: (code: string, container: HTMLDivElement) => void;
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
  const [menuOpen, setMenuOpen] = useState(false);

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
      previewConfig.render(code, containerRef.current);
      setState(prev => prev.status === 'previewing' ? prev : { status: 'previewing' });
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

  // Check overflow
  useEffect(() => {
    if ((state.status === 'success' || state.status === 'previewing') && containerRef.current) {
      setOverflows(containerRef.current.scrollHeight > maxHeight);
    }
  }, [state, maxHeight]);

  const handleCopy = useCallback(async () => {
    await navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
    setMenuOpen(false);
  }, [code]);

  const handleDownload = useCallback(() => {
    const blob = new Blob([code], { type: 'text/html;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `widget-${Date.now().toString(36)}.html`;
    a.click();
    URL.revokeObjectURL(url);
    setMenuOpen(false);
  }, [code]);

  if (!code.trim()) return null;

  const isLoading = state.status === 'loading';
  const isPreviewing = state.status === 'previewing';
  const isError = state.status === 'error';
  const showFallback = isError || showSource;
  const isSuccess = state.status === 'success' && !showFallback;
  const isVisible = isSuccess || isPreviewing;
  const seamless = config.seamless ?? false;
  // Seamless mode: no expand/collapse, show full height (like Claude)
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

  // Shimmer overlay: only for bordered mode. Seamless mode relies on per-element
  // placeholders (e.g. canvas → "图表加载中…") instead of a full-widget overlay.
  const shimmerOverlay = isPreviewing && !seamless && (
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
        className="flex items-center gap-1 px-3 py-1 rounded-full bg-black/5 hover:bg-black/10 text-xs text-[#888579] transition-colors"
      >
        <ChevronDown className="h-3.5 w-3.5" />
        {config.i18n.expand}
      </button>
    </div>
  );

  const collapseButton = overflows && expanded && (
    <button
      onClick={() => setExpanded(false)}
      className="flex items-center gap-0.5 text-xs text-[#888579] hover:text-[#29261b] transition-colors"
    >
      <ChevronUp className="h-3.5 w-3.5" />
      {config.i18n.collapse}
    </button>
  );

  const loadingOverlay = isLoading && (
    <div className="absolute inset-0 z-10 flex items-center justify-center rounded-lg bg-[#f5f3ee] text-sm text-[#888579]">
      {config.i18n.loading}
    </div>
  );

  const sourceFallback = showFallback && (
    <div>
      {isError && !showSource && (
        <div className="rounded-t-lg bg-red-50 border border-red-200 border-b-0 px-3 py-2 text-xs text-red-600">
          {config.i18n.renderError}
        </div>
      )}
      <CollapsibleCodeBlock codeString={code} language={config.fallbackLanguage} />
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
            hover:bg-[#f5f3ee] transition-colors"
        >
          <X className="h-4 w-4 text-[#888579]" />
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
    return (
      <div className="my-3 group/widget relative">
        {sourceFallback}
        <div className={cn(showFallback && 'hidden')}>
          <div className="relative">
            {loadingOverlay}
            {renderContainer}
            {shimmerOverlay}
            {expandButton}

            {/* Hover menu — top-right ··· button */}
            {!isLoading && (
              <div className="absolute top-2 right-2 z-10 opacity-0 group-hover/widget:opacity-100 transition-opacity">
                <div className="relative">
                  <button
                    onClick={() => setMenuOpen(!menuOpen)}
                    className="p-1.5 rounded-lg bg-white/90 shadow-sm border border-[#e5e2db]
                      hover:bg-[#f5f3ee] transition-colors"
                  >
                    <Ellipsis className="h-4 w-4 text-[#888579]" />
                  </button>
                  {menuOpen && (
                    <>
                      <div className="fixed inset-0 z-20" onClick={() => setMenuOpen(false)} />
                      <div className="absolute right-0 top-full mt-1 z-30 bg-white rounded-lg shadow-lg border border-[#e5e2db]
                        py-1 min-w-[160px]">
                        {config.buildFullscreenHtml && (
                          <button
                            onClick={() => { setFullscreen(true); setMenuOpen(false); }}
                            className="flex items-center gap-2.5 w-full px-3 py-2 text-sm text-[#29261b]
                              hover:bg-[#f5f3ee] transition-colors"
                          >
                            <Maximize2 className="h-4 w-4 text-[#888579]" />
                            {config.i18n.fullscreen ?? 'Fullscreen'}
                          </button>
                        )}
                        <button
                          onClick={handleCopy}
                          className="flex items-center gap-2.5 w-full px-3 py-2 text-sm text-[#29261b]
                            hover:bg-[#f5f3ee] transition-colors"
                        >
                          {copied
                            ? <Check className="h-4 w-4 text-green-600" />
                            : <Copy className="h-4 w-4 text-[#888579]" />
                          }
                          {copied ? (config.i18n.copied ?? 'Copied') : (config.i18n.copyCode ?? 'Copy')}
                        </button>
                        <button
                          onClick={handleDownload}
                          className="flex items-center gap-2.5 w-full px-3 py-2 text-sm text-[#29261b]
                            hover:bg-[#f5f3ee] transition-colors"
                        >
                          <Download className="h-4 w-4 text-[#888579]" />
                          {config.i18n.download ?? 'Download'}
                        </button>
                        <button
                          onClick={() => { setShowSource(!showSource); setMenuOpen(false); }}
                          className="flex items-center gap-2.5 w-full px-3 py-2 text-sm text-[#29261b]
                            hover:bg-[#f5f3ee] transition-colors"
                        >
                          {showSource
                            ? <Eye className="h-4 w-4 text-[#888579]" />
                            : <Code className="h-4 w-4 text-[#888579]" />
                          }
                          {showSource ? (config.i18n.viewPreview ?? 'Preview') : (config.i18n.viewCode ?? 'Code')}
                        </button>
                      </div>
                    </>
                  )}
                </div>
              </div>
            )}
          </div>
          {/* Collapse button — shown inline below widget when expanded */}
          {collapseButton && (
            <div className="flex justify-center mt-1">{collapseButton}</div>
          )}
        </div>
        {fullscreenOverlay}
      </div>
    );
  }

  // --- Bordered mode (Mermaid, Infographic) ---

  return (
    <div className="my-3">
      {sourceFallback}
      <div className={cn('rounded-lg overflow-hidden border border-[#e5e2db]', showFallback && 'hidden')}>
        <div className="relative bg-white">
          {loadingOverlay}
          {renderContainer}
          {shimmerOverlay}
          {expandButton}
        </div>
        {/* Bottom toolbar */}
        <div className="flex items-center justify-between px-3 py-1.5 bg-[#f5f3ee] text-xs text-[#888579] border-t border-[#e5e2db]">
          <div className="flex items-center gap-2">
            <span>{config.label}</span>
            {collapseButton}
          </div>
          <div className="flex items-center gap-1">
            {config.buildFullscreenHtml && (
              <button onClick={() => setFullscreen(true)} className="p-1 rounded hover:bg-black/5 transition-colors">
                <Maximize2 className="h-3.5 w-3.5" />
              </button>
            )}
            <button onClick={handleCopy} className="p-1 rounded hover:bg-black/5 transition-colors" title={copied ? '✓' : 'Copy'}>
              {copied ? <Check className="h-3.5 w-3.5 text-green-600" /> : <Copy className="h-3.5 w-3.5" />}
            </button>
            <button onClick={() => setShowSource(!showSource)} className="p-1 rounded hover:bg-black/5 transition-colors">
              {showSource ? <Eye className="h-3.5 w-3.5" /> : <Code className="h-3.5 w-3.5" />}
            </button>
          </div>
        </div>
      </div>
      {fullscreenOverlay}
    </div>
  );
}
