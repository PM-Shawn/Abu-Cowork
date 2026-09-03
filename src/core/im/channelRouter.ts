/**
 * IMChannelRouter — Core integration for Phase 2 IM independent channel
 *
 * Flow: InboundMessage → AuthGate → SessionMapper → agentLoop → StreamingReply
 *
 * This router handles IM messages that target channels (not triggers).
 * It is registered as a listener on the 'im-inbound-event' Tauri event,
 * alongside the trigger engine's own IM listener.
 */

import { useIMChannelStore } from '../../stores/imChannelStore';
import { useChatStore } from '../../stores/chatStore';
import { runAgentLoopDispatched } from '../agent/agentLoopRunner';
import { buildIMRunPermissionCeiling } from '../permissions/runPermissionCeiling';
import { createAuthorizationScope, disposeAuthorizationScope, scopedAuthorizeWorkspace } from '../tools/pathSafety';
import type { NormalizedIMMessage } from './inboundRouter';
import { resolveCapability, getCallbacksForLevel, getBlockedToolsForLevel, getAllowedToolsForLevel } from './authGate';
import { cancelAllIMConfirmations, parseIMConfirmationReply, requestIMConfirmation } from './confirmationRelay';
import { sessionMapper } from './sessionMapper';
import { sendThinking, sendFinal, addProcessingReaction } from './streamingReply';
import type { AbuMessage } from './adapters/types';
import type { IMChannel, IMCapabilityLevel } from '../../types/imChannel';
import { tokenManager } from './tokenManager';
import { consumeTriggerContext } from './triggerContextCache';
import { getI18n, format } from '../../i18n';
import { createLogger } from '../logging/logger';
import type { IMAdapter } from './adapters/types';
import { redactText } from '../session/shareRedactor';

const MAX_CONCURRENT_IM = 5;
const WECHAT_TYPING_REFRESH_MS = 5_000;
const WECHAT_TYPING_REQUEST_TIMEOUT_MS = 4_000;
const imChannelLog = createLogger('im-channel');
/**
 * Maximum time (ms) to wait for agentLoop before aborting.
 *
 * Ten minutes, not three: an attachment turn routinely runs longer than three
 * (a real 427KB image-only PDF took 3m53s — read it, found no text layer,
 * extracted the embedded images, identified the document) and the old ceiling
 * killed the notification while the work itself was succeeding, so the user was
 * told "处理出错" about a task that had actually finished. An IM user is not
 * watching a progress bar; waiting is cheap, a false failure is not.
 */
const AGENT_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes
/**
 * Give the dispatched runner time to acknowledge abort and run its 5-second
 * force-finalize watchdog.  If it is still wedged after this bound, report the
 * timeout but quarantine the session until the original promise really settles.
 */
const AGENT_ABORT_SETTLE_GRACE_MS = 6_000;
const IM_CONFIRM_COMMAND_LIMIT = 1_200;
const IM_CONFIRM_REASON_LIMIT = 600;
const IM_CONFIRM_PATH_LIMIT = 800;
const IM_CONFIRM_MESSAGE_LIMIT = 2_400;

class TimedOutRunStillActiveError extends Error {
  readonly settlement: Promise<void>;

  constructor(ms: number, settlement: Promise<void>) {
    super(`Agent timed out after ${ms / 1000}s`);
    this.name = 'TimedOutRunStillActiveError';
    this.settlement = settlement;
  }
}

function redactAndLimit(value: string | undefined, maxLength: number): string {
  const redacted = redactText(value ?? '').text;
  if (redacted.length <= maxLength) return redacted;
  return `${redacted.slice(0, maxLength)}…`;
}

function buildIMConfirmationMessage(parts: string[]): string {
  const content = parts.filter(Boolean).join('\n\n');
  if (content.length <= IM_CONFIRM_MESSAGE_LIMIT) return content;
  return `${content.slice(0, IM_CONFIRM_MESSAGE_LIMIT)}…`;
}

function buildGroupIMConfirmationMessage(kind: 'command' | 'delete_file' | 'file_read' | 'file_write'): string {
  const t = getI18n().imChannel;
  const summary = kind === 'command'
    ? t.confirmGroupCommandPrompt
    : kind === 'delete_file'
      ? t.confirmGroupDeleteFilePrompt
      : kind === 'file_read'
        ? t.confirmGroupFileReadPrompt
        : t.confirmGroupFileWritePrompt;
  return buildIMConfirmationMessage([
    summary,
    t.confirmGroupDetailsHidden,
    t.confirmReplyOptions,
  ]);
}

