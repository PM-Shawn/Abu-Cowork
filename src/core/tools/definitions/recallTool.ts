import type { ToolDefinition } from '../../../types';
import { useChatStore } from '../../../stores/chatStore';
import { useWorkspaceStore } from '../../../stores/workspaceStore';
import { TOOL_NAMES } from '../toolNames';

/**
 * Format a memory file's content for return. Strips frontmatter (already
 * parsed into header) and prepends a one-line type/name banner so the
 * agent immediately sees what kind of memory this is without parsing
 * frontmatter itself.
 *
 * For private memories, appends a restraint reminder asking the agent
 * to quote only the minimum needed and not to splash the content into
 * conversation history.
 */
function formatMemoryContent(
  type: string,
  name: string,
  content: string,
  isPrivate = false,
): string {
  const banner = `# [${type}]${isPrivate ? ' 🔒' : ''} ${name}\n\n`;
  const body = content.trim();
  if (!isPrivate) return banner + body;
  return (
    banner + body + '\n\n' +
    '[这是用户的私密记忆。回复时**只引用回答当前问题所需的最少部分**，' +
    '不要完整复述到对话历史中。例如用户问"我证件号是多少"可以直接答数字，' +
    '但不要主动展开关联信息，也不要在后续无关消息里再次引用。]'
  );
}

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
          // For private memories: surface that they exist (so the agent can
          // tell the user to ask explicitly) but do NOT preview content.
          const lock = h.private ? ' 🔒' : '';
          if (h.private) {
            lines.push(`- [${h.type}]${lock} ${h.name} (${formatTime(h.updated)}) — 私密记忆，需用户明确询问后调 read_memory 拉取`);
            // Don't bump accessCount for private — surfacing in recall isn't a real read.
            continue;
          }
          const file = await readMemoryFile(h.filePath);
          const contentPreview = file ? file.content.slice(0, 150) : '';
          lines.push(`- [${h.type}]${lock} ${h.name}${contentPreview ? ': ' + contentPreview : ''} (${formatTime(h.updated)})`);
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

/**
 * read_memory — pull the full content of a single memory file by filename.
 *
 * Designed to pair with the MEMORY.md index injected in the system prompt:
 * each index line has the form `- [filename](filename) — description`. When
 * the description is not enough for the agent to act, it can call
 * `read_memory(filename)` to load the full body. This is the pull half of
 * the pull-based recall model; it replaces the previous push-of-top-5
 * behavior in orchestrator.
 *
 * Search order: requested workspace > current workspace > global. accessCount
 * is bumped on a successful read because this represents a real recall (the
 * agent decided this file was worth loading), in contrast to passive
 * system-prompt injection which no longer touches accessCount at all.
 */
export const readMemoryTool: ToolDefinition = {
  name: TOOL_NAMES.READ_MEMORY,
  description: '按 filename 精确读取一条记忆的完整内容。当 <memory-index> 索引行的 description 不足以判断时使用。索引行格式 `- [filename](filename) — description`，传入 filename 即可。先在当前工作区查，再退到全局。',
  inputSchema: {
    type: 'object',
    properties: {
      filename: {
        type: 'string',
        description: '记忆文件名（如 user_data_team.md），来自 <memory-index> 索引行',
      },
      workspace: {
        type: 'string',
        description: '可选 workspace 路径。不传时按"当前工作区 → 全局"顺序查找',
      },
    },
    required: ['filename'],
  },
  execute: async (input, context) => {
    const filename = ((input.filename as string) || '').trim();
    if (!filename) return 'Error: filename 不能为空';

    const requestedWs = (input.workspace as string | undefined)?.trim() || undefined;
    const currentWs = context?.workspacePath ?? useWorkspaceStore.getState().currentPath;

    const { scanMemoryFiles, readMemoryFile } = await import('../../memdir/scan');
    const { touchMemory } = await import('../../memdir/write');

    // Build search order: requested workspace > current workspace > global.
    const searchPaths: Array<string | null> = [];
    if (requestedWs) {
      searchPaths.push(requestedWs);
    } else {
      if (currentWs) searchPaths.push(currentWs);
      searchPaths.push(null);
    }

    for (const path of searchPaths) {
      try {
        const headers = await scanMemoryFiles(path);
        const match = headers.find((h) => h.filename === filename);
        if (match) {
          const file = await readMemoryFile(match.filePath);
          if (file) {
            // Real active recall — bump accessCount (fire-and-forget).
            touchMemory(match.filePath).catch(() => {});
            return formatMemoryContent(
              file.header.type,
              file.header.name,
              file.content,
              file.header.private,
            );
          }
        }
      } catch {
        // Skip inaccessible directories
      }
    }

    return `没有找到 filename="${filename}" 的记忆。请确认拼写（参考 <memory-index> 中的索引行），或先用 recall 工具按关键词搜索。`;
  },
  isConcurrencySafe: true,
};
