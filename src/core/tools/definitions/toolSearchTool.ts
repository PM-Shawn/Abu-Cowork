import type { ToolDefinition, ToolResult } from '../../../types';
import { TOOL_NAMES } from '../toolNames';
import { getAllTools } from '../registry';
import { searchTools, promoteToolToSession } from '../toolSearch';

/**
 * tool_search — lets the LLM discover and load deferred tools on demand.
 *
 * When tools are deferred (only name + description in system prompt),
 * the LLM calls this tool to get the full input schema before invoking them.
 * Matched tools are automatically promoted to session-core for subsequent turns.
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
  async execute(input): Promise<ToolResult> {
    const query = input.query as string;
    const maxResults = (input.max_results as number) ?? 5;

    const allTools = getAllTools();
    const matched = searchTools(query, allTools, maxResults);

    if (matched.length === 0) {
      return `未找到匹配 "${query}" 的工具。请尝试其他关键词。`;
    }

    // Promote matched tools to session core
    for (const tool of matched) {
      promoteToolToSession(tool.name);
    }

    // Return full schema for each matched tool
    const results = matched.map(tool => {
      const schema = JSON.stringify(tool.inputSchema, null, 2);
      return `### ${tool.name}\n${tool.description}\n\n参数 Schema:\n\`\`\`json\n${schema}\n\`\`\``;
    });

    return `找到 ${matched.length} 个工具：\n\n${results.join('\n\n---\n\n')}\n\n以上工具已加载，可以在后续回合中直接调用。`;
  },
};
