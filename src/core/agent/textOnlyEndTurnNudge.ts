/**
 * Text-only end_turn nudge — the `harness.guards.textOnlyEndTurnNudge` guard.
 *
 * A model that has been working with tools and then ends a turn with prose
 * alone ("Next I will edit the file…") has stopped without finishing. When the
 * profile opens this guard, the loop sends one continuation message and lets
 * the model go on, at most {@link TEXT_ONLY_END_TURN_NUDGE_LIMIT} times per
 * run. A turn is nudged when every one of these holds:
 *
 *   1. the turn ended with `end_turn` (a cut-off turn has its own recovery);
 *   2. the turn carried no tool call;
 *   3. an earlier turn of this run carried a tool call (a run that was never
 *      more than a conversation is left alone);
 *   4. the run's most recent tool batch did not call `ask_user_question` (a
 *      reply to the user's answer may legitimately stop and ask again);
 *   5. the turn's text does not ask the user something ({@link textAsksUser}).
 *
 * The counter belongs to one run and is not persisted.
 */
import type { ToolCall } from '../../types';
import { TOOL_NAMES } from '../tools/toolNames';

export const TEXT_ONLY_END_TURN_NUDGE_LIMIT = 2;

export const TEXT_ONLY_END_TURN_NUDGE_MESSAGE =
  'Your reply described work without doing it. Continue executing the task with your tools now, '
  + 'or state explicitly that the task is complete and nothing is left to do.';

/**
 * Phrases that address the user with a question or a request for a decision.
 * Matched case-insensitively anywhere in the text.
 */
const ASKING_PHRASES = [
  // English
  'please confirm',
  'let me know',
  'would you like',
  'do you want',
  'should i ',
  'shall i ',
  'which one',
  'which option',
  'your preference',
  // Chinese
  '请确认',
  '请告诉我',
  '请告知',
  '请选择',
  '请问',
  '是否需要',
  '是否要',
  '需要我',
  '要不要',
  '要我',
  '你希望',
  '您希望',
  '可以吗',
  '好吗',
  '行吗',
];

/** Trailing characters that may follow a question mark at the end of a line. */
const LINE_TAIL = /[\s*_`'")\]）」』】”’。.!！]+$/u;

/** How many lines from the end of the text are read for a closing question mark. */
const CLOSING_LINES = 3;

/**
 * True when the text asks the user something: one of the last three non-empty
 * lines ends with `?` / `？`, or the text contains one of the asking phrases.
 */
export function textAsksUser(text: string): boolean {
  const lines = text.split('\n').map((line) => line.trim()).filter((line) => line.length > 0);
  const closing = lines.slice(-CLOSING_LINES);
  for (const line of closing) {
    const stripped = line.replace(LINE_TAIL, '');
    if (stripped.endsWith('?') || stripped.endsWith('？')) return true;
  }
  const lowered = text.toLowerCase();
  return ASKING_PHRASES.some((phrase) => lowered.includes(phrase));
}

export interface TextOnlyEndTurnObservation {
  /** `profile.harness.guards.textOnlyEndTurnNudge` of the model that ran the turn. */
  enabled: boolean;
  stopReason: string;
  toolCalls: readonly Pick<ToolCall, 'name'>[];
  /** The assistant text of the turn, as the user will see it. */
  text: string;
}

export interface TextOnlyEndTurnNudge {
  /**
   * Record the outcome of a turn and say whether the loop should inject the
   * continuation message and run another turn. Call once per turn, after the
   * stream ended and before the loop decides to stop; a turn with tool calls
   * only updates the run's state and never asks for a nudge.
   */
  observeTurn(observation: TextOnlyEndTurnObservation): boolean;
  /** How many nudges this run has sent so far. */
  readonly count: number;
  /** Whether an earlier turn of this run carried a tool call. */
  readonly sawToolCall: boolean;
}

export function createTextOnlyEndTurnNudge(): TextOnlyEndTurnNudge {
  let count = 0;
  let sawToolCall = false;
  let lastBatchAskedUser = false;
  return {
    get count() {
      return count;
    },
    get sawToolCall() {
      return sawToolCall;
    },
    observeTurn({ enabled, stopReason, toolCalls, text }) {
      if (toolCalls.length > 0) {
        sawToolCall = true;
        lastBatchAskedUser = toolCalls.some((toolCall) => toolCall.name === TOOL_NAMES.ASK_USER_QUESTION);
        return false;
      }
      if (!enabled) return false;
      if (stopReason !== 'end_turn') return false;
      if (!sawToolCall) return false;
      if (lastBatchAskedUser) return false;
      if (textAsksUser(text)) return false;
      if (count >= TEXT_ONLY_END_TURN_NUDGE_LIMIT) return false;
      count++;
      return true;
    },
  };
}
