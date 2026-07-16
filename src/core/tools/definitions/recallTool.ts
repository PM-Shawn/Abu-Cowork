import type { ToolDefinition } from '../../../types';
import { useChatStore } from '../../../stores/chatStore';
import { useWorkspaceStore } from '../../../stores/workspaceStore';
import { catalogGetCount } from '../../session/conversationStorage';
import { TOOL_NAMES } from '../toolNames';
import { getI18n, format } from '../../../i18n';

/**
 * Light TTL cache for the catalog's authoritative message_count, keyed by
 * conversation id. The recall tool displays a message count per listed
 * conversation and prefers the catalog (authoritative) over the in-memory
 * conversationIndex.messageCount ONLY for conversations that are not
 * currently loaded in memory — see `resolveDisplayCount` for why. Caching
 * keeps a burst of recall calls from issuing one IPC per conversation per
 * call. Misses (null) are NOT cached — we fall back to the optimistic index
 * count and retry next time.
 */
const catalogCountCache = new Map<string, { count: number; at: number }>();
const CATALOG_COUNT_CACHE_TTL_MS = 5000;

/**
 * Resolve the message count to display for a conversation in recall's list.
 *
 * - **Loaded in memory** (`useChatStore.getState().conversations[convId]`
 *   exists): `fallback` (the in-memory `conversationIndex.messageCount`) is
 *   authoritative here — chatStore re-derives it from `conv.messages.length`
 *   on every `addMessage` (see chatStore.ts), so it already reflects any
 *   edit/retry truncation of the in-memory transcript. The catalog's
 *   `message_count`, by contrast, is re-derived by the Rust side from the
 *   append-only JSONL line count (`reindex_one_core`, catalog_db.rs), which
 *   is NOT rewritten on truncation — at the next turn-end reindex it would
 *   re-inflate back up to include messages the user has since edited/retried
 *   away. Preferring the catalog here would make recall report a stale,
 *   too-high count for the conversation the user is actively looking at.
 * - **Not loaded in memory**: fall back to the catalog's authoritative count
 *   (message-storage P1 step 3) — the in-memory index for an unloaded
 *   conversation can understate it (e.g. a windowed/partial index entry),
 *   and there is no truncation risk since nothing is currently mutating it.
 */
