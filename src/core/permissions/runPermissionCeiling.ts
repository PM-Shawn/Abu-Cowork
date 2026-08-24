import type { IMCapabilityLevel } from '../../types/imChannel';
import type { TriggerAction, TriggerCapability } from '../../types/trigger';
import { TOOL_NAMES } from '../tools/toolNames';
import { matchesToolPattern } from '../skill/toolFilter';
import type { CmdBoundary } from './commandBoundary';
import { READ_ONLY_TOOL_ALLOWLIST } from './readOnlyToolPolicy';

export type RunPermissionCeilingLevel = IMCapabilityLevel | TriggerCapability | 'scheduled';

export interface RunPermissionCeiling {
  version: 1;
  source: 'trigger' | 'im' | 'scheduler';
  capability: RunPermissionCeilingLevel;
  allowedTools?: readonly string[];
  allowedCommands?: readonly string[];
}

declare module '../../types' {
  interface ToolExecutionContext {
    /**
     * Host-owned upper bound for unattended execution. Unlike permissionMode,
     * this policy may only remove authority: ambient autonomous settings,
     * standing grants, callbacks, sidecars, and delegated agents must not widen
     * it.
     */
    runPermissionCeiling?: RunPermissionCeiling;
  }
}

export interface CeilingDecision {
  decision: 'allow' | 'deny';
  reason?: string;
}

export const SAFE_TOOL_ALLOWLIST: readonly string[] = [
  ...READ_ONLY_TOOL_ALLOWLIST,
  TOOL_NAMES.WRITE_FILE,
  TOOL_NAMES.EDIT_FILE,
  TOOL_NAMES.DELETE_FILE,
  // IM safe_tools may deliver a file it generated inside the run scope.
  // Registry maps this tool's path as a read so the roster does not become an
  // out-of-scope exfiltration bypass. Non-IM loops hide send_file separately.
  TOOL_NAMES.SEND_FILE,
];

export const DENY_ALL_TOOL_ALLOWLIST: readonly string[] = ['__run_permission_ceiling_no_tools__'];

/**
 * Built-ins whose existing permissionMode/path/confirmation gates are valid
 * for an unattended scheduled task. Exact names are deliberate: a new
 * built-in must be reviewed before it becomes scheduler-reachable. MCP tools
 * are excluded until discovery exposes trustworthy host-side consequence
 * metadata; names and connection state are not authorization evidence.
 */
export const SCHEDULER_CORE_TOOL_ALLOWLIST: readonly string[] = Object.freeze([
  TOOL_NAMES.GET_SYSTEM_INFO,
  TOOL_NAMES.READ_FILE,
  TOOL_NAMES.WRITE_FILE,
  TOOL_NAMES.EDIT_FILE,
  TOOL_NAMES.DELETE_FILE,
  TOOL_NAMES.LIST_DIRECTORY,
  TOOL_NAMES.SEARCH_FILES,
  TOOL_NAMES.FIND_FILES,
  TOOL_NAMES.RUN_COMMAND,
  TOOL_NAMES.WEB_SEARCH,
  TOOL_NAMES.USE_SKILL,
  TOOL_NAMES.READ_SKILL_FILE,
  TOOL_NAMES.SKILL_VIEW,
  TOOL_NAMES.DELEGATE_TO_AGENT,
  TOOL_NAMES.RUN_AGENT_BATCH,
  TOOL_NAMES.RECALL,
  TOOL_NAMES.READ_MEMORY,
  TOOL_NAMES.UPDATE_MEMORY,
  TOOL_NAMES.LOG_TASK_COMPLETION,
  TOOL_NAMES.SYSTEM_NOTIFY,
  TOOL_NAMES.TOOL_SEARCH,
  TOOL_NAMES.CAPABILITY_SNAPSHOT,
]);

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

type StringArraySanitization =
  | { status: 'missing' }
  | { status: 'malformed' }
  | { status: 'valid'; value: string[] };

function sanitizeStringArray(value: unknown): StringArraySanitization {
  if (value === undefined) return { status: 'missing' };
  if (!isStringArray(value)) return { status: 'malformed' };
  return { status: 'valid', value: [...value] };
}

function isTriggerCapability(value: unknown): value is TriggerCapability {
  return value === 'read_tools' || value === 'safe_tools' || value === 'full' || value === 'custom';
}

function isIMCapability(value: unknown): value is IMCapabilityLevel {
  return value === 'chat_only' || value === 'read_tools' || value === 'safe_tools' || value === 'full';
}

export function normalizeRunCapability(value: unknown): RunPermissionCeilingLevel {
  switch (value) {
    case 'chat_only':
    case 'read_tools':
    case 'safe_tools':
    case 'full':
    case 'custom':
    case 'scheduled':
      return value;
    default:
      return 'read_tools';
  }
}

export function normalizeTriggerRunCapability(value: unknown): TriggerCapability {
  return isTriggerCapability(value) ? value : 'read_tools';
}

export function normalizeIMRunCapability(value: unknown): IMCapabilityLevel {
  return isIMCapability(value) ? value : 'read_tools';
}

