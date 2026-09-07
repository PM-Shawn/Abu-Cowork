import type { Message } from '../../types';

/**
 * Per-hand-off input queue for a RUNNING team member (in-conversation team,
 * block M "直接对某队员说话"). Keyed by the same `${toolCallId}:${taskIndex}`
 * dispatch key the stop button uses (subagentAbort.ts). Pure module: it is
 * bundled into the sidecar next to subagentLoop, so the loop drains the queue
 * of the process it runs in; the renderer tells both processes and each side
 * only accepts a key it currently owns (isDispatchActive).
 */
const queues = new Map<string, string[]>();

/** Step name the member's process shows for an injected instruction. */
export const MEMBER_INSTRUCTION_STEP = 'member_instruction';

export function enqueueDispatchInput(dispatchKey: string, text: string): void {
  const trimmed = text.trim();
  if (!trimmed) return;
  const queue = queues.get(dispatchKey);
  if (queue) queue.push(trimmed);
  else queues.set(dispatchKey, [trimmed]);
}

/** Take (and remove) everything queued for this hand-off, oldest first. */
export function drainDispatchInputs(dispatchKey: string): string[] {
  const queue = queues.get(dispatchKey);
  if (!queue) return [];
  queues.delete(dispatchKey);
  return queue;
}

export function hasDispatchInput(dispatchKey: string): boolean {
  return (queues.get(dispatchKey)?.length ?? 0) > 0;
}

/** Drop anything still queued — called when the hand-off settles so nothing leaks. */
export function clearDispatchInputs(dispatchKey: string): void {
  queues.delete(dispatchKey);
}

// Instructions the user sent to a hand-off, kept SHELL-side regardless of
// which process runs the member loop, so the dispatch tool can tell the
// leader about them structurally when the hand-off returns (a prompt rule
// alone was ignored — retest G1, 2026-09-07).
const delivered = new Map<string, string[]>();

export function noteDeliveredInstruction(dispatchKey: string, text: string): void {
  const trimmed = text.trim();
  if (!trimmed) return;
  const list = delivered.get(dispatchKey);
  if (list) list.push(trimmed);
  else delivered.set(dispatchKey, [trimmed]);
}

/** Take (and forget) the instructions delivered to this hand-off. */
export function takeDeliveredInstructions(dispatchKey: string): string[] {
  const list = delivered.get(dispatchKey);
  if (!list) return [];
  delivered.delete(dispatchKey);
  return list;
}

/**
 * Put an instruction in front of the model as user content without breaking
 * role alternation: merged into a trailing user message (turn 0, or a
 * recovery re-prompt), otherwise appended as a new user message.
 */
export function appendInstructionToHistory(messages: Message[], text: string, id: string): void {
  const last = messages[messages.length - 1];
  if (last && last.role === 'user') {
    if (typeof last.content === 'string') {
      last.content = last.content ? `${last.content}\n\n${text}` : text;
    } else {
      last.content = [...last.content, { type: 'text', text }];
    }
    return;
  }
  messages.push({ id, role: 'user', content: text, timestamp: Date.now() });
}