const MAX_SESSION_QUEUE = 5;
const MAX_GLOBAL_QUEUE = MAX_CONCURRENT_IM * MAX_SESSION_QUEUE;

/** How long an image-only message waits for the caption that usually follows.
 *
 *  Sized for a human, not a network hop: the user picks the photo, sends it,
 *  and only then types "what is this?" — several seconds of typing. A window
 *  that expires mid-typing splits the pair back into two turns, which is the
 *  whole failure this buffer exists to prevent.
 *
 *  The cost is paid ONLY by a photo sent with no caption at all: it waits this
 *  long before the agent starts. A caption arriving inside the window merges
 *  and dispatches immediately, so the common "photo + question" flow sees no
 *  added latency at all. Tune here if that lone-photo wait feels too long. */
const MEDIA_COALESCE_MS = 15_000;

/** Placeholder markers the adapters emit for an attachment, so a message that
 *  is *only* an attachment can be recognised as having no words of its own.
 *  Covers files too — a file message's whole text is `[文件: name, 路径: …]`,
 *  which is payload for the agent but not something the user "said". */
const MEDIA_PLACEHOLDER_RE = /\[(图片|视频|文件[^\]]*)\]/g;

/** True when the message is nothing but an attachment: an image with no words,
 *  or a file/video whose text is only its placeholder. These are the messages
 *  that get a caption in a SEPARATE follow-up message. */
function isMediaOnly(message: NormalizedIMMessage): boolean {
  // Fresh regex per call: MEDIA_PLACEHOLDER_RE is /g and would carry lastIndex.
  const stripped = message.text.replace(MEDIA_PLACEHOLDER_RE, '').trim();
  if (stripped !== '') return false;
  return Boolean(message.images?.length) || message.text.trim() !== '';
}

/** Merge a buffered attachment with the follow-up that carries its caption.
 *  Both texts are kept: an image contributes nothing (its block is the content)
 *  while a file contributes the local path the agent needs to open it. */
function mergeInboundMessages(
  buffered: NormalizedIMMessage,
  next: NormalizedIMMessage,
): NormalizedIMMessage {
  return {
    ...next,
    text: [buffered.text.trim(), next.text.trim()].filter(Boolean).join('\n') || next.text,
    images: [...(buffered.images ?? []), ...(next.images ?? [])],
  };
}

class IMChannelRouter {
  private runningCount = 0;
  private queuedMessages: {
    message: NormalizedIMMessage;
    channelId: string;
    sessionKey: string;
  }[] = [];
  private cleanupInterval: ReturnType<typeof setInterval> | null = null;
  /** Track recently processed message IDs with timestamps for TTL-based dedup */
  private recentMessageIds = new Map<string, number>();
  /** Per-session active flag — ensures same-session messages are processed sequentially */
  private activeSessions = new Set<string>();
  /** Per-session message queue — messages waiting for the active turn to finish */
  private sessionQueues = new Map<string, { message: NormalizedIMMessage; channel: IMChannel; capability: IMCapabilityLevel }[]>();
  /** Per-chat image-only message awaiting the caption that usually follows it. */
  private pendingMedia = new Map<string, { message: NormalizedIMMessage; timer: ReturnType<typeof setTimeout> }>();
  /** Serialize typing operations per user so one turn's cancel cannot overtake
   *  the next turn's start when same-session messages drain back-to-back. */
  private typingOperations = new Map<string, Promise<void>>();
  /** Active heartbeat cleanup functions, including turns still inside agentLoop. */
  private activeTypingStops = new Set<() => void>();
  /** Invalidates async continuations that started before the latest stop(). */
  private typingLifecycleGeneration = 0;

  async start() {
    // IM inbound events are dispatched by inboundDispatcher (single dispatcher pattern).
    // channelRouter no longer listens directly — it receives pre-parsed messages
    // via dispatchMessage() when no trigger matched.

    // Periodic session cleanup (every 5 minutes)
    this.cleanupInterval = setInterval(() => {
      sessionMapper.cleanup();
      // Purge only expired dedup entries (30-min TTL), not full clear
      const now = Date.now();
      const DEDUP_TTL_MS = 30 * 60 * 1000;
      for (const [key, ts] of this.recentMessageIds) {
        if (now - ts > DEDUP_TTL_MS) this.recentMessageIds.delete(key);
      }
    }, 5 * 60 * 1000);

    console.log('[IMChannel] Router started');
  }

