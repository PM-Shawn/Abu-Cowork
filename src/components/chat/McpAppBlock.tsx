import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { useI18n, format } from '@/i18n';
import { cn } from '@/lib/utils';
import { APP_VERSION } from '@/utils/version';
import { getLocale } from '@/i18n';
import { mcpManager } from '@/core/mcp/client';
import type { McpAppResource } from '@/core/mcp/appResources';
import {
  APP_IFRAME_SANDBOX,
  MAX_ACTIVE_MCP_APPS,
  MAX_APP_IFRAME_HEIGHT,
  buildAppCsp,
  buildAppSrcdoc,
  buildHostContext,
  type McpAppResourceMeta,
} from '@/core/mcp/appHost';
import { createAppBridgeSession, type AppBridgeSession } from '@/core/mcp/appBridgeSession';
import type { ToolResultContent } from '@/types';

/** Production handshake budget: the app has this long to answer `ui/initialize`
 *  and send `ui/notifications/initialized` before we give up and fall back to
 *  the plain tool result. Tests pass 0 to disable the timer entirely. */
const HANDSHAKE_TIMEOUT_MS = 10_000;

type BlockStatus = 'loading' | 'ready' | 'failed' | 'disconnected';

// ---------------------------------------------------------------------------
// Concurrency cap (spec §4.5) — at most MAX_ACTIVE_MCP_APPS live bridges per
// conversation. Mount order is the LRU key: the newest blocks keep their slot,
// older ones collapse to a click-to-load placeholder.
// ---------------------------------------------------------------------------

const slotsByConversation = new Map<string, string[]>();
const slotListeners = new Set<() => void>();

function notifySlots() {
  slotListeners.forEach((l) => l());
}

function claimSlot(conversationKey: string, id: string) {
  const current = slotsByConversation.get(conversationKey) ?? [];
  const next = current.filter((x) => x !== id);
  next.push(id);
  slotsByConversation.set(conversationKey, next.slice(-MAX_ACTIVE_MCP_APPS));
  notifySlots();
}

function releaseSlot(conversationKey: string, id: string) {
  const current = slotsByConversation.get(conversationKey);
  if (!current) return;
  const next = current.filter((x) => x !== id);
  if (next.length === 0) slotsByConversation.delete(conversationKey);
  else slotsByConversation.set(conversationKey, next);
  notifySlots();
}

function hasSlot(conversationKey: string, id: string): boolean {
  return (slotsByConversation.get(conversationKey) ?? []).includes(id);
}

/** Test-only: drop every recorded slot so LRU state cannot leak between cases. */
// eslint-disable-next-line react-refresh/only-export-components
export function resetMcpAppSlots() {
  slotsByConversation.clear();
  notifySlots();
}

function subscribeSlots(listener: () => void) {
  slotListeners.add(listener);
  return () => { slotListeners.delete(listener); };
}

// ---------------------------------------------------------------------------
// Result conversion
// ---------------------------------------------------------------------------

/**
 * Rebuild an MCP `CallToolResult` from what Abu actually persists.
 *
 * KNOWN GAP: Abu keeps the tool's *converted* output (a display string plus
 * optional content blocks), not the server's raw `CallToolResult`. So
 * `structuredContent`, `_meta` and any non-text/image block are lost before the
 * result reaches the app. Apps that read `structuredContent` will see nothing
 * until the raw result is threaded through the tool pipeline.
 */
