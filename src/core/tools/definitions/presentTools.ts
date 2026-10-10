import type { ToolDefinition, ToolExecutionContext } from '../../../types';
import { TOOL_NAMES } from '../toolNames';
import { getI18n, format } from '../../../i18n';
import { exists, stat } from '../fsBridge';
import {
  checkReadPath,
  createAuthorizationScope,
  disposeAuthorizationScope,
  scopedAuthorizeWorkspace,
  type AuthorizationScopeId,
} from '../pathSafety';
import { resolveExpectedFile } from '../../team/expectedFiles';
import { normalizeLexicalPath } from '../../../utils/pathUtils';

export const MAX_PRESENTED_FILES = 8;

export interface PresentedFileInput {
  path: string;
  description?: string;
}

/** Model input → entries with a non-blank string path; description kept only when non-empty. */
export function parsePresentedFilesInput(raw: unknown): PresentedFileInput[] {
  if (!Array.isArray(raw)) return [];
  const files: PresentedFileInput[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue;
    const { path, description } = entry as Record<string, unknown>;
    if (typeof path !== 'string') continue;
    const trimmed = path.trim();
    if (!trimmed) continue;
    files.push(
      typeof description === 'string' && description !== ''
        ? { path: trimmed, description }
        : { path: trimmed },
    );
  }
  return files;
}

/**
 * A successful call answers with one line per file, `Presented <absolute path>`,
 * in the order of its input. The text is the same in every interface language,
 * because the chat reads the presented paths back from it.
 */
export const PRESENTED_RESULT_PREFIX = 'Presented ';

/** The paths a result lists when each of its non-empty lines is a presented line; otherwise null. */
export function parsePresentedResult(result: string): string[] | null {
  const paths: string[] = [];
  for (const line of result.split('\n')) {
    if (line.trim() === '') continue;
    if (!line.startsWith(PRESENTED_RESULT_PREFIX)) return null;
    paths.push(line.slice(PRESENTED_RESULT_PREFIX.length));
  }
  return paths;
}

type RejectionReason = 'needsAbsolutePath' | 'notAuthorized' | 'notFound' | 'notAFile';

function isAbsolutePath(file: string): boolean {
  return /^(?:[a-zA-Z]:[\\/]|[\\/])/.test(file);
}

/**
 * Which paths the run of `context` may read, decided by checkReadPath alone.
 *
 * A run with an authorization scope of its own is held to that scope. A run
 * without one is checked against the shared grants, and a path those do not
 * cover is checked against a scope that holds the run's workspace and nothing
 * else: the shared table follows the conversation in view, so it stops
 * listing this run's workspace once the user looks at another conversation.
 * No path is ever granted here and nobody is asked; `release` drops the scope.
 */
function readAuthorizationOfRun(context: ToolExecutionContext | undefined): {
  allows: (path: string) => Promise<boolean>;
  release: () => void;
} {
  const runScopeId = context?.authorizationScopeId;
  const workspacePath = context?.workspacePath;
  let workspaceScopeId: AuthorizationScopeId | undefined;

  return {
    allows: async (path) => {
      if ((await checkReadPath(path, runScopeId)).allowed === true) return true;
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
        if (!(await exists(resolved))) {
          rejected.push({ path: resolved, reason: 'notFound' });
          continue;
        }
        if (!(await stat(resolved)).isFile) {
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
