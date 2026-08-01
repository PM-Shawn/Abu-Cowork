/**
 * Skill Content Preprocessing Pipeline
 *
 * Processes SKILL.md content before injecting into the LLM system prompt:
 * 1. substituteVariables() — replace $ARGUMENTS, $0, ${ABU_SKILL_DIR}, etc.
 * 2. executeInlineCommands() — run !`command` directives and replace with output
 */

import { parseArgs } from '../../utils/argsParser';
import type { ToolExecutionContext } from '../../types';
import { invokeTaskCommand } from '../tools/helpers/scopedCommand';

export { parseArgs };

interface CommandOutput {
  stdout: string;
  stderr: string;
  code: number;
}

/**
 * Replace variable placeholders in skill content.
 *
 * Supported variables:
 * - $ARGUMENTS        — full argument string
 * - $ARGUMENTS[N]     — positional argument (0-indexed)
 * - $0, $1, ... $N    — shorthand for positional arguments
 * - ${ABU_SESSION_ID} — current session/conversation ID
 * - ${ABU_SKILL_DIR}  — absolute path to skill directory
 * - ${CLAUDE_SESSION_ID} / ${CLAUDE_SKILL_DIR} — Claude Code compatible aliases
 *
 * If content does not contain $ARGUMENTS and args is non-empty,
 * appends "ARGUMENTS: <value>" at the end.
 */
export function substituteVariables(
  content: string,
  args: string,
  skillDir: string,
  sessionId: string,
): string {
  const positionalArgs = parseArgs(args);
  const hasArgsPlaceholder = content.includes('$ARGUMENTS');

  let result = content;

  // Replace $ARGUMENTS[N] first (longer format, avoids conflicts)
  result = result.replace(/\$ARGUMENTS\[(\d+)\]/g, (_, i) => positionalArgs[+i] ?? '');

  // Replace $N positional args (only single/multi-digit numbers preceded by $)
  // Use word boundary to avoid replacing inside other identifiers
  result = result.replace(/\$(\d+)(?!\w)/g, (_, i) => positionalArgs[+i] ?? '');

  // Replace $ARGUMENTS (full string)
  result = result.replace(/\$ARGUMENTS/g, args);

  // Replace environment variables
  result = result.replace(/\$\{ABU_SESSION_ID\}/g, sessionId);
  result = result.replace(/\$\{ABU_SKILL_DIR\}/g, skillDir);
  // Claude Code compatible aliases
  result = result.replace(/\$\{CLAUDE_SESSION_ID\}/g, sessionId);
  result = result.replace(/\$\{CLAUDE_SKILL_DIR\}/g, skillDir);

  // Auto-append if no $ARGUMENTS placeholder and args provided
  if (args && !hasArgsPlaceholder) {
    result += `\nARGUMENTS: ${args}`;
  }

  return result;
}

/**
 * Execute !`command` inline directives in skill content.
 * Each match is replaced with the command's stdout (or an error message).
 * Commands are executed in parallel for better performance.
 */
export async function executeInlineCommands(
  content: string,
  skillDir: string,
  context?: ToolExecutionContext,
): Promise<string> {
  const pattern = /!`([^`]+)`/g;
  const matches = [...content.matchAll(pattern)];
  if (matches.length === 0) return content;

  // Execute all commands in parallel
  const results = await Promise.allSettled(
    matches.map(async (match) => {
      const command = match[1];
      try {
        const output = await invokeTaskCommand<CommandOutput>('run_shell_command', {
          command,
          cwd: skillDir,
          background: false,
          timeout: 10,
          sandboxEnabled: true,
          extraWritablePaths: [skillDir],
        }, context, { commandIdPrefix: 'skill-inline' });
        return output.code === 0
          ? output.stdout.trim()
          : `[Command failed: ${output.stderr.trim()}]`;
      } catch (err) {
        return `[Command error: ${err instanceof Error ? err.message : String(err)}]`;
      }
    }),
  );

  // Replace in reverse order to preserve indices
  let result = content;
  for (let i = matches.length - 1; i >= 0; i--) {
    const match = matches[i];
    const start = match.index!;
    const end = start + match[0].length;
    const settled = results[i];
    const replacement = settled.status === 'fulfilled' ? settled.value : `[Command error: ${settled.reason}]`;
    result = result.substring(0, start) + replacement + result.substring(end);
  }

  return result;
}