  stop() {
    this.typingLifecycleGeneration++;
    for (const stopTyping of [...this.activeTypingStops]) stopTyping();
    this.activeTypingStops.clear();
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
    this.queuedMessages = [];
    this.recentMessageIds.clear();
    // In-flight runs keep their slot/session ownership until their promise
    // settles. Clearing either here would let a restarted router overlap the
    // same session and make the old finally callback corrupt new counters.
    this.sessionQueues.clear();
    cancelAllIMConfirmations();
    for (const { timer } of this.pendingMedia.values()) clearTimeout(timer);
    this.pendingMedia.clear();
    console.log('[IMChannel] Router stopped');
  }

  /**
   * Called by inboundDispatcher when no trigger matched the message.
   * Accepts a pre-parsed NormalizedIMMessage.
   */
  dispatchMessage(message: NormalizedIMMessage): void {
    this.handleMessage(message);
  }

  private handleMessage(message: NormalizedIMMessage) {
    // Dedup: prefer messageId (stable ID) over content-based key
    const dedupKey = message.replyContext.messageId
      ? `${message.platform}:${message.replyContext.messageId}`
      : `${message.platform}:${message.chatId}:${message.senderId}:${message.text}`;
    const now = Date.now();
    const DEDUP_TTL_MS = 30 * 60 * 1000; // 30 minutes
    const seenAt = this.recentMessageIds.get(dedupKey);
    if (seenAt !== undefined && now - seenAt < DEDUP_TTL_MS) {
      console.log('[IMChannel] Duplicate message skipped');
      return;
    }
    this.recentMessageIds.set(dedupKey, now);

    // Coalesce "photo, then caption" into ONE turn. IM clients (WeChat included)
    // cannot send an image and its text together — the user must send two
    // messages — but treating them as two turns makes the agent answer the photo
    // with no question, then answer the question with no photo ("I didn't get an
    // image this turn"). So an image-only message waits briefly for the caption
    // that usually follows; the caption merges into it and dispatches one turn.
    const chatKey = `${message.platform}:${message.chatId}`;
    const pending = this.pendingMedia.get(chatKey);
    if (pending) {
      clearTimeout(pending.timer);
      this.pendingMedia.delete(chatKey);
      message = mergeInboundMessages(pending.message, message);
    }
    if (isMediaOnly(message)) {
      const buffered = message;
      const timer = setTimeout(() => {
        this.pendingMedia.delete(chatKey);
        this.routeMessage(buffered);
      }, MEDIA_COALESCE_MS);
      this.pendingMedia.set(chatKey, { message: buffered, timer });
      return;
    }

    this.routeMessage(message);
  }

  /** Channel resolution → auth → queueing → run. Split out of `handleMessage`
   *  so the media-coalescing timer can dispatch a buffered message too. */
  private routeMessage(message: NormalizedIMMessage) {
    // Find matching enabled channel for this platform
    const store = useIMChannelStore.getState();
    const channels = store.getChannelsByPlatform(message.platform).filter((c) => c.enabled === true);
    if (channels.length === 0) return;

    const channel = channels[0];

    // Response mode filter: in group chats, check if @mention is required
    if (!message.isDirect && channel.responseMode !== 'all_messages' && !message.isMention) {
      return; // Group message without @mention, skip silently
    }

    // Auth check
    const authResult = resolveCapability(message.senderId, channel);
    if (!authResult.allowed) {
      console.log(`[IMChannel] Auth denied for ${message.senderId}: ${authResult.reason}`);
      return;
    }

    // Per-session queue: ensure same-session messages are processed sequentially
    const sessionKey = sessionMapper.peekSessionKey(message);
    if (this.activeSessions.has(sessionKey)) {
      this.enqueueSessionMessage(sessionKey, message, channel, authResult.capability);
      return;
    }

    // Global concurrency check
    if (this.runningCount >= MAX_CONCURRENT_IM) {
      if (
        this.sessionQueuedCount(sessionKey) >= MAX_SESSION_QUEUE
        || this.queuedMessages.length >= MAX_GLOBAL_QUEUE
      ) {
        console.log('[IMChannel] Global queue full, dropping message');
        this.notifyQueueFull(message);
        return;
      }
      console.log('[IMChannel] Concurrency limit reached, queueing message');
      this.queuedMessages.push({ message, channelId: channel.id, sessionKey });
      const queuePos = this.queuedMessages.length;
      const queueMsg: AbuMessage = {
        content: `收到！当前有 ${this.runningCount} 个请求正在处理，你的请求已排队（第 ${queuePos} 位），请稍候。`,
      };
      sendThinking(message.platform, message.replyContext)
        .then((h) => sendFinal(h, queueMsg))
        .catch(() => {});
      return;
    }

    this.startMessageRun(message, channel, authResult.capability, sessionKey);
  }

