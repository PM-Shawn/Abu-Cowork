/** 追加给模型、不显示给用户的纠错消息。 */
export const MALFORMED_TOOL_CALL_NUDGE =
  'The tool call in your previous reply could not be parsed, so nothing was executed. '
  + 'Call the tool again using the native tool-calling format with complete, valid arguments.';

export type MalformedToolCallDecision = 'retry' | 'give-up';

/** 本轮第一次写坏悄悄重写，连续第二次就在回答里说明并结束。 */
export function createMalformedToolCallGuard(): { decide(): MalformedToolCallDecision; reset(): void } {
  let retried = false;
  return {
    decide(): MalformedToolCallDecision {
      if (retried) return 'give-up';
      retried = true;
      return 'retry';
    },
    reset(): void {
      retried = false;
    },
  };
}
