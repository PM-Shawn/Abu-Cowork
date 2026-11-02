/**
 * The summary request of a compaction.
 *
 * The request is the conversation itself — the model's current view up to the
 * retained tail — followed by one instruction. It reuses the conversation's
 * own request options (model, credentials, system prompt, tools, reasoning
 * settings), so it shares the conversation's cached prefix and costs about as
 * much as one ordinary request. DSH's `summarizer.ts` builds its request the
 * same way.
 *
 * Transient provider errors are retried like every other request; an error
 * that survives the retries is thrown to the caller, which stops the run.
 */

import type { Message } from '../../types';
import { LLMError, type ChatOptions, type LLMAdapter } from '../llm/adapter';
import { withRetry } from '../agent/retry';

/** Everything the summary request needs besides the conversation. */
export interface SummaryRequest {
  adapter: LLMAdapter;
  /**
   * The conversation's own request options. `maxTokens` and the reasoning
   * settings are kept as they are, so a thinking budget stays below the
   * output budget it belongs to.
   */
  chatOptions: ChatOptions;
  /** Accounting: whose usage the summary is. The source is always `compaction`. */
  conversationId: string | null;
  providerInstanceId: string;
  signal?: AbortSignal;
  /**
   * Anchor preservation (labs: state-preserving-compression, read by the
   * caller through compressionTuning). The instruction then asks the summary
   * to copy task anchors verbatim; compactHistory additionally appends the
   * deterministic `[kept anchors]` block.
   */
  preserveAnchors?: boolean;
}

const SUMMARY_INSTRUCTION = `Stop working on the task for a moment. The conversation is close to the context limit, so write a summary that another assistant will continue the task from. The summary replaces every message above, so include everything needed to carry on.

Do not call any tools. Reply with the summary only, in Markdown, with these sections:

1. Primary request and intent — what the user asked for, quoting their exact words where they matter.
2. Key concepts — technical facts, decisions and constraints the work depends on.
3. Files and code — every file read, created or changed, with the parts that matter and why.
4. Errors and fixes — what went wrong and how it was resolved.
5. Done so far — the steps that are complete, so they are not repeated.
6. Still to do — the remaining work.
7. Current work — exactly what was being done when this summary was requested.
8. Next step — the very next action, in line with the user's latest request.
9. Data to keep — values, identifiers, paths, numbers and results the next steps need.

If an earlier summary appears above, merge it into this one. If the assistant said it could not do something or lacked a tool, do not record that as a fact: tools may have been installed since.`;

// Appended to SUMMARY_INSTRUCTION when anchor preservation is on: the summary
// itself must carry the anchors, on top of the deterministic block
// compactHistory appends regardless of what the summary model kept.
const SUMMARY_INSTRUCTION_ANCHORS = `

10. Kept anchors — copy verbatim every plan-step line, file path and URL that appears in the conversation above, exactly as written.`;

export async function writeCompactionSummary(
  messages: Message[],
  request: SummaryRequest,
  fitInput?: (messages: Message[]) => Message[],
): Promise<string> {
  const instruction: Message = {
    id: 'compaction-instruction',
    role: 'user',
    content: SUMMARY_INSTRUCTION + (request.preserveAnchors ? SUMMARY_INSTRUCTION_ANCHORS : ''),
    timestamp: 0,
  };
  const requestedMessages = [...messages, instruction];
  const sentMessages = fitInput ? fitInput(requestedMessages) : requestedMessages;
  let summary = '';
  let streamError: string | undefined;
  let cancelled = false;
  let usedTools = false;
  await withRetry(
    async () => {
      summary = '';
      streamError = undefined;
      cancelled = false;
      usedTools = false;
      await request.adapter.chat(
        sentMessages,
        {
          ...request.chatOptions,
          volatileContextTail: undefined,
          signal: request.signal,
          accounting: {
            source: 'compaction',
            conversationId: request.conversationId,
            skill: null,
            providerInstanceId: request.providerInstanceId,
          },
        },
        (event) => {
          if (event.type === 'text') summary += event.text;
          if (event.type === 'error') streamError = event.error;
          if (event.type === 'tool_use') usedTools = true;
          if (event.type === 'done' && event.stopReason === 'cancelled') cancelled = true;
        },
      );
    },
    { maxRetries: 3, baseDelayMs: 1000, maxDelayMs: 30000 },
    request.signal,
  );
  if (request.signal?.aborted || cancelled) {
    throw new LLMError('The compaction summary request was cancelled', 'cancelled', { retryable: false });
  }
  if (streamError !== undefined) {
    throw new LLMError(`The compaction summary request failed: ${streamError}`, 'network_error', { retryable: false });
  }
  if (usedTools) {
    throw new LLMError('The compaction summary response contained a tool call', 'invalid_request', { retryable: false });
  }
  const text = summary.trim();
  if (!text) {
    throw new LLMError('The compaction summary came back empty', 'invalid_request', { retryable: false });
  }
  return text;
}
