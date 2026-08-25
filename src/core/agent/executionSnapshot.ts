import type { Message, ToolCall } from '../../types';
import type { DetailBlock, ExecutionStep } from '../../types/execution';
import type { ExecutionStepSnapshot } from '../../types/execution';
import { firstImageContent } from '../tools/toolResultContent';

/**
 * Convert full ExecutionStep[] to compact ExecutionStepSnapshot[] for persistence.
 * Strips large fields (toolInput, toolResult) and keeps only display-relevant data.
 */
export function snapshotExecutionSteps(steps: ExecutionStep[]): ExecutionStepSnapshot[] {
  return steps.map(snapshotStep);
}

function snapshotStep(step: ExecutionStep): ExecutionStepSnapshot {
  const snapshot: ExecutionStepSnapshot = {
    id: step.id,
    toolCallId: step.toolCallId,
    type: step.type,
    label: step.label,
    status: step.status === 'error' ? 'error' : 'completed',
    toolName: step.toolName,
  };

  if (step.duration != null) {
    snapshot.duration = step.duration;
  }

  if (step.agentName) {
    snapshot.agentName = step.agentName;
  }

  if (step.childSteps && step.childSteps.length > 0) {
    snapshot.childSteps = step.childSteps.map(snapshotStep);
  }

  if (step.detailBlocks.length > 0) {
    snapshot.detailBlocks = step.detailBlocks.map((b) => {
      // Truncate content for persistence (keep first 500 chars)
      const maxLen = 500;
      const truncated = b.content.length > maxLen
        ? b.content.slice(0, maxLen) + '...'
        : b.content;
      return {
        id: b.id,
        title: b.label,
        type: b.type,
        content: truncated || undefined,
      };
    });
  }

  return snapshot;
}

/**
 * Convert persisted ExecutionStepSnapshot[] back to ExecutionStep[] shape with defaults.
 * Inverse of snapshotExecutionSteps — used for rendering persisted data.
 */
export function snapshotToExecutionSteps(snapshots: ExecutionStepSnapshot[]): ExecutionStep[] {
  return snapshots.map((s): ExecutionStep => ({
    id: s.id,
    executionId: '',
    toolCallId: s.toolCallId,
    type: s.type,
    label: s.label,
    status: s.status,
    toolName: s.toolName,
    toolInput: {},
    source: 'agent',
    detailBlocks: s.detailBlocks?.filter((b) => b.content).map((b) => ({
      id: b.id,
      stepId: s.id,
      type: b.type,
      label: b.title,
      content: b.content || '',
      isTruncated: b.content ? b.content.endsWith('...') : false,
      isExpanded: false,
    })) ?? [],
    duration: s.duration,
    agentName: s.agentName,
    childSteps: s.childSteps ? snapshotToExecutionSteps(s.childSteps) : undefined,
  }));
}

// --- Image backfill for restored snapshots ---

type ImagePayload = NonNullable<DetailBlock['imageData']>;

/**
 * Payload identity cache, keyed by the ToolCall object itself.
 *
 * This backfill re-runs on nearly every render: `messageGroups` in ChatView is
 * deliberately not memoized, so MessageGroup gets a fresh `messages` array each
 * time and its memo recomputes on every streaming tick. Returning a NEW payload
 * object each run would change `block.imageData`'s identity, blowing the
 * `useMemo` in DetailBlockView that builds the `data:` URL — re-concatenating a
 * multi-megabyte base64 string for every finished group, on every tick.
 *
 * A WeakMap keyed on the ToolCall gives the same payload object back for an
 * unchanged tool call, so that memo holds. Keying on identity is safe because
 * the store updates through immer: a changed tool call is a NEW object, which
 * simply misses the cache. Entries die with their ToolCall.
 */
const imagePayloadCache = new WeakMap<ToolCall, ImagePayload>();

function readImagePayload(toolCall: ToolCall): ImagePayload | undefined {
  const cached = imagePayloadCache.get(toolCall);
  if (cached) return cached;
  const payload = firstImageContent(toolCall.resultContent);
  if (!payload) return undefined;
  imagePayloadCache.set(toolCall, payload);
  return payload;
}

function forEachStep(steps: ExecutionStep[], visit: (step: ExecutionStep) => void): void {
  for (const step of steps) {
    visit(step);
    if (step.childSteps && step.childSteps.length > 0) forEachStep(step.childSteps, visit);
  }
}

function applyImagePayloads(
  steps: ExecutionStep[],
  resolved: Map<string, ImagePayload>,
): ExecutionStep[] {
  let treeChanged = false;
  const nextSteps = steps.map((step) => {
    const nextChildSteps = step.childSteps
      ? applyImagePayloads(step.childSteps, resolved)
      : step.childSteps;

    let blocksChanged = false;
    const candidateBlocks = step.detailBlocks.map((block) => {
      const payload = resolved.get(block.id);
      if (!payload) return block;
      blocksChanged = true;
      return { ...block, imageData: payload };
    });

    if (!blocksChanged && nextChildSteps === step.childSteps) return step;
    treeChanged = true;
    return {
      ...step,
      detailBlocks: blocksChanged ? candidateBlocks : step.detailBlocks,
      childSteps: nextChildSteps,
    };
  });
  return treeChanged ? nextSteps : steps;
}

