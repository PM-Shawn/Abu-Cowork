import type { ToolDefinition, ToolResult } from '../../../types';
import { TOOL_NAMES } from '../toolNames';
import { resolveDeferredToolSearch } from '../toolSearch';
import { getAllTools } from '../registry';
import { getI18n, format } from '../../../i18n';

/**
 * tool_search — lets the LLM discover and load deferred tools on demand.
 *
 * When tools are deferred (only name + description in system prompt),
 * the LLM calls this tool to get the full input schema before invoking them.
 * The agent runtime promotes schemas confirmed in the successful result. This
 * execute function may run in a different process, so it deliberately keeps no
 * conversation catalog or promotion state of its own.
 */
export const toolSearchTool: ToolDefinition = {
  name: TOOL_NAMES.TOOL_SEARCH,
  description: 'Search for and load deferred tools. When you need to use a deferred tool listed in the system prompt, call this tool first to get its full parameter definition, then you can invoke that tool directly in subsequent turns.',
  inputSchema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Search keywords — can be a tool name or a description of the desired capability',
      },
      max_results: {
        type: 'number',
        description: 'Maximum number of results to return (default 5)',
      },
    },
    required: ['query'],
  },
  isConcurrencySafe: true,
  async execute(input, context): Promise<ToolResult> {
    const ts = getI18n().toolResult.toolSearch;
    const query = typeof input.query === 'string' ? input.query : '';

    // Fail closed without a conversation scope. Searching the global registry
    // would re-return already loaded or policy-blocked tools and let the model
    // escape the exposure selected by the host for this turn.
    const deferredNames = Array.isArray(context?.deferredToolNames)
      ? new Set(context.deferredToolNames.filter((name): name is string => typeof name === 'string'))
      : new Set<string>();
    const deferredTools = context?.conversationId
      ? getAllTools().filter(tool => deferredNames.has(tool.name))
      : [];
    const matched = resolveDeferredToolSearch(input, deferredTools);

    if (matched.length === 0) {
      return format(ts.noResults, { query });
    }

    // Return full schema for each matched tool
    const results = matched.map(tool => {
      const schema = JSON.stringify(tool.inputSchema, null, 2);
      return `### ${tool.name}\n${tool.description}\n\n${ts.schemaLabel}\n\`\`\`json\n${schema}\n\`\`\``;
    });

    return format(ts.resultsFound, { count: String(matched.length), results: results.join('\n\n---\n\n') });
  },
};