  private notifyQueueFull(message: NormalizedIMMessage): void {
    sendThinking(message.platform, message.replyContext)
      .then((h) => sendFinal(h, { content: getI18n().imChannel.sessionQueueFull }))
      .catch(() => {});
  }

  private sessionQueuedCount(sessionKey: string): number {
    const localCount = this.sessionQueues.get(sessionKey)?.length ?? 0;
    return this.queuedMessages.reduce(
      (count, queued) => count + (queued.sessionKey === sessionKey ? 1 : 0),
      localCount,
    );
  }

  private enqueueSessionMessage(
    sessionKey: string,
    message: NormalizedIMMessage,
    channel: IMChannel,
    capability: IMCapabilityLevel,
  ): void {
    const queue = this.sessionQueues.get(sessionKey) ?? [];
    if (this.sessionQueuedCount(sessionKey) >= MAX_SESSION_QUEUE) {
      console.log('[IMChannel] Session queue full, dropping message');
      this.notifyQueueFull(message);
      return;
    }
    queue.push({ message, channel, capability });
    this.sessionQueues.set(sessionKey, queue);
  }

  /** Atomically acquire the per-session owner before an async run can yield. */
  private startMessageRun(
    message: NormalizedIMMessage,
    channel: IMChannel,
    capability: IMCapabilityLevel,
    sessionKey = sessionMapper.peekSessionKey(message),
  ): void {
    this.activeSessions.add(sessionKey);
    void this.processMessage(message, channel, capability);
  }

  /** Queue a typing request behind earlier requests for the same user. */
  private enqueueTyping(
    adapter: IMAdapter,
    token: string,
    userId: string,
    status: 1 | 2,
  ): Promise<void> {
    const sendTyping = adapter.sendTyping;
    if (!sendTyping) return Promise.resolve();

    const key = `${adapter.config.platform}:${userId}`;
    const previous = this.typingOperations.get(key) ?? Promise.resolve();
    const operation = previous
      .catch(() => {})
      .then(() => new Promise<void>((resolve, reject) => {
        const controller = new AbortController();
        const timer = setTimeout(() => {
          controller.abort();
          reject(new Error(`typing request timed out after ${WECHAT_TYPING_REQUEST_TIMEOUT_MS}ms`));
        }, WECHAT_TYPING_REQUEST_TIMEOUT_MS);

        Promise.resolve()
          .then(() => sendTyping.call(adapter, token, userId, status, controller.signal))
          .then(
            () => {
              clearTimeout(timer);
              resolve();
            },
            (err) => {
              clearTimeout(timer);
              reject(err);
            },
          );
      }))
      .catch((err) => {
        // warn/error are the logger levels that reach the captured app log.
        imChannelLog.warn('typing indicator lifecycle failed', {
          platform: adapter.config.platform,
          userId,
          status,
          error: err instanceof Error ? err.message : String(err),
        });
      });

    const tracked = operation.finally(() => {
      if (this.typingOperations.get(key) === tracked) {
        this.typingOperations.delete(key);
      }
    });
    this.typingOperations.set(key, tracked);
    return tracked;
  }

  /** Start immediately, refresh while work continues, and return an idempotent stop. */
  private startTypingHeartbeat(
    adapter: IMAdapter,
    token: string,
    userId: string,
  ): () => void {
    let stopped = false;
    let heartbeatInFlight: Promise<void> | null = null;

    const heartbeat = () => {
      if (stopped || heartbeatInFlight) return;
      const current = this.enqueueTyping(adapter, token, userId, 1);
      heartbeatInFlight = current;
      void current.finally(() => {
        if (heartbeatInFlight === current) heartbeatInFlight = null;
      });
    };

    heartbeat();
    const interval = setInterval(heartbeat, WECHAT_TYPING_REFRESH_MS);

    const stop = () => {
      if (stopped) return;
      stopped = true;
      clearInterval(interval);
      this.activeTypingStops.delete(stop);
      void this.enqueueTyping(adapter, token, userId, 2);
    };
    this.activeTypingStops.add(stop);
    return stop;
  }

