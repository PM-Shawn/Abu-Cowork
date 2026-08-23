import type { Message, ToolCall } from '../../types';
import type { DetailBlock, ExecutionStep } from '../../types/execution';
import type { ExecutionStepSnapshot } from '../../types/execution';

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

/** Key a detail block by its owning step, so ids stay unique across the tree. */
function detailBlockKey(stepId: string, blockId: string): string {
  return `${stepId}::${blockId}`;
}

function readImagePayload(toolCall: ToolCall): ImagePayload | undefined {
  const block = toolCall.resultContent?.find((c) => c.type === 'image');
  if (!block || block.type !== 'image' || !block.source?.data) return undefined;
  return { mediaType: block.source.media_type, base64: block.source.data };
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
      const payload = resolved.get(detailBlockKey(step.id, block.id));
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
 * Returns the input array unchanged (same reference) when nothing is backfilled.
 */
export function backfillDetailBlockImages(
  steps: ExecutionStep[],
  messages: Message[],
): ExecutionStep[] {
  if (steps.length === 0) return steps;

  const byToolCallId = new Map<string, ImagePayload>();
  const candidates: { toolCallId: string; result: string; payload: ImagePayload }[] = [];
  for (const message of messages) {
    for (const toolCall of message.toolCalls ?? []) {
      const payload = readImagePayload(toolCall);
      if (!payload) continue;
      byToolCallId.set(toolCall.id, payload);
      candidates.push({ toolCallId: toolCall.id, result: toolCall.result ?? '', payload });
    }
  }
  if (candidates.length === 0) return steps;

  const resolved = new Map<string, ImagePayload>();
  const consumedToolCallIds = new Set<string>();
  // Legacy snapshots (no toolCallId): group by placeholder text, resolve later.
  const pendingByContent = new Map<string, string[]>();

  forEachStep(steps, (step) => {
    for (const block of step.detailBlocks) {
      if (block.type !== 'image' || block.imageData) continue;
      const key = detailBlockKey(step.id, block.id);
      const direct = step.toolCallId ? byToolCallId.get(step.toolCallId) : undefined;
      if (direct) {
        resolved.set(key, direct);
        if (step.toolCallId) consumedToolCallIds.add(step.toolCallId);
        continue;
      }
      if (!block.content) continue;
      const bucket = pendingByContent.get(block.content);
      if (bucket) bucket.push(key);
      else pendingByContent.set(block.content, [key]);
    }
  });

  for (const [content, keys] of pendingByContent) {
    const matches = candidates.filter(
      (c) => c.result === content && !consumedToolCallIds.has(c.toolCallId),
    );
    // Ambiguous (or nothing to pair with) → leave the placeholder alone.
    if (matches.length === 0 || matches.length !== keys.length) continue;
    keys.forEach((key, i) => resolved.set(key, matches[i].payload));
  }

  if (resolved.size === 0) return steps;
  return applyImagePayloads(steps, resolved);
}
