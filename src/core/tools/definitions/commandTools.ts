import type { CommandOutcome, ToolDefinition } from '../../../types';
import { getPlatform, getShell, isWindows } from '../../../utils/platform';
import { resolveCommandPython } from '../../../utils/pythonRuntime';
import { isSandboxEnabled, isNetworkIsolationEnabled } from '../../sandbox/config';
import { getWorkspaceReader } from '../../agent/ports/workspaceReader';
import { getAuthorizedPathsReader } from '../../agent/ports/authorizedPathsReader';
import { sandboxBlockClass } from '../../sandbox/blockClass';
import { showSandboxBlockedToast } from '../../sandbox/recovery';
import {
  detectAppAutomationSandboxBlock,
  getAppAutomationSandboxRecovery,
  hasUnquotedShellControlSyntax,
} from '../../sandbox/appAutomationRecovery';
import type { CommandOutput } from '../helpers/toolHelpers';
import { invokeTaskCommand, isTaskCommandAbortedError } from '../helpers/scopedCommand';
import { isReadOnlyCommand } from '../readOnlyDetector';
import { TOOL_NAMES } from '../toolNames';
import { format, getI18n } from '../../../i18n';
import { hasElectronCommandHost } from '../../../utils/electronHost';
import { COMMAND_OUTPUT_RULE, truncateText, type TruncationRule } from '../../context/truncation';

const PART_SEPARATOR = '\n\n';
const STDOUT_HEADING = 'stdout:\n';
const STDERR_HEADING = 'stderr:\n';

/**
 * Cut each output stream on its own, so the joined result fits `rule` and the
 * recorded positions point into the text the model receives. When both
 * streams have text, stderr gets at most half of the budget and stdout the rest.
 */
function boundCommandOutput(stdout: string, stderr: string, rule: TruncationRule): { stdout: string; stderr: string } {
  if (stdout && stderr) {
    const boundedStderr = truncateText(stderr, {
      headLines: Math.floor(rule.headLines / 2),
      tailLines: Math.floor(rule.tailLines / 2),
      maxChars: Math.floor(rule.maxChars / 2),
    });
    return {
      stdout: truncateText(stdout, { ...rule, maxChars: rule.maxChars - boundedStderr.length }),
      stderr: boundedStderr,
    };
  }
  return {
    stdout: stdout ? truncateText(stdout, rule) : '',
    stderr: stderr ? truncateText(stderr, rule) : '',
  };
}

/**
 * Global-workspace fallback for direct invocations that carry no context.
 * Sidecar-safe: the bare `getWorkspaceReader()` getter throws outside a
 * registered agent run (see `shims/workspaceReaderRun.ts`) — a throwing
 * fallback must degrade to "no workspace", never fail the command itself.
 */
function safeGlobalWorkspacePath(): string | null {
  try {
    return getWorkspaceReader().getCurrentPath();
  } catch {
    return null;
  }
}

function formatAppAutomationRecovery(
  recovery: NonNullable<ReturnType<typeof getAppAutomationSandboxRecovery>>,
): string {
  const app = recovery.targetApp
    ?? getI18n().sandbox.appAutomationTargetFallback;
  return [
    format(getI18n().sandbox.appAutomationToolError, { app }),
  ].join('\n\n');
}

