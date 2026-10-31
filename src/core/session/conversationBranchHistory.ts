import type { ConversationBranchOrigin, Message } from '@/types';
import type { ExecutionStepSnapshot } from '@/types/execution';
import { getMessageText } from '@/core/context/contextUtils';

export type ConversationBranchHistoryFailure = 'inaccessible' | 'unavailable' | 'incomplete' | 'invalid-history' | 'invalid-id';

export type ConversationBranchEligibility =
  | { eligible: true; targetIndex: number; turnStartIndex: number }
  | { eligible: false; reason: ConversationBranchHistoryFailure };

export class ConversationBranchHistoryError extends Error {
  readonly code: ConversationBranchHistoryFailure;

  constructor(code: ConversationBranchHistoryFailure) {
    super(`Cannot build conversation branch: ${code}`);
    this.name = 'ConversationBranchHistoryError';
    this.code = code;
  }
}

// ChatView groups visible user messages; hidden recovery prompts stay in that turn.
function startsTurn(message: Message): boolean {
  return message.role === 'user'
    && (!message.isSystem || !!message.isRecoveryNotice || !!message.goalRound);
}

export function isConversationBranchReply(message: Message): boolean {
  return message.role === 'assistant' && !message.isSystem && !message.introduction
    && !message.compactBoundary && !message.browserRunReport && !message.maxTurnsNotice
    && !!(getMessageText(message.content).trim() || message.toolCalls?.length
      || message.toolCallsForContext?.length || message.thinking);
}

/** The action and creation command share the same ended-turn boundary. */
export function getConversationBranchEligibility(
  messages: readonly Message[],
  targetMessageId: string,
  accessAllowed: boolean,
  historySource: 'live' | 'saved' = 'live',
): ConversationBranchEligibility {
  if (!accessAllowed) return { eligible: false, reason: 'inaccessible' };
  const targetIndex = messages.findIndex(message => message.id === targetMessageId);
  const target = messages[targetIndex];
  if (!target || !isConversationBranchReply(target)) {
    return { eligible: false, reason: 'unavailable' };
  }
  let turnStartIndex = targetIndex - 1;
  while (turnStartIndex >= 0 && !startsTurn(messages[turnStartIndex])) turnStartIndex -= 1;
  if (turnStartIndex < 0) return { eligible: false, reason: 'unavailable' };
  let turnEndIndex = targetIndex + 1;
  while (turnEndIndex < messages.length && !startsTurn(messages[turnEndIndex])) turnEndIndex += 1;
  const turn = messages.slice(turnStartIndex, turnEndIndex);
  const lastAssistant = turn.filter(isConversationBranchReply).at(-1);
  const user = messages[turnStartIndex];
  if (lastAssistant !== target) {
    return { eligible: false, reason: 'unavailable' };
  }
  // Persisted terminal run states also cover interrupted streams and tools.
  // Older transcripts use active execution flags without requiring usage metadata.
  if (ACTIVE_RUN_STATES.has(user.runState)
    || (historySource === 'live' && user.runState === undefined && turn.some(message => message.isStreaming
      || ACTIVE_RUN_STATES.has(message.runState)
      || message.toolCalls?.some(tool => tool.isExecuting
        || tool.sandboxRecoveryAction === 'pending' || tool.sandboxRecoveryAction === 'enqueued'
        || tool.sandboxRecoveryAction === 'started')))) {
    return { eligible: false, reason: 'incomplete' };
  }
  return { eligible: true, targetIndex, turnStartIndex };
}

export interface ConversationBranchHistoryOptions {
  sourceConversationId: string;
  childConversationId: string;
  sourceTitle: string;
  messages: readonly Message[];
  targetMessageId: string;
  accessAllowed: boolean;
  /** Supplies fresh globally unique IDs; this module reads no clock or entropy. */
  createId(kind: 'message' | 'loop' | 'step' | 'detail'): string;
}

export interface ConversationBranchHistory {
  messages: Message[];
  branchOrigin: ConversationBranchOrigin;
  /** Used by the file-copy stage to remap user-upload manifest references. */
  messageIdMap: ReadonlyMap<string, string>;
}

