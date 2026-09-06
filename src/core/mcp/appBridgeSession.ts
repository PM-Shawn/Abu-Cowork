/**
 * One MCP App bridge, bound to one iframe (spec §4.3).
 *
 * Owns the `AppBridge` + `PostMessageTransport` lifecycle: connect → answer
 * `ui/initialize` → wait for `ui/notifications/initialized` → push
 * tool-input / tool-result / tool-cancelled / host-context-changed → tear the
 * resource down and close the transport.
 *
 * EVERY request handler is default-deny unless the caller hands one in through
 * `options.handlers` (built by `appBridgeHandlers.ts`, which owns same-server
 * scoping, schema validation, the shared permission gate, the rate limit and
 * the byte caps). A handler the caller does not supply keeps answering with a
 * JSON-RPC error — an app that could reach `tools/call` without that policy
 * layer would be an unreviewed execution path, so the fail-closed default
 * survives. `ping` is always honoured (the SDK answers it itself).
 *
 * Host capabilities are derived from the handlers actually supplied, so a
 * well-behaved app never attempts a method this session would refuse.
 */
import { AppBridge, PostMessageTransport } from '@modelcontextprotocol/ext-apps/app-bridge';
import type {
  McpUiHostCapabilities,
  McpUiHostContext,
  McpUiSizeChangedNotification,
} from '@modelcontextprotocol/ext-apps/app-bridge';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { AppBridgeHandlers } from './appBridgeHandlers';

/** JSON-RPC `MethodNotFound`. Protocol copies a numeric `code` straight into
 *  the error response, so this reaches the app as a proper -32601. */
const METHOD_NOT_FOUND = -32601;

/** How long the app gets to acknowledge `ui/resource-teardown` before its
 *  pending request is dropped. Teardown never blocks on it (see `teardown`). */
const TEARDOWN_TIMEOUT_MS = 2000;

class AppBridgeDeniedError extends Error {
  readonly code = METHOD_NOT_FOUND;
  constructor(method: string) {
    super(`${method} is not supported yet`);
    this.name = 'AppBridgeDeniedError';
  }
}

export interface AppBridgeSessionOptions {
  /** The app iframe's `contentWindow` — both the post target and the only
   *  accepted message source. */
  frameWindow: Window;
  /** Host context handed to the app at `ui/initialize`. */
  hostContext: McpUiHostContext;
  /** Abu's version, reported as the host implementation version. */
  appVersion: string;
  onSizeChange?: (params: McpUiSizeChangedNotification['params']) => void;
  onInitialized?: () => void;
  /** The app asked the host to tear it down (`ui/notifications/request-teardown`). */
  onRequestTeardown?: () => void;
  onError?: (error: Error) => void;
  /**
   * Request handlers that replace the default-deny ones. Anything omitted stays
   * denied; anything supplied is also advertised in `hostCapabilities`.
   */
  handlers?: Partial<AppBridgeHandlers>;
}

export interface AppBridgeSession {
  /** The underlying SDK bridge (handlers already wired — see `options.handlers`). */
  readonly bridge: AppBridge;
  isInitialized(): boolean;
  /** Resolves `true` once the app sent `ui/notifications/initialized`, or
   *  `false` if the session was torn down first. Never rejects. */
  whenInitialized(): Promise<boolean>;
  sendToolInput(args?: Record<string, unknown>): Promise<void>;
  sendToolResult(result: CallToolResult): Promise<void>;
  sendToolCancelled(reason?: string): Promise<void>;
  sendHostContextChange(patch: Partial<McpUiHostContext>): Promise<void>;
  /** Idempotent. Tells the app to tear down, then closes the transport (which
   *  removes the window message listener — spec §4.5 "拆除路径不泄漏 listener"). */
  teardown(): Promise<void>;
}

const HOST_INFO = { name: 'Abu' } as const;

/**
 * Advertise exactly what this session can actually answer. `downloadFile` is
 * never advertised (still denied); `sandbox` is not advertised because Abu
 * grants no device permissions and rewrites the CSP itself.
 */
function capabilitiesFor(handlers: Partial<AppBridgeHandlers> | undefined): McpUiHostCapabilities {
  if (!handlers) return {};
  return {
    ...(handlers.oncalltool ? { serverTools: {} } : {}),
    ...(handlers.onreadresource || handlers.onlistresources ? { serverResources: {} } : {}),
    ...(handlers.onopenlink ? { openLinks: {} } : {}),
    ...(handlers.onmessage ? { message: { text: {} } } : {}),
    ...(handlers.onupdatemodelcontext ? { updateModelContext: { text: {} } } : {}),
  };
}