export const runCommandTool: ToolDefinition = {
  name: TOOL_NAMES.RUN_COMMAND,
  get description() {
    const plat = getPlatform();
    const shell = getShell();
    return `Execute a shell command on the user's computer (current platform: ${plat}, shell: ${shell}).

Important: prefer a dedicated tool when one is available:
- Read a file → read_file
- List a directory → list_directory
- Search file contents → search_files
- Find files → find_files
- HTTP requests → http_fetch
- Edit a file → edit_file

This tool is suitable for: moving/copying/renaming files (mv/cp), package management (npm/pip/brew), build and test (npm run/cargo build), Git operations, running Python scripts (automatically uses the built-in runtime). For long-running commands, including finite jobs such as rendering, set background=true when permitted and use background_command_output to check completion and the exit result. Use tool_search to find that tool if needed. Background commands are unavailable in scoped unattended runs. Foreground commands are terminated on timeout.`;
  },
  descriptionByFamily: {
    get gpt() {
      const plat = getPlatform();
      const shell = getShell();
      return `Execute a shell command on the user's computer (current platform: ${plat}, shell: ${shell}).

Prefer a dedicated tool when one is offered:
- Read a file → read_file
- List a directory → list_directory
- Search file contents → search_files
- Find files → find_files
- HTTP requests → http_fetch
- Edit or create a file → apply_patch when it is offered, otherwise edit_file / write_file. Never write a file with cat, echo, printf, heredocs, shell redirection or a Python script.

Use it for: moving/copying/renaming files (mv/cp), package management (npm/pip/brew), build and test (npm run/cargo build), Git operations, running Python scripts (the built-in runtime is used automatically). For long-running commands, including finite jobs such as rendering, set background=true when permitted and use background_command_output to check completion and the exit result. Use tool_search to find that tool if needed. Background commands are unavailable in scoped unattended runs. Foreground commands are terminated on timeout. Quote arguments carefully: backticks and $() in the command still execute.`;
    },
  },
  inputSchema: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'The shell command to execute' },
      cwd: { type: 'string', description: 'Working directory for the command (optional, defaults to user home)' },
      background: { type: 'boolean', description: 'Set to true for long-running commands, including services and finite jobs such as rendering. Returns initial output after a few seconds; use background_command_output to check completion and the exit result. Unavailable in scoped unattended runs.' },
      timeout: { type: 'number', description: 'Timeout in seconds (default 30, max 300). Command will be killed if it exceeds this.' },
    },
    required: ['command'],
  },
  execute: async (input, context) => {
    const command = input.command as string;
    const cwd = input.cwd as string | undefined;
    const background = input.background as boolean | undefined;
    const timeout = input.timeout as number | undefined;
    const abortSignal = context?.abortSignal;
    if (abortSignal?.aborted) {
      return 'Error executing command: command was aborted before it started';
    }

    try {
      // Use embedded Python runtime if command starts with python/python3
      const resolvedCommand = await resolveCommandPython(command);
      if (abortSignal?.aborted) {
        return 'Error executing command: command was aborted before it started';
      }

      // Exempt app-launcher commands from sandbox
      // macOS: `open` uses LaunchServices via XPC, blocked by Seatbelt
      // Windows: `start`/`Start-Process` exempted for consistency with ExecutionPolicy
      const isLauncherCandidate = isWindows()
        ? /^\s*(start|Start-Process)\s/i.test(resolvedCommand)
        : /^\s*open\s/.test(resolvedCommand);
      const isLauncherCmd = isLauncherCandidate
        && (
          !hasElectronCommandHost()
          || !hasUnquotedShellControlSyntax(resolvedCommand)
        );
      const sandbox = isLauncherCmd ? false : isSandboxEnabled();

      // Seatbelt does not contain the target app process: Apple Events can ask
      // that app to mutate data outside the shell profile. Electron therefore
      // blocks explicit cross-app AppleScript before spawn while Shell sandbox
      // protection is enabled. Tauri stays unchanged during coexistence.
      const preflightAppAutomationRecovery = sandbox && hasElectronCommandHost()
        ? getAppAutomationSandboxRecovery(resolvedCommand)
        : null;
      if (preflightAppAutomationRecovery) {
        context?.reportMetadata?.({
          sandboxRecovery: preflightAppAutomationRecovery,
        });
        return formatAppAutomationRecovery(preflightAppAutomationRecovery);
      }

      // Use the shell/session-owned workspace from context. Scoped unattended
      // runs fail closed when that trusted value is null/absent; only
      // unscoped interactive/direct invocations may fall back to the global
      // workspace reader.
      // The fallback must not fail the command: in the sidecar the bare getter
      // resolves an ambient-run mirror and THROWS outside a registered run —
      // treat that as "no workspace" (cwd-less spawn), matching the shell's
      // no-workspace behavior instead of erroring before the spawn.
      const workspacePath = context?.authorizationScopeId !== undefined
        ? (context.workspacePath ?? null)
        : (context?.workspacePath ?? safeGlobalWorkspacePath());
      const authorizedPaths = sandbox
        ? await getAuthorizedPathsReader().getAuthorizedWritablePaths(context?.authorizationScopeId)
        : [];
      const extraWritablePaths = [
        ...(context?.authorizationScopeId === undefined && workspacePath ? [workspacePath] : []),
        ...authorizedPaths,
      ];

      // Use custom Tauri command defined in Rust
      const output = await invokeTaskCommand<CommandOutput & { backgroundCommandId?: string; running?: boolean }>('run_shell_command', {
        command: resolvedCommand,
        cwd: cwd || workspacePath || null,
        background: background || false,
        timeout: Math.min(Math.max(1, timeout ?? 30), 300),
        sandboxEnabled: sandbox,
        networkIsolation: isNetworkIsolationEnabled(),
        extraWritablePaths,
      }, context, {
        commandIdPrefix: 'run-command',
        keepAbortListenerAfterResolve: (result) => background === true && result.code === 0,
      });

      const appAutomationRecovery = sandbox
        ? detectAppAutomationSandboxBlock(resolvedCommand, output.stderr, output.code)
        : null;
      if (appAutomationRecovery) {
        context?.reportMetadata?.({
          sandboxRecovery: appAutomationRecovery,
        });
      }

      // Only a blocked *write* gets the "authorize this directory" toast —
      // an exec/read/network/unclassified block has no directory to authorize,
      // so the toast would be misleading. Every class still reaches the model
      // through the annotated stderr below. AppleScript cross-app blocks render
      // a task-local recovery card instead.
      if (!appAutomationRecovery && sandbox && sandboxBlockClass(output.stderr) === 'write') {
        showSandboxBlockedToast(resolvedCommand);
      }

      const { stdout, stderr } = boundCommandOutput(
        output.stdout.trim(),
        output.stderr.trim(),
        COMMAND_OUTPUT_RULE,
      );
      const commandOutcome: CommandOutcome = { exitCode: output.code };
      const parts: string[] = [];
      // Where the next part starts in the joined result.
      const nextStart = (): number => (parts.length === 0 ? 0 : parts.join(PART_SEPARATOR).length + PART_SEPARATOR.length);
      if (appAutomationRecovery) {
        parts.push(formatAppAutomationRecovery(appAutomationRecovery));
      }
      if (stdout) {
        const start = nextStart() + STDOUT_HEADING.length;
        parts.push(`${STDOUT_HEADING}${stdout}`);
        commandOutcome.stdout = [start, start + stdout.length];
      }
      if (stderr) {
        const start = nextStart() + STDERR_HEADING.length;
        parts.push(`${STDERR_HEADING}${stderr}`);
        commandOutcome.stderr = [start, start + stderr.length];
      }
      parts.push(`exit code: ${output.code}`);
      if (output.backgroundCommandId && output.running === true) {
        commandOutcome.background = true;
        parts.push(`Background command id: ${output.backgroundCommandId} (still running). Use background_command_output to read later output, stop_background_command to stop it.`);
      }

      context?.reportMetadata?.({ commandOutcome });
      return parts.join(PART_SEPARATOR);
    } catch (err) {
      if (isTaskCommandAbortedError(err)) {
        return 'Error executing command: command was aborted before it started';
      }
      return `Error executing command: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
  isConcurrencySafe: (input) => isReadOnlyCommand(String(input.command ?? '')),
};