export function normalizeCustomRunToolAllowlist(value: unknown): string[] {
  const sanitized = sanitizeStringArray(value);
  if (sanitized.status === 'malformed') return [...DENY_ALL_TOOL_ALLOWLIST];
  if (sanitized.status === 'missing' || sanitized.value.length === 0) return ['*'];
  return sanitized.value;
}

export function normalizeCustomRunCommandAllowlist(value: unknown): string[] | undefined {
  const sanitized = sanitizeStringArray(value);
  if (sanitized.status === 'missing') return undefined;
  if (sanitized.status === 'malformed') return [];
  return sanitized.value;
}

export function isRunPermissionCeiling(value: unknown): value is RunPermissionCeiling {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as {
    version?: unknown;
    source?: unknown;
    capability?: unknown;
    allowedTools?: unknown;
    allowedCommands?: unknown;
  };
  if (candidate.version !== 1) return false;
  if (candidate.source !== 'trigger' && candidate.source !== 'im' && candidate.source !== 'scheduler') return false;
  if (normalizeRunCapability(candidate.capability) !== candidate.capability) return false;
  const capability = candidate.capability;
  if (candidate.source === 'trigger' && !isTriggerCapability(capability)) return false;
  if (candidate.source === 'im' && !isIMCapability(capability)) return false;
  if (candidate.source === 'scheduler' && capability !== 'scheduled') return false;
  if (candidate.source !== 'scheduler' && capability === 'scheduled') return false;
  if (capability !== 'custom' && capability !== 'scheduled' && candidate.allowedTools !== undefined) return false;
  if (capability !== 'custom' && candidate.allowedCommands !== undefined) return false;
  if (candidate.allowedTools !== undefined && !isStringArray(candidate.allowedTools)) return false;
  if (candidate.allowedCommands !== undefined && !isStringArray(candidate.allowedCommands)) return false;
  if (capability === 'scheduled' && !isStringArray(candidate.allowedTools)) return false;
  return true;
}

function freezeStringArray(value: string[] | undefined): readonly string[] | undefined {
  return value ? Object.freeze([...value]) : undefined;
}

function freezeCeiling(ceiling: RunPermissionCeiling): RunPermissionCeiling {
  return Object.freeze({
    ...ceiling,
    ...(ceiling.allowedTools ? { allowedTools: freezeStringArray([...ceiling.allowedTools]) } : {}),
    ...(ceiling.allowedCommands ? { allowedCommands: freezeStringArray([...ceiling.allowedCommands]) } : {}),
  });
}

const FALLBACK_READ_TRIGGER_CEILING = freezeCeiling({
  version: 1,
  source: 'trigger',
  capability: 'read_tools',
});

export function getReadOnlyRunToolAllowlist(): string[] {
  return [...READ_ONLY_TOOL_ALLOWLIST];
}

export function getSafeRunToolAllowlist(): string[] {
  return [...SAFE_TOOL_ALLOWLIST];
}

export function buildTriggerRunPermissionCeiling(action: TriggerAction): RunPermissionCeiling {
  const runtimeAction = action as TriggerAction & {
    capability?: unknown;
    permissions?: {
      allowedTools?: unknown;
      allowedCommands?: unknown;
    };
  };
  const capability = normalizeTriggerRunCapability(runtimeAction.capability);
  const customAllowedTools = capability === 'custom'
    ? normalizeCustomRunToolAllowlist(runtimeAction.permissions?.allowedTools)
    : undefined;
  const customAllowedCommands = capability === 'custom'
    ? normalizeCustomRunCommandAllowlist(runtimeAction.permissions?.allowedCommands)
    : undefined;
  return freezeCeiling({
    version: 1,
    source: 'trigger',
    capability,
    ...(customAllowedTools ? { allowedTools: customAllowedTools } : {}),
    ...(customAllowedCommands !== undefined
      ? { allowedCommands: customAllowedCommands }
      : {}),
  });
}

export function buildIMRunPermissionCeiling(level: unknown): RunPermissionCeiling {
  return freezeCeiling({
    version: 1,
    source: 'im',
    capability: normalizeIMRunCapability(level),
  });
}

/** Freeze the scheduler's host-reviewed builtin roster. */
export function buildScheduledRunPermissionCeiling(
  _availableToolNames: readonly string[],
): RunPermissionCeiling {
  // Deliberately do not infer authority from MCP names such as `list_*`:
  // discovery can expose a destructive sibling from the same connected
  // server, and registry has no generic MCP consequence gate to catch it.
  const allowedTools = [...SCHEDULER_CORE_TOOL_ALLOWLIST];
  return freezeCeiling({
    version: 1,
    source: 'scheduler',
    capability: 'scheduled',
    allowedTools,
  });
}

export function getRunPermissionCeilingFromContext(context: unknown): RunPermissionCeiling | null {
  if (!context || typeof context !== 'object') return null;
  const candidate = context as {
    runPermissionCeiling?: unknown;
  };
  if (isRunPermissionCeiling(candidate.runPermissionCeiling)) {
    return candidate.runPermissionCeiling;
  }
  if (candidate.runPermissionCeiling !== undefined) {
    return FALLBACK_READ_TRIGGER_CEILING;
  }
  return null;
}

