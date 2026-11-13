/**
 * Compaction: summarize a long history so the task can go on.
 *
 * Shared by the main loop, the subagent loop and manual /compact. Imports no
 * store, so it is bundle-safe for the sidecar.
 */

import {
  createCompactBoundaryMarker,
  planStepCompaction,
} from './compactBoundary';
import { writeCompactionSummary, type SummaryRequest } from './contextCompressor';
import { estimateMessageTokens, estimateTokens } from './tokenEstimator';
import type { Message, RestoredFile, ToolExecutionContext, ToolResultContent } from '@/types';

/** Compact once the next request would use this share of the input budget (Codex: 90 %). */
export const COMPACTION_TRIGGER_RATIO = 0.9;

/** Share of the room left for the conversation kept verbatim as the newest steps (DSH: 16 %). */
export const RETAINED_TAIL_RATIO = 0.15;

/**
 * Upper bounds of what a compaction keeps besides the summary: the user's own
 * messages (Codex keeps 20 000 tokens of them) and the re-read files (Claude
 * Code keeps 5 files of at most 5 000 tokens each). Each is held to a tenth of
 * the room left for the conversation (see `compactHistory`), so a small window
 * keeps room for the task itself.
 */
const USER_MESSAGE_BUDGET_TOKENS = 20_000;
const RESTORED_FILES_BUDGET_TOKENS = 25_000;
const RESTORED_FILE_MAX_TOKENS = 5_000;
const KEPT_SHARE_OF_BUDGET = 0.1;

const RESTORED_FILE_CUT_NOTE = '[... the rest of this file is not shown; read it again with read_file if you need it ...]';

const ATTACHMENT_NOTE = '[An image or document was attached here; it is not part of this summary request]';
const RESULT_IMAGES_NOTE = '[The result included images; they are not part of this summary request]';

/** Reads a file through the read_file tool; null when it cannot be read. */
export type RestoredFileReader = (path: string) => Promise<string | null>;

/**
 * The summary request carries text only: every image or document becomes a
 * one-line note, so no picture is re-sent (or re-read from disk) to be
 * summarized.
 */
function textOnly(messages: Message[]): Message[] {
  const withoutResultImages = <T extends { result?: string; resultContent?: ToolResultContent[] }>(call: T): T => {
    if (!call.resultContent?.some((block) => block.type === 'image')) return call;
    return {
      ...call,
      result: call.result ? `${call.result}\n${RESULT_IMAGES_NOTE}` : RESULT_IMAGES_NOTE,
      resultContent: call.resultContent.filter((block) => block.type === 'text'),
    };
  };
  return messages.map((message) => ({
    ...message,
    content: typeof message.content === 'string'
      ? message.content
      : message.content.map((block) => (block.type === 'text' ? block : { type: 'text' as const, text: ATTACHMENT_NOTE })),
    toolCalls: message.toolCalls?.map(withoutResultImages),
    toolCallsForContext: message.toolCallsForContext?.map(withoutResultImages),
  }));
}

function keptBudget(room: number, cap: number): number {
  return Math.min(cap, Math.floor(room * KEPT_SHARE_OF_BUDGET));
}

async function restoreFiles(
  paths: string[],
  readFile: RestoredFileReader,
  room: number,
  signal?: AbortSignal,
): Promise<RestoredFile[]> {
  const totalBudget = keptBudget(room, RESTORED_FILES_BUDGET_TOKENS);
  const fileBudget = Math.min(RESTORED_FILE_MAX_TOKENS, totalBudget);
  const restored: RestoredFile[] = [];
  let used = 0;
  for (const path of paths) {
    signal?.throwIfAborted();
    const content = await readFile(path);
    signal?.throwIfAborted();
    if (content === null) continue;
    const tokens = estimateTokens(content);
    const kept = tokens <= fileBudget
      ? content
      : `${content.slice(0, Math.floor(content.length * (fileBudget / tokens)))}\n${RESTORED_FILE_CUT_NOTE}`;
    const keptTokens = Math.min(tokens, fileBudget);
    if (used + keptTokens > totalBudget) break;
    used += keptTokens;
    restored.push({ path, content: kept });
  }
  return restored;
}

/**
 * Compact one history: summarize everything before the newest steps worth
 * `retainShare` of the room and return the marker that records it. The room is
 * what the conversation may use: the input budget minus `fixedTokens` (the
 * system prompt and the tool definitions). What compaction keeps (the newest
 * steps, the user's messages, the re-read files) is sized from it, so a long
 * fixed part cannot leave a floor that fills the budget before the run's next
 * step is added. The caller adds the marker.
 * Returns null when there is nothing to summarize; throws when the summary
 * request fails (after its retries).
 */
export async function compactHistory(params: {
  history: Message[];
  inputBudget: number;
  fixedTokens: number;
  retainShare: number;
  source: 'auto' | 'manual';
  loopId?: string;
  summary: SummaryRequest;
  /**
   * Fits the complete summary request, including its instruction, into the window.
   * Needed after the provider refused a request as too long: the view up to
   * the tail is then about as long as the refused request.
   */
  fitSummaryInput?: (messages: Message[]) => Message[];
  readFile: RestoredFileReader;
  now: () => number;
}): Promise<Message | null> {
  const room = Math.max(0, params.inputBudget - params.fixedTokens);
  const plan = planStepCompaction(params.history, {
    retainTokens: Math.floor(room * params.retainShare),
    userMessageBudget: keptBudget(room, USER_MESSAGE_BUDGET_TOKENS),
    estimateTokens: estimateMessageTokens,
  });
  if (!plan) return null;
  const summarize = textOnly(plan.summarize);
  const summaryText = await writeCompactionSummary(summarize, params.summary, params.fitSummaryInput);
  params.summary.signal?.throwIfAborted();
  const restoredFiles = await restoreFiles(plan.readFilePaths, params.readFile, room, params.summary.signal);
  params.summary.signal?.throwIfAborted();
  return createCompactBoundaryMarker({
    summaryText,
    summarizedFromId: plan.summarizedFromId,
    summarizedToId: plan.summarizedToId,
    keptUserMessageIds: plan.keptUserMessageIds,
    cutUserMessage: plan.cutUserMessage,
    restoredFiles,
    source: params.source,
    loopId: params.loopId,
    timestamp: params.now(),
  });
}

/**
 * A read_file call made on the compaction's behalf. It asks for nothing: a
 * file whose access would need the user's permission is left out.
 */
export function readFileThroughTool(
  execute: (input: Record<string, unknown>, context: ToolExecutionContext) => Promise<string>,
  context: ToolExecutionContext,
): RestoredFileReader {
  return async (path) => {
    let readText = false;
    const result = await execute({ path }, {
      ...context,
      allowPermissionPrompts: false,
      reportMetadata: (metadata) => {
        if (metadata.fileReadOutcome?.kind === 'text' || metadata.fileReadOutcome?.kind === 'document') readText = true;
      },
    });
    return readText ? result : null;
  };
}