// eslint-disable-next-line react-refresh/only-export-components
export function toCallToolResult(
  result: string | undefined,
  resultContent: ToolResultContent[] | undefined,
  isError: boolean | undefined,
): CallToolResult {
  const blocks = (resultContent ?? [])
    .map((block) => {
      if (block.type === 'text') return { type: 'text' as const, text: block.text };
      if (block.type === 'image' && block.source?.data) {
        return {
          type: 'image' as const,
          data: block.source.data,
          mimeType: block.source.media_type,
        };
      }
      return undefined;
    })
    .filter((b): b is NonNullable<typeof b> => b !== undefined);

  const content = blocks.length > 0
    ? blocks
    : [{ type: 'text' as const, text: result ?? '' }];

  return { content, ...(isError ? { isError: true } : {}) };
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

/** Seams the tests (and later batches) inject instead of the live MCP client. */
export interface McpAppBlockDeps {
  readResource?: (server: string, uri: string) => Promise<McpAppResource>;
  isConnected?: (server: string) => boolean;
  createSession?: typeof createAppBridgeSession;
  /** 0 disables the handshake timer (tests run without timers). */
  handshakeTimeoutMs?: number;
  isDark?: () => boolean;
}

export interface McpAppBlockProps {
  /** The step this interface belongs to — also the LRU identity. */
  toolCallId: string;
  /** MCP server that owns both the tool and the `ui://` resource. */
  server: string;
  resourceUri: string;
  /** Arguments the model passed, replayed to the app as `tool-input`. */
  input: Record<string, unknown>;
  /** Abu's persisted display result — absent while the step is still running. */
  result?: string;
  resultContent?: ToolResultContent[];
  isError?: boolean;
  /** True while the step is in flight. */
  isExecuting?: boolean;
  /** Set once the step was aborted; pushes `tool-cancelled` instead of a result. */
  cancelled?: boolean;
  conversationId?: string;
  deps?: McpAppBlockDeps;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * Renders one MCP App interface (spec §4.2): fetch the connector's `ui://`
 * resource, drop it into a `sandbox="allow-scripts"` srcdoc iframe behind a
 * host-built CSP, and drive the `AppBridge` handshake / tool lifecycle.
 *
 * Every failure path degrades to a single muted line — the plain tool result is
 * already rendered by the tool card above, so a broken interface never hides
 * the output.
 */
export default function McpAppBlock({
  toolCallId,
  server,
  resourceUri,
  input,
  result,
  resultContent,
  isError,
  isExecuting,
  cancelled,
  conversationId,
  deps,
}: McpAppBlockProps) {
  const { t } = useI18n();
  const conversationKey = conversationId ?? '__no-conversation__';

  const readResource = deps?.readResource ?? ((s: string, u: string) => mcpManager.readResource(s, u));
  const isConnected = deps?.isConnected ?? ((s: string) => mcpManager.isConnected(s));
  const createSession = deps?.createSession ?? createAppBridgeSession;
  const handshakeTimeoutMs = deps?.handshakeTimeoutMs ?? HANDSHAKE_TIMEOUT_MS;
  const readIsDark = deps?.isDark ?? (() => document.documentElement.classList.contains('dark'));

  const [activated, setActivated] = useState(false);
  const active = useSyncExternalStore(
    subscribeSlots,
    () => hasSlot(conversationKey, toolCallId),
  );

  // Claim a slot on mount (and whenever the user re-activates a collapsed
  // block). Releasing on unmount keeps the cap honest across conversation
  // switches.
  useEffect(() => {
    claimSlot(conversationKey, toolCallId);
    setActivated(true);
    return () => releaseSlot(conversationKey, toolCallId);
  }, [conversationKey, toolCallId]);

  const [status, setStatus] = useState<BlockStatus>('loading');
  const [resource, setResource] = useState<McpAppResource | undefined>(undefined);
  const [height, setHeight] = useState(120);

  const containerRef = useRef<HTMLDivElement | null>(null);
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const sessionRef = useRef<AppBridgeSession | null>(null);

  // ---- 1. Fetch the interface resource -------------------------------------
  useEffect(() => {
    if (!active) return;
    let cancelledEffect = false;
    setStatus('loading');
    setResource(undefined);

    if (!isConnected(server)) {
      setStatus('disconnected');
      return;
    }

    readResource(server, resourceUri)
      .then((res) => {
        if (cancelledEffect) return;
        if (!res.isMcpApp) {
          // A server may hand back plain HTML; without the MCP App profile we
          // will not run it in a bridge.
          setStatus('failed');
          return;
        }
        setResource(res);
        setStatus('ready');
      })
      .catch(() => {
        if (!cancelledEffect) setStatus('failed');
      });

    return () => { cancelledEffect = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, server, resourceUri]);

  const meta = (resource?.meta ?? undefined) as McpAppResourceMeta | undefined;
  const { csp } = useMemo(() => buildAppCsp(meta?.csp), [meta]);
  const srcdoc = useMemo(
    () => (resource ? buildAppSrcdoc(resource.text, csp) : undefined),
    [resource, csp],
  );
  // `domain` (a dedicated sandbox origin) and `permissions` (camera/mic/…) are
  // never honoured — surface that instead of silently ignoring it.
  const unsupportedMeta = Boolean(meta?.domain) || Boolean(meta?.permissions);

  // ---- 2. Bridge lifecycle -------------------------------------------------
  useEffect(() => {
    if (status !== 'ready' || !srcdoc) return;
    const frameWindow = frameRef.current?.contentWindow;
    if (!frameWindow) {
      setStatus('failed');
      return;
    }

    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const session = createSession({
      frameWindow,
      appVersion: APP_VERSION,
      hostContext: buildHostContext({
        isDark: readIsDark(),
        locale: getLocale(),
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        appVersion: APP_VERSION,
        containerDimensions: containerRef.current
          ? { width: containerRef.current.clientWidth, maxHeight: MAX_APP_IFRAME_HEIGHT }
          : undefined,
      }),
      onSizeChange: ({ height: h }) => {
        if (typeof h === 'number' && h > 0) setHeight(Math.min(h, MAX_APP_IFRAME_HEIGHT));
      },
      onInitialized: () => {
        if (timer) clearTimeout(timer);
      },
    });
    sessionRef.current = session;

    if (handshakeTimeoutMs > 0) {
      timer = setTimeout(() => {
        if (!disposed && !session.isInitialized()) setStatus('failed');
      }, handshakeTimeoutMs);
    }

    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
      sessionRef.current = null;
      void session.teardown();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, srcdoc]);

  // ---- 3. Tool lifecycle ---------------------------------------------------
  // The session buffers until the app reports `initialized`, so a fast tool
  // (resource resolved only after the step already ended) still gets
  // input-then-result in order.
  useEffect(() => {
    const session = sessionRef.current;
    if (!session) return;
    void session.sendToolInput(input);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, srcdoc]);

  useEffect(() => {
    const session = sessionRef.current;
    if (!session) return;
    if (cancelled) {
      void session.sendToolCancelled();
      return;
    }
    if (isExecuting || result === undefined) return;
    void session.sendToolResult(toCallToolResult(result, resultContent, isError));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, srcdoc, result, isExecuting, cancelled]);

  // ---- 4. Theme + container size -------------------------------------------
  useEffect(() => {
    if (status !== 'ready') return;
    const observer = new MutationObserver(() => {
      void sessionRef.current?.sendHostContextChange({ theme: readIsDark() ? 'dark' : 'light' });
    });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status]);

  useEffect(() => {
    const container = containerRef.current;
    if (status !== 'ready' || !container || typeof ResizeObserver === 'undefined') return;
    let frame: number | undefined;
    const observer = new ResizeObserver(() => {
      // rAF-debounced (never a timer) so a resize storm collapses into one
      // notification per painted frame.
      if (frame !== undefined) cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        frame = undefined;
        void sessionRef.current?.sendHostContextChange({
          containerDimensions: { width: container.clientWidth, maxHeight: MAX_APP_IFRAME_HEIGHT },
        });
      });
    });
    observer.observe(container);
    return () => {
      if (frame !== undefined) cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [status]);

  const activate = useCallback(() => {
    claimSlot(conversationKey, toolCallId);
  }, [conversationKey, toolCallId]);

  // ---- Render --------------------------------------------------------------

  if (!active && activated) {
    return (
      <div className="my-2" data-testid="mcp-app-block">
        <button
          type="button"
          onClick={activate}
          data-testid="mcp-app-placeholder"
          className="btn-ghost w-full rounded-lg border border-dashed border-[var(--abu-border-subtle)] px-3 py-2 text-minor text-[var(--abu-text-muted)] hover:text-[var(--abu-text-primary)]"
        >
          {t.chat.mcpAppLoadPlaceholder}
        </button>
      </div>
    );
  }

  if (status === 'disconnected') {
    return (
      <div className="my-2" data-testid="mcp-app-block">
        <div className="px-1 text-caption text-[var(--abu-text-muted)]" data-testid="mcp-app-status">
          {format(t.chat.mcpAppNotConnected, { server })}
        </div>
      </div>
    );
  }

  if (status === 'failed') {
    return (
      <div className="my-2" data-testid="mcp-app-block">
        <div className="px-1 text-caption text-[var(--abu-text-muted)]" data-testid="mcp-app-status">
          {t.chat.mcpAppLoadFailed}
        </div>
      </div>
    );
  }

  return (
    <div className="my-2" data-testid="mcp-app-block" ref={containerRef}>
      {unsupportedMeta && (
        <div className="mb-1 px-1 text-caption text-[var(--abu-text-muted)]" data-testid="mcp-app-unsupported">
          {t.chat.mcpAppUnsupportedMeta}
        </div>
      )}
      {status === 'loading' || !srcdoc ? (
        <div className="px-1 text-caption text-[var(--abu-text-muted)]" data-testid="mcp-app-status">
          {t.chat.mcpAppLoading}
        </div>
      ) : (
        <iframe
          ref={frameRef}
          data-testid="mcp-app-frame"
          title={`${server} · ${resourceUri}`}
          srcDoc={srcdoc}
          sandbox={APP_IFRAME_SANDBOX}
          allow=""
          referrerPolicy="no-referrer"
          className={cn(
            'block w-full rounded-lg',
            meta?.prefersBorder && 'border border-[var(--abu-border-subtle)]',
          )}
          style={{ height: `${height}px`, border: meta?.prefersBorder ? undefined : 'none' }}
        />
      )}
    </div>
  );
}
