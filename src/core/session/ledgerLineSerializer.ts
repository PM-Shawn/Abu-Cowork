/**
 * How a message becomes the text of one ledger line or one stream-snapshot
 * entry.
 *
 * Pure: the only thing it needs from a tier is the lookup that answers whether
 * a tool result's image already has a snapshot on disk, which arrives as
 * `findToolResultImageSnapshot` in the options. Every writer of a conversation
 * serializes through here, so a line written by the renderer and a line written
 * by the sidecar are the same bytes.
 */

import type { Message, MessageContent, ToolCall, ToolCallForContext, ToolResultContent } from '@/types';
import type { LedgerLine } from './messageLedger';
import { boundMessageToolResultContentForDisk } from './durableToolResultContent';

/** What a tool result's image snapshot contributes to an `outputRef`. */
export interface ToolResultImageSnapshotRef {
  snapshotRelPath: string;
  basename: string;
  size: number;
}

export type FindToolResultImageSnapshot =
  (convId: string | undefined, toolCallId: string) => ToolResultImageSnapshotRef | null;

export interface StripForDiskOptions {
  allowToolResultDehydration?: boolean;
  findToolResultImageSnapshot: FindToolResultImageSnapshot;
}

// ════════════════════════════════════════════════════════════
// Strip for disk — reduce message size before persisting
// ════════════════════════════════════════════════════════════

/**
 * Prepare a message for disk storage:
 * - Clear image base64 data (filePath preserved for recovery)
 * - PDF document blocks stay intact; delegated PDF refs are a send-time
 *   contract, not a restart/rehydration persistence layer in this batch
 * - HTML/Mermaid/code blocks preserved intact
 */
function cloneToolResultContentForDisk(
  convId: string | undefined,
  toolCallId: string | undefined,
  resultContent: ToolResultContent[] | undefined,
  allowToolResultDehydration: boolean,
  find: FindToolResultImageSnapshot,
): ToolResultContent[] | undefined {
  if (!resultContent) return undefined;
  const imageCount = resultContent.filter((block) => block.type === 'image').length;
  const snapshot = allowToolResultDehydration && imageCount === 1 && toolCallId
    ? find(convId, toolCallId)
    : null;
  return resultContent.map((block) => {
    if (block.type !== 'image') return { ...block };

    const clonedSource = { ...block.source };
    if (imageCount === 1 && block.source?.data && snapshot?.snapshotRelPath) {
      clonedSource.data = '';
      return {
        ...block,
        source: clonedSource,
        outputRef: {
          relPath: snapshot.snapshotRelPath,
          basename: snapshot.basename,
          sizeBytes: snapshot.size,
        },
      };
    }

    return {
      ...block,
      source: clonedSource,
      ...(block.outputRef ? { outputRef: { ...block.outputRef } } : {}),
    };
  });
}

function cloneToolCallsForDisk(
  convId: string | undefined,
  calls: ToolCall[] | undefined,
  allowToolResultDehydration: boolean,
  find: FindToolResultImageSnapshot,
): ToolCall[] | undefined {
  return calls?.map((call) => ({
    ...call,
    ...(call.resultContent
      ? { resultContent: cloneToolResultContentForDisk(convId, call.id, call.resultContent, allowToolResultDehydration, find) }
      : {}),
  }));
}

function cloneContextToolCallsForDisk(
  convId: string | undefined,
  calls: ToolCallForContext[] | undefined,
  allowToolResultDehydration: boolean,
  find: FindToolResultImageSnapshot,
): ToolCallForContext[] | undefined {
  return calls?.map((call) => ({
    ...call,
    ...(call.resultContent
      ? { resultContent: cloneToolResultContentForDisk(convId, call.id, call.resultContent, allowToolResultDehydration, find) }
      : {}),
  }));
}

export function hasInlineToolResultImages(message: Message): boolean {
  const hasInlineImage = (call: ToolCall | ToolCallForContext): boolean =>
    !!call.resultContent?.some((block) => block.type === 'image' && !!block.source.data);
  return !!(
    message.toolCalls?.some(hasInlineImage)
    || message.toolCallsForContext?.some(hasInlineImage)
  );
}

export function stripForDisk(msg: Message, convId: string | undefined, options: StripForDiskOptions): Message {
  // Tool-result rich content is a different persistence surface from
  // Message.content. Bound both tool projections before every ledger/snapshot
  // serialization so no alternate writer can bypass the admission guard; the
  // dehydration pass below then operates on the bounded projections.
  const stripped: Message = { ...boundMessageToolResultContentForDisk(msg) };
  const allowToolResultDehydration = options.allowToolResultDehydration !== false;
  const find = options.findToolResultImageSnapshot;

  // 2. Clear user-message image base64 data (preserve filePath for recovery)
  if (Array.isArray(stripped.content)) {
    stripped.content = (stripped.content as MessageContent[]).map((block) => {
      if (block.type === 'image' && block.source?.data) {
        return {
          ...block,
          source: { ...block.source, data: '' },
        };
      }
      return block;
    });
  }

  // 3. Clear tool-result image base64 only when its PR-A snapshot definitely
  // exists. Always clone the full nested tree so a disk projection never shares
  // resultContent/image/source references with the live Zustand store.
  if (stripped.toolCalls) {
    stripped.toolCalls = cloneToolCallsForDisk(convId, stripped.toolCalls, allowToolResultDehydration, find);
  }
  if (stripped.toolCallsForContext) {
    stripped.toolCallsForContext = cloneContextToolCallsForDisk(
      convId,
      stripped.toolCallsForContext,
      allowToolResultDehydration,
      find,
    );
  }

  // 4. Clear streaming flags
  if (stripped.isStreaming) {
    stripped.isStreaming = false;
  }

  return stripped;
}

/**
 * Serialize one `msg.put` line.
 *
 * `lk` is left off: an absent kind IS `msg.put` (plan §3.1), so omitting it
 * keeps revision lines byte-identical in shape to the bare `Message` rows
 * every previous version wrote — nothing about a revised log looks new to an
 * older build. `pid` is written but never read (plan §3.2).
 */
export function serializeLedgerPut(
  convId: string,
  message: Message,
  pid: string | undefined,
  options: StripForDiskOptions,
): string {
  const line = stripForDisk(message, convId, options) as LedgerLine;
  if (pid === undefined) delete line.pid;
  else line.pid = pid;
  return JSON.stringify(line) + '\n';
}
