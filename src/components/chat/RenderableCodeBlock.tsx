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
import { Copy, Check, ChevronDown, ChevronUp, Code, Image } from 'lucide-react';
import { cn } from '@/lib/utils';
import { CollapsibleCodeBlock } from './MarkdownRenderer';

type RenderState =
  | { status: 'loading' }
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
  /** i18n strings */
  i18n: {
    loading: string;
    renderError: string;
    expand: string;
    collapse: string;
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

    debounceRef.current = setTimeout(async () => {
      if (!containerRef.current || codeRef.current !== code) return;

      try {
        containerRef.current.innerHTML = '';
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
    if (state.status === 'success' && containerRef.current) {
      setOverflows(containerRef.current.scrollHeight > maxHeight);
    }
  }, [state, maxHeight]);

  const handleCopy = useCallback(async () => {
    await navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [code]);

  if (!code.trim()) return null;

  const isLoading = state.status === 'loading';
  const isError = state.status === 'error';
  const showFallback = isError || showSource;
  const isSuccess = state.status === 'success' && !showFallback;
  const isCollapsed = isSuccess && overflows && !expanded;

  return (
    <div className="my-3">
      {/* Error / source view overlay */}
      {showFallback && (
        <div>
          {isError && !showSource && (
            <div className="rounded-t-lg bg-red-50 border border-red-200 border-b-0 px-3 py-2 text-xs text-red-600">
              {config.i18n.renderError}
            </div>
          )}
          <CollapsibleCodeBlock codeString={code} language={config.fallbackLanguage} />
          {showSource && state.status === 'success' && (
            <div className="flex justify-end -mt-1">
              <button
                onClick={() => setShowSource(false)}
                className="flex items-center gap-1 px-2 py-1 text-xs text-[#888579] hover:text-[#29261b] transition-colors"
              >
                <Image className="h-3.5 w-3.5" />
              </button>
            </div>
          )}
        </div>
      )}

      {/* Render container — always mounted so ref is stable and lib can measure dimensions.
          During loading: visible but overlaid with loading text.
          During error/source: hidden (render already done/failed, no dimension needed). */}
      <div className={cn('rounded-lg overflow-hidden border border-[#e5e2db]', showFallback && 'hidden')}>
        <div className="relative bg-white">
          {/* Loading overlay — covers container while render is in progress */}
          {isLoading && (
            <div className="absolute inset-0 z-10 flex items-center justify-center rounded-lg bg-[#f5f3ee] text-sm text-[#888579]">
              {config.i18n.loading}
            </div>
          )}
          <div
            ref={containerRef}
            className={cn(
              'flex justify-center p-4 overflow-x-auto [&>svg]:max-w-full',
              isCollapsed && 'overflow-hidden',
              isLoading && 'min-h-[100px] invisible'
            )}
            style={isCollapsed ? { maxHeight: `${maxHeight}px` } : undefined}
          />
          {isCollapsed && (
            <div className="absolute bottom-0 left-0 right-0 h-20 bg-gradient-to-t from-white to-transparent flex items-end justify-center pb-2">
              <button
                onClick={() => setExpanded(true)}
                className="flex items-center gap-1 px-3 py-1 rounded-full bg-black/5 hover:bg-black/10 text-xs text-[#888579] transition-colors"
              >
                <ChevronDown className="h-3.5 w-3.5" />
                {config.i18n.expand}
              </button>
            </div>
          )}
        </div>
        {/* Bottom toolbar */}
        <div className="flex items-center justify-between px-3 py-1.5 bg-[#f5f3ee] text-xs text-[#888579] border-t border-[#e5e2db]">
          <div className="flex items-center gap-2">
            <span>{config.label}</span>
            {overflows && expanded && (
              <button
                onClick={() => setExpanded(false)}
                className="flex items-center gap-0.5 hover:text-[#29261b] transition-colors"
              >
                <ChevronUp className="h-3.5 w-3.5" />
                {config.i18n.collapse}
              </button>
            )}
          </div>
          <div className="flex items-center gap-1">
            <button
              onClick={handleCopy}
              className="p-1 rounded hover:bg-black/5 transition-colors"
              title={copied ? '✓' : 'Copy'}
            >
              {copied ? (
                <Check className="h-3.5 w-3.5 text-green-600" />
              ) : (
                <Copy className="h-3.5 w-3.5" />
              )}
            </button>
            <button
              onClick={() => setShowSource(true)}
              className="p-1 rounded hover:bg-black/5 transition-colors"
              title="Source"
            >
              <Code className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