  private async processMessage(
    message: NormalizedIMMessage,
    channel: IMChannel,
    capability: IMCapabilityLevel,
    reuseGlobalSlot = false,
  ) {
    const lifecycleGeneration = this.typingLifecycleGeneration;
    if (!reuseGlobalSlot) this.runningCount++;
    let removeReaction: (() => Promise<void>) | null = null;
    let stopTyping: (() => void) | null = null;
    let authorizationScopeId: string | undefined;
    let deferredRunSettlement: Promise<void> | null = null;

    try {
      const adapter = (await import('./adapters/registry')).getAdapter(message.platform);
      if (
        message.platform === 'wechat'
        && adapter?.sendTyping
        && lifecycleGeneration === this.typingLifecycleGeneration
      ) {
        stopTyping = this.startTypingHeartbeat(
          adapter,
          channel.appSecret,
          message.senderId,
        );
      }

      // 1. Session resolution
      const resolveResult = sessionMapper.resolve(message, channel, capability);
      const { session, isRecovered, hasRecoverableSession, recoverableContext } = resolveResult;

      // 1a. Hydrate the conversation before any run touches it. Conversations are
      // lazily loaded (and evicted by `unloadOldConversations`), so a message for
      // a session the desktop hasn't opened recently finds no in-memory record:
      // `buildAgentRunParams` then throws "no conversation record" and the
      // in-process fallback silently skips upgrading the persisted user message —
      // which drops inbound image attachments and leaves the message stuck in
      // `pending` ("发送失败" in the UI). Loading first keeps both paths whole.
      if (!useChatStore.getState().conversations[session.conversationId]) {
        await useChatStore.getState().loadConversation(session.conversationId);
      }

      // 1b. Auto-extract memories from archived session (non-blocking)
      if (resolveResult.archivedConversationId) {
        const extractWorkspace = channel.workspacePaths[0] ?? null;
        import('../memdir/extractor').then(({ extractMemoriesFromConversation }) =>
          extractMemoriesFromConversation(resolveResult.archivedConversationId!, extractWorkspace)
        ).catch(() => {});
      }

      // 1c. Async user name resolution (non-blocking)
      if (resolveResult.isNew && message.platform === 'feishu' && message.senderId) {
        this.resolveFeishuUserName(message.senderId, channel, session.conversationId, session.key)
          .catch(() => {});
      }

      // 2. Send thinking acknowledgment (or recovery/hint messages)
      let replyHandle;

      // Handle "新对话" reset — confirm and wait for next message
      if (resolveResult.isReset) {
        const resetMsg: AbuMessage = { content: getI18n().imChannel.sessionResetConfirm };
        replyHandle = await sendThinking(message.platform, message.replyContext);
        await sendFinal(replyHandle, resetMsg);
        useIMChannelStore.getState().setChannelStatus(channel.id, 'connected');
        console.log(`[IMChannel] Session reset for ${message.senderName}`);
        return;
      }

      if (isRecovered) {
        // Send recovery confirmation
        const confirmMsg: AbuMessage = {
          content: format(getI18n().imChannel.sessionRecovered, { context: recoverableContext ?? '' }),
        };
        replyHandle = await sendThinking(message.platform, message.replyContext);
        await sendFinal(replyHandle, confirmMsg);
        useIMChannelStore.getState().setChannelStatus(channel.id, 'connected');
        console.log(`[IMChannel] Recovered session for ${message.senderName}`);
        return; // "继续上次" is not a real question — just confirm and wait for next message
      }

      if (resolveResult.isRolledOver) {
        // The round cap rolled the session over. Say so — otherwise the agent
        // just looks like it forgot everything mid-conversation. (Checked before
        // the recoverable hint below: the roll-over archived that very session,
        // so both flags are set, but "expired" would be the wrong story.)
        const rolledMsg: AbuMessage = {
          content: format(getI18n().imChannel.sessionRolledOver, {
            rounds: String(channel.maxRoundsPerSession),
          }),
        };
        sendThinking(message.platform, message.replyContext)
          .then((h) => sendFinal(h, rolledMsg))
          .catch(() => {});
      } else if (hasRecoverableSession) {
        // Hint the user that they can recover
        const hintMsg: AbuMessage = {
          content: getI18n().imChannel.sessionExpiredHint,
        };
        // Send hint as a side-effect, don't block main flow
        sendThinking(message.platform, message.replyContext)
          .then((h) => sendFinal(h, hintMsg))
          .catch(() => {});
      }

      // Add processing indicator: emoji reaction for Feishu/Slack, thinking message for others
      if (adapter?.config.supportsMessageUpdate) {
        // Feishu/Slack: add emoji reaction as processing indicator
        removeReaction = await addProcessingReaction(message.platform, message.replyContext);
        replyHandle = {
          platform: message.platform,
          supportsUpdate: true,
          replyContext: message.replyContext,
        };
      } else {
        replyHandle = await sendThinking(message.platform, message.replyContext);
      }

      // 3. Run agent with timeout (agentLoop adds the user message internally)

      // Inject trigger context if a trigger recently processed a message in this chat
      let userText = message.text;
      if (resolveResult.isNew) {
        const triggerCtx = consumeTriggerContext(message.chatId);
        if (triggerCtx) {
          userText = `${message.text}\n\n[上下文] 触发器「${triggerCtx.triggerName}」刚才在这个群处理了一条消息，结果如下：\n${triggerCtx.summary}\n\n用户可能在追问上述触发器的处理结果，请结合这个上下文回答。`;
          console.log(`[IMChannel] Injected trigger context from "${triggerCtx.triggerName}" for chat ${message.chatId}`);
        }
      }

      authorizationScopeId = createAuthorizationScope();
      let ownedAbortController: AbortController | undefined;
      const workspacePath = channel.workspacePaths[0] ?? null;
      if (workspacePath && capability !== 'chat_only') {
        scopedAuthorizeWorkspace(
          authorizationScopeId,
          workspacePath,
          capability === 'read_tools' ? ['read'] : ['read', 'write'],
        );
      }
      let canConsumeFreshIntentTombstone = parseIMConfirmationReply(message.text) === null
        && Boolean(message.replyContext.messageId?.trim());
      const consumeFreshIntentTombstone = () => {
        const allowed = canConsumeFreshIntentTombstone;
        canConsumeFreshIntentTombstone = false;
        return allowed;
      };
      const confirmViaIM = (content: string) => {
        if (lifecycleGeneration !== this.typingLifecycleGeneration) return Promise.resolve(false);
        return requestIMConfirmation(
          {
            platform: message.platform,
            channelId: channel.id,
            senderId: message.senderId,
            chatId: message.chatId,
            threadId: message.replyContext.threadId,
            sessionWebhook: message.replyContext.sessionWebhook,
            sessionKey: session.key,
            conversationId: session.conversationId,
            replyContext: message.replyContext,
          },
          { content },
          {
            abortSignal: ownedAbortController?.signal,
            invalidReplyMessage: getI18n().imChannel.confirmInvalidReply,
            allowRouteRearm: consumeFreshIntentTombstone(),
          },
        );
      };
      const baseCallbacks = getCallbacksForLevel(capability, {
        confirmCommand: async (info) => {
          if (!message.isDirect) {
            return confirmViaIM(buildGroupIMConfirmationMessage('command'));
          }
          const command = redactAndLimit(info.command, IM_CONFIRM_COMMAND_LIMIT);
          const reason = redactAndLimit(info.reason, IM_CONFIRM_REASON_LIMIT);
          return confirmViaIM(buildIMConfirmationMessage([
            getI18n().imChannel.confirmCommandPrompt,
            command,
            reason,
            getI18n().imChannel.confirmReplyOptions,
          ]));
        },
        confirmFilePermission: async (request) => {
          if (!message.isDirect) {
            const kind = request.toolName === 'delete_file'
              ? 'delete_file'
              : request.capability === 'read' ? 'file_read' : 'file_write';
            return confirmViaIM(buildGroupIMConfirmationMessage(kind));
          }
          const action = request.toolName === 'delete_file'
            ? getI18n().imChannel.confirmDeleteFilePrompt
            : getI18n().imChannel.confirmFilePermissionPrompt;
          return confirmViaIM(buildIMConfirmationMessage([
            action,
            redactAndLimit(request.path, IM_CONFIRM_PATH_LIMIT),
            getI18n().imChannel.confirmReplyOptions,
          ]));
        },
      });
      const filePermissionCallback = async (...args: Parameters<typeof baseCallbacks.filePermissionCallback>) => {
        const [request] = args;
        const granted = await baseCallbacks.filePermissionCallback(...args);
        if (granted && capability === 'full') {
          scopedAuthorizeWorkspace(authorizationScopeId!, request.path, [request.capability]);
        }
        return granted;
      };
      await this.runWithTimeout(
        runAgentLoopDispatched(session.conversationId, userText, {
          // Inbound images (e.g. a WeChat photo) forwarded as real vision content
          // so the model actually sees them instead of a "[图片]" text marker.
          images: message.images,
          commandConfirmCallback: baseCallbacks.commandConfirmCallback,
          filePermissionCallback,
          // Tier-scoped, not a hard-coded single entry: the read-only tier
          // must carry no browser capability at all (same rule
          // triggerPermission.ts enforces), and a standing per-site grant
          // would otherwise let it act without the confirm callback ever
          // running.
          blockedTools: getBlockedToolsForLevel(capability),
          // The read-only tier's positive ceiling (RB-02): its confirm
          // callback is skipped whenever the strategy resolves to 'allow' on
          // its own, so the roster — not the callback — is what keeps an
          // unattended read-only channel from writing.
          allowedTools: getAllowedToolsForLevel(capability),
          authorizationScopeId,
          onAbortControllerReady: (controller) => {
            ownedAbortController = controller;
          },
          runPermissionCeiling: buildIMRunPermissionCeiling(capability),
          imContext: {
            platform: message.platform,
            workspacePath,
            capability,
            // Reply target for outbound tools (send_file). The chatId is the
            // same one sendFinal replies to.
            replyChatId: message.replyContext.chatId,
          },
        }),
        AGENT_TIMEOUT_MS,
        () => {
          ownedAbortController?.abort(
            new Error(`IM agent timed out after ${AGENT_TIMEOUT_MS / 1000}s`),
          );
        },
      );

      // 5. Extract and send reply
      const lastAIContent = this.extractLastAIReply(session.conversationId);
      if (lastAIContent) {
        const replyMessage: AbuMessage = {
          content: lastAIContent,
          footer: `Abu AI · ${new Date().toLocaleString('zh-CN')}`,
        };
        const result = await sendFinal(replyHandle, replyMessage);
        if (!result.success) {
          console.warn(`[IMChannel] Reply send failed: ${result.error}`);
        }
      } else {
        console.warn(`[IMChannel] No AI reply found for conversation ${session.conversationId}`);
      }

      // Clear channel error on success
      useIMChannelStore.getState().setChannelStatus(channel.id, 'connected');
      console.log(`[IMChannel] Completed: ${message.senderName} in ${message.platform}`);
    } catch (err) {
      if (err instanceof TimedOutRunStillActiveError) {
        // The timeout has a real upper bound, but the old run may still hold
        // shell/sidecar state.  Keep this session active and its authorization
        // scope alive until that exact promise settles; otherwise the queued
        // turn could overlap it or lose cleanup authority mid-operation.
        deferredRunSettlement = err.settlement;
      }
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error(`[IMChannel] Error processing message:`, errorMsg);

      // Write error to channel store so UI can display it
      useIMChannelStore.getState().setChannelStatus(channel.id, 'error', errorMsg);

      // Best-effort error reply to user
      this.sendErrorReply(message, errorMsg).catch(() => {});
    } finally {
      // Stop the WeChat heartbeat before draining this session's next message.
      // enqueueTyping serializes the cancel ahead of the next turn's start.
      stopTyping?.();

      // Remove processing reaction (emoji) if it was added
      if (removeReaction) {
        removeReaction().catch(() => {});
      }

      if (deferredRunSettlement) {
        void deferredRunSettlement.then(() => {
          this.releaseRunResources(message, authorizationScopeId);
        });
      } else {
        this.releaseRunResources(message, authorizationScopeId);
      }
    }
  }

