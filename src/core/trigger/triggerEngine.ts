import { useTriggerStore } from '../../stores/triggerStore';
import { useChatStore } from '../../stores/chatStore';
import { useToastStore } from '../../stores/toastStore';
import { runAgentLoop } from '../agent/agentLoop';
import {
  notifyTriggerCompleted,
  notifyTriggerError,
} from '../../utils/notifications';
import type { Trigger, TriggerEventPayload } from '../../types/trigger';
import { getI18n } from '../../i18n';
import type { ConfirmationInfo, FilePermissionCallback } from '../tools/registry';
import { usePermissionStore } from '../../stores/permissionStore';
import { authorizeWorkspace } from '../tools/pathSafety';
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { watch, type UnwatchFn } from '@tauri-apps/plugin-fs';

/**
 * Auto-deny confirmation callback for trigger tasks.
 * Trigger tasks run unattended, so dangerous commands are automatically rejected.
 */
async function autoDenyConfirmation(_info: ConfirmationInfo): Promise<boolean> {
  console.log('[Trigger] Auto-denied dangerous command:', _info.command);
  return false;
}

/**
 * Auto file permission callback for trigger tasks.
 * Auto-allows paths that have persisted grants; auto-denies everything else.
 */
const autoFilePermission: FilePermissionCallback = async (request) => {
  const permStore = usePermissionStore.getState();
  if (permStore.hasPermission(request.path, request.capability)) {
    authorizeWorkspace(request.path);
    return true;
  }
  console.log(`[Trigger] Auto-denied file access: ${request.path} (${request.capability})`);
  return false;
};

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

    // Start file watchers and cron timers for existing triggers
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

    // Create a hidden conversation (same pattern as scheduler.ts)
    const conversationId = chatStore.createConversation(
      trigger.action.workspacePath ?? null,
      { skipActivate: true }
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

    // Prepend skill if configured
    if (trigger.action.skillName) {
      prompt = `/${trigger.action.skillName} ${prompt}`;
    }

    try {
      await runAgentLoop(conversationId, prompt, {
        commandConfirmCallback: autoDenyConfirmation,
        filePermissionCallback: autoFilePermission,
      });

      useTriggerStore.getState().completeRun(trigger.id, runId);
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

  // ── Filter matching ──

  private matchFilter(trigger: Trigger, payload: TriggerEventPayload): boolean {
    const { filter } = trigger;

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

  /** Start a file watcher or cron timer for a trigger. Safe to call multiple times. */
  startSourceWatcher(trigger: Trigger) {
    if (trigger.source.type === 'file') {
      this.startFileWatcher(trigger);
    } else if (trigger.source.type === 'cron') {
      this.startCronTimer(trigger);
    }
  }

  /** Stop a file watcher or cron timer for a trigger. */
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
  }

  private async startFileWatcher(trigger: Trigger) {
    if (trigger.source.type !== 'file') return;
    if (this.fileWatchers.has(trigger.id)) return; // already watching

    const { path: watchPath, events: watchEvents, pattern } = trigger.source;

    try {
      const unwatch = await watch(watchPath, (event) => {
        // event.type can be: 'create' | 'modify' | 'remove' | 'access' | 'any' | etc.
        const eventType = typeof event.type === 'string' ? event.type : String(event.type);
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

  isTriggerRunning(triggerId: string): boolean {
    return this.runningTriggers.has(triggerId);
  }
}

// Singleton instance
export const triggerEngine = new TriggerEngine();
