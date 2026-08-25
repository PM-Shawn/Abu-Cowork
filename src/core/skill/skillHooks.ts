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
import { explainBlockedSkillCommand } from './preprocessor';

interface CommandOutput {
  stdout: string;
  stderr: string;
  code: number;
}

function eventBelongsToActivation(
  event: PreToolCallEvent | PostToolCallEvent,
  activationContext?: ToolExecutionContext,
): boolean {
  if (!activationContext) return true;
  if (
    activationContext.loopId !== undefined &&
    event.toolContext?.loopId !== activationContext.loopId
  ) {
    return false;
  }
  if (
    activationContext.conversationId !== undefined &&
    (event.toolContext?.conversationId ?? event.conversationId) !== activationContext.conversationId
  ) {
    return false;
  }
  return true;
}

function commandContextForEvent(
  event: PreToolCallEvent | PostToolCallEvent,
  activationContext?: ToolExecutionContext,
): ToolExecutionContext {
  // The activation context owns authority. Event context is only a fallback
  // for legacy direct registrations that did not supply one; a concurrent run
  // must never lend its ceiling, scope, or approval bridge to this skill.
  return {
    ...(activationContext ?? event.toolContext),
    abortSignal: event.abortSignal,
  };
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
    if (await explainBlockedSkillCommand(command, skillDir, context)) {
      return false;
    }
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
export function activateSkillHooks(skill: Skill, context?: ToolExecutionContext): () => void {
  if (!skill.hooks) return () => {};

  const cleanups: Array<() => void> = [];

  // Register PreToolUse hooks
  if (skill.hooks.PreToolUse) {
    for (const entry of skill.hooks.PreToolUse) {
      const cleanup = registerHook<PreToolCallEvent>(
        'preToolCall',
        async (event: PreToolCallEvent) => {
          if (!matchWildcard(event.toolName, entry.matcher)) return;
          if (!eventBelongsToActivation(event, context)) return;

          for (const hook of entry.hooks) {
            if (hook.type === 'command') {
              const success = await executeHookCommand(
                hook.command,
                skill.skillDir,
                commandContextForEvent(event, context),
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
          if (!eventBelongsToActivation(event, context)) return;

          for (const hook of entry.hooks) {
            if (hook.type === 'command') {
              await executeHookCommand(
                hook.command,
                skill.skillDir,
                commandContextForEvent(event, context),
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