async function resolveDisplayCount(convId: string, fallback: number): Promise<number> {
  const isLoadedInMemory = Boolean(useChatStore.getState().conversations[convId]);
  if (isLoadedInMemory) return fallback;

  const now = Date.now();
  const cached = catalogCountCache.get(convId);
  if (cached && now - cached.at < CATALOG_COUNT_CACHE_TTL_MS) return cached.count;
  const authoritative = await catalogGetCount(convId);
  if (authoritative == null) return fallback; // catalog unavailable → optimistic fallback
  catalogCountCache.set(convId, { count: authoritative, at: now });
  // Bound the cache: entries are only useful within the TTL, so sweep expired
  // ones once the map grows past a small threshold. Without this the map keeps
  // one entry per distinct conversation recalled for the whole session.
  if (catalogCountCache.size > 64) {
    for (const [id, entry] of catalogCountCache) {
      if (now - entry.at >= CATALOG_COUNT_CACHE_TTL_MS) catalogCountCache.delete(id);
    }
  }
  return authoritative;
}

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
  return banner + body + '\n\n' + getI18n().toolResult.recall.privateMemoryNote;
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
  description: `Recall past memories, task records, and conversation history. Use when the user asks questions that require looking back at history, such as "previously", "last time", "what have we done recently", "do you remember", or "what have we talked about".

## Priority (in order)
1. **Check <relevant-memories> first** (at the end of the system prompt): relevant non-private memories are auto-injected in full each turn — answer from there directly without calling any tool if possible.
2. **recall (keyword search)**: use when <relevant-memories> does not cover the topic, or when you are unsure whether a relevant memory exists.
3. **read_memory (precise pull by filename)**: when you see a specific filename in <memory-index> and its description looks relevant (including 🔒 private memories the user explicitly asks about), call read_memory(filename) directly — more accurate than recall and uses fewer tokens.

## Sanity-check when using memories
Memories are snapshots from a point in the past and may be outdated. Before giving advice based on memory:
- Mentions a specific file path → confirm the file still exists first
- Mentions a specific function/tool name → grep to confirm first
- User is about to act on it → verify the current state before commenting

"Memory says X exists" ≠ "X still exists now". When memory conflicts with the current state, trust the current state and update or delete the outdated memory.`,
  inputSchema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Search keywords (matched against memory content, task summaries, and conversation titles)',
      },
      limit: {
        type: 'number',
        description: 'Maximum number of results to return per data source, default 10',
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
    const t = getI18n().toolResult.recall;

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
            lines.push(`- [${h.type}]${lock} ${h.name} (${formatTime(h.updated)})${t.privateMemorySuffix}`);
            // Don't bump accessCount for private — surfacing in recall isn't a real read.
            continue;
          }
          const file = await readMemoryFile(h.filePath);
          const contentPreview = file ? file.content.slice(0, 150) : '';
          lines.push(`- [${h.type}]${lock} ${h.name}${contentPreview ? ': ' + contentPreview : ''} (${formatTime(h.updated)})`);
          // Touch accessed memories (fire-and-forget)
          touchMemory(h.filePath).catch(() => {});
        }
        sections.push(`${format(t.sectionMemories, { count: top.length })}\n${lines.join('\n')}`);
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
        sections.push(`${format(t.sectionTasks, { count: tasks.length })}\n${lines.join('\n')}`);
      }
    } catch {
      // Non-critical
    }

    // --- 3. Conversation index (from chatStore) ---
    try {
      const conversationIndex = useChatStore.getState().conversationIndex;
      // The `>= 2` gate and sort stay on the optimistic index count — it is the
      // fast, pre-load value already in memory for every conversation, and the
      // gate is coarse. Only the DISPLAYED count (below) is upgraded to the
      // catalog's authoritative value (message-storage P1 step 3): read priority
      // changes, write timing does not.
      const convList = Object.values(conversationIndex)
        .filter(c => c.messageCount >= 2)
        .sort((a, b) => b.updatedAt - a.updatedAt);

      let matched = convList;
      if (queryTokens.length > 0) {
        matched = convList.filter(c => matchesQuery(c.title || '', queryTokens));
      }
      matched = matched.slice(0, limit);

      if (matched.length > 0) {
        // Displayed count resolution: see `resolveDisplayCount` — loaded
        // conversations use the accurate in-memory count, unloaded ones fall
        // back to the catalog's authoritative count. Bounded to the <= limit
        // matched rows and TTL-cached, so this is at most `limit` IPCs.
        const lines = await Promise.all(matched.map(async c => {
          const count = await resolveDisplayCount(c.id, c.messageCount);
          return format(t.convLine, { title: c.title || t.untitled, count, time: formatTime(c.updatedAt) });
        }));
        sections.push(`${format(t.sectionConversations, { count: matched.length })}\n${lines.join('\n')}`);
      }
    } catch {
      // Non-critical
    }

    if (sections.length === 0) {
      return query
        ? format(t.noResultsQuery, { query })
        : t.noResultsEmpty;
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
  description: 'Read the full content of a single memory file by exact filename. Use when the description in a <memory-index> index line is not enough to make a decision. Index line format: `- [filename](filename) — description` — just pass the filename. Searches the current workspace first, then falls back to global.',
  inputSchema: {
    type: 'object',
    properties: {
      filename: {
        type: 'string',
        description: 'Memory filename (e.g. user_data_team.md), as found in a <memory-index> index line',
      },
      workspace: {
        type: 'string',
        description: 'Optional workspace path. When omitted, searches in order: current workspace → global',
      },
    },
    required: ['filename'],
  },
  execute: async (input, context) => {
    const t = getI18n().toolResult.recall;
    const filename = ((input.filename as string) || '').trim();
    if (!filename) return t.errFilenameEmpty;

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

    return format(t.notFound, { filename });
  },
  isConcurrencySafe: true,
};
