import { useTriggerStore } from '../../stores/triggerStore';
import { useChatStore } from '../../stores/chatStore';
import { useToastStore } from '../../stores/toastStore';
import { runAgentLoop } from '../agent/agentLoop';
import {
  notifyTriggerCompleted,
  notifyTriggerError,
} from '../../utils/notifications';
import { outputSender } from '../im/outputSender';
import type { OutputContext } from '../im/adapters/types';
import type { Trigger, TriggerEventPayload } from '../../types/trigger';
import type { IMReplyContext } from '../../types/im';
import type { NormalizedIMMessage } from '../im/inboundRouter';
import { getI18n } from '../../i18n';
import { useIMChannelStore } from '../../stores/imChannelStore';
import { resolveTriggerCallbacks } from './triggerPermission';
import { cacheTriggerContext } from '../im/triggerContextCache';
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { watch, type UnwatchFn } from '@tauri-apps/plugin-fs';

const DEFAULT_PORT = 18080;

/** Simple glob matching: supports * and ? */
function matchGlob(str: string, pattern: string): boolean {
  const regex = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${regex}$`, 'i').test(str);
}

// Simple string hash for debounce deduplication
function simpleHash(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash) + str.charCodeAt(i);
    hash |= 0;
  }
  return hash.toString(36);
}

const MAX_CONCURRENT_TRIGGERS = 5;
const MAX_RETRY_ATTEMPTS = 3;
const MAX_DEBOUNCE_CACHE_SIZE = 10_000;

class TriggerEngine {
  private runningTriggers = new Set<string>();
  private debounceCache = new Map<string, number>(); // "triggerId:hash" → timestamp
  private unlistenHttp: UnlistenFn | null = null;
  private debounceCleanupInterval: ReturnType<typeof setInterval> | null = null;
  private serverPort: number | null = null;
  private fileWatchers = new Map<string, UnwatchFn>(); // triggerId → unwatch
  private cronTimers = new Map<string, ReturnType<typeof setInterval>>(); // triggerId → timer
  private imTriggersMap = new Map<string, Set<string>>(); // "channelId" → Set<triggerId>
  private unsubscribeStore: (() => void) | null = null;

  async start() {
    console.log('[Trigger] Engine starting...');

    // Start HTTP server (Rust side)
    try {
      const port = await invoke<number>('start_trigger_server', { port: DEFAULT_PORT });
      this.serverPort = port;
      console.log(`[Trigger] HTTP server started on port ${port}`);
    } catch (err) {
      // May already be running from previous start
      console.warn('[Trigger] HTTP server start:', err);
      try {
        const port = await invoke<number | null>('get_trigger_server_port');
        if (port) this.serverPort = port;
      } catch {
        // ignore
      }
    }

    // Listen for HTTP trigger events from Rust
    this.unlistenHttp = await listen<{ triggerId: string; payload: TriggerEventPayload }>(
      'trigger-http-event',
      (event) => {
        const { triggerId, payload } = event.payload;
        // Ensure payload has data field
        const normalizedPayload: TriggerEventPayload = {
          data: payload?.data ?? payload ?? {},
        };
        this.handleEvent(triggerId, normalizedPayload);
      }
    );

    // IM inbound events are handled by inboundDispatcher (single dispatcher pattern)

    // Start file watchers, cron timers, and IM listeners for existing triggers
    this.setupSourceWatchers();

    // Subscribe to store changes to manage file/cron watchers dynamically
    // Only react to trigger addition/removal, status changes, and source config changes
    this.unsubscribeStore = useTriggerStore.subscribe((state, prevState) => {
      // Quick check: skip if triggers object reference is unchanged
      if (state.triggers === prevState.triggers) return;

      const currentIds = new Set(Object.keys(state.triggers));
      const prevIds = new Set(Object.keys(prevState.triggers));

      // Removed triggers — stop their watchers
      for (const id of prevIds) {
        if (!currentIds.has(id)) {
          this.stopSourceWatcher(id);
        }
      }

      // Added or changed triggers — only check source/status fields
      for (const id of currentIds) {
        const trigger = state.triggers[id];
        const prev = prevState.triggers[id];

        if (!prev) {
          if (trigger.status === 'active') this.startSourceWatcher(trigger);
        } else if (trigger.status !== prev.status) {
          if (trigger.status === 'active') {
            this.startSourceWatcher(trigger);
          } else {
            this.stopSourceWatcher(id);
          }
        } else if (trigger.source !== prev.source) {
          // Immer produces new references on change, so identity check is sufficient
          this.stopSourceWatcher(id);
          if (trigger.status === 'active') this.startSourceWatcher(trigger);
        }
      }
    });

    // Periodically clean up expired debounce entries (every 5 minutes)
    this.debounceCleanupInterval = setInterval(() => {
      const now = Date.now();
      for (const [key, timestamp] of this.debounceCache) {
        // Remove entries older than 1 hour
        if (now - timestamp > 3_600_000) {
          this.debounceCache.delete(key);
        }
      }
    }, 300_000);

    console.log('[Trigger] Engine started');
  }

  stop() {
    this.unlistenHttp?.();
    this.unlistenHttp = null;

    if (this.debounceCleanupInterval) {
      clearInterval(this.debounceCleanupInterval);
      this.debounceCleanupInterval = null;
    }

    // Clean up file watchers
    for (const [id, unwatch] of this.fileWatchers) {
      unwatch();
      console.log(`[Trigger] Stopped file watcher: ${id}`);
    }
    this.fileWatchers.clear();

    // Clean up cron timers
    for (const [id, timer] of this.cronTimers) {
      clearInterval(timer);
      console.log(`[Trigger] Stopped cron timer: ${id}`);
    }
    this.cronTimers.clear();

    // Unsubscribe from store
    this.unsubscribeStore?.();
    this.unsubscribeStore = null;

    this.runningTriggers.clear();
    this.debounceCache.clear();
    this.imTriggersMap.clear();
    this.serverPort = null;

    console.log('[Trigger] Engine stopped');
  }

  getServerPort(): number | null {
    return this.serverPort;
  }

  // ── Event handling ──

  async handleEvent(triggerId: string, payload: TriggerEventPayload, options?: { skipChecks?: boolean; _retryCount?: number }) {
    const store = useTriggerStore.getState();
    const trigger = store.triggers[triggerId];
    const skipChecks = options?.skipChecks ?? false;
    const retryCount = options?._retryCount ?? 0;

    if (!trigger) {
      console.warn(`[Trigger] Unknown trigger ID: ${triggerId}`);
      return;
    }

    if (!skipChecks && trigger.status !== 'active') {
      console.log(`[Trigger] Trigger ${triggerId} is paused, skipping`);
      return;
    }

    // Event summary for skipped run records
    const eventSummary = JSON.stringify(payload.data).slice(0, 200);

    if (!skipChecks) {
      // 1. Quiet hours check
      if (this.isQuietHours(trigger)) {
        console.log(`[Trigger] Quiet hours active for ${trigger.name}, skipping`);
        return;
      }

      // 2. Filter check
      if (!this.matchFilter(trigger, payload)) {
        console.log(`[Trigger] Filter not matched for ${trigger.name}`);
        store.addSkippedRun(triggerId, 'filtered', eventSummary);
        return;
      }

      // 3. Debounce check
      if (this.isDebounced(trigger, payload)) {
        console.log(`[Trigger] Debounced for ${trigger.name}`);
        store.addSkippedRun(triggerId, 'debounced', eventSummary);
        return;
      }
    }

    // 4. Prevent concurrent execution of same trigger — retry with backoff (max 3 times)
    if (this.runningTriggers.has(triggerId)) {
      if (retryCount >= MAX_RETRY_ATTEMPTS) {
        console.log(`[Trigger] Max retries reached for ${trigger.name}, dropping event`);
        return;
      }
      const delay = 5000 * (retryCount + 1); // 5s, 10s, 15s
      console.log(`[Trigger] Already running: ${trigger.name}, retry ${retryCount + 1}/${MAX_RETRY_ATTEMPTS} in ${delay / 1000}s`);
      setTimeout(() => this.handleEvent(triggerId, payload, { ...options, _retryCount: retryCount + 1 }), delay);
      return;
    }

    // 5. Global concurrency limit
    if (this.runningTriggers.size >= MAX_CONCURRENT_TRIGGERS) {
      if (retryCount >= MAX_RETRY_ATTEMPTS) {
        console.log(`[Trigger] Concurrency limit reached, dropping event for ${trigger.name}`);
        return;
      }
      const delay = 5000 * (retryCount + 1);
      console.log(`[Trigger] Concurrency limit (${MAX_CONCURRENT_TRIGGERS}), retry ${retryCount + 1}/${MAX_RETRY_ATTEMPTS} in ${delay / 1000}s`);
      setTimeout(() => this.handleEvent(triggerId, payload, { ...options, _retryCount: retryCount + 1 }), delay);
      return;
    }

    // 6. Execute
    this.runningTriggers.add(triggerId);

    try {
      await this.executeAction(trigger, payload);
    } finally {
      this.runningTriggers.delete(triggerId);
    }
  }

  // ── Execution ──

  private async executeAction(trigger: Trigger, payload: TriggerEventPayload) {
    console.log(`[Trigger] Executing: ${trigger.name} (${trigger.id})`);

    const chatStore = useChatStore.getState();
    const triggerStore = useTriggerStore.getState();

    // Determine workspace path: explicit config > file source path > null
    let workspacePath = trigger.action.workspacePath ?? null;
    if (!workspacePath && trigger.source.type === 'file') {
      workspacePath = trigger.source.path;
    }

    // Create a hidden conversation (same pattern as scheduler.ts)
    const conversationId = chatStore.createConversation(
      workspacePath,
      { triggerId: trigger.id, skipActivate: true }
    );

    // Set conversation title
    const timeStr = new Date().toLocaleString('zh-CN', {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
    chatStore.renameConversation(conversationId, `[Trigger] ${trigger.name} - ${timeStr}`);

    // Event summary for run history (truncate to 200 chars)
    const eventSummary = JSON.stringify(payload.data).slice(0, 200);

    // Start run tracking
    const runId = triggerStore.startRun(trigger.id, conversationId, eventSummary);

    // Build prompt with $EVENT_DATA substitution
    let prompt = trigger.action.prompt;
    const eventDataStr = JSON.stringify(payload.data, null, 2);
    prompt = prompt.replace(/\$EVENT_DATA/g, eventDataStr);

    // Append no-followup instruction for IM triggers (single-turn, no interactive Q&A)
    if (trigger.source.type === 'im') {
      prompt += '\n\n（注意：这是自动触发器任务，请直接给出完整结果，不要反问用户或等待确认。）';
    }

    // Prepend skill if configured
    if (trigger.action.skillName) {
      prompt = `/${trigger.action.skillName} ${prompt}`;
    }

    try {
      // Resolve permission callbacks based on trigger's capability level.
      // Permissions are declared at creation time — no runtime dialogs.
      // Pass resolved workspacePath so it gets pre-authorized for file access.
      const actionWithWorkspace = workspacePath
        ? { ...trigger.action, workspacePath }
        : trigger.action;
      const callbacks = resolveTriggerCallbacks(actionWithWorkspace);
      await runAgentLoop(conversationId, prompt, {
        commandConfirmCallback: callbacks.commandConfirmCallback,
        filePermissionCallback: callbacks.filePermissionCallback,
        blockedTools: callbacks.blockedTools,
      });

      useTriggerStore.getState().completeRun(trigger.id, runId);

      // Cache trigger result for channel follow-up context (IM source only)
      if (trigger.source.type === 'im') {
        const chatIdFromPayload = String(payload.data?.chatId ?? '');
        if (chatIdFromPayload) {
          const aiResponse = this.extractLastAIReply(conversationId);
          if (aiResponse) {
            // Truncate to avoid bloating the channel session prompt
            const truncated = aiResponse.length > 800 ? aiResponse.slice(0, 800) + '...' : aiResponse;
            cacheTriggerContext(chatIdFromPayload, trigger.name, truncated);
          }
        }
      }

      // Output push — send results to IM channel or webhook
      if (trigger.output?.enabled) {
        const replyContext = (payload as TriggerEventPayload & { _replyContext?: IMReplyContext })._replyContext;
        await this.pushOutput(trigger, runId, conversationId, payload, replyContext);
      }

      notifyTriggerCompleted(trigger.name);
      const t = getI18n();
      useToastStore.getState().addToast({
        type: 'success',
        title: t.trigger.triggerCompleted.replace('{name}', trigger.name),
      });
      console.log(`[Trigger] Completed: ${trigger.name}`);
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      useTriggerStore.getState().errorRun(trigger.id, runId, errorMsg);
      notifyTriggerError(trigger.name);
      const t = getI18n();
      useToastStore.getState().addToast({
        type: 'error',
        title: t.trigger.triggerError.replace('{name}', trigger.name),
        message: errorMsg.slice(0, 100),
      });
      console.error(`[Trigger] Error: ${trigger.name}`, err);
    }
  }

  // ── Output push ──

  private async pushOutput(
    trigger: Trigger,
    runId: string,
    conversationId: string,
    payload: TriggerEventPayload,
    replyContext?: IMReplyContext,
  ) {
    if (!trigger.output) return;

    useTriggerStore.getState().updateRunOutput(trigger.id, runId, 'pending');

    const startedAt = useTriggerStore
      .getState()
      .triggers[trigger.id]?.runs.find((r) => r.id === runId)?.startedAt;
    const runTimeMs = startedAt ? Date.now() - startedAt : 0;
    const runTimeStr = runTimeMs > 0 ? `${Math.round(runTimeMs / 1000)}s` : '';

    const context: OutputContext = {
      triggerName: trigger.name,
      eventSummary:
        typeof payload.data?.content === 'string'
          ? payload.data.content
          : JSON.stringify(payload.data).slice(0, 200),
      aiResponse: '', // filled by buildMessage
      runTime: runTimeStr,
      timestamp: new Date().toLocaleString('zh-CN'),
      eventData: JSON.stringify(payload.data),
    };

    const message = outputSender.buildMessage(conversationId, trigger.output, context);
    const { success, error } = await outputSender.send(trigger.output, message, replyContext);

    useTriggerStore
      .getState()
      .updateRunOutput(trigger.id, runId, success ? 'sent' : 'failed', error);

    const t = getI18n();
    if (!success) {
      console.warn(`[Trigger] Output push failed for ${trigger.name}: ${error}`);
      useToastStore.getState().addToast({
        type: 'error',
        title: t.trigger.outputPushFailed.replace('{name}', trigger.name),
        message: error?.slice(0, 100),
      });
      notifyTriggerError(trigger.name);
    } else {
      console.log(`[Trigger] Output pushed: ${trigger.name}`);
      useToastStore.getState().addToast({
        type: 'success',
        title: t.trigger.outputPushSent.replace('{name}', trigger.name),
      });
    }
  }

  // ── Filter matching ──

  private matchFilter(trigger: Trigger, payload: TriggerEventPayload): boolean {
    const { filter } = trigger;

    // Sender match filter (IM source only)
    if (trigger.source.type === 'im' && trigger.source.senderMatch) {
      const senderName = String(payload.data?.sender ?? '');
      const senderId = String(payload.data?.senderId ?? '');
      const match = trigger.source.senderMatch;
      if (!senderName.includes(match) && !senderId.includes(match)) {
        return false;
      }
    }

    // Determine text to match against (supports nested paths like "data.content")
    let text: string;
    if (filter.field) {
      const value = filter.field.split('.').reduce<unknown>((obj, key) => {
        if (obj && typeof obj === 'object') return (obj as Record<string, unknown>)[key];
        return undefined;
      }, payload.data);
      text = value !== undefined ? String(value) : JSON.stringify(payload.data);
    } else {
      text = JSON.stringify(payload.data);
    }

    switch (filter.type) {
      case 'always':
        return true;
      case 'keyword':
        return (filter.keywords ?? []).some((kw) => text.includes(kw));
      case 'regex':
        try {
          return new RegExp(filter.pattern ?? '').test(text);
        } catch {
          console.warn(`[Trigger] Invalid regex: ${filter.pattern}`);
          return false;
        }
      default:
        return false;
    }
  }

  // ── Debounce ──

  private isDebounced(trigger: Trigger, payload: TriggerEventPayload): boolean {
    if (!trigger.debounce.enabled) return false;

    const content = JSON.stringify(payload.data);
    const hash = simpleHash(content);
    const key = `${trigger.id}:${hash}`;
    const now = Date.now();
    const last = this.debounceCache.get(key);

    if (last && now - last < trigger.debounce.windowSeconds * 1000) {
      return true;
    }

    // Evict oldest entries if cache is too large
    if (this.debounceCache.size >= MAX_DEBOUNCE_CACHE_SIZE) {
      let oldest = Infinity;
      let oldestKey = '';
      for (const [k, ts] of this.debounceCache) {
        if (ts < oldest) { oldest = ts; oldestKey = k; }
      }
      if (oldestKey) this.debounceCache.delete(oldestKey);
    }

    this.debounceCache.set(key, now);
    return false;
  }

  // ── Quiet hours ──

  private isQuietHours(trigger: Trigger): boolean {
    if (!trigger.quietHours?.enabled) return false;

    const now = new Date();
    const hhmm = now.getHours() * 100 + now.getMinutes();

    const [sh, sm] = trigger.quietHours.start.split(':').map(Number);
    const [eh, em] = trigger.quietHours.end.split(':').map(Number);
    const start = sh * 100 + sm;
    const end = eh * 100 + em;

    if (start > end) {
      // Crosses midnight: e.g. 22:00 ~ 08:00
      return hhmm >= start || hhmm < end;
    }
    return hhmm >= start && hhmm < end;
  }

  // ── Source watchers ──

  private setupSourceWatchers() {
    const store = useTriggerStore.getState();
    for (const trigger of Object.values(store.triggers)) {
      if (trigger.status !== 'active') continue;
      this.startSourceWatcher(trigger);
    }
  }

  /** Start a file watcher, cron timer, or IM listener for a trigger. Safe to call multiple times. */
  startSourceWatcher(trigger: Trigger) {
    if (trigger.source.type === 'file') {
      this.startFileWatcher(trigger);
    } else if (trigger.source.type === 'cron') {
      this.startCronTimer(trigger);
    } else if (trigger.source.type === 'im') {
      this.registerIMTrigger(trigger);
    }
  }

  /** Stop a file watcher, cron timer, or IM listener for a trigger. */
  stopSourceWatcher(triggerId: string) {
    const unwatch = this.fileWatchers.get(triggerId);
    if (unwatch) {
      unwatch();
      this.fileWatchers.delete(triggerId);
      console.log(`[Trigger] Stopped file watcher: ${triggerId}`);
    }
    const timer = this.cronTimers.get(triggerId);
    if (timer) {
      clearInterval(timer);
      this.cronTimers.delete(triggerId);
      console.log(`[Trigger] Stopped cron timer: ${triggerId}`);
    }
    this.unregisterIMTrigger(triggerId);
  }

  private async startFileWatcher(trigger: Trigger) {
    if (trigger.source.type !== 'file') return;
    if (this.fileWatchers.has(trigger.id)) return; // already watching

    const { path: watchPath, events: watchEvents, pattern } = trigger.source;

    try {
      const unwatch = await watch(watchPath, (event) => {
        // Tauri 2.0 event.type can be a string ("create") or object ({ create: { kind: "file" } })
        let eventType: string;
        if (typeof event.type === 'string') {
          eventType = event.type;
        } else if (event.type && typeof event.type === 'object') {
          // Extract first key from object format: { create: {...} } → "create"
          eventType = Object.keys(event.type as Record<string, unknown>)[0] ?? '';
        } else {
          eventType = String(event.type);
        }
        const mappedType =
          eventType === 'create' ? 'create' :
          eventType === 'modify' ? 'modify' :
          eventType === 'remove' ? 'delete' : null;

        if (!mappedType) return;
        if (!watchEvents.includes(mappedType as 'create' | 'modify' | 'delete')) return;

        // Pattern filter
        const paths = Array.isArray(event.paths) ? event.paths : [];
        const matchedPaths = pattern
          ? paths.filter((p) => {
              const fileName = p.split('/').pop() ?? '';
              return matchGlob(fileName, pattern);
            })
          : paths;

        if (matchedPaths.length === 0) return;

        const payload = {
          data: {
            event: mappedType,
            paths: matchedPaths,
            watchPath,
          },
        };

        this.handleEvent(trigger.id, payload);
      }, { recursive: true });

      this.fileWatchers.set(trigger.id, unwatch);
      console.log(`[Trigger] File watcher started: ${trigger.name} → ${watchPath}`);
    } catch (err) {
      console.error(`[Trigger] Failed to start file watcher for ${trigger.name}:`, err);
      const t = getI18n();
      useToastStore.getState().addToast({
        type: 'error',
        title: t.trigger.triggerError.replace('{name}', trigger.name),
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private startCronTimer(trigger: Trigger) {
    if (trigger.source.type !== 'cron') return;
    if (this.cronTimers.has(trigger.id)) return; // already running

    const intervalMs = trigger.source.intervalSeconds * 1000;
    if (intervalMs < 10_000) {
      console.warn(`[Trigger] Cron interval too short (${trigger.source.intervalSeconds}s), min 10s`);
      return;
    }

    let cronRunCount = 0;
    const timer = setInterval(() => {
      cronRunCount++;
      const payload = {
        data: {
          event: 'cron',
          run: cronRunCount,
          timestamp: Date.now(),
        },
      };
      this.handleEvent(trigger.id, payload);
    }, intervalMs);

    this.cronTimers.set(trigger.id, timer);
    console.log(`[Trigger] Cron timer started: ${trigger.name} every ${trigger.source.intervalSeconds}s`);
  }

  // ── IM source ──

  /** Register a trigger to receive IM messages for its referenced channel */
  private registerIMTrigger(trigger: Trigger) {
    if (trigger.source.type !== 'im') return;
    const channelId = trigger.source.channelId;
    if (!this.imTriggersMap.has(channelId)) {
      this.imTriggersMap.set(channelId, new Set());
    }
    this.imTriggersMap.get(channelId)!.add(trigger.id);

    // Resolve channel name for logging
    const channel = useIMChannelStore.getState().channels[channelId];
    const channelName = channel?.name ?? channelId;
    console.log(`[Trigger] IM listener registered: ${trigger.name} → channel "${channelName}"`);
  }

  /** Unregister a trigger from IM messages */
  private unregisterIMTrigger(triggerId: string) {
    for (const [channelId, triggerIds] of this.imTriggersMap) {
      if (triggerIds.delete(triggerId)) {
        console.log(`[Trigger] IM listener unregistered: ${triggerId} from channel ${channelId}`);
        if (triggerIds.size === 0) {
          this.imTriggersMap.delete(channelId);
        }
      }
    }
  }

  /**
   * Try to match an inbound IM message against registered IM triggers.
   * Called by inboundDispatcher. Returns the number of triggers dispatched.
   * If > 0, the dispatcher will NOT forward the message to channelRouter.
   */
  tryMatchIMTriggers(message: NormalizedIMMessage): number {
    const store = useTriggerStore.getState();
    const channelStore = useIMChannelStore.getState();
    let dispatched = 0;

    for (const [channelId, triggerIds] of this.imTriggersMap) {
      const channel = channelStore.channels[channelId];
      if (!channel || channel.platform !== message.platform) continue;

      for (const triggerId of triggerIds) {
        const trigger = store.triggers[triggerId];
        if (!trigger || trigger.status !== 'active') continue;
        if (trigger.source.type !== 'im') continue;

        // chatId filter
        if (trigger.source.chatId && message.chatId !== trigger.source.chatId) {
          continue;
        }

        // listenScope filter
        if (!this.matchIMScope(trigger.source.listenScope, message)) {
          continue;
        }

        // Build payload and check content filter (keyword/regex/senderMatch)
        const payload: TriggerEventPayload & { _replyContext?: IMReplyContext } = {
          data: {
            platform: message.platform,
            sender: message.senderName,
            senderId: message.senderId,
            text: message.text,
            chatId: message.chatId,
            chatName: message.chatName,
            isDirect: message.isDirect,
            isMention: message.isMention,
          },
          _replyContext: message.replyContext,
        };

        // Pre-check filter synchronously so dispatcher can decide routing
        if (!this.matchFilter(trigger, payload)) {
          continue;
        }

        this.handleEvent(triggerId, payload);
        dispatched++;
      }
    }

    return dispatched;
  }

  /** Check if a message matches the IM trigger's listen scope */
  private matchIMScope(
    scope: 'all' | 'mention_only' | 'direct_only',
    message: NormalizedIMMessage,
  ): boolean {
    switch (scope) {
      case 'all':
        return true;
      case 'mention_only':
        return message.isMention || message.isDirect;
      case 'direct_only':
        return message.isDirect;
    }
  }

  isTriggerRunning(triggerId: string): boolean {
    return this.runningTriggers.has(triggerId);
  }

  private extractLastAIReply(conversationId: string): string | null {
    const conv = useChatStore.getState().conversations[conversationId];
    if (!conv) return null;
    const lastAI = [...conv.messages].reverse().find((m) => m.role === 'assistant');
    if (!lastAI) return null;
    if (typeof lastAI.content === 'string') return lastAI.content;
    return (lastAI.content as { type: string; text?: string }[])
      .filter((c) => c.type === 'text')
      .map((c) => c.text ?? '')
      .join('\n');
  }
}

// Singleton instance
export const triggerEngine = new TriggerEngine();
