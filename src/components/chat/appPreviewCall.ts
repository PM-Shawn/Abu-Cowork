import type { Message } from '@/types';
import { TOOL_NAMES } from '@/core/tools/toolNames';

/**
 * The app preview card follows the conversation's latest `app_prepare`, and
 * only when that call found a ready draft: an earlier preview is out of date
 * once the draft changed.
 */
export function latestAppPreviewCallId(messages: readonly Message[] | undefined): string | undefined {
  for (const message of [...(messages ?? [])].reverse()) {
    const call = [...(message.toolCalls ?? [])].reverse().find((toolCall) => toolCall.name === TOOL_NAMES.APP_PREPARE);
    if (!call) continue;
    if (call.result === undefined || call.isError || call.isExecuting) return undefined;
    return (JSON.parse(call.result) as { status: string }).status === 'ready' ? call.id : undefined;
  }
  return undefined;
}