export function createAppBridgeSession(options: AppBridgeSessionOptions): AppBridgeSession {
  const bridge = new AppBridge(
    // No MCP client: automatic server forwarding would bypass Abu's permission
    // gate entirely (the SDK would proxy straight to the server). Every handler
    // stays host-owned so `appBridgeHandlers.ts` is the only way in.
    null,
    { ...HOST_INFO, version: options.appVersion },
    capabilitiesFor(options.handlers),
    { hostContext: options.hostContext },
  );

  let initialized = false;
  let closed = false;
  let settleInitialized: (ok: boolean) => void = () => {};
  const initializedPromise = new Promise<boolean>((resolve) => {
    settleInitialized = resolve;
  });

  const deny = (method: string) => async (): Promise<never> => {
    throw new AppBridgeDeniedError(method);
  };

  bridge.oncalltool = deny('tools/call');
  bridge.onreadresource = deny('resources/read');
  bridge.onlistresources = deny('resources/list');
  bridge.onlistresourcetemplates = deny('resources/templates/list');
  bridge.onlistprompts = deny('prompts/list');
  bridge.onopenlink = deny('ui/open-link');
  bridge.ondownloadfile = deny('ui/download-file');
  bridge.onmessage = deny('ui/message');
  bridge.onupdatemodelcontext = deny('ui/update-model-context');
  bridge.onrequestdisplaymode = deny('ui/request-display-mode');

  // Anything supplied overrides its deny; anything else stays fail-closed.
  const handlers = options.handlers;
  if (handlers?.oncalltool) bridge.oncalltool = handlers.oncalltool;
  if (handlers?.onreadresource) bridge.onreadresource = handlers.onreadresource;
  if (handlers?.onlistresources) bridge.onlistresources = handlers.onlistresources;
  if (handlers?.onopenlink) bridge.onopenlink = handlers.onopenlink;
  if (handlers?.onmessage) bridge.onmessage = handlers.onmessage;
  if (handlers?.onupdatemodelcontext) bridge.onupdatemodelcontext = handlers.onupdatemodelcontext;
  if (handlers?.onrequestdisplaymode) bridge.onrequestdisplaymode = handlers.onrequestdisplaymode;

  bridge.oninitialized = () => {
    initialized = true;
    settleInitialized(true);
    options.onInitialized?.();
  };
  if (options.onSizeChange) bridge.onsizechange = options.onSizeChange;
  bridge.onrequestteardown = () => options.onRequestTeardown?.();

  const transport = new PostMessageTransport(
    options.frameWindow,
    options.frameWindow as unknown as MessageEventSource,
  );
  transport.onerror = (error) => options.onError?.(error);

  // Protocol.connect only awaits transport.start(), which just registers the
  // window listener — but connect() is async, so hold the promise and let every
  // send await it. That removes the "app answered before we finished
  // connecting" race without making the caller await a second thing.
  const connected = bridge.connect(transport).catch((error: unknown) => {
    options.onError?.(error instanceof Error ? error : new Error(String(error)));
  });

  /** Gate every host→app notification on "connected AND the app said it is
   *  ready", so nothing is posted into a view that cannot receive it. */
  async function ready(): Promise<boolean> {
    await connected;
    if (closed) return false;
    return initializedPromise;
  }

  async function guarded(send: () => Promise<void>): Promise<void> {
    if (!(await ready())) return;
    try {
      await send();
    } catch (error) {
      options.onError?.(error instanceof Error ? error : new Error(String(error)));
    }
  }

  return {
    bridge,
    isInitialized: () => initialized,
    whenInitialized: () => initializedPromise,
    sendToolInput: (args) => guarded(() => bridge.sendToolInput({ arguments: args })),
    sendToolResult: (result) => guarded(() => bridge.sendToolResult(result)),
    sendToolCancelled: (reason) =>
      guarded(() => bridge.sendToolCancelled(reason === undefined ? {} : { reason })),
    sendHostContextChange: (patch) =>
      guarded(async () => {
        await bridge.sendHostContextChange(patch as McpUiHostContext);
      }),
    async teardown() {
      if (closed) return;
      closed = true;
      // Release anything waiting on initialization so no send hangs forever.
      settleInitialized(false);
      await connected;
      try {
        // Fire-and-forget on purpose: `Protocol.request` posts synchronously,
        // so the app is told, but a crashed view must not keep the listener
        // (and this promise) alive. `close()` below clears the pending timeout.
        void bridge
          .teardownResource({}, { timeout: TEARDOWN_TIMEOUT_MS })
          .catch(() => { /* the view may already be gone */ });
      } catch { /* already closed */ }
      try {
        await bridge.close();
      } catch (error) {
        options.onError?.(error instanceof Error ? error : new Error(String(error)));
      }
    },
  };
}
