/**
 * Skill-Scoped Hooks
 *
 * Activates lifecycle hooks defined in a skill's frontmatter.
 * Hooks are scoped to the skill's lifetime — deactivated when skill is deactivated.
 */

import type { Skill, ToolExecutionContext } from '../../types';
import { registerHook } from '../agent/lifecycleHooks';
import type { PreToolCallEvent, PostToolCallEvent } from '../agent/lifecycleHooks';
import { invokeTaskCommand } from '../tools/helpers/scopedCommand';
import { matchWildcard } from './toolFilter';

interface CommandOutput {
  stdout: string;
  stderr: string;
  code: number;
}

/**
 * Execute a hook command in the skill's directory.
 * Returns true if the command succeeded (exit code 0), false otherwise.
 */
async function executeHookCommand(
  command: string,
  skillDir: string,
  context?: ToolExecutionContext,
): Promise<boolean> {
  try {
    const output = await invokeTaskCommand<CommandOutput>('run_shell_command', {
      command,
      cwd: skillDir,
      background: false,
      timeout: 10,
      sandboxEnabled: true,
      extraWritablePaths: [skillDir],
    }, context, { commandIdPrefix: 'skill-hook' });
    return output.code === 0;
  } catch {
    return false;
  }
}

/**
 * Activate a skill's scoped hooks.
 * Returns a cleanup function that unregisters all hooks.
 */
export function activateSkillHooks(skill: Skill): () => void {
  if (!skill.hooks) return () => {};

  const cleanups: Array<() => void> = [];

  // Register PreToolUse hooks
  if (skill.hooks.PreToolUse) {
    for (const entry of skill.hooks.PreToolUse) {
      const cleanup = registerHook<PreToolCallEvent>(
        'preToolCall',
        async (event: PreToolCallEvent) => {
          if (!matchWildcard(event.toolName, entry.matcher)) return;

          for (const hook of entry.hooks) {
            if (hook.type === 'command') {
              const success = await executeHookCommand(
                hook.command,
                skill.skillDir,
                { abortSignal: event.abortSignal },
              );
              if (!success) {
                event.blocked = true;
              }
            }
          }
        },
      );
      cleanups.push(cleanup);
    }
  }

  // Register PostToolUse hooks
  if (skill.hooks.PostToolUse) {
    for (const entry of skill.hooks.PostToolUse) {
      const cleanup = registerHook<PostToolCallEvent>(
        'postToolCall',
        async (event: PostToolCallEvent) => {
          if (!matchWildcard(event.toolName, entry.matcher)) return;

          for (const hook of entry.hooks) {
            if (hook.type === 'command') {
              await executeHookCommand(
                hook.command,
                skill.skillDir,
                { abortSignal: event.abortSignal },
              );
            }
          }
        },
      );
      cleanups.push(cleanup);
    }
  }

  return () => cleanups.forEach(fn => fn());
}