const MARKER_PREFIXES = ['compact-boundary-', 'browser-run-report-', 'max-turns-', 'expert-introduction:'];
const ACTIVE_RUN_STATES = new Set<Message['runState']>(['pending', 'accepted', 'running', 'recovering']);
const UNKNOWN_TOOL_RESULT = 'The inherited history contains no recorded result for this tool call. Its outcome is unknown. Before repeating an operation that changes files or external state, verify its current outcome. Do not automatically replay it.';
const INTERRUPTED_TOOL_RESULTS = new Set(['[Tool execution interrupted by user]', '[Tool execution was interrupted]', '[Cancelled]', '[已取消]']);

function needsToolOutcome(result: string | undefined, resultContent: unknown, isExecuting = false): boolean {
  return isExecuting || (result === undefined && resultContent === undefined)
    || (result !== undefined && INTERRUPTED_TOOL_RESULTS.has(result));
}

function withUnknownToolOutcome(result: string | undefined): string {
  return result ? `${result}\n${UNKNOWN_TOOL_RESULT}` : UNKNOWN_TOOL_RESULT;
}

/** Builds detached history only. Files must be installed before publishing it. */
export function buildConversationBranchHistory(options: ConversationBranchHistoryOptions): ConversationBranchHistory {
  const eligibility = getConversationBranchEligibility(options.messages, options.targetMessageId, options.accessAllowed);
  if (!eligibility.eligible) throw new ConversationBranchHistoryError(eligibility.reason);
  if (!options.sourceConversationId || !options.childConversationId
    || options.sourceConversationId === options.childConversationId) {
    throw new ConversationBranchHistoryError('invalid-id');
  }
  const prefix = options.messages.slice(0, eligibility.targetIndex + 1);
  const messageIdMap = new Map<string, string>();
  const sourceIndexes = new Map<string, number>();
  const usedIds = new Set(options.messages.flatMap(message => [message.id, ...(message.loopId ? [message.loopId] : [])]));
  usedIds.add(options.sourceConversationId);
  usedIds.add(options.childConversationId);
  function reserveStepIds(steps: ExecutionStepSnapshot[]): void {
    for (const step of steps) {
      usedIds.add(step.id);
      for (const block of step.detailBlocks ?? []) usedIds.add(block.id);
      reserveStepIds(step.childSteps ?? []);
    }
  }
  for (const message of prefix) reserveStepIds(message.executionSteps ?? []);
  function newId(kind: Parameters<ConversationBranchHistoryOptions['createId']>[0], markerPrefix = ''): string {
    const supplied = options.createId(kind);
    const id = markerPrefix + supplied;
    if (!supplied || usedIds.has(supplied) || usedIds.has(id)) throw new ConversationBranchHistoryError('invalid-id');
    usedIds.add(supplied);
    usedIds.add(id);
    return id;
  }
  prefix.forEach((message, index) => {
    if (!message.id || sourceIndexes.has(message.id)) throw new ConversationBranchHistoryError('invalid-history');
    sourceIndexes.set(message.id, index);
    const markerPrefix = MARKER_PREFIXES.find(value => message.id.startsWith(value));
    messageIdMap.set(message.id, newId('message', markerPrefix));
  });
  function mappedMessage(id: string): string {
    const mapped = messageIdMap.get(id);
    if (!mapped) throw new ConversationBranchHistoryError('invalid-history');
    return mapped;
  }
  const stepIds = new Map<string, string>();
  const detailIds = new Map<string, string>();
  function mappedLocalId(id: string, kind: 'step' | 'detail', map: Map<string, string>): string {
    if (!id) throw new ConversationBranchHistoryError('invalid-history');
    const previous = map.get(id);
    if (previous) return previous;
    const mapped = newId(kind);
    map.set(id, mapped);
    return mapped;
  }
  function remapSteps(steps: ExecutionStepSnapshot[]): void {
    for (const step of steps) {
      step.id = mappedLocalId(step.id, 'step', stepIds);
      for (const block of step.detailBlocks ?? []) block.id = mappedLocalId(block.id, 'detail', detailIds);
      remapSteps(step.childSteps ?? []);
    }
  }
  let loops = new Map<string, string>();
  let turnLoopId: string | undefined;
  const messages = prefix.map((original, index) => {
    const message = structuredClone(original);
    message.id = mappedMessage(original.id);
    message.inheritedFromBranch = true;
    message.isStreaming = false;
    delete message.runId;
    delete message.clientMessageId;
    if (ACTIVE_RUN_STATES.has(message.runState)) message.runState = 'interrupted';
    if (startsTurn(original)) {
      loops = new Map();
      turnLoopId = newId('loop');
      if (original.loopId) loops.set(original.loopId, turnLoopId);
    }
    if (original.loopId) {
      let loopId = loops.get(original.loopId);
      if (!loopId) {
        loopId = newId('loop');
        loops.set(original.loopId, loopId);
      }
      message.loopId = loopId;
    } else if (turnLoopId && message.role !== 'system' && !message.introduction) {
      message.loopId = turnLoopId;
    }
    const boundary = message.compactBoundary;
    if (boundary) {
      if (!original.id.startsWith('compact-boundary-')) throw new ConversationBranchHistoryError('invalid-history');
      if (boundary.status !== 'failed') {
        const from = sourceIndexes.get(boundary.summarizedFromId);
        const to = sourceIndexes.get(boundary.summarizedToId);
        if (from === undefined || to === undefined || from > to || to >= index) {
          throw new ConversationBranchHistoryError('invalid-history');
        }
        for (const keptId of boundary.keptUserMessageIds ?? []) {
          const keptIndex = sourceIndexes.get(keptId);
          if (keptIndex === undefined || keptIndex > to || prefix[keptIndex].role !== 'user' || prefix[keptIndex].isSystem) {
            throw new ConversationBranchHistoryError('invalid-history');
          }
        }
        if (boundary.cutUserMessage && !boundary.keptUserMessageIds?.includes(boundary.cutUserMessage.id)) {
          throw new ConversationBranchHistoryError('invalid-history');
        }
      }
      boundary.summarizedFromId = boundary.status === 'failed' && boundary.summarizedFromId === ''
        ? '' : mappedMessage(boundary.summarizedFromId);
      boundary.summarizedToId = boundary.status === 'failed' && boundary.summarizedToId === ''
        ? '' : mappedMessage(boundary.summarizedToId);
      if (boundary.keptUserMessageIds) boundary.keptUserMessageIds = boundary.keptUserMessageIds.map(mappedMessage);
      if (boundary.cutUserMessage) boundary.cutUserMessage.id = mappedMessage(boundary.cutUserMessage.id);
    }
    const unknownCalls = new Set((message.toolCalls ?? []).filter(tool =>
      needsToolOutcome(tool.result, tool.resultContent, tool.isExecuting)).map(tool => tool.id));
    for (const tool of message.toolCalls ?? []) {
      tool.isExecuting = false;
      if (unknownCalls.has(tool.id)) {
        tool.result = withUnknownToolOutcome(tool.result);
        tool.isError = true;
      }
      if (tool.sandboxRecoveryAction === 'pending' || tool.sandboxRecoveryAction === 'enqueued' || tool.sandboxRecoveryAction === 'started') {
        tool.sandboxRecoveryAction = 'stopped';
      }
      if (tool.batchTerminalSummary) {
        const batch = tool.batchTerminalSummary.batch;
        if (batch.conversationId !== options.sourceConversationId) throw new ConversationBranchHistoryError('invalid-history');
        batch.conversationId = options.childConversationId;
        batch.assistantMessageId = batch.assistantMessageId ? mappedMessage(batch.assistantMessageId) : message.id;
      }
    }
    for (const tool of message.toolCallsForContext ?? []) {
      if (needsToolOutcome(tool.result, tool.resultContent) || (tool.id !== undefined && unknownCalls.has(tool.id))) {
        tool.result = withUnknownToolOutcome(tool.result);
        tool.isError = true;
      } else if (tool.id !== undefined) {
        const display = message.toolCalls?.find(candidate => candidate.id === tool.id);
        if (display?.isError) tool.isError = true;
      }
    }
    remapSteps(message.executionSteps ?? []);
    return message;
  });
  return {
    messages,
    messageIdMap,
    branchOrigin: {
      version: 1,
      sourceConversationId: options.sourceConversationId,
      sourceMessageId: options.targetMessageId,
      sourceTitle: options.sourceTitle,
      inheritedThroughMessageId: mappedMessage(options.targetMessageId),
    },
  };
}
