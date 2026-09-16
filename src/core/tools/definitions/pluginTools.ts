import { homeDir } from '@tauri-apps/api/path';
import { readInstalledResult } from '@/core/plugin/installedStore';
import type { ToolDefinition } from '@/types';
import { usePluginAuthorStore } from '@/stores/pluginAuthorStore';
import { releasePreparedInstall } from '@/core/plugin/installer';
import { TOOL_NAMES } from '../toolNames';

/** Validation only: never accepts a path, installs, grants or executes a plugin. */
export const preparePluginTool: ToolDefinition = {
  name: TOOL_NAMES.PLUGIN_PREPARE,
  description: 'Validate the local plugin belonging to this plugin-creation conversation. Use after writing its manifest and components. Returns validation results only; the user installs or updates from Extensions > Plugins > Mine.',
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
      const next = status === 'update-available'
        ? 'Tell the user the source changes are validated but not applied. Open Extensions > Plugins > Mine, open this plugin, then Preview update and confirm Update. The installed version remains unchanged until confirmation.'
        : status === 'unchanged'
          ? 'Tell the user the validated content matches the installed version; no update is needed.'
          : 'Ask the user to open Extensions > Plugins > Mine and review installation or check for updates. Nothing has been installed or enabled.';
      return JSON.stringify({ name: author.name, status, version: disclosure.version, skills: disclosure.skills,
        agents: disclosure.agents, connectors: disclosure.mcpServers.map(server => server.name),
        unsupported: disclosure.ignoredPayloads, next });
    } finally { if (disclosure.preparedToken) await releasePreparedInstall(disclosure.preparedToken); }
  },
};
