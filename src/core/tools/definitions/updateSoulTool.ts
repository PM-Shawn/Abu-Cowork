import type { ToolDefinition } from '../../../types';
import { saveSoul } from '../../agent/soulConfig';
import { useSettingsStore } from '../../../stores/settingsStore';
import { TOOL_NAMES } from '../toolNames';
import { getI18n, format } from '../../../i18n';

export const updateSoulTool: ToolDefinition = {
  name: TOOL_NAMES.UPDATE_SOUL,
  description: 'Update your personality configuration. Call this tool when the user asks you to adjust your personality or communication style. Writes the full content (not a delta) — replaces the existing configuration.',
  inputSchema: {
    type: 'object',
    properties: {
      content: {
        type: 'string',
        description: 'Complete personality configuration content (markdown format)',
      },
    },
    required: ['content'],
  },
  execute: async (input) => {
    const tu = getI18n().toolResult.updateSoul;
    const content = (input.content as string || '').trim();
    if (!content) {
      return tu.errContentEmpty;
    }

    try {
      await saveSoul(content);
      // Mark soul as initialized (bootstrap won't trigger again)
      useSettingsStore.getState().setSoulInitialized(true);
      return tu.updated;
    } catch (err) {
      return format(tu.updateFailed, { error: err instanceof Error ? err.message : String(err) });
    }
  },
};
