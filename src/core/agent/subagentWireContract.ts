/**
 * Canonical shell <-> sidecar field list for the `subagent.run` request.
 *
 * Keep this module value-only and dependency-free so both runtimes can import
 * the exact same tuple. Each boundary additionally checks the tuple against
 * its local params interface; adding a field on either side therefore cannot
 * be satisfied by updating only that side's private copy.
 */
export const SUBAGENT_RUN_WIRE_FIELDS = [
  'runId',
  'agent',
  'task',
  'context',
  'parentConversationSummary',
  'parentConversationId',
  'persistParentToolImages',
  'imContext',
  'allowedTools',
  'blockedTools',
  'authorizationScopeId',
  'runPermissionCeiling',
  'triggerId',
  'scheduledTaskId',
  'locale',
  'uiStrings',
  'settingsSnapshot',
  'resolvedCreds',
  'tools',
  'workspacePathSnapshot',
] as const;
