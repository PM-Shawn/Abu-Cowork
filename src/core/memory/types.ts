/**
 * Memory System Types — structured memory with pluggable backend
 */

export type MemoryCategory =
  | 'user_preference'      // user habits, format preferences
  | 'project_knowledge'    // tech stack, architecture, terminology
  | 'conversation_fact'    // key facts from conversations
  | 'decision'             // important decisions and rationale
  | 'action_item'          // follow-ups, pending tasks
  | 'conversation_index';  // lightweight conversation metadata (auto-generated)

export type MemorySourceType = 'agent_explicit' | 'auto_flush' | 'user_manual';

export interface MemoryEntry {
  id: string;
  category: MemoryCategory;
  /** One-line summary for display and search */
  summary: string;
  /** Full content (markdown) */
  content: string;
  /** Keywords for search matching */
  keywords: string[];
  /** How this memory was created */
  sourceType: MemorySourceType;
  /** Scope: user-level (cross-project) or project-level */
  scope: 'user' | 'project';
  /** Workspace path when scope='project' */
  projectPath?: string;
  createdAt: number;
  updatedAt: number;
  /** Number of times this memory was recalled — used for relevance scoring */
  accessCount: number;
}

export interface SearchOptions {
  scope?: 'user' | 'project';
  projectPath?: string;
  category?: MemoryCategory;
  limit?: number;
}

export interface ListOptions {
  scope?: 'user' | 'project';
  projectPath?: string;
  category?: MemoryCategory;
}

/**
 * Memory Backend interface — pluggable storage layer.
 *
 * Built-in implementation uses local JSON files.
 * Can be replaced by MCP-backed backends (e.g., Mem0) at runtime.
 */
export interface MemoryBackend {
  add(entry: Omit<MemoryEntry, 'id' | 'createdAt' | 'updatedAt' | 'accessCount'>): Promise<MemoryEntry>;
  search(query: string, options?: SearchOptions): Promise<MemoryEntry[]>;
  update(id: string, data: Partial<Pick<MemoryEntry, 'summary' | 'content' | 'keywords' | 'category'>>, scope?: 'user' | 'project', projectPath?: string): Promise<void>;
  remove(id: string, scope?: 'user' | 'project', projectPath?: string): Promise<void>;
  list(options?: ListOptions): Promise<MemoryEntry[]>;
  /** Increment access count (called when a memory is injected into context) */
  touch(id: string, scope?: 'user' | 'project', projectPath?: string): Promise<void>;
}
