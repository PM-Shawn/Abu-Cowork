/**
 * Shared tool-media transport-failure vocabulary — ONE definition for both
 * sides of the sidecar→shell wire.
 *
 * The SENDER (`sidecar/src/portFrameSenders.ts`) uses it when it cannot
 * encode a tool call's inline media into a delegated ref before pushing the
 * frame. The RECEIVER (`src/core/agent/agentLoopRunner.ts`, through
 * `degradeDeltaFramesForMediaFailure` below) uses the same label when a
 * frame arrives carrying raw base64 anyway. One definition means a degraded
 * tool call reads identically no matter which side caught the failure.
 *
 * Plain module — no store, no i18n, no privileged imports. It is bundled
 * into the sidecar as-is (deliberately NOT listed in `scripts/
 * build-sidecar.mjs`'s SHIM_TARGETS); its only runtime dependency,
 * `delegatedUserTurnMaterializer.ts`, is already bundled for the sidecar
 * today via `portFrameSenders.ts`. The `PortFrame` import is type-only, so
 * this module carries no runtime edge to the store-backed applier.
 */
import type { PortFrame } from '@/core/agent/frameApplier';
import {
  redactSidecarValueForWireFailure,
  sidecarValueHasOpaqueMediaRefs,
} from './delegatedUserTurnMaterializer';

export const TOOL_MEDIA_TRANSPORT_ERROR = 'Error: Could not prepare sidecar tool media for transport.';

/**
 * Settle one tool call as a media-transport failure: scrub any raw media
 * still on it, then stamp the terminal state. `isExecuting: false` is the
 * load-bearing field — without it a dispatch whose media failed stays stuck
 * at "executing" forever.
 */
export function markToolCallMediaTransportFailure<T>(toolCall: T): T {
  if (!toolCall || typeof toolCall !== 'object' || Array.isArray(toolCall)) return toolCall;
  const safe = redactSidecarValueForWireFailure(toolCall) as Record<string, unknown>;
  return {
    ...safe,
    result: TOOL_MEDIA_TRANSPORT_ERROR,
    resultContent: undefined,
    isError: true,
    isExecuting: false,
  } as T;
}

/** Positional index of `result` in `ChatDelta.updateToolCall`'s args (chatDelta.ts). */
const UPDATE_TOOL_CALL_RESULT_INDEX = 3;

/**
 * chat-port methods whose args identify the tool call the frame mutates
 * (chatDelta.ts signatures). `checkpointToolCallMetadata` belongs here for
 * identity, but its args are `(convId, messageId, toolCallId, metadata)` —
 * `ToolExecutionMetadata` has no `result`/`isExecuting` slot to stamp, and
 * the store's `checkpointToolCallMetadata` never sets `isExecuting`, so a
 * degraded checkpoint frame is redaction-only: it cannot leave a call stuck.
 */
function degradeChatFrameArgs(method: string, args: unknown[]): unknown[] {
  if (method === 'appendMessageToolCall' || method === 'appendToolCallContext') {
    if (args.length < 3) return args;
    const next = args.slice();
    next[2] = markToolCallMediaTransportFailure(next[2]);
    return next;
  }
  if (method === 'setMessageToolCalls') {
    if (!Array.isArray(args[2])) return args;
    const next = args.slice();
    next[2] = (args[2] as unknown[]).map((call) => markToolCallMediaTransportFailure(call));
    return next;
  }
  if (method === 'updateToolCall') {
    // Positional signature, not a tool-call object: stamp result/
    // resultContent/isError in place (the store always settles isExecuting
    // on updateToolCall, see chatStore.ts).
    const next = args.slice();
    while (next.length <= UPDATE_TOOL_CALL_RESULT_INDEX + 2) next.push(undefined);
    next[UPDATE_TOOL_CALL_RESULT_INDEX] = TOOL_MEDIA_TRANSPORT_ERROR;
    next[UPDATE_TOOL_CALL_RESULT_INDEX + 1] = undefined;
    next[UPDATE_TOOL_CALL_RESULT_INDEX + 2] = true;
    return next;
  }
  return args;
}

/**
 * Degrade, never drop. Each frame is checked on its own against the
 * receiver's raw-media guard; a frame that trips it is redacted in place and
 * — when it carries a tool call — settled as a media-transport failure. Frame
 * order and frame count are unchanged, and clean frames (the settle frames
 * that let a dispatch finish) are passed through untouched.
 *
 * `session`-port frames carry terminal conversation state, not tool calls:
 * they are redacted but never re-labelled as a tool failure.
 *
 * `degradedIndexes` are positions in the array handed to THIS function — for
 * `agent.delta` that is the position after the per-session trust filter, not
 * the sidecar's wire index (same convention as `summarizeFramesForLog`).
 */
export function degradeDeltaFramesForMediaFailure(
  frames: readonly PortFrame[],
): { frames: PortFrame[]; degradedIndexes: number[] } {
  const degradedIndexes: number[] = [];
  const degraded = frames.map((frame, index) => {
    try {
      sidecarValueHasOpaqueMediaRefs(frame.a);
      return frame;
    } catch {
      degradedIndexes.push(index);
      const args = redactSidecarValueForWireFailure(frame.a);
      return {
        ...frame,
        a: frame.p === 'chat' ? degradeChatFrameArgs(frame.m, args) : args,
      };
    }
  });
  return { frames: degraded, degradedIndexes };
}
