/**
 * Task Log — records completed tasks for pattern analysis
 *
 * Stores at ~/.abu/task-log.json, FIFO keeps latest 100 entries.
 * Used by orchestrator to inject task patterns into system prompt,
 * enabling the agent to propose Skill/Agent sedimentation.
 */

import { readTextFile, writeTextFile } from '@tauri-apps/plugin-fs';
import { homeDir } from '@tauri-apps/api/path';
import { ensureParentDir, joinPath } from '../../utils/pathUtils';
import { skillLoader } from '../skill/loader';
import { agentRegistry } from './registry';

const MAX_LOG_ENTRIES = 500;

export type TaskCategory =
  | 'translation'
  | 'coding'
  | 'research'
  | 'writing'
  | 'data-processing'
  | 'file-management'
  | 'communication'
  | 'other';

export interface TaskLogEntry {
  id: string;
  summary: string;
  category: TaskCategory;
  toolsUsed: string[];
  skillUsed: string | null;
  agentUsed: string | null;
  success: boolean;
  timestamp: number;
}

export interface TaskPattern {
  category: string;
  count: number;
  recentSummaries: string[];
  hasSkill: boolean;
  hasAgent: boolean;
}

// Cache homeDir
let cachedHome: string | null = null;

async function getLogPath(): Promise<string> {
  if (!cachedHome) cachedHome = await homeDir();
  return joinPath(cachedHome, '.abu', 'task-log.json');
}

/**
 * Read all task log entries from disk.
 */
export async function readTaskLog(): Promise<TaskLogEntry[]> {
  try {
    const path = await getLogPath();
    const raw = await readTextFile(path);
    return JSON.parse(raw) as TaskLogEntry[];
  } catch {
    return [];
  }
}

/**
 * Append a task log entry, keeping FIFO limit.
 */
export async function appendTaskLog(entry: TaskLogEntry): Promise<void> {
  const entries = await readTaskLog();
  entries.push(entry);
  // FIFO: keep latest MAX_LOG_ENTRIES
  const trimmed = entries.length > MAX_LOG_ENTRIES
    ? entries.slice(entries.length - MAX_LOG_ENTRIES)
    : entries;
  const path = await getLogPath();
  await ensureParentDir(path);
  await writeTextFile(path, JSON.stringify(trimmed, null, 2));
}

/**
 * Analyze task patterns — group by category, check if skill/agent exists.
 * Only returns categories with count >= 2.
 */
export function analyzePatterns(entries: TaskLogEntry[]): TaskPattern[] {
  const grouped = new Map<string, TaskLogEntry[]>();
  for (const entry of entries) {
    const list = grouped.get(entry.category) ?? [];
    list.push(entry);
    grouped.set(entry.category, list);
  }

  const patterns: TaskPattern[] = [];
  const availableSkills = new Set(skillLoader.getAvailableSkills().map((s) => s.name));
  const availableAgents = new Set(
    agentRegistry.getAvailableAgents()
      .filter((a) => a.name !== 'abu')
      .map((a) => a.name)
  );

  for (const [category, list] of grouped) {
    if (list.length < 2) continue;
    patterns.push({
      category,
      count: list.length,
      recentSummaries: list.slice(-3).map((e) => e.summary),
      hasSkill: availableSkills.has(category),
      hasAgent: availableAgents.has(category),
    });
  }

  // Sort by count descending
  patterns.sort((a, b) => b.count - a.count);
  return patterns;
}

/**
 * Build a concise summary string for system prompt injection.
 */
export function buildPatternSummary(patterns: TaskPattern[]): string {
  if (patterns.length === 0) return '';
  const lines = patterns.map((p) => {
    const status = p.hasSkill ? '已有技能' : p.hasAgent ? '已有代理' : '未沉淀';
    return `- ${p.category}: ${p.count}次 (${status})`;
  });
  return lines.join('\n');
}
