import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown, ChevronRight, X } from 'lucide-react';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { useI18n, format } from '@/i18n';
import { cn } from '@/lib/utils';
import { APP_VERSION } from '@/utils/version';
import { getLocale } from '@/i18n';
import { mcpManager } from '@/core/mcp/client';
import { useMCPStore } from '@/stores/mcpStore';
import type { McpAppResource } from '@/core/mcp/appResources';
import {
  APP_IFRAME_SANDBOX,
  MAX_ACTIVE_MCP_APPS,
  MAX_APP_IFRAME_HEIGHT,
  buildAppCsp,
  buildAppSrcdoc,
  buildAppThemeContext,
  buildHostContext,
  type McpAppResourceMeta,
} from '@/core/mcp/appHost';
import { createAppBridgeSession, type AppBridgeSession } from '@/core/mcp/appBridgeSession';
import {
  appendAuditRow,
  createAppBridgeHandlers,
  MAX_AUDIT_SUMMARY_CHARS,
  type AppApprovalDecision,
  type McpAppAuditEntry,
} from '@/core/mcp/appBridgeHandlers';
import ConfirmDialog from '@/components/common/ConfirmDialog';
import type { ConfirmationInfo } from '@/core/tools/registry';
import type { RawCallToolResult } from '@/core/mcp/client';
import { useChatStore } from '@/stores/chatStore';
import { openWidgetLink } from './widgetLink';
import type { ToolDefinition, ToolResult, ToolResultContent } from '@/types';

/** Production handshake budget: the app has this long to answer `ui/initialize`
 *  and send `ui/notifications/initialized` before we give up and fall back to
 *  the plain tool result. Tests pass 0 to disable the timer entirely. */
const HANDSHAKE_TIMEOUT_MS = 10_000;

/** How many domains (rejected or accepted) the disclosure line names before it
 *  says "and more" — the note is one line under a tool card, not a report. */
const MAX_LISTED_DOMAINS = 3;

/** How much of an app-supplied URL the consent dialog prints. The rest is
 *  reachable through the element's `title`, so a long URL neither truncates
 *  away the part that matters nor turns the dialog into a wall of text. */
const MAX_SHOWN_LINK_CHARS = 512;

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
  /** Same-server tool lookup for the app bridge (model tools, then app-only). */
  findTool?: (server: string, tool: string) => ToolDefinition | undefined;
  /** The shared approval chain; see `defaultCheckApproval` below. */
  checkApproval?: (namespacedTool: string, args: Record<string, unknown>) => Promise<AppApprovalDecision>;
  callTool?: (server: string, tool: string, args: Record<string, unknown>) => Promise<ToolResult>;
  takeRawAppResult?: (server: string, tool: string, args: Record<string, unknown>) => RawCallToolResult | undefined;
  readServerResource?: (server: string, uri: string) => Promise<{ contents: Array<Record<string, unknown>> }>;
  listServerResources?: (server: string, cursor?: string) => Promise<{ resources: Array<Record<string, unknown>> }>;
  openLink?: (url: string) => void;
  appendComposerDraft?: (text: string) => void;
  persistModelContext?: (text: string) => void;
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
  /** Namespaced (`server__tool`) step name — the raw-result LRU key. */
  toolName?: string;
  /** Message that owns the step; needed to persist `modelContext`. */
  messageId?: string;
  /** Already-persisted `ui/update-model-context` text for this step. */
  modelContext?: string;
  deps?: McpAppBlockDeps;
}

// ---------------------------------------------------------------------------
// Default dependencies
// ---------------------------------------------------------------------------

/**
 * Run an app-initiated call through the SAME approval chain a model-initiated
 * call of that tool goes through — `checkToolApproval` (registry.ts), the single
 * source of truth the sidecar's `approval.check` also calls. Passing the
 * NAMESPACED name means the plugin / browser / self-extension / enterprise-policy
 * classifiers all see exactly what they would see for a model call, so an app
 * call is never classified more leniently than the model path.
 *
 * The confirmation goes through `requestCommandConfirmationForConversation`
 * rather than the loop-bound `requestCommandConfirmation`: an interface is not
 * running inside an agent loop, so there is no loopId to resolve a conversation
 * from and the dialog would be filed against the wrong conversation (and then
 * hidden by ChatView's active-conversation filter).
 *
 * Imported lazily so the chat bundle does not pull registry.ts's whole graph in
 * at module-evaluation time.
 */
