/**
 * skill_view — read-only inspection of a skill without activating routing.
 *
 * Complements `use_skill` (which activates routing + loads content) by
 * letting the agent peek at a skill's full content when the L0 description
 * alone is too thin to judge relevance. Also handles supporting-file lookups
 * via the optional `file_path` arg, making `skill_list_files` unnecessary —
 * the default response already includes a `supporting_files` array the
 * agent can iterate on.
 *
 * ## Usage
 *
 *   skill_view("weekly-report")
 *     → JSON { name, description, source, trigger, content, supporting_files }
 *
 *   skill_view("weekly-report", "references/api-guide.md")
 *     → raw supporting-file content (string)
 *
 * ## Differences from `read_skill_file`
 *
 * - `read_skill_file` always requires a path; reads only supporting files.
 * - `skill_view` can read the SKILL.md body (no path) or a supporting file
 *   (with path). One tool, two modes.
 * - Kept `read_skill_file` registered for backward compat — callers that
 *   have it in prompt memory still work.
 */

import type { ToolDefinition } from '../../../types';
import { skillLoader } from '../../skill/loader';
import { TOOL_NAMES } from '../toolNames';

export const skillViewTool: ToolDefinition = {
  name: TOOL_NAMES.SKILL_VIEW,
  description:
    'View the full SKILL.md content of a skill without activating routing.' +
    ' Optionally pass file_path to read a supporting file in that skill\'s directory (references / templates / scripts / assets).' +
    ' Use case: when the description alone is not enough to judge relevance, view the skill first and then decide whether to use_skill; or to inspect reference materials or templates in supporting files.',
  inputSchema: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description: 'Name of the skill to view.',
      },
      file_path: {
        type: 'string',
        description:
          'Optional: relative path of a supporting file within the skill directory, e.g. "references/api.md". When omitted, returns the full SKILL.md content plus a list of supporting files.',
      },
    },
    required: ['name'],
  },
  execute: async (input) => {
    const name = input.name as string;
    const filePath = input.file_path as string | undefined;

    const skill = skillLoader.getSkill(name);
    if (!skill) {
      const available = skillLoader
        .getAvailableSkills()
        .map((s) => s.name)
        .slice(0, 10);
      const hint = available.length > 0
        ? ` Available (sample): ${available.join(', ')}`
        : '';
      return `Error: skill "${name}" not found.${hint}`;
    }

    // ── Mode B: supporting file lookup ─────────────────────────────────
    if (filePath) {
      // Path-traversal defense is handled inside loader.loadSupportingFile
      // (rejects paths containing ".."). Keep this as a second layer.
      if (filePath.includes('..')) {
        return `Error: file_path must not contain "..". Use a path relative to the skill directory.`;
      }

      const content = await skillLoader.loadSupportingFile(name, filePath);
      if (content === null) {
        const files = await skillLoader.listSupportingFiles(name);
        if (files.length === 0) {
          return `Error: file "${filePath}" not found in skill "${name}" (skill has no supporting files).`;
        }
        return (
          `Error: file "${filePath}" not found in skill "${name}".\n` +
          `Available supporting files:\n${files.map((f) => `- ${f}`).join('\n')}`
        );
      }
      return content;
    }

    // ── Mode A: full SKILL.md view ─────────────────────────────────────
    const supportingFiles = await skillLoader.listSupportingFiles(name);
    return JSON.stringify(
      {
        name: skill.name,
        description: skill.description,
        source: skill.source,
        trigger: skill.trigger,
        do_not_trigger: skill.doNotTrigger,
        content: skill.content,
        supporting_files: supportingFiles,
      },
      null,
      2,
    );
  },
  isConcurrencySafe: true,
};