function matchCommandGlob(command: string, pattern: string): boolean {
  const regex = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${regex}$`, 'i').test(command);
}

function customCommandAllowed(ceiling: RunPermissionCeiling, command: string): boolean {
  const allowedCommands = ceiling.allowedCommands;
  return Boolean(
    allowedCommands?.length &&
    allowedCommands.some((pattern) => {
      const hasWildcard = pattern.includes('*') || pattern.includes('?');
      if (hasShellControlSyntax(command)) {
        return !hasWildcard && pattern.toLowerCase() === command.toLowerCase();
      }
      return matchCommandGlob(command, pattern);
    }),
  );
}

function hasShellControlSyntax(command: string): boolean {
  return /&&|\|\||[;&|<>`]|\$\(|[\r\n]/.test(command);
}

export function decideToolUnderRunPermissionCeiling(
  ceiling: RunPermissionCeiling | null,
  toolName: string,
  input: Record<string, unknown>,
): CeilingDecision {
  if (!ceiling || ceiling.capability === 'full') return { decision: 'allow' };
  if (ceiling.capability === 'chat_only') {
    return { decision: 'deny', reason: 'Error: tool use is disabled for this chat-only run' };
  }
  if (ceiling.capability === 'scheduled') {
    return ceiling.allowedTools?.includes(toolName)
      ? { decision: 'allow' }
      : {
          decision: 'deny',
          reason: `Error: tool "${toolName}" is outside this scheduled run's host roster`,
        };
  }

  const allowedTools =
    ceiling.capability === 'read_tools'
      ? READ_ONLY_TOOL_ALLOWLIST
      : ceiling.capability === 'custom'
        ? (ceiling.allowedTools?.length ? ceiling.allowedTools : ['*'])
        : SAFE_TOOL_ALLOWLIST;

  if (!allowedTools.some((pattern) => matchesToolPattern(toolName, pattern, input))) {
    return {
      decision: 'deny',
      reason: `Error: tool "${toolName}" is outside this unattended run's capability ceiling`,
    };
  }
  return { decision: 'allow' };
}

export function decideCommandUnderRunPermissionCeiling(
  ceiling: RunPermissionCeiling | null,
  info: { command: string; level: 'safe' | 'warn' | 'danger' | 'block'; reason?: string },
  readOnly: boolean,
  boundary: CmdBoundary,
): CeilingDecision {
  if (!ceiling || ceiling.capability === 'full') return { decision: 'allow' };
  // Scheduler uses the existing permissionMode strategy and headless-deny
  // callbacks for commands; this ceiling only prevents unreviewed tools from
  // reaching that strategy in the first place.
  if (ceiling.capability === 'scheduled') return { decision: 'allow' };
  if (ceiling.capability === 'chat_only' || ceiling.capability === 'read_tools') {
    return { decision: 'deny', reason: 'Error: command execution is outside this unattended run capability' };
  }
  if (ceiling.capability === 'safe_tools') {
    return { decision: 'deny', reason: 'Error: command execution is outside this safe_tools unattended run' };
  }
  if (info.level === 'block' || !customCommandAllowed(ceiling, info.command)) {
    return { decision: 'deny', reason: 'Error: command is not allowed by this custom unattended run' };
  }
  if (!readOnly && boundary !== 'inside') {
    return { decision: 'deny', reason: 'Error: command writes outside this unattended run scope' };
  }
  return { decision: 'allow' };
}

export function decideFileUnderRunPermissionCeiling(
  ceiling: RunPermissionCeiling | null,
  capability: 'read' | 'write',
  inRunScope: boolean,
): CeilingDecision {
  if (!ceiling || ceiling.capability === 'full') return { decision: 'allow' };
  // Scoped path authorization + permissionMode remain the scheduler's file
  // policy, including run-local grants that are disposed in its finally.
  if (ceiling.capability === 'scheduled') return { decision: 'allow' };
  if (ceiling.capability === 'chat_only') {
    return { decision: 'deny', reason: 'Error: file access is disabled for this chat-only run' };
  }
  if (ceiling.capability === 'read_tools' && capability === 'write') {
    return { decision: 'deny', reason: 'Error: write access is outside this read-only unattended run' };
  }
  if (!inRunScope) {
    return { decision: 'deny', reason: 'Error: file path is outside this unattended run scope' };
  }
  return { decision: 'allow' };
}

export function decideStateChangingToolUnderRunPermissionCeiling(
  ceiling: RunPermissionCeiling | null,
  kind: 'browser' | 'self-extension',
): CeilingDecision {
  if (!ceiling || ceiling.capability === 'full') return { decision: 'allow' };
  if (ceiling.capability === 'scheduled') {
    // Preserve pre-authorized browser-site behavior, but never allow an
    // unattended task to install/modify durable capabilities or identity.
    return kind === 'browser'
      ? { decision: 'allow' }
      : { decision: 'deny', reason: 'Error: self-extension is outside this scheduled run capability' };
  }
  return {
    decision: 'deny',
    reason: `Error: ${kind} action is outside this unattended run capability`,
  };
}
