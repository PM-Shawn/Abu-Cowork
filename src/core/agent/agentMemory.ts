/**
 * Agent Memory — per-agent persistent memory
 *
 * Each agent has a memory.md file stored at:
 *   ~/.abu/agents/{agentName}/memory.md
 *
 * Memory is loaded into the agent system prompt and can be updated
 * by the agent via the update_memory tool (append / rewrite / clear).
 */

import { readTextFile, writeTextFile } from '@tauri-apps/plugin-fs';
import { homeDir } from '@tauri-apps/api/path';
import { ensureParentDir, joinPath } from '../../utils/pathUtils';
import { isSafeSkillDirName } from '../skill/skillDirName';

const MAX_MEMORY_CHARS = 4000; // Limit memory size to prevent context bloat

/**
 * Truncate content at a paragraph boundary to avoid breaking markdown structure.
 * Falls back to hard cut if no suitable paragraph break is found.
 */
function truncateAtParagraph(content: string, maxChars: number, suffix: string): string {
  if (content.length <= maxChars) return content;
  const cutPoint = content.lastIndexOf('\n\n', maxChars);
  const effectiveCut = cutPoint > maxChars * 0.5 ? cutPoint : maxChars;
  return content.slice(0, effectiveCut) + '\n' + suffix;
}

// Cache homeDir to avoid repeated IPC calls
let cachedHomeDir: string | null = null;

async function getCachedHomeDir(): Promise<string> {
  if (!cachedHomeDir) {
    cachedHomeDir = await homeDir();
  }
  return cachedHomeDir;
}

/**
 * Get the memory file path for an agent.
 * Throws unless the name is one plain path segment: `joinPath` does not
 * collapse `..`, so `../../x` would address a file outside ~/.abu/agents/.
 */
async function getMemoryPath(agentName: string): Promise<string> {
  if (!isSafeSkillDirName(agentName)) {
    throw new Error(`invalid agent name: ${JSON.stringify(agentName)}`);
  }
  const home = await getCachedHomeDir();
  return joinPath(home, '.abu', 'agents', agentName, 'memory.md');
}

/**
 * Read raw memory content from disk without truncation (for internal write operations).
 */
async function readRawMemory(agentName: string): Promise<string> {
  try {
    const memoryPath = await getMemoryPath(agentName);
    return await readTextFile(memoryPath);
  } catch {
    return '';
  }
}

/**
 * Load agent memory from disk. Returns empty string if no memory exists.
 * Truncates for prompt injection — does NOT modify the file on disk.
 */
export async function loadAgentMemory(agentName: string): Promise<string> {
  const content = await readRawMemory(agentName);
  if (!content) return '';
  return truncateAtParagraph(content, MAX_MEMORY_CHARS,
    `\n> WARNING: Memory truncated (${content.length} chars, limit ${MAX_MEMORY_CHARS}). Only partial content was loaded.`);
}

/**
 * Save agent memory to disk. Overwrites existing memory.
 * Returns whether content was truncated so callers can inform the agent.
 */
export async function saveAgentMemory(agentName: string, content: string): Promise<{ wasTruncated: boolean }> {
  const memoryPath = await getMemoryPath(agentName);
  await ensureParentDir(memoryPath);
  const wasTruncated = content.length > MAX_MEMORY_CHARS;
  const toWrite = wasTruncated
    ? truncateAtParagraph(content, MAX_MEMORY_CHARS,
        `\n> WARNING: Memory truncated (${content.length} chars, limit ${MAX_MEMORY_CHARS}).`)
    : content;
  await writeTextFile(memoryPath, toWrite);
  return { wasTruncated };
}

/**
 * Append to agent memory (adds to the end of existing memory)
 */
export async function appendAgentMemory(agentName: string, newContent: string): Promise<string> {
  const existing = await readRawMemory(agentName);
  const updated = existing
    ? `${existing}\n\n${newContent}`
    : newContent;
  await saveAgentMemory(agentName, updated);
  return updated;
}

/**
 * Clear agent memory
 */
export async function clearAgentMemory(agentName: string): Promise<void> {
  await saveAgentMemory(agentName, '');
}

// ============ Project-level Memory ============

const MAX_PROJECT_MEMORY_CHARS = 8000;

/**
 * Get the project memory file path (sync — no IPC needed)
 * Storage: {workspacePath}/.abu/MEMORY.md
 */
function getProjectMemoryPath(workspacePath: string): string {
  return joinPath(workspacePath, '.abu', 'MEMORY.md');
}

/**
 * Read raw project memory without truncation (for internal write operations).
 */
async function readRawProjectMemory(workspacePath: string): Promise<string> {
  try {
    const memoryPath = getProjectMemoryPath(workspacePath);
    return await readTextFile(memoryPath);
  } catch {
    return '';
  }
}

/**
 * Load project memory. Returns empty string if no memory exists.
 * Truncates for prompt injection — does NOT modify the file on disk.
 */
export async function loadProjectMemory(workspacePath: string): Promise<string> {
  const content = await readRawProjectMemory(workspacePath);
  if (!content) return '';
  return truncateAtParagraph(content, MAX_PROJECT_MEMORY_CHARS,
    `\n> WARNING: Project memory truncated (${content.length} chars, limit ${MAX_PROJECT_MEMORY_CHARS}). Only partial content was loaded.`);
}

/**
 * Save project memory (overwrite).
 * Returns whether content was truncated so callers can inform the agent.
 */
export async function saveProjectMemory(workspacePath: string, content: string): Promise<{ wasTruncated: boolean }> {
  const memoryPath = getProjectMemoryPath(workspacePath);
  await ensureParentDir(memoryPath);
  const wasTruncated = content.length > MAX_PROJECT_MEMORY_CHARS;
  const toWrite = wasTruncated
    ? truncateAtParagraph(content, MAX_PROJECT_MEMORY_CHARS,
        `\n> WARNING: Project memory truncated (${content.length} chars, limit ${MAX_PROJECT_MEMORY_CHARS}).`)
    : content;
  await writeTextFile(memoryPath, toWrite);
  return { wasTruncated };
}

/**
 * Append to project memory.
 */
export async function appendProjectMemory(workspacePath: string, newContent: string): Promise<string> {
  const existing = await readRawProjectMemory(workspacePath);
  const updated = existing ? `${existing}\n\n${newContent}` : newContent;
  await saveProjectMemory(workspacePath, updated);
  return updated;
}

/**
 * Clear project memory.
 */
export async function clearProjectMemory(workspacePath: string): Promise<void> {
  await saveProjectMemory(workspacePath, '');
}
