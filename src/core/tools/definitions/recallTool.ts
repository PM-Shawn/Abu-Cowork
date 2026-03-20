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
      scope: {
        type: 'string',
        description: '搜索范围: user(个人级，默认) / project(项目级)',
        enum: ['user', 'project'],
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
    const scope = ((input.scope as string) || 'user') as 'user' | 'project';
    const limit = (input.limit as number) || 10;
    const queryTokens = query.toLowerCase().split(/\s+/).filter(t => t.length > 0);

    const workspacePath = context?.workspacePath ?? useWorkspaceStore.getState().currentPath;
    const sections: string[] = [];

    // --- 1. Structured memories ---
    try {
      const { getMemoryBackend } = await import('../../memory/router');
      const backend = getMemoryBackend();

      let memories: import('../../memory/types').MemoryEntry[];
      if (queryTokens.length > 0) {
        memories = await backend.search(query, {
          scope,
          projectPath: scope === 'project' ? workspacePath ?? undefined : undefined,
          limit,
        });
      } else {
        // No query: return most recent memories
        const all = await backend.list({
          scope,
          projectPath: scope === 'project' ? workspacePath ?? undefined : undefined,
        });
        memories = all
          .filter(e => e.category !== 'conversation_index')
          .sort((a, b) => b.updatedAt - a.updatedAt)
          .slice(0, limit);
      }

      // Exclude conversation_index entries (those go in section 3)
      memories = memories.filter(e => e.category !== 'conversation_index');

      if (memories.length > 0) {
        const lines = memories.map(e =>
          `- [${e.category}] ${e.summary}${e.content !== e.summary ? ': ' + e.content.slice(0, 150) : ''} (${formatTime(e.updatedAt)})`
        );
        sections.push(`## 记忆 (${memories.length}条)\n${lines.join('\n')}`);

        // Touch accessed entries (fire-and-forget)
        for (const e of memories) {
          backend.touch(e.id).catch(() => {});
        }
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

    // --- 3. Conversation index (from chatStore + memory backend) ---
    try {
      const conversations = useChatStore.getState().conversations;
      const convList = Object.values(conversations)
        .filter(c => c.messages.length >= 2)
        .sort((a, b) => b.updatedAt - a.updatedAt);

      let matched = convList;
      if (queryTokens.length > 0) {
        matched = convList.filter(c => matchesQuery(c.title || '', queryTokens));
      }
      matched = matched.slice(0, limit);

      if (matched.length > 0) {
        const lines = matched.map(c => {
          const toolNames = new Set<string>();
          for (const m of c.messages) {
            if (m.toolCalls) {
              for (const tc of m.toolCalls) {
                toolNames.add(tc.name);
              }
            }
          }
          const toolSuffix = toolNames.size > 0 ? `, 工具: ${[...toolNames].slice(0, 5).join('/')}` : '';
          return `- "${c.title || '无标题'}" (${c.messages.length}条消息${toolSuffix}, ${formatTime(c.updatedAt)})`;
        });
        sections.push(`## 历史会话 (${matched.length}条)\n${lines.join('\n')}`);
      }

      // Also check conversation_index entries from memory backend (for archived conversations no longer in chatStore)
      const { getMemoryBackend } = await import('../../memory/router');
      const backend = getMemoryBackend();
      const indexEntries = await backend.list({ scope: 'user', category: 'conversation_index' as import('../../memory/types').MemoryCategory });
      // Only show index entries for conversations NOT in current chatStore
      const liveConvIds = new Set(Object.keys(conversations));
      const archivedEntries = indexEntries
        .filter(e => {
          const convId = e.keywords.find(k => k.startsWith('conv:'));
          return convId && !liveConvIds.has(convId.slice(5));
        })
        .sort((a, b) => b.updatedAt - a.updatedAt);

      let archivedMatched = archivedEntries;
      if (queryTokens.length > 0) {
        archivedMatched = archivedEntries.filter(e => matchesQuery(e.summary, queryTokens) || matchesQuery(e.content, queryTokens));
      }
      archivedMatched = archivedMatched.slice(0, limit);

      if (archivedMatched.length > 0) {
        const lines = archivedMatched.map(e => `- ${e.summary} (${formatTime(e.updatedAt)})`);
        sections.push(`## 已归档会话 (${archivedMatched.length}条)\n${lines.join('\n')}`);
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
};