let approvalSeq = 0;

async function defaultCheckApproval(
  namespacedTool: string,
  args: Record<string, unknown>,
  conversationId: string | undefined,
  /** This block's outstanding confirmations, as cancel thunks. The bridge
   *  effect's cleanup runs every one of them. */
  pendingCancels: Set<() => void>,
): Promise<AppApprovalDecision> {
  const [{ checkToolApproval }, permissionBridge] = await Promise.all([
    import('@/core/tools/registry'),
    import('@/core/agent/permissionBridge'),
  ]);

  // 🔴 Fail closed without a conversation. The dialog is addressed BY
  // conversation (ChatView renders only `conversationId === activeConvId`), so
  // a block with no conversation could enqueue a confirmation nobody can ever
  // see — and because the command queue is single-active + FIFO, that one
  // unanswerable entry would then block every later confirmation in every
  // conversation. Passing no callback at all reuses `checkToolApproval`'s own
  // "confirmation is unavailable for this run" denial instead of enqueueing.
  const onRequireConfirmation = conversationId
    ? async (info: ConfirmationInfo): Promise<boolean> => {
        const requestId = `mcp-app-approval-${++approvalSeq}`;
        const cancel = () => permissionBridge.cancelCommandConfirmation(requestId);
        pendingCancels.add(cancel);
        try {
          return await permissionBridge.requestCommandConfirmationForConversation(
            info,
            conversationId,
            requestId,
          );
        } finally {
          pendingCancels.delete(cancel);
        }
      }
    : undefined;

  return checkToolApproval(namespacedTool, args, { conversationId }, onRequireConfirmation);
}

/** Strip the `<server>__` prefix a step name carries; app calls use bare names. */
function bareToolName(server: string, toolName: string | undefined): string | undefined {
  if (!toolName) return undefined;
  const prefix = `${server}__`;
  return toolName.startsWith(prefix) ? toolName.slice(prefix.length) : toolName;
}

/** Arguments are app-supplied and unbounded; the row is a disclosure, not a
 *  log viewer, so it gets the same ceiling as the result summary. */
function formatAuditArgs(args: Record<string, unknown>): string {
  let text: string;
  try {
    text = JSON.stringify(args, null, 2) ?? '';
  } catch {
    text = String(args);
  }
  return text.length > MAX_AUDIT_SUMMARY_CHARS
    ? `${text.slice(0, MAX_AUDIT_SUMMARY_CHARS)}…`
    : text;
}

