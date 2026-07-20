/**
 * Per-run conversation read-mirror — P1-3B-3A item 3. A local, in-memory
 * `ConversationReader` implementation, seeded from the full conversation
 * snapshot the shell includes in `agent.run` params, kept coherent for the
 * DURATION OF THE RUN by write-through application of the SAME writes the
 * run's `ChatDelta` sends out as `agent.delta` frames (`onLocalApply`, see
 * `portFrameSenders.ts`'s `createFrameChatDelta`), plus scalar patches
 * pushed in by the shell (`state.convPatch` — workspacePath/title/
 * activeSkills/model changing mid-run, e.g. via `bindWorkspaceFromWrite`).
 *
 * ── Scope: which of the 28 ChatDelta methods get a real apply ───────────
 * Design doc §1 fact 5 enumerates the loop's actual read surface via
 * `ConversationReader`: messages by id (including reading back its OWN
 * just-written message — the "flush-then-read" hazard), `workspacePath`,
 * `activeSkills`, `title`, `indexEntry.model`, `getThinkingStartTime()`.
 * Only the WRITE methods that touch these facts get a real, faithful apply
 * below (mirroring `chatStore.ts`'s own action bodies side by side — same
 * `msgId ?? "last message"` targeting semantics `findTargetMessage`/
 * `FALLBACK_LAST` implement in-process). Every OTHER `ChatDelta` method
 * (`flushTokens`/`updateMessageUsage`/`setExecutionStepsSnapshot`/
 * `setPlannedStepsSnapshot`/`setCurrentUsage`/`setRetryInfo`/
 * `setContextUsage`/`setContextCache`/`clearContextCache`/
 * `setIsCompressing`/`setPendingProposalSignal`/`removeActiveAgent`) is a
 * documented no-op HERE — the frame itself still always travels to the
 * shell (`portFrameSenders.ts`'s `send()` unconditionally pushes), so the
 * shell's REAL `chatStore` stays authoritative and complete; only this
 * LOCAL read-mirror is intentionally partial, because nothing in
 * `ConversationReader`'s read surface depends on those fields.
 *
 * ── Stronger-than-in-process by design ───────────────────────────────────
 * The in-process `chatDelta.appendText`/`updateMessageThinking` RAF-batch
 * tokens (see `chatStore.ts`'s `tokenBuffer`/`thinkingBuffer` +
 * `scheduleFlush`) before mutating the store — so an in-process
 * `conversationReader.getConversation(...).messages` read mid-stream can
 * observe STALE (not-yet-flushed) content. This mirror applies EVERY write
 * immediately, synchronously, in call order — a stronger, more coherent
 * view than the in-process path ever gave the loop. `flushTokens` itself is
 * therefore an intentional no-op here (see the fall-through above): there
 * is no buffer to flush.
 *
 * ── `cancelStreaming` simplification (documented, bounded) ───────────────
 * The real `chatStore.cancelStreaming` appends a cosmetic "*[已停止]*"
 * marker and synthesizes a `thinkingDuration` fallback via `getI18n()`.
 * This mirror only flips `isStreaming` false on the trailing message and
 * clears `thinkingStartTime` — the two read-facts a loop could observe.
 * `agentLoop.ts`'s own `chatDelta.cancelStreaming(...)` call site (the
 * `@abu`-delegate abort-check block) returns immediately afterward without
 * re-reading the message via `ConversationReader`, so this is a bounded,
 * verified-safe simplification, not a silent behavior gap — see
 * P1-3B-3A-REPORT.md.
 */
import type { ChatDelta } from '@/core/agent/ports/chatDelta';
import type { ConversationReader } from '@/core/agent/ports/conversationReader';
import type { Conversation, Message, AgentStatus, ToolCall } from '@/types';
import type { ConversationMeta } from '@/core/session/conversationStorage';

export interface ConversationRunMirrorSeed {
  conversation: Conversation;
  indexEntry?: ConversationMeta;
}

export interface ConversationPatch {
  workspacePath?: string | null;
  title?: string;
  activeSkills?: string[];
  model?: { providerId: string; modelId: string };
}

export interface ConversationRunMirror {
  reader: ConversationReader;
  /** Write-through apply — wire as `createFrameChatDelta(push, applyChatDeltaWrite)`'s `onLocalApply`. */
  applyChatDeltaWrite(method: string, args: unknown[]): void;
  /** Apply a `state.convPatch` notification's scalar-field patch. */
  applyConvPatch(patch: ConversationPatch): void;
  /** Live workspacePath read for the per-run `WorkspaceReader` — always reflects the latest conv-patch/write. */
  getWorkspacePathSnapshot(): string | null;
}

