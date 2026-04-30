import type { ToolDefinition } from '../../../types';
import { useChatStore } from '../../../stores/chatStore';
import { useWorkspaceStore } from '../../../stores/workspaceStore';
import { TOOL_NAMES } from '../toolNames';

/**
 * Format a timestamp as a short date string (MM-DD HH:mm).
 */
function formatTime(ts: number): string {
  const d = new Date(ts);
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const min = String(d.getMinutes()).padStart(2, '0');
  return `${mm}-${dd} ${hh}:${min}`;
}

/**
 * Check if a text contains any of the query tokens (case-insensitive).
 */
function matchesQuery(text: string, queryTokens: string[]): boolean {
  const lower = text.toLowerCase();
  return queryTokens.some(t => lower.includes(t));
}

export const recallTool: ToolDefinition = {
  name: TOOL_NAMES.RECALL,
  description: '回忆过去的记忆、任务记录和历史会话。当用户问到"之前"、"上次"、"最近做了什么"、"你记得吗"、"我们聊过什么"等需要回溯历史的问题时使用。',
  inputSchema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: '搜索关键词（匹配记忆内容、任务摘要、对话标题）',
      },
      limit: {
        type: 'number',
        description: '每类数据源最多返回条数，默认 10',
      },
    },
    required: [],
  },
  execute: async (input, context) => {
    const query = ((input.query as string) || '').trim();
    const limit = (input.limit as number) || 10;
    const queryTokens = query.toLowerCase().split(/\s+/).filter(t => t.length > 0);

    const workspacePath = context?.workspacePath ?? useWorkspaceStore.getState().currentPath;
    const sections: string[] = [];

    // --- 1. Memdir memories (global + workspace) ---
    try {
      const { scanMemoryFiles, readMemoryFile } = await import('../../memdir/scan');
      const { touchMemory } = await import('../../memdir/write');

      // Scan both global and workspace memories
      const [globalHeaders, wsHeaders] = await Promise.all([
        scanMemoryFiles(null),
        workspacePath ? scanMemoryFiles(workspacePath) : Promise.resolve([]),
      ]);
      let allHeaders = [...globalHeaders, ...wsHeaders];

      // Filter by query if provided
      if (queryTokens.length > 0) {
        allHeaders = allHeaders.filter(h =>
          matchesQuery(h.name, queryTokens) ||
          matchesQuery(h.description, queryTokens) ||
          matchesQuery(h.filename, queryTokens)
        );
      }

      // Recency-first; accessCount as tiebreaker. accessCount now only
      // counts real recall-tool hits (passive system-prompt injection no
      // longer touches it), so high counts are a meaningful signal of
      // utility rather than a self-reinforcing positive feedback loop.
      allHeaders.sort((a, b) => b.updated - a.updated || b.accessCount - a.accessCount);
      const top = allHeaders.slice(0, limit);

      if (top.length > 0) {
        const lines: string[] = [];
        for (const h of top) {
          const file = await readMemoryFile(h.filePath);
          const contentPreview = file ? file.content.slice(0, 150) : '';
          lines.push(`- [${h.type}] ${h.name}${contentPreview ? ': ' + contentPreview : ''} (${formatTime(h.updated)})`);
          // Touch accessed memories (fire-and-forget)
          touchMemory(h.filePath).catch(() => {});
        }
        sections.push(`## 记忆 (${top.length}条)\n${lines.join('\n')}`);
      }
    } catch {
      // Non-critical
    }

    // --- 2. Task log ---
    try {
      const { readTaskLog } = await import('../../agent/taskLog');
      const allTasks = await readTaskLog();

      let tasks = allTasks;
      if (queryTokens.length > 0) {
        tasks = allTasks.filter(t => matchesQuery(t.summary, queryTokens) || matchesQuery(t.category, queryTokens));
      }
      tasks = tasks.slice(-limit); // most recent N

      if (tasks.length > 0) {
        const lines = tasks.map(t =>
          `- [${t.category}] ${t.summary} ${t.success ? '✓' : '✗'} (${formatTime(t.timestamp)})`
        );
        sections.push(`## 任务记录 (${tasks.length}条)\n${lines.join('\n')}`);
      }
    } catch {
      // Non-critical
    }

    // --- 3. Conversation index (from chatStore) ---
    try {
      const conversationIndex = useChatStore.getState().conversationIndex;
      const convList = Object.values(conversationIndex)
        .filter(c => c.messageCount >= 2)
        .sort((a, b) => b.updatedAt - a.updatedAt);

      let matched = convList;
      if (queryTokens.length > 0) {
        matched = convList.filter(c => matchesQuery(c.title || '', queryTokens));
      }
      matched = matched.slice(0, limit);

      if (matched.length > 0) {
        const lines = matched.map(c =>
          `- "${c.title || '无标题'}" (${c.messageCount}条消息, ${formatTime(c.updatedAt)})`
        );
        sections.push(`## 历史会话 (${matched.length}条)\n${lines.join('\n')}`);
      }
    } catch {
      // Non-critical
    }

    if (sections.length === 0) {
      return query
        ? `没有找到与"${query}"相关的记忆、任务记录或历史会话。`
        : '当前没有存储的记忆、任务记录或历史会话。';
    }

    return sections.join('\n\n');
  },
  isConcurrencySafe: true,
};
