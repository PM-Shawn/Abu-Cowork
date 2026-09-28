import { homeDir } from '@tauri-apps/api/path';
import { readInstalledResult } from '@/core/plugin/installedStore';
import type { ToolDefinition } from '@/types';
import type { AppConfig, AppRunRef, ParsedPluginTeam } from '@/types/app';
import { usePluginAuthorStore } from '@/stores/pluginAuthorStore';
import { releasePreparedInstall } from '@/core/plugin/installer';
import { appPageUrl } from '../../../../electron/shared/pluginAppSpec.mjs';
import { TOOL_NAMES } from '../toolNames';

/** The validated app the way the install disclosure shows it, for the model to read back. */
function describeApp(app: AppConfig | undefined) {
  if (!app) return null;
  const run = (ref: AppRunRef | undefined) => ref ?? null;
  return {
    title: app.home.header?.title ?? null,
    defaultRun: run(app.defaultRun),
    modes: app.home.modes.items.map(mode => ({
      id: mode.modeId,
      title: mode.title,
      scenes: mode.scenes.map(scene => ({ id: scene.id, title: scene.title, run: run(scene.run ?? app.defaultRun), templates: scene.templates.map(template => template.id) })),
    })),
    nav: (app.nav?.items ?? []).map(item => ({ id: item.id, target: item.target })),
    pages: (app.nav?.items ?? []).map(item => appPageUrl(item.target)).filter((url): url is string => url !== undefined),
    requiredConnectors: app.requiredConnectors ?? [],
  };
}

function describeTeams(teams: ParsedPluginTeam[] | undefined) {
  return (teams ?? []).map(team => ({ id: team.id, name: team.name, leader: team.leaderRoleId, members: team.memberRoleIds }));
}

/** Validation only: never accepts a path, installs, grants or executes a plugin. */
export const preparePluginTool: ToolDefinition = {
  name: TOOL_NAMES.PLUGIN_PREPARE,
  description: 'Validate the local plugin or app belonging to this plugin-creation conversation. Use after writing its manifest and components. Returns validation results only, including the teams and the app configuration the user will see; the user installs or updates from Extensions > Plugins > Mine.',
  inputSchema: { type: 'object', properties: {} },
  execute: async (_input, context) => {
    if (Object.keys(_input).length) throw new Error('Plugin preparation accepts no arguments');
    if (!context?.conversationId) throw new Error('Plugin preparation requires a creation conversation');
    const { author, disclosure } = await usePluginAuthorStore.getState().prepare({ conversationId: context.conversationId });
    try {
      const registry = await readInstalledResult(await homeDir());
      const installed = registry.ok ? registry.plugins.find(plugin => plugin.key === author.key && plugin.authoringId === author.id) : undefined;
      const status = !registry.ok ? 'unknown' : !installed ? 'ready-to-install'
        : installed.checksum === author.prepared?.checksum ? 'unchanged' : 'update-available';
      const app = describeApp(disclosure.app);
      const next = status === 'update-available'
        ? 'Tell the user the source changes are validated but not applied. Open Extensions > Plugins > Mine, open this plugin, then Preview update and confirm Update. The installed version remains unchanged until confirmation.'
        : status === 'unchanged'
          ? 'Tell the user the validated content matches the installed version; no update is needed.'
          : app
            ? 'Ask the user to open Extensions > Plugins > Mine and review installation. Nothing has been installed or enabled. After the user confirms, the app appears in the app switcher and opens right away.'
            : 'Ask the user to open Extensions > Plugins > Mine and review installation or check for updates. Nothing has been installed or enabled.';
      return JSON.stringify({ name: author.name, status, version: disclosure.version, skills: disclosure.skills,
        agents: disclosure.agents, connectors: disclosure.mcpServers.map(server => server.name),
        teams: describeTeams(disclosure.teams), app,
        unsupported: disclosure.ignoredPayloads, next });
    } finally { if (disclosure.preparedToken) await releasePreparedInstall(disclosure.preparedToken); }
  },
};
