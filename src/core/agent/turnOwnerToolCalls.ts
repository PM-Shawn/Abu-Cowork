import type { ToolCall } from '../../types';
import { TOOL_NAMES } from '../tools/toolNames';
import { FILE_CREATE_TOOLS, FILE_WRITE_TOOLS } from '../../utils/workflowExtractor';

const PATH_INPUT_KEYS = ['path', 'file_path', 'filePath'] as const;

const WHOLE_INPUT_TOOLS: readonly string[] = [
  TOOL_NAMES.PRESENT_FILES,
  TOOL_NAMES.GENERATE_IMAGE,
  TOOL_NAMES.PROCESS_IMAGE,
];

/**
 * The entry the reply keeps for a tool call of the expert that ran the user
 * turn, or null when the reply has no use for the call.
 *
 * On a `delegate` route the expert's calls are child steps of the execution,
 * and a persisted step keeps neither input nor result. The file cards and the
 * file names of the reply are read from `Message.toolCalls`, so the calls they
 * depend on are kept there as hidden subagent entries: present_files and the
 * image tools with their input, write and create tools with the path alone
 * (the written content stays out of the conversation record).
 */
export function replyEntryForTurnOwnerToolCall(call: {
  id: string;
  toolName: string;
  input: Record<string, unknown>;
  result: string;
  error: boolean;
}): ToolCall | null {
  let input: Record<string, unknown>;
  if (WHOLE_INPUT_TOOLS.includes(call.toolName)) {
    input = call.input;
  } else if (FILE_WRITE_TOOLS.includes(call.toolName) || FILE_CREATE_TOOLS.includes(call.toolName)) {
    input = {};
    for (const key of PATH_INPUT_KEYS) {
      if (typeof call.input[key] === 'string') input[key] = call.input[key];
    }
  } else {
    return null;
  }
  return {
    id: call.id,
    name: call.toolName,
    input,
    result: call.result,
    ...(call.error ? { isError: true } : {}),
    hidden: true,
    fromSubagent: true,
  };
}
