/**
 * All tool names — single source of truth.
 * Use these constants instead of hardcoded strings for type safety and refactorability.
 */
export const TOOL_NAMES = {
  // Core file/system tools
  GET_SYSTEM_INFO: 'get_system_info',
  READ_FILE: 'read_file',
  WRITE_FILE: 'write_file',
  EDIT_FILE: 'edit_file',
  LIST_DIRECTORY: 'list_directory',
  SEARCH_FILES: 'search_files',
  FIND_FILES: 'find_files',
  RUN_COMMAND: 'run_command',
  DELETE_FILE: 'delete_file',

  // Web & network
  WEB_SEARCH: 'web_search',
  HTTP_FETCH: 'http_fetch',

  // Image
  GENERATE_IMAGE: 'generate_image',
  PROCESS_IMAGE: 'process_image',

  // Inline visualization (generative UI widgets)
  SHOW_WIDGET: 'show_widget',
  READ_ME: 'read_me',

  // Agent & skill
  USE_SKILL: 'use_skill',
  READ_SKILL_FILE: 'read_skill_file',
  SKILL_VIEW: 'skill_view',
  SKILL_MANAGE: 'skill_manage',
  DELEGATE_TO_AGENT: 'delegate_to_agent',
  REPORT_PLAN: 'report_plan',
  /** @deprecated save_skill was removed in favor of skill_manage. The constant
   *  is kept solely because the shared factory in agentTools.ts still references
   *  it in an unreachable branch; delete both once save_agent gets its own
   *  bespoke implementation. */
  SAVE_SKILL: 'save_skill',
  SAVE_AGENT: 'save_agent',
  TEST_SKILL_TRIGGER: 'test_skill_trigger',
  IMPROVE_SKILL_DESCRIPTION: 'improve_skill_description',

  // Memory & planning
  UPDATE_MEMORY: 'update_memory',
  UPDATE_SOUL: 'update_soul',
  RECALL: 'recall',
  READ_MEMORY: 'read_memory',

  // Automation
  MANAGE_SCHEDULED_TASK: 'manage_scheduled_task',
  MANAGE_TRIGGER: 'manage_trigger',
  MANAGE_FILE_WATCH: 'manage_file_watch',
  MANAGE_MCP_SERVER: 'manage_mcp_server',

  // Clipboard & notification
  CLIPBOARD_READ: 'clipboard_read',
  CLIPBOARD_WRITE: 'clipboard_write',
  SYSTEM_NOTIFY: 'system_notify',

  // Computer use
  COMPUTER: 'computer',

  // Task tracking
  LOG_TASK_COMPLETION: 'log_task_completion',

  // Workspace
  REQUEST_WORKSPACE: 'request_workspace',

  // Human-in-the-loop
  ASK_USER_QUESTION: 'ask_user_question',

  // Tool discovery
  TOOL_SEARCH: 'tool_search',

  // Inbox proposals
  CREATE_TODO: 'create_todo',

  // Orchestration
  RUN_AGENT_BATCH: 'run_agent_batch',
} as const;

export type ToolName = typeof TOOL_NAMES[keyof typeof TOOL_NAMES];

/**
 * Tools whose ToolCall is marked `hidden: true` for DISPLAY purposes only,
 * while still being step-backed: agentLoop runs the full step bookkeeping
 * for them (createStepForToolUse + planned-step auto-link/advance), unlike
 * report_plan which breaks before step creation.
 *
 * Single source for that semantics — used by agentLoop (hidden-marking),
 * MessageGroup (step slicing + timeline filtering + widget segments), and
 * proposalSignal (these calls count as real work). Currently only
 * show_widget, which renders as a dedicated inline card (ShowWidgetCard)
 * instead of the generic tool list.
 */
export function isDisplayHiddenStepBackedTool(name: string | undefined): boolean {
  return name === TOOL_NAMES.SHOW_WIDGET;
}