export function createConversationRunMirror(
  conversationId: string,
  seed: ConversationRunMirrorSeed,
): ConversationRunMirror {
  const conversation: Conversation = seed.conversation;
  let indexEntry: ConversationMeta | undefined = seed.indexEntry;
  let thinkingStartTime: number | null = null;

  const reader: ConversationReader = {
    getConversation: (convId) => (convId === conversationId ? conversation : undefined),
    getIndexEntry: (convId) => (convId === conversationId ? indexEntry : undefined),
    getThinkingStartTime: () => thinkingStartTime,
  };

  function findTarget(msgId: string | undefined): Message | undefined {
    if (!conversation.messages.length) return undefined;
    if (msgId !== undefined) return conversation.messages.find((m) => m.id === msgId);
    return conversation.messages[conversation.messages.length - 1];
  }

  function applyChatDeltaWrite(method: string, args: unknown[]): void {
    switch (method as keyof ChatDelta) {
      case 'addMessage': {
        const [, message] = args as [string, Message];
        conversation.messages.push(message);
        conversation.updatedAt = Date.now();
        if (indexEntry) {
          indexEntry = { ...indexEntry, messageCount: conversation.messages.length, updatedAt: conversation.updatedAt };
        }
        break;
      }
      case 'appendText': {
        const [, token, msgId] = args as [string, string, string | undefined];
        const target = findTarget(msgId);
        if (target && typeof target.content === 'string') {
          target.content += token;
        } else if (target && Array.isArray(target.content)) {
          const last = target.content[target.content.length - 1];
          if (last && last.type === 'text') last.text += token;
        }
        break;
      }
      case 'setLastMessageContent': {
        const [, content, msgId] = args as [string, string, string | undefined];
        const target = findTarget(msgId);
        if (target) target.content = content;
        break;
      }
      case 'appendThinking': {
        const [, thinking, msgId] = args as [string, string, string | undefined];
        const target = findTarget(msgId);
        if (target) target.thinking = (target.thinking ?? '') + thinking;
        break;
      }
      case 'setThinkingDuration': {
        const [, duration, msgId] = args as [string, number, string | undefined];
        const target = findTarget(msgId);
        if (target) target.thinkingDuration = duration;
        break;
      }
      case 'finishStreaming': {
        const [, msgId] = args as [string, string | undefined];
        const target = findTarget(msgId);
        if (target) target.isStreaming = false;
        break;
      }
      case 'cancelStreaming': {
        // See module doc's "cancelStreaming simplification" section.
        const last = conversation.messages[conversation.messages.length - 1];
        if (last) last.isStreaming = false;
        thinkingStartTime = null;
        break;
      }
      case 'deactivateSkills': {
        conversation.activeSkills = [];
        break;
      }
      case 'setMessageStreamingFlag': {
        const [, messageId, streaming] = args as [string, string, boolean];
        const msg = conversation.messages.find((m) => m.id === messageId);
        if (msg) msg.isStreaming = streaming;
        break;
      }
      case 'setMessageToolCalls': {
        const [, messageId, toolCalls] = args as [string, string, Message['toolCalls']];
        const msg = conversation.messages.find((m) => m.id === messageId);
        if (msg) {
          msg.toolCalls = toolCalls;
          msg.isStreaming = false;
        }
        break;
      }
      case 'updateToolCall': {
        const [, messageId, toolCallId, result, resultContent, isError, hideScreenshot] = args as [
          string, string, string, string,
          ToolCall['resultContent'],
          boolean | undefined, boolean | undefined,
        ];
        const msg = conversation.messages.find((m) => m.id === messageId);
        const tc = msg?.toolCalls?.find((t) => t.id === toolCallId);
        if (tc) {
          tc.result = result;
          if (resultContent) tc.resultContent = resultContent;
          if (isError) tc.isError = true;
          if (hideScreenshot != null) tc.hideScreenshot = hideScreenshot;
          tc.isExecuting = false;
        }
        break;
      }
      case 'deleteMessage': {
        const [, messageId] = args as [string, string];
        conversation.messages = conversation.messages.filter((m) => m.id !== messageId);
        conversation.updatedAt = Date.now();
        break;
      }
      case 'appendToolCallContext': {
        const [, loopId, context] = args as [string, string, NonNullable<Message['toolCallsForContext']>[number]];
        for (let i = conversation.messages.length - 1; i >= 0; i--) {
          const msg = conversation.messages[i];
          if (msg.role === 'assistant' && msg.loopId === loopId) {
            if (!msg.toolCallsForContext) msg.toolCallsForContext = [];
            msg.toolCallsForContext.push(context);
            break;
          }
        }
        break;
      }
      case 'setConversationStatus': {
        const [, status] = args as [string, Conversation['status']];
        conversation.status = status;
        break;
      }
      case 'setConversationModel': {
        const [, model] = args as [string, Conversation['model']];
        conversation.model = model;
        if (indexEntry) indexEntry = { ...indexEntry, model };
        break;
      }
      case 'setAgentStatus': {
        const [status] = args as [AgentStatus, string | undefined, string | undefined];
        if (status === 'thinking') thinkingStartTime = Date.now();
        else if (status === 'idle') thinkingStartTime = null;
        break;
      }
      default:
        // See module doc — every other ChatDelta method doesn't feed any of
        // this mirror's read facts. No-op; the frame still ships to the shell.
        break;
    }
  }

  function applyConvPatch(patch: ConversationPatch): void {
    if (Object.prototype.hasOwnProperty.call(patch, 'workspacePath')) {
      conversation.workspacePath = patch.workspacePath;
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'title') && patch.title !== undefined) {
      conversation.title = patch.title;
      if (indexEntry) indexEntry = { ...indexEntry, title: patch.title };
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'activeSkills')) {
      conversation.activeSkills = patch.activeSkills;
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'model')) {
      conversation.model = patch.model;
      if (indexEntry) indexEntry = { ...indexEntry, model: patch.model };
    }
  }

  function getWorkspacePathSnapshot(): string | null {
    return conversation.workspacePath ?? null;
  }

  return { reader, applyChatDeltaWrite, applyConvPatch, getWorkspacePathSnapshot };
}
