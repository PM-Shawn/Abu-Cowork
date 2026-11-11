import type { ToolDefinition, ToolExecutionContext } from '../../../types';
import { TOOL_NAMES } from '../toolNames';
import { getI18n, format } from '../../../i18n';
import { exists, stat } from '../fsBridge';
import { useChatStore } from '../../../stores/chatStore';
import {
  checkConversationResultRead,
  checkReadPath,
  createAuthorizationScope,
  disposeAuthorizationScope,
  scopedAuthorizeWorkspace,
  type AuthorizationScopeId,
} from '../pathSafety';
import { resolveExpectedFile } from '../../team/expectedFiles';
import { normalizeLexicalPath } from '../../../utils/pathUtils';
import { parsePresentedFilesInput, PRESENTED_RESULT_PREFIX } from '../../media/presentedFileRecords';
export { parsePresentedFilesInput, parsePresentedResult, PRESENTED_RESULT_PREFIX, type PresentedFileInput } from '../../media/presentedFileRecords';

export const MAX_PRESENTED_FILES = 8;

type RejectionReason = 'needsAbsolutePath' | 'notAuthorized' | 'notFound' | 'notAFile';

function isAbsolutePath(file: string): boolean {
  return /^(?:[a-zA-Z]:[\\/]|[\\/])/.test(file);
}

/**
 * Which paths the run of `context` may read: what `read_file` lets it read,
 * without the side effects.
 *
 * The check is the registry's own: the conversation's tool results, then
 * `checkReadPath` under the run's scope. A path that check only holds for a
 * grant (a folder of the user's) is readable too, because a read never asks;
 * `read_file` would grant that folder at this point, and this check grants
 * nothing and asks nobody. A run that may not prompt (the files a compaction
 * re-reads) and a run with a scope of its own are held to what is already
 * granted. A run without a scope that the shared grants do not cover is also
 * checked against a scope that holds its workspace and nothing else: the
 * shared table follows the conversation in view, so it stops listing this
 * run's workspace once the user looks at another conversation. A blocked path
 * stays refused by every one of these checks; `release` drops the scope.
 */
function readAuthorizationOfRun(context: ToolExecutionContext | undefined): {
  allows: (path: string) => Promise<boolean>;
  release: () => void;
} {
  const runScopeId = context?.authorizationScopeId;
  const workspacePath = context?.workspacePath;
  const conversationId = context?.conversationId;
  const ownerId = conversationId && useChatStore.getState().conversations[conversationId] ? conversationId : undefined;
  let workspaceScopeId: AuthorizationScopeId | undefined;

  const readableUnderScope = async (path: string, scopeId: AuthorizationScopeId | undefined): Promise<boolean> => {
    const check = await checkReadPath(path, scopeId);
    if (check.allowed === true) return true;
    return scopeId === undefined
      && context?.allowPermissionPrompts !== false
      && check.needsPermission === true
      // Only a folder read_file would grant without a per-file question: a path
      // that only gets a per-file ask (app data without a host resolver, a
      // spelling of home, outside the user's folders) is not presented.
      && check.permissionIsFolder === true
      && Boolean(check.permissionPath);
  };

  return {
    allows: async (path) => {
      if ((await checkConversationResultRead(path, ownerId))?.allowed === true) return true;
      if (await readableUnderScope(path, runScopeId)) return true;
      if (runScopeId !== undefined || !workspacePath) return false;
      if (workspaceScopeId === undefined) {
        workspaceScopeId = createAuthorizationScope();
        scopedAuthorizeWorkspace(workspaceScopeId, workspacePath, ['read']);
      }
      return (await checkReadPath(path, workspaceScopeId)).allowed === true;
    },
    release: () => disposeAuthorizationScope(workspaceScopeId),
  };
}

/**
 * present_files — the agent declares the files it hands to the user this turn.
 *
 * The declaration is the tool call itself: the chat reads the paths from the
 * result of a call that listed every file it was given, and the descriptions
 * from its input. A call is all-or-nothing, so one bad path fails the whole
 * call and the model resends the full list.
 */
export const presentFilesTool: ToolDefinition = {
  name: TOOL_NAMES.PRESENT_FILES,
  description:
    'Present finished files to the user as the deliverables of this turn. Call it once near the end, after the files exist on disk. List only what the user asked for or will keep — usually the 1-2 most important files; never scripts, drafts, logs or other intermediate files. Skip it when your final reply alone is enough. Each path must be an existing regular file (absolute, or relative to the workspace). The user opens the current file on disk; nothing is copied. Images produced by generate_image or process_image are presented automatically.',
  inputSchema: {
    type: 'object',
    properties: {
      files: {
        type: 'array',
        description: 'The files to present, most important first',
        minItems: 1,
        maxItems: MAX_PRESENTED_FILES,
        items: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Path of the file (absolute, or relative to the workspace)' },
            description: { type: 'string', description: 'One short sentence telling the user what this file is' },
          },
          required: ['path'],
        },
      },
    },
    required: ['files'],
  },
  execute: async (input, context) => {
    const t = getI18n().toolResult.present;

    const files = parsePresentedFilesInput(input.files);
    if (files.length === 0 || files.length > MAX_PRESENTED_FILES) {
      return `Error: ${format(t.countOutOfRange, { max: MAX_PRESENTED_FILES })}`;
    }

    const accepted: string[] = [];
    const rejected: { path: string; reason: RejectionReason }[] = [];
    const readAuthorization = readAuthorizationOfRun(context);

    try {
      for (const file of files) {
        const joined = resolveExpectedFile(file.path, context?.workspacePath);
        if (file.path.startsWith('~') || !isAbsolutePath(joined)) {
          rejected.push({ path: file.path, reason: 'needsAbsolutePath' });
          continue;
        }
        const resolved = normalizeLexicalPath(joined);
        // Authorization comes before any disk probe, so an unauthorized path
        // reveals nothing about whether it exists.
        if (!(await readAuthorization.allows(resolved))) {
          rejected.push({ path: resolved, reason: 'notAuthorized' });
          continue;
        }
        if (!(await (context?.files ? context.files.exists(resolved) : exists(resolved)))) {
          rejected.push({ path: resolved, reason: 'notFound' });
          continue;
        }
        if (!(await (context?.files ? context.files.stat(resolved) : stat(resolved))).isFile) {
          rejected.push({ path: resolved, reason: 'notAFile' });
          continue;
        }
        accepted.push(resolved);
      }
    } finally {
      readAuthorization.release();
    }

    if (rejected.length > 0) {
      const lines = [
        `Error: ${t.nothingPresented}`,
        ...rejected.map(({ path, reason }) => `- ${path}: ${t[reason]}`),
      ];
      if (accepted.length > 0) {
        lines.push(t.theseWereFine, ...accepted.map((path) => `- ${path}`));
      }
      lines.push(t.fixAndRetry);
      return lines.join('\n');
    }

    return accepted.map((path) => `${PRESENTED_RESULT_PREFIX}${path}`).join('\n');
  },
  isConcurrencySafe: true,
};