  /** Release run-owned authority, then hand the per-session slot onward. */
  private releaseRunResources(
    message: NormalizedIMMessage,
    authorizationScopeId?: string,
  ): void {
    disposeAuthorizationScope(authorizationScopeId);

    // Drain per-session queue: process next message for same session
    const sessionKey = sessionMapper.peekSessionKey(message);
    const queue = this.sessionQueues.get(sessionKey);
    if (queue && queue.length > 0) {
      const next = queue.shift()!;
      if (queue.length === 0) this.sessionQueues.delete(sessionKey);
      // The session remains owned and the replacement turn reuses the exact
      // same global concurrency slot.
      void this.processMessage(next.message, next.channel, next.capability, true);
    } else {
      this.activeSessions.delete(sessionKey);
      this.runningCount--;
      this.processQueue();
    }
  }

  /**
   * Wrap a promise with a timeout. Rejects with a clear message if exceeded.
   */
  private async runWithTimeout<T>(
    promise: Promise<T>,
    ms: number,
    onTimeout?: () => void,
    settleGraceMs = AGENT_ABORT_SETTLE_GRACE_MS,
  ): Promise<T> {
    const settled = promise.then(
      (value) => ({ kind: 'fulfilled' as const, value }),
      (error) => ({ kind: 'rejected' as const, error }),
    );
    let timer: ReturnType<typeof setTimeout>;
    const timeout = new Promise<{ kind: 'timeout' }>((resolve) => {
      timer = setTimeout(() => {
        try {
          onTimeout?.();
        } catch (error) {
          console.warn('[IMChannel] Failed to cancel timed-out agent run:', error);
        }
        resolve({ kind: 'timeout' });
      }, ms);
    });

    const first = await Promise.race([settled, timeout]);
    if (first.kind === 'fulfilled') {
      clearTimeout(timer!);
      return first.value;
    }
    if (first.kind === 'rejected') {
      clearTimeout(timer!);
      throw first.error;
    }

    const timeoutError = () => new Error(`Agent timed out after ${ms / 1000}s`);

    // Without a cancellation hook, preserve this helper's generic hard-timeout
    // behavior.  With one, allow a bounded grace period for normal abort
    // cleanup; a run that outlives the grace is handed back to processMessage
    // as a quarantine handle instead of blocking error reporting forever.
    if (!onTimeout) throw timeoutError();

    let graceTimer: ReturnType<typeof setTimeout> | undefined;
    const graceExpired = new Promise<{ kind: 'grace-expired' }>((resolve) => {
      graceTimer = setTimeout(() => resolve({ kind: 'grace-expired' }), settleGraceMs);
    });
    const afterCancel = await Promise.race([settled, graceExpired]);
    if (afterCancel.kind !== 'grace-expired') {
      if (graceTimer) clearTimeout(graceTimer);
      throw timeoutError();
    }

    const settlement = settled.then(() => undefined);
    throw new TimedOutRunStillActiveError(ms, settlement);
  }

