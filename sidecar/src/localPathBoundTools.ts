import { TOOL_NAMES } from '@/core/tools/toolNames';

/**
 * Locally executed file tools that require the shell approval ACK to carry the
 * canonical execution path. Kept in a small pure module so the contract test
 * can compare it with the renderer's FILE_TOOL_PATH_MAP without loading the
 * sidecar host runtime.
 */
export const LOCAL_PATH_BOUND_TOOLS = new Set<string>([
  TOOL_NAMES.READ_FILE,
  TOOL_NAMES.LIST_DIRECTORY,
  TOOL_NAMES.WRITE_FILE,
  TOOL_NAMES.EDIT_FILE,
  TOOL_NAMES.DELETE_FILE,
  TOOL_NAMES.SEARCH_FILES,
  TOOL_NAMES.FIND_FILES,
]);