/**
 * Re-attach image payloads to image detail blocks restored from a persisted
 * snapshot.
 *
 * Snapshots deliberately stay lean — the base64 is NOT copied into them, it
 * already lives on `Message.toolCalls[].resultContent` on disk. Once the live
 * execution is evicted, the restored blocks therefore carry only the placeholder
 * text ("Image: /path (37KB, image/png)"), which is why a finished task used to
 * degrade from a thumbnail to that line.
 *
 * Resolution order per block: existing `imageData` (live path — untouched) →
 * exact `toolCallId` match → legacy text match. The legacy path exists because
 * snapshots written before `toolCallId` was persisted have nothing to join on:
 * it pairs an image block with tool calls whose `result` string equals the
 * block's placeholder content, in order of appearance, and gives up entirely
 * when the counts don't line up — showing the placeholder is strictly better
 * than showing the wrong image.
 *
 * Known limit of that legacy path: `snapshotStep` truncates persisted content at
 * 500 chars and appends "...", so an old snapshot whose placeholder ran longer
 * than that (a ~472+ char file path) can never match its tool call's untruncated
 * `result` and stays a placeholder forever. Left as-is on purpose — it fails in
 * the "give up" direction, and such snapshots have no toolCallId to fall back
 * on. New snapshots carry toolCallId and are unaffected.
 *
 * Returns the input array unchanged (same reference) when nothing is backfilled.
 */
export function backfillDetailBlockImages(
  steps: ExecutionStep[],
  messages: Message[],
): ExecutionStep[] {
  if (steps.length === 0) return steps;

  // Insertion order is the tool calls' order of appearance, which the legacy
  // text-match path below relies on for its positional pairing.
  const imagesByToolCallId = new Map<string, { result: string; payload: ImagePayload }>();
  const rawToolCallIdCounts = new Map<string, number>();
  for (const message of messages) {
    for (const toolCall of message.toolCalls ?? []) {
      rawToolCallIdCounts.set(toolCall.id, (rawToolCallIdCounts.get(toolCall.id) ?? 0) + 1);
    }
  }
  for (const message of messages) {
    for (const toolCall of message.toolCalls ?? []) {
      const payload = readImagePayload(toolCall);
      if (!payload) continue;
      // A duplicate raw id remains ambiguous even when one duplicate lost its
      // payload to eviction. Do not let the surviving payload be reused by
      // every legacy block with the same placeholder.
      if ((rawToolCallIdCounts.get(toolCall.id) ?? 0) !== 1) continue;
      // Legacy data may contain provider-run-local ids without an app scope.
      // A duplicate is ambiguous: dropping both candidates to placeholders is
      // strictly safer than the old last-write-wins behavior, which displayed
      // a different child agent's screenshot as if it belonged to this step.
      imagesByToolCallId.set(toolCall.id, { result: toolCall.result ?? '', payload });
    }
  }
  if (imagesByToolCallId.size === 0) return steps;

  // Detail block ids embed their step id (`${stepId}-image`), so they are
  // already unique across the tree and serve as the resolution key directly.
  const resolved = new Map<string, ImagePayload>();
  const consumedToolCallIds = new Set<string>();
  // Legacy snapshots (no toolCallId): group by placeholder text, resolve later.
  const pendingByContent = new Map<string, string[]>();

  forEachStep(steps, (step) => {
    for (const block of step.detailBlocks) {
      if (block.type !== 'image' || block.imageData) continue;
      const toolCallId = step.toolCallId;
      if (toolCallId) {
        const direct = imagesByToolCallId.get(toolCallId);
        if (direct) {
          resolved.set(block.id, direct.payload);
          consumedToolCallIds.add(toolCallId);
          continue;
        }
      }
      if (!block.content) continue;
      const bucket = pendingByContent.get(block.content);
      if (bucket) bucket.push(block.id);
      else pendingByContent.set(block.content, [block.id]);
    }
  });

  for (const [content, blockIds] of pendingByContent) {
    const matches: ImagePayload[] = [];
    for (const [toolCallId, entry] of imagesByToolCallId) {
      if (entry.result === content && !consumedToolCallIds.has(toolCallId)) {
        matches.push(entry.payload);
      }
    }
    // Ambiguous (or nothing to pair with) → leave the placeholder alone.
    if (matches.length === 0 || matches.length !== blockIds.length) continue;
    blockIds.forEach((blockId, i) => resolved.set(blockId, matches[i]));
  }

  if (resolved.size === 0) return steps;
  return applyImagePayloads(steps, resolved);
}
