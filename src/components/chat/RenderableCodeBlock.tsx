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
import { cn } from '@/lib/utils';
import { useI18n } from '@/i18n';
import { Button, IconButton } from '@/components/ds/button';
import { Dialog } from '@/components/ds/dialog';
import { AppIcons } from '@/components/ds/icons';
import { InlineMessage } from '@/components/ds/inline-message';
import { Spinner } from '@/components/ds/spinner';
import { Tooltip } from '@/components/ds/tooltip';
import { CollapsibleCodeBlock } from './MarkdownRenderer';
import { zoomIn as zoomInFn, zoomOut as zoomOutFn, zoomByWheel, clampZoom, formatZoomPercent, ZOOM_MIN, ZOOM_MAX } from '@/utils/zoom';

/** WebKit-only gesture events (macOS trackpad pinch on Safari/WKWebView).
 *  Not in the DOM lib types — declare the minimal shape we use. */
interface GestureEvent extends Event {
  scale: number;
}


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

const WIDGET_CLOSE_BUTTON = { 'data-widget-close': '' } as const;
const widgetCloseButtonOf = (content: HTMLElement) => content.querySelector<HTMLElement>('[data-widget-close]');

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
  const [fullscreenAsked, setFullscreenAsked] = useState(false);
  const [scale, setScale] = useState(1);


  const containerRef = useRef<HTMLDivElement>(null);
  const codeRef = useRef(code);
  const configRef = useRef(config);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const settleRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  // Zoom host: the `.relative` wrapper div (seamless or bordered — only one mounts).
  // Native (non-React) listeners are attached here so we can preventDefault on
  // wheel/gesture events, which React's passive onWheel cannot do.
  const zoomHostRef = useRef<HTMLDivElement>(null);
  const scaleRef = useRef(scale);
  const showSourceRef = useRef(showSource);
  const gestureBaseRef = useRef(1);

  codeRef.current = code;
  configRef.current = config;
  scaleRef.current = scale;
  showSourceRef.current = showSource;

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

  // Reset zoom when the diagram changes (same mounted instance, new code)
  useEffect(() => {
    setScale(1);
  }, [code]);

  // Native wheel + WebKit gesture listeners for zoom. Attached once (not on every
  // scale/showSource change) to avoid thrashing; fresh state is read via refs.
  // React's onWheel is passive so e.preventDefault() there is a no-op — hence native.
  useEffect(() => {
    const host = zoomHostRef.current;
    if (!host) return;

    const handleWheel = (e: WheelEvent) => {
      if (showSourceRef.current || !(e.ctrlKey || e.metaKey)) return; // bare wheel / source view stays scroll
      e.preventDefault();
      setScale(s => zoomByWheel(s, e.deltaY));
    };
    const handleGestureStart = (e: Event) => {
      if (showSourceRef.current) return;
      e.preventDefault();
      gestureBaseRef.current = scaleRef.current;
    };
    const handleGestureChange = (e: Event) => {
      if (showSourceRef.current) return;
      e.preventDefault();
      const scaleFactor = (e as GestureEvent).scale;
      setScale(clampZoom(gestureBaseRef.current * scaleFactor));
    };
    const handleGestureEnd = (e: Event) => {
      e.preventDefault();
    };

    host.addEventListener('wheel', handleWheel, { passive: false });
    host.addEventListener('gesturestart', handleGestureStart, { passive: false });
    host.addEventListener('gesturechange', handleGestureChange, { passive: false });
    host.addEventListener('gestureend', handleGestureEnd, { passive: false });

    return () => {
      host.removeEventListener('wheel', handleWheel);
      host.removeEventListener('gesturestart', handleGestureStart);
      host.removeEventListener('gesturechange', handleGestureChange);
      host.removeEventListener('gestureend', handleGestureEnd);
    };
  }, []);

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

  const handleZoomIn = useCallback(() => setScale(s => zoomInFn(s)), []);
  const handleZoomOut = useCallback(() => setScale(s => zoomOutFn(s)), []);
  const handleZoomReset = useCallback(() => setScale(1), []);
  const openFullscreen = useCallback(() => {
    setFullscreenAsked(true);
    setFullscreen(true);
  }, []);

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
    // OUTER = scroll viewport + collapse clipper. Owns overflow + maxHeight + padding.
    <div
      className={cn(
        'overflow-auto',
        seamless ? 'p-0' : 'p-4',
        isCollapsed && 'overflow-hidden',
        isLoading && 'min-h-[100px] invisible',
      )}
      style={isCollapsed ? { maxHeight: `${maxHeight}px` } : undefined}
    >
      {/* INNER = the element render() injects into. Owns the scale transform. */}
      <div
        ref={containerRef}
        className="flex justify-center [&>svg]:max-w-full"
        style={{
          transform: scale !== 1 ? `scale(${scale})` : undefined,
          transformOrigin: 'top center',
        }}
      />
    </div>
  );

  const shimmerOverlay = isPreviewing && (
    <div className="pointer-events-none absolute inset-0">
      <div className="absolute inset-0 bg-gradient-to-r from-transparent via-surface/40 to-transparent"
        style={{ backgroundSize: '200% 100%', animation: 'shimmer 3s infinite linear' }} />
      <style>{`@keyframes shimmer { 0% { background-position: 200% 0; } 100% { background-position: -200% 0; } }`}</style>
    </div>
  );

  const expandButton = isCollapsed && (
    <div className="absolute bottom-0 left-0 right-0 flex h-20 items-end justify-center bg-gradient-to-t from-diagram-canvas to-transparent pb-2">
      <Button variant="secondary" size="sm" icon={AppIcons.expand} onClick={() => setExpanded(true)}>
        {config.i18n.expand}
      </Button>
    </div>
  );

  const collapseButton = overflows && expanded && (
    <Button variant="plain" size="sm" icon={AppIcons.collapse} onClick={() => setExpanded(false)}>
      {config.i18n.collapse}
    </Button>
  );

  const loadingOverlay = isLoading && (seamless ? (
    <div className="flex justify-center rounded-panel bg-code p-6">
      <Spinner label={config.i18n.loading} />
    </div>
  ) : (
    <div className="absolute inset-0 z-sticky flex items-center justify-center bg-surface">
      <Spinner label={config.i18n.loading} />
    </div>
  ));

  // --- Right-top hover toolbar (visualization mode) ---
  const vizToolbar = !isLoading && !showSource && (
    <div className="absolute top-2 right-2 z-sticky opacity-0 transition-opacity duration-fast group-hover/widget:opacity-100 focus-within:opacity-100">
      <div className="relative flex items-center gap-1 rounded-control bg-raised p-1 text-label shadow-float">
        <IconButton size="sm" icon={AppIcons.zoomOut} label={t.panel.pdfZoomOut} onClick={handleZoomOut} disabled={scale <= ZOOM_MIN} />
        <Tooltip content="Reset zoom">
          <Button variant="plain" size="sm" onClick={handleZoomReset} className="w-10 tabular-nums">
            {formatZoomPercent(scale)}
          </Button>
        </Tooltip>
        <IconButton size="sm" icon={AppIcons.zoomIn} label={t.panel.pdfZoomIn} onClick={handleZoomIn} disabled={scale >= ZOOM_MAX} />
        <div className="mx-1 h-4 w-px bg-separator" />
        <IconButton
          size="sm"
          icon={copied ? AppIcons.done : AppIcons.copy}
          label={t.chat.copy}
          onClick={handleCopy}
          className={cn(copied && 'text-success hover:text-success')}
        />
        <IconButton size="sm" icon={AppIcons.download} label="Download" onClick={handleDownload} />
        {config.buildFullscreenHtml && (
          <IconButton size="sm" icon={AppIcons.enlarge} label={t.chat.htmlWidgetFullscreen} onClick={openFullscreen} />
        )}
        <IconButton size="sm" icon={AppIcons.viewSource} label="View source" onClick={() => setShowSource(true)} />
      </div>
    </div>
  );

  // --- "Back to visual" button for source code view ---
  const backToVisualBtn = showSource && state.status === 'success' && (
    <div className="absolute right-2 top-2 z-sticky">
      <Button variant="secondary" size="sm" icon={AppIcons.preview} onClick={() => setShowSource(false)}>
        {config.i18n.viewPreview ?? t.chat.htmlWidgetViewPreview}
      </Button>
    </div>
  );

  // The enlarged widget is a new frame in a viewer window. The window opens on its close
  // button: a sandboxed frame that has the focus keeps every key, Escape included.
  // A conversation can hold many widgets: a block has no window until its first enlargement,
  // and from then on the window is closed, not removed, so it fades out.
  const fullscreenOverlay = config.buildFullscreenHtml && fullscreenAsked && (
    <Dialog
      open={fullscreen}
      onOpenChange={(next) => { if (!next) setFullscreen(false); }}
      size="viewer"
      title={t.chat.htmlWidgetFullscreen}
      titleHidden
      closeButton={WIDGET_CLOSE_BUTTON}
      initialFocus={widgetCloseButtonOf}
    >
      {/* The frame starts below the close button, so the button covers none of the widget. */}
      <div className="flex min-h-0 flex-1 flex-col pt-13">
        <iframe
          srcDoc={config.buildFullscreenHtml(code)}
          sandbox="allow-scripts"
          className="min-h-0 w-full flex-1 rounded-b-window border-none bg-page-canvas"
        />
      </div>
    </Dialog>
  );

  // --- Seamless mode (Claude-like) ---

  if (seamless) {
    // Error-only fallback for seamless mode
    const seamlessErrorFallback = isError && !showSource && (
      <div>
        <InlineMessage tone="danger">{config.i18n.renderError}</InlineMessage>
        <CollapsibleCodeBlock codeString={code} language={config.fallbackLanguage} />
      </div>
    );

    return (
      <div className="my-3 group/widget">
        {seamlessErrorFallback}
        <div className={cn('overflow-hidden rounded-panel', isError && !showSource && 'hidden')}>
          <div ref={zoomHostRef} className="relative">
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
      <InlineMessage tone="danger">{config.i18n.renderError}</InlineMessage>
      <CollapsibleCodeBlock codeString={code} language={config.fallbackLanguage} />
    </div>
  );

  return (
    <div className="my-3 group/widget">
      {errorFallback}
      <div className={cn('overflow-hidden rounded-panel border border-separator bg-surface', isError && !showSource && 'hidden')}>
        <div ref={zoomHostRef} className="relative">
          {/* Source code view with "back to visual" button */}
          {showSource && (
            <div className="relative">
              <CollapsibleCodeBlock codeString={code} language={config.fallbackLanguage} />
              {backToVisualBtn}
            </div>
          )}
          {/* Diagrams keep their own light colors, so they sit on a fixed light canvas. */}
          <div className={cn('bg-diagram-canvas', showSource && 'hidden')}>
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
          <div className="flex justify-center border-t border-separator py-1">{collapseButton}</div>
        )}
      </div>
      {fullscreenOverlay}
    </div>
  );
}
