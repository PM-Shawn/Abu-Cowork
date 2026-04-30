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

  // Web & network
  WEB_SEARCH: 'web_search',
  HTTP_FETCH: 'http_fetch',

  // Image
  GENERATE_IMAGE: 'generate_image',
  PROCESS_IMAGE: 'process_image',

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
  TODO_WRITE: 'todo_write',

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

  // Tool discovery
  TOOL_SEARCH: 'tool_search',
} as const;

export type ToolName = typeof TOOL_NAMES[keyof typeof TOOL_NAMES];