/** One collapsed audit row: what the interface asked its server to do. */
function AuditRow({ entry, label, argsLabel, resultLabel, resultText }: {
  entry: McpAppAuditEntry;
  label: string;
  argsLabel: string;
  resultLabel: string;
  resultText: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div data-testid="mcp-app-audit-row" className="px-1">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-1 text-left text-caption text-[var(--abu-text-muted)] hover:text-[var(--abu-text-primary)]"
      >
        {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
        <span className={cn(entry.isError && 'text-[var(--abu-danger)]')}>{label}</span>
      </button>
      {open && (
        <div className="mt-1 space-y-1 pl-4 text-caption text-[var(--abu-text-muted)]">
          <div>
            <div className="font-medium">{argsLabel}</div>
            <pre className="whitespace-pre-wrap break-all">{formatAuditArgs(entry.args)}</pre>
          </div>
          <div>
            <div className="font-medium">{resultLabel}</div>
            <pre className="whitespace-pre-wrap break-all">{resultText}</pre>
          </div>
        </div>
      )}
    </div>
  );
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
  toolName,
  messageId,
  modelContext,
  deps,
}: McpAppBlockProps) {
  const { t } = useI18n();
  const conversationKey = conversationId ?? '__no-conversation__';

  const readResource = deps?.readResource ?? ((s: string, u: string) => mcpManager.readResource(s, u));
  const isConnected = deps?.isConnected ?? ((s: string) => mcpManager.isConnected(s));
  const createSession = deps?.createSession ?? createAppBridgeSession;
  const handshakeTimeoutMs = deps?.handshakeTimeoutMs ?? HANDSHAKE_TIMEOUT_MS;
  const readIsDark = deps?.isDark ?? (() => document.documentElement.classList.contains('dark'));
  const findTool = deps?.findTool ?? ((s: string, tool: string) =>
    mcpManager.getServerTools(s).find((d) => d.name === `${s}__${tool}`)
    ?? mcpManager.getAppTool(s, tool));
  // Cancel thunks for confirmations this block is still waiting on. Cleared by
  // the bridge effect's cleanup so an approval never outlives its iframe.
  const pendingApprovalCancelsRef = useRef(new Set<() => void>());
  const checkApproval = deps?.checkApproval
    ?? ((name: string, args: Record<string, unknown>) =>
      defaultCheckApproval(name, args, conversationId, pendingApprovalCancelsRef.current));
  const callToolDep = deps?.callTool
    ?? ((s: string, tool: string, args: Record<string, unknown>) =>
      mcpManager.callTool(s, tool, args, { viaAppBridge: true }));
  const takeRawAppResult = deps?.takeRawAppResult
    ?? ((s: string, tool: string, args: Record<string, unknown>) => mcpManager.takeRawAppResult(s, tool, args));
  const readServerResource = deps?.readServerResource
    ?? ((s: string, uri: string) => mcpManager.readServerResource(s, uri));
  const listServerResources = deps?.listServerResources
    ?? ((s: string, cursor?: string) => mcpManager.listServerResources(s, cursor));
  const openLink = deps?.openLink ?? openWidgetLink;
  const appendComposerDraft = deps?.appendComposerDraft
    ?? ((text: string) => useChatStore.getState().appendPendingInput(text));
  const persistModelContext = deps?.persistModelContext ?? ((text: string) => {
    if (!conversationId || !messageId) return;
    useChatStore.getState().setToolCallModelContext(conversationId, messageId, toolCallId, text);
  });

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
  const [displayMode, setDisplayMode] = useState<'inline' | 'fullscreen'>('inline');
  const [audit, setAudit] = useState<McpAppAuditEntry[]>([]);
  const [rateLimited, setRateLimited] = useState(false);
  const [contextOpen, setContextOpen] = useState(false);
  /** URL awaiting the user's answer in the `ui/open-link` consent dialog. */
  const [pendingLink, setPendingLink] = useState<string | null>(null);
  const pendingLinkResolveRef = useRef<((allowed: boolean) => void) | null>(null);
  // Local echo of `ui/update-model-context` so the expander updates even when
  // the block has no message to persist against (replay-only mounts).
  const [liveModelContext, setLiveModelContext] = useState<string | undefined>(undefined);
  const shownModelContext = liveModelContext ?? modelContext;

  // Live connection state (spec §4.4: a server that goes away must take its
  // interface with it). A server the store has never heard of says nothing —
  // only an explicit non-connected status counts as a disconnect, so the
  // `isConnected` seam stays authoritative everywhere else.
  const serverStatus = useMCPStore((s) => s.servers[server]?.status);
  const storeDisconnected = serverStatus !== undefined && serverStatus !== 'connected';

  const containerRef = useRef<HTMLDivElement | null>(null);
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  /**
   * 🔴 Fullscreen hostage guard (policy in `appBridgeHandlers`, evidence here).
   * `lastUserGestureAt` is the last pointerdown/keydown the HOST saw inside this
   * block — a gesture inside the sandboxed iframe never crosses the document
   * boundary, so this is all the host can honestly know. `lastUserExitAt` is set
   * ONLY when the user left fullscreen themselves; an app-driven return to
   * inline must not look like the user saying no.
   */
  const lastUserGestureAtRef = useRef<number | undefined>(undefined);
  const lastUserExitAtRef = useRef<number | undefined>(undefined);
  const noteUserGesture = useCallback(() => {
    lastUserGestureAtRef.current = Date.now();
  }, []);
  const sessionRef = useRef<AppBridgeSession | null>(null);
  /** Raw server result for THIS step, taken from the LRU at most once. */
  const rawResultRef = useRef<{ key: string; value: RawCallToolResult | undefined } | null>(null);

  // The bridge effect only re-runs on active/status/srcdoc, so the handlers it
  // builds would otherwise close over the props of that one render. Keep the
  // injectable seams in a ref that every render refreshes and read them at call
  // time instead.
  const handlerDepsRef = useRef({
    findTool, checkApproval, callToolDep, takeRawAppResult,
    readServerResource, listServerResources, openLink,
    appendComposerDraft, persistModelContext, readResource,
  });
  // Refreshed AFTER each render (never during it — a ref write in the render
  // body is a React anti-pattern). The handlers only read this at call time,
  // which is always after a commit, and the `useRef` initializer already holds
  // the first render's values, so the bridge effect never sees an empty ref.
  useEffect(() => {
    handlerDepsRef.current = {
      findTool, checkApproval, callToolDep, takeRawAppResult,
      readServerResource, listServerResources, openLink,
      appendComposerDraft, persistModelContext, readResource,
    };
  });

  /**
   * The consent gate for `ui/open-link`. Resolves `true` only after the user
   * says yes; the URL reaches `openWidgetLink` (and therefore the system
   * browser) at that point and not one moment earlier.
   *
   * One prompt at a time: a second request while one is open is declined
   * outright rather than queued, so an app cannot stack dialogs to wear the
   * user down or to hide which URL it is actually asking about.
   */
  const requestOpenLink = useCallback((url: string) => new Promise<boolean>((resolve) => {
    if (pendingLinkResolveRef.current) {
      resolve(false);
      return;
    }
    pendingLinkResolveRef.current = resolve;
    setPendingLink(url);
  }), []);

  const settleOpenLink = useCallback((allowed: boolean, url: string | null) => {
    const resolve = pendingLinkResolveRef.current;
    pendingLinkResolveRef.current = null;
    setPendingLink(null);
    if (allowed && url) handlerDepsRef.current.openLink(url);
    resolve?.(allowed);
  }, []);

  // ---- 1. Fetch the interface resource -------------------------------------
  useEffect(() => {
    if (!active) return;
    let cancelledEffect = false;
    setStatus('loading');
    setResource(undefined);

    if (storeDisconnected || !isConnected(server)) {
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
  }, [active, server, resourceUri, storeDisconnected]);

  const meta = (resource?.meta ?? undefined) as McpAppResourceMeta | undefined;
  const { csp, rejected, accepted } = useMemo(() => buildAppCsp(meta?.csp), [meta]);
  const srcdoc = useMemo(
    () => (resource ? buildAppSrcdoc(resource.text, csp) : undefined),
    [resource, csp],
  );
  // `domain` (a dedicated sandbox origin) and `permissions` (camera/mic/…) are
  // never honoured — surface that instead of silently ignoring it.
  const unsupportedMeta = Boolean(meta?.domain) || Boolean(meta?.permissions);
  // Same idea for domains `buildAppCsp` threw away: the app will fail to reach
  // them at runtime, so say which ones rather than leaving a silent CSP block.
  const listDomains = useCallback((domains: string[]) => {
    const shown = domains.slice(0, MAX_LISTED_DOMAINS).join(', ');
    return domains.length > MAX_LISTED_DOMAINS
      ? `${shown}${t.chat.mcpAppIgnoredDomainsMore}`
      : shown;
  }, [t]);
  const ignoredDomains = useMemo(() => (
    rejected.length === 0
      ? undefined
      : format(t.chat.mcpAppIgnoredDomains, { domains: listDomains(rejected) })
  ), [rejected, listDomains, t]);
  // The accepted origins are disclosed too: `connect-src` may be `'none'`, but
  // an allowed `img-src` origin still carries whatever the app puts in a URL,
  // so "this interface may reach a, b" is part of what the user is agreeing to
  // by leaving it running — not an implementation detail of the CSP.
  const allowedDomains = useMemo(() => (
    accepted.length === 0
      ? undefined
      : format(t.chat.mcpAppAllowedDomains, { domains: listDomains(accepted) })
  ), [accepted, listDomains, t]);
  const disclosure = [
    unsupportedMeta ? t.chat.mcpAppUnsupportedMeta : undefined,
    ignoredDomains,
    allowedDomains,
  ]
    .filter((part): part is string => Boolean(part))
    .join(' · ');

  // ---- 2. Bridge lifecycle -------------------------------------------------
  // `active` is a dependency, not just a guard: losing the LRU slot unmounts
  // the iframe, so the session must run the same teardown as an unmount (kill
  // the handshake timer, tell the app, close the transport) instead of holding
  // a bridge onto a window that no longer exists.
  useEffect(() => {
    if (!active || status !== 'ready' || !srcdoc) return;
    const frame = frameRef.current;
    const frameWindow = frame?.contentWindow;
    if (!frame || !frameWindow) {
      setStatus('failed');
      return;
    }

    // 🔴 A new session needs a new document. The app's `ui/initialize` retry
    // loop stops for good once the first handshake lands, so a bridge rebuilt
    // over a document that is still running (StrictMode's double-invoke, a
    // `status` flicker back through 'loading', a theme/srcdoc churn) would wait
    // for a handshake that can never arrive — the app goes silently deaf and
    // its own requests get no answer. Assigning `srcdoc` re-navigates the frame
    // even when the value is byte-identical, which is exactly the property
    // wanted here. Nothing is lost in the gap: the session buffers
    // `tool-input`/`tool-result` until the app reports `initialized`.
    frame.srcdoc = srcdoc;

    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    // Policy lives in `appBridgeHandlers` (pure, separately tested); this only
    // binds it to this block's server, store writes and UI state.
    const handlers = createAppBridgeHandlers({
      server,
      findTool: (tool) => handlerDepsRef.current.findTool(server, tool),
      checkApproval: (namespaced, args) => handlerDepsRef.current.checkApproval(namespaced, args),
      callTool: async (tool, args) => {
        const converted = await handlerDepsRef.current.callToolDep(server, tool, args);
        // Prefer what the server actually returned (structuredContent/_meta
        // survive only there) — see the raw-result LRU in client.ts.
        const raw = handlerDepsRef.current.takeRawAppResult(server, tool, args);
        if (raw) return raw as CallToolResult;
        return typeof converted === 'string'
          ? toCallToolResult(converted, undefined, false)
          : toCallToolResult(undefined, converted, false);
      },
      readAppResource: async (uri) => {
        const res = await handlerDepsRef.current.readResource(server, uri);
        return { mimeType: res.mimeType, text: res.text };
      },
      readServerResource: async (uri) => {
        const res = await handlerDepsRef.current.readServerResource(server, uri);
        return res as unknown as Awaited<ReturnType<typeof handlers.onreadresource>>;
      },
      listResources: async (cursor) => {
        const res = await handlerDepsRef.current.listServerResources(server, cursor);
        return res as unknown as Awaited<ReturnType<typeof handlers.onlistresources>>;
      },
      requestOpenLink,
      appendComposerDraft: (text) => handlerDepsRef.current.appendComposerDraft(text),
      // Live value first (the expander must not lag the app), persistence
      // second — coalesced inside the handler factory.
      setModelContext: (text) => setLiveModelContext(text),
      persistModelContext: (text) => handlerDepsRef.current.persistModelContext(text),
      setDisplayMode: (mode) => setDisplayMode(mode),
      lastUserGestureAt: () => lastUserGestureAtRef.current,
      lastUserExitAt: () => lastUserExitAtRef.current,
      // Per-kind caps (see `appendAuditRow`): a resource-read storm must not
      // be able to push the tool-call rows out of the trail.
      onAudit: (entry) => setAudit((prev) => appendAuditRow(prev, entry)),
      onRateLimited: () => setRateLimited(true),
    });

    const session = createSession({
      frameWindow,
      appVersion: APP_VERSION,
      handlers,
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
      // 🔴 Nothing this block asked for may outlive it. A confirmation left in
      // the single-active command queue would block every later confirmation in
      // every conversation behind a dialog for an iframe that is gone; an
      // unanswered link prompt would leave the app's promise pending forever.
      // Both settle as "denied", which the handler turns into a JSON-RPC error.
      const cancels = pendingApprovalCancelsRef.current;
      pendingApprovalCancelsRef.current = new Set();
      cancels.forEach((cancel) => cancel());
      if (pendingLinkResolveRef.current) {
        const resolve = pendingLinkResolveRef.current;
        pendingLinkResolveRef.current = null;
        setPendingLink(null);
        resolve(false);
      }
      // Flush the last model-context write instead of dropping it on the floor.
      handlers.dispose();
      void session.teardown();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, status, srcdoc]);

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
    // The LRU hands a raw result over exactly once, so remember what we took:
    // this effect re-runs whenever the bridge is rebuilt (srcdoc/theme churn)
    // and must replay the same payload rather than silently downgrading to the
    // converted one. After a conversation reload the LRU is empty by design —
    // it is per-process — so replay falls back to the converted content and an
    // app that reads `structuredContent` sees nothing there.
    const bare = bareToolName(server, toolName);
    const key = `${bare ?? ''}|${result}`;
    if (bare && rawResultRef.current?.key !== key) {
      rawResultRef.current = { key, value: takeRawAppResult(server, bare, input) };
    }
    const raw = rawResultRef.current?.key === key ? rawResultRef.current.value : undefined;
    void session.sendToolResult(raw ? (raw as CallToolResult) : toCallToolResult(result, resultContent, isError));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, srcdoc, result, isExecuting, cancelled]);

  // ---- 3b. Display mode ----------------------------------------------------
  // Tell the app which mode it ended up in — both on the way into fullscreen
  // and on the way back — so a view that lays itself out per mode can react.
  //
  // No palette here on purpose: Abu's colours do not depend on the display
  // mode, so re-sending them would be noise. Only a patch that changes the
  // THEME has to carry `styles.variables` (see the MutationObserver below).
  useEffect(() => {
    void sessionRef.current?.sendHostContextChange({ displayMode });
  }, [displayMode]);

  /** Every USER-initiated way out of fullscreen. Recording the moment is what
   *  stops the app from dragging the user straight back in. */
  const exitFullscreen = useCallback(() => {
    lastUserExitAtRef.current = Date.now();
    setDisplayMode('inline');
  }, []);

  // Esc leaves fullscreen: the iframe is sandboxed and cannot offer a host
  // control of its own, so the host must always provide a way out.
  //
  // ⚠️ SPEC LIMITATION: this listener is on the HOST window, and a keydown that
  // happens while focus is inside the sandboxed iframe never crosses the
  // document boundary — so Escape does nothing once the user has clicked into
  // the app. The visible close button (and the backdrop) are the guaranteed
  // exits; Escape is a convenience for when focus is still on the host side.
  useEffect(() => {
    if (displayMode !== 'fullscreen') return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') exitFullscreen();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [displayMode, exitFullscreen]);

  // ---- 4. Theme + container size -------------------------------------------
  useEffect(() => {
    if (!active || status !== 'ready') return;
    const observer = new MutationObserver(() => {
      // Theme AND palette, never one without the other: the iframe is not
      // re-navigated here (`srcdoc` does not depend on the theme), so this
      // patch is the app's only chance to learn the new colours. Sending the
      // bare theme name leaves an app that adopted `styles.variables` at
      // handshake time painting the previous theme — see
      // `buildAppThemeContext`.
      void sessionRef.current?.sendHostContextChange(buildAppThemeContext(readIsDark()));
    });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, status]);

  useEffect(() => {
    const container = containerRef.current;
    if (!active || status !== 'ready' || !container || typeof ResizeObserver === 'undefined') return;
    let frame: number | undefined;
    const observer = new ResizeObserver(() => {
      // rAF-debounced (never a timer) so a resize storm collapses into one
      // notification per painted frame.
      if (frame !== undefined) cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        frame = undefined;
        // Size only — a resize changes no colour, and a palette on every
        // frame of a drag would be pure traffic.
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
  }, [active, status]);

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

  const fullscreen = displayMode === 'fullscreen';

  /** Localized text for a refused/consented attempt; `undefined` for a plain
   *  executed tool call, whose row shows the result summary instead. */
  const outcomeLabel = (entry: McpAppAuditEntry): string | undefined => {
    switch (entry.outcome) {
      case 'opened': return t.chat.mcpAppOutcomeOpened;
      case 'declined': return t.chat.mcpAppOutcomeDeclined;
      case 'rate-limited': return t.chat.mcpAppRateLimited;
      case 'rejected-scheme':
      case 'too-long':
      case 'denied': return t.chat.mcpAppOutcomeRejected;
      default: return undefined;
    }
  };

  // Fullscreen is a CSS promotion of the very same element tree — the iframe
  // keeps its position in the JSX children array, so React never unmounts it
  // and the bridge (and the app's own state) survive. Reparenting the iframe
  // into a portal container would look tidier but discards the nested browsing
  // context, i.e. reloads the app; see the spec's "不重建，保状态".
  return (
    <>
      {fullscreen && createPortal(
        <div
          data-testid="mcp-app-fullscreen-backdrop"
          // Fullscreen paints over the window chrome; without this the top 72px
          // band is an OS drag lane on Windows and swallows the click that is
          // supposed to close the overlay.
          data-electron-no-drag
          className="fixed inset-0 z-40 bg-black/60"
          onClick={exitFullscreen}
        />,
        document.body,
      )}
      {/* In fullscreen the frame container covers the viewport, so it would sit
          ON TOP of the backdrop and swallow every click meant for it. It is
          therefore click-through (`pointer-events-none`) and each real control
          — the close button and the iframe itself — opts back in. That leaves
          the padding around the app as backdrop, which is what makes
          click-outside-to-close work at all. */}
      <div
        className={cn(
          'my-2',
          fullscreen && 'pointer-events-none fixed inset-0 z-50 my-0 flex flex-col gap-2 p-6 [&>*]:pointer-events-auto',
        )}
        data-electron-no-drag
        data-testid="mcp-app-block"
        data-display-mode={displayMode}
        ref={containerRef}
        // Capture phase, so a control that stops propagation still counts: this
        // is evidence for the fullscreen gate, not an interaction of its own.
        onPointerDownCapture={noteUserGesture}
        onKeyDownCapture={noteUserGesture}
      >
        {fullscreen && (
          <div className="flex justify-end" data-testid="mcp-app-fullscreen">
            <button
              type="button"
              onClick={exitFullscreen}
              data-testid="mcp-app-fullscreen-exit"
              aria-label={t.chat.mcpAppExitFullscreen}
              title={t.chat.mcpAppExitFullscreen}
              className="btn-ghost rounded-full p-1.5"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        )}
        {disclosure && (
          <div className="mb-1 px-1 text-caption text-[var(--abu-text-muted)]" data-testid="mcp-app-unsupported">
            {disclosure}
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
              fullscreen && 'min-h-0 flex-1 bg-[var(--abu-bg-primary)]',
              meta?.prefersBorder && 'border border-[var(--abu-border-subtle)]',
            )}
            style={{
              height: fullscreen ? undefined : `${height}px`,
              border: meta?.prefersBorder ? undefined : 'none',
            }}
          />
        )}
        {rateLimited && (
          <div className="px-1 text-caption text-[var(--abu-text-muted)]" data-testid="mcp-app-rate-limited">
            {t.chat.mcpAppRateLimited}
          </div>
        )}
        {/* Audit trail — every tool call the interface made on the user's
            behalf, collapsed by default (spec §4.3). */}
        {audit.map((entry) => (
          <AuditRow
            key={entry.id}
            entry={entry}
            label={entry.kind === 'open-link'
              ? t.chat.mcpAppAuditOpenLink
              : format(t.chat.mcpAppAuditRow, { tool: entry.tool })}
            argsLabel={t.chat.mcpAppAuditArgs}
            resultLabel={t.chat.mcpAppAuditResult}
            resultText={outcomeLabel(entry) ?? entry.summary}
          />
        ))}
        {/* What the interface told the model behind the user's back
            (`ui/update-model-context`) — visible on demand, spec §4.5. */}
        {shownModelContext && (
          <div className="px-1" data-testid="mcp-app-context">
            <button
              type="button"
              onClick={() => setContextOpen((v) => !v)}
              className="flex w-full items-center gap-1 text-left text-caption text-[var(--abu-text-muted)] hover:text-[var(--abu-text-primary)]"
            >
              {contextOpen ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
              {t.chat.mcpAppModelContext}
            </button>
            {contextOpen && (
              <pre className="mt-1 whitespace-pre-wrap break-all pl-4 text-caption text-[var(--abu-text-muted)]">
                {shownModelContext}
              </pre>
            )}
          </div>
        )}
      </div>
      {/* Consent for an app-initiated `ui/open-link`. The URL is shown verbatim
          (monospace, wrapped) because it is the thing being consented to — a
          prettified or shortened URL would hide exactly the query string an
          exfiltration attempt lives in. */}
      <ConfirmDialog
        open={pendingLink !== null}
        title={t.chat.mcpAppOpenLinkTitle}
        message={(
          <span
            data-testid="mcp-app-open-link-url"
            title={pendingLink ?? undefined}
            className="block break-all font-mono"
          >
            {pendingLink && pendingLink.length > MAX_SHOWN_LINK_CHARS
              ? `${pendingLink.slice(0, MAX_SHOWN_LINK_CHARS)}…`
              : pendingLink}
          </span>
        )}
        confirmText={t.chat.mcpAppOpenLinkConfirm}
        cancelText={t.common.cancel}
        onConfirm={() => settleOpenLink(true, pendingLink)}
        onCancel={() => settleOpenLink(false, pendingLink)}
      />
    </>
  );
}
