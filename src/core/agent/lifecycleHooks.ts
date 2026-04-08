/**
 * Agent Lifecycle Hooks — extensible event system for agent execution
 *
 * Allows registering callbacks at key lifecycle points:
 * - preToolCall: Before a tool is executed (can modify input or block)
 * - postToolCall: After a tool completes (can inspect result)
 * - agentStart: When an agent loop begins
 * - agentEnd: When an agent loop completes
 * - subagentStart: When a subagent is spawned
 * - subagentEnd: When a subagent completes
 * - turnStart: At the beginning of each LLM turn
 * - turnEnd: At the end of each LLM turn
 */

/** Hook event types */
export type HookEventType =
  | 'preToolCall'
  | 'postToolCall'
  | 'agentStart'
  | 'agentEnd'
  | 'subagentStart'
  | 'subagentEnd'
  | 'turnStart'
  | 'turnEnd';

/** Base hook event */
interface BaseHookEvent {
  type: HookEventType;
  timestamp: number;
  conversationId?: string;
}

/** Pre-tool call event — can block or modify */
export interface PreToolCallEvent extends BaseHookEvent {
  type: 'preToolCall';
  toolName: string;
  toolInput: Record<string, unknown>;
  /** Set to true to block the tool call */
  blocked?: boolean;
  /** Override the input (optional) */
  modifiedInput?: Record<string, unknown>;
}

/** Post-tool call event — read-only inspection */
export interface PostToolCallEvent extends BaseHookEvent {
  type: 'postToolCall';
  toolName: string;
  toolInput: Record<string, unknown>;
  result: string;
  error: boolean;
  durationMs: number;
}

/** Agent start/end events */
export interface AgentStartEvent extends BaseHookEvent {
  type: 'agentStart';
  agentName: string;
  loopId: string;
}

export interface AgentEndEvent extends BaseHookEvent {
  type: 'agentEnd';
  agentName: string;
  loopId: string;
  reason: string;
}

/** Subagent start/end events */
export interface SubagentStartEvent extends BaseHookEvent {
  type: 'subagentStart';
  agentName: string;
  task: string;
}

export interface SubagentEndEvent extends BaseHookEvent {
  type: 'subagentEnd';
  agentName: string;
  result: string;
  error: boolean;
}

/** Turn start/end events */
export interface TurnStartEvent extends BaseHookEvent {
  type: 'turnStart';
  turnNumber: number;
  maxTurns?: number; // undefined = unlimited
}

export interface TurnEndEvent extends BaseHookEvent {
  type: 'turnEnd';
  turnNumber: number;
  toolCallCount: number;
}

/** Union of all hook events */
export type HookEvent =
  | PreToolCallEvent
  | PostToolCallEvent
  | AgentStartEvent
  | AgentEndEvent
  | SubagentStartEvent
  | SubagentEndEvent
  | TurnStartEvent
  | TurnEndEvent;

/** Hook handler function */
export type HookHandler<T extends HookEvent = HookEvent> = (event: T) => void | Promise<void>;

/** Registered hook entry */
interface RegisteredHook {
  id: string;
  eventType: HookEventType;
  handler: HookHandler;
  /** Priority (lower = earlier). Default 100. */
  priority: number;
}

// ─── Registry ───

const hooks: RegisteredHook[] = [];

/**
 * Register a lifecycle hook.
 * Returns a cleanup function to unregister.
 */
export function registerHook<T extends HookEvent>(
  eventType: T['type'],
  handler: HookHandler<T>,
  priority: number = 100
): () => void {
  const id = `hook-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  hooks.push({
    id,
    eventType,
    handler: handler as HookHandler,
    priority,
  });
  // Keep sorted by priority
  hooks.sort((a, b) => a.priority - b.priority);

  return () => {
    const index = hooks.findIndex(h => h.id === id);
    if (index >= 0) hooks.splice(index, 1);
  };
}

/**
 * Emit a lifecycle event to all registered hooks.
 * For preToolCall, returns the (possibly modified) event.
 * Returns synchronously when no hooks are registered (fast path).
 */
export function emitHook<T extends HookEvent>(event: T): T | Promise<T> {
  const matching = hooks.filter(h => h.eventType === event.type);

  // Fast path: no hooks registered — return synchronously
  if (matching.length === 0) return event;

  // Async path: run hooks sequentially
  return (async () => {
    for (const hook of matching) {
      try {
        await hook.handler(event);
      } catch (err) {
        console.warn(`[lifecycleHook] Error in ${event.type} hook "${hook.id}":`, err);
      }
    }
    return event;
  })();
}

/**
 * Get count of registered hooks (for debugging/testing)
 */
export function getHookCount(eventType?: HookEventType): number {
  if (eventType) {
    return hooks.filter(h => h.eventType === eventType).length;
  }
  return hooks.length;
}

/**
 * Clear all registered hooks (for testing)
 */
export function clearAllHooks(): void {
  hooks.length = 0;
}