  /**
   * Best-effort: try to notify the user that an error occurred.
   */
  private async sendErrorReply(message: NormalizedIMMessage, error: string) {
    const truncated = error.length > 100 ? error.slice(0, 100) + '...' : error;
    const errorMessage: AbuMessage = {
      content: `Abu 处理出错: ${truncated}`,
    };
    const handle = { platform: message.platform, supportsUpdate: false, replyContext: message.replyContext };
    await sendFinal(handle, errorMessage);
  }

  private processQueue() {
    while (this.queuedMessages.length > 0 && this.runningCount < MAX_CONCURRENT_IM) {
      const next = this.queuedMessages.shift()!;
      const store = useIMChannelStore.getState();
      const channel = store.channels[next.channelId];
      if (!channel || channel.enabled !== true) continue;

      const authResult = resolveCapability(next.message.senderId, channel);
      if (!authResult.allowed) continue;

      const sessionKey = next.sessionKey;
      if (this.activeSessions.has(sessionKey)) {
        this.enqueueSessionMessage(sessionKey, next.message, channel, authResult.capability);
        continue;
      }

      this.startMessageRun(next.message, channel, authResult.capability, sessionKey);
      return;
    }
  }

  /**
   * Resolve Feishu user's display name via API and update session/conversation title.
   */
  private async resolveFeishuUserName(
    openId: string,
    channel: IMChannel,
    conversationId: string,
    sessionKey: string,
  ) {
    try {
      const token = await tokenManager.getToken('feishu', channel.appId, channel.appSecret);
      const { FeishuAdapter } = await import('./adapters/feishu');
      const adapter = new FeishuAdapter();
      const name = await adapter.resolveUserName(token, openId);
      if (!name) return;

      // Update session userName
      const store = useIMChannelStore.getState();
      const session = store.sessions[sessionKey];
      if (session) {
        store.upsertSession(sessionKey, { ...session, userName: name });
      }

      // Update conversation title
      const chatStore = useChatStore.getState();
      const conv = chatStore.conversations[conversationId];
      if (conv) {
        const chatName = session?.chatName ? ` · ${session.chatName}` : '';
        chatStore.renameConversation(conversationId, chatName ? `${name}${chatName}` : name);
      }

      console.log(`[IMChannel] Resolved Feishu user name: ${openId} → ${name}`);
    } catch (err) {
      console.warn(`[IMChannel] Failed to resolve user name for ${openId}:`, err);
    }
  }

  private extractLastAIReply(conversationId: string): string | null {
    const conv = useChatStore.getState().conversations[conversationId];
    if (!conv) return null;

    const lastAI = [...conv.messages].reverse().find((m) => m.role === 'assistant');
    if (!lastAI) return null;

    if (typeof lastAI.content === 'string') return lastAI.content;

    // Multimodal content
    return (lastAI.content as { type: string; text?: string }[])
      .filter((c) => c.type === 'text')
      .map((c) => c.text ?? '')
      .join('\n');
  }
}

export const imChannelRouter = new IMChannelRouter();
