import type { ToolDefinition } from '@/types';
import type { AppRunRef } from '@/types/app';
import { appPageUrl, appRuns } from '../../../../electron/shared/appSpec.mjs';
import { draftFor, draftHasApp, readAppDraft, usersOwnRefs } from '@/core/app/appDraft';
import { TOOL_NAMES } from '../toolNames';

/**
 * Validation only, for 「创建应用」: reads the draft folder of THIS
 * conversation (never a path the model names), checks it, and returns what
 * the preview will show. Nothing is created until the user confirms the
 * preview card in the conversation. Before anything is written it reports the
 * experts and teams the user already has, which `mine:` references can name.
 */
export const prepareAppTool: ToolDefinition = {
  name: TOOL_NAMES.APP_PREPARE,
  description: 'Validate the app draft of this app-creation conversation (.abu-app/app.json, agents/, teams/ in the conversation folder). Call it once before writing anything to learn the experts and teams the user already has, and again after writing or changing the draft. Returns what the user will see in the preview; on a problem, the error names the field to fix. Nothing is created: the user confirms the preview card shown in the conversation.',
  inputSchema: { type: 'object', properties: {} },
  execute: async (input, context) => {
    if (Object.keys(input).length) throw new Error('App preparation accepts no arguments');
    if (!context?.conversationId) throw new Error('App preparation requires an app creation conversation');
    const draft = draftFor(context.conversationId);
    const yours = usersOwnRefs();
    if (!(await draftHasApp(draft))) {
      return JSON.stringify({
        status: 'empty',
        yours,
        next: 'Nothing is written yet. Write .abu-app/app.json (and agents/, teams/ for new experts and teams) in the conversation folder, then call app_prepare again.',
      });
    }
    const preview = await readAppDraft(draft);
    const run = (ref: AppRunRef | undefined) => ref ?? null;
    return JSON.stringify({
      status: 'ready',
      name: preview.file.name,
      title: preview.file.interface.displayName,
      version: preview.file.version,
      scenes: appRuns(preview.file.config).map((entry) => ({ field: entry.field, mode: entry.modeId ?? null, scene: entry.sceneId ?? null, run: run(entry.run) })),
      pages: (preview.file.config.nav?.items ?? []).map((item) => appPageUrl(item.target)).filter((url): url is string => url !== undefined),
      newExperts: preview.experts.map((expert) => expert.name),
      newTeams: preview.teams.map((team) => team.id),
      yours,
      next: 'Tell the user the preview is ready below this message: they can confirm it to add the app, or say what to change. Nothing has been created yet.',
    });
  },
};
