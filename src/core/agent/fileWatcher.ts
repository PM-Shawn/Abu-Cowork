/**
 * File Watcher — event-driven task triggering
 *
 * Watches directories for file changes and triggers Agent tasks.
 * Rules stored at ~/.abu/watch-rules.json.
 * Uses Tauri's @tauri-apps/plugin-fs watch API.
 */

import { watch, readTextFile, writeTextFile, exists, type UnwatchFn } from '@tauri-apps/plugin-fs';
import { homeDir } from '@tauri-apps/api/path';
import { ensureParentDir, joinPath, getBaseName } from '../../utils/pathUtils';
import { runAgentLoop } from './agentLoop';
import { useChatStore } from '../../stores/chatStore';
import { format, getI18n } from '../../i18n';

export interface FileWatchRule {
  id: string;
  path: string;
  pattern?: string;         // glob-like filter (simple: *.pdf, *.xlsx)
  event: 'create' | 'modify' | 'any';
  prompt: string;           // supports {filePath} and {fileName} placeholders
  skillName?: string;
  enabled: boolean;
}

// --- Rule Storage ---

let cachedHome: string | null = null;

async function getRulesPath(): Promise<string> {
  if (!cachedHome) cachedHome = await homeDir();
  return joinPath(cachedHome, '.abu', 'watch-rules.json');
}

export async function loadWatchRules(): Promise<FileWatchRule[]> {
  try {
    const path = await getRulesPath();
    const raw = await readTextFile(path);
    return JSON.parse(raw) as FileWatchRule[];
  } catch {
    return [];
  }
}

export async function saveWatchRules(rules: FileWatchRule[]): Promise<void> {
  const path = await getRulesPath();
  await ensureParentDir(path);
  await writeTextFile(path, JSON.stringify(rules, null, 2));
}

// --- Watcher Engine ---

/** Active watchers keyed by rule id */
const activeWatchers = new Map<string, UnwatchFn>();

/** Debounce map to avoid rapid re-triggers */
const lastTriggerTime = new Map<string, number>();
const DEBOUNCE_MS = 5000;

/**
 * Simple glob match: supports *.ext pattern only.
 */
function matchPattern(fileName: string, pattern?: string): boolean {
  if (!pattern) return true;
  if (pattern.startsWith('*.')) {
    const ext = pattern.slice(1); // ".pdf"
    return fileName.endsWith(ext);
  }
  return fileName === pattern;
}

/**
 * Handle a file watch event — create a background conversation and run Agent.
 */
async function handleWatchTrigger(rule: FileWatchRule, filePath: string) {
  // Debounce
  const now = Date.now();
  const last = lastTriggerTime.get(rule.id) ?? 0;
  if (now - last < DEBOUNCE_MS) return;
  lastTriggerTime.set(rule.id, now);

  const fileName = getBaseName(filePath);
  const prompt = rule.skillName
    ? `/${rule.skillName} ${format(rule.prompt, { filePath, fileName })}`
    : format(rule.prompt, { filePath, fileName });

  const chatStore = useChatStore.getState();
  const conversationId = chatStore.createConversation(null, { skipActivate: true });

  const timeStr = new Date().toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  chatStore.renameConversation(
    conversationId,
    format(getI18n().chatDefaults.watcherConversationTitle, { file: fileName, time: timeStr }),
  );

  try {
    await runAgentLoop(conversationId, prompt, {
      // Auto-deny dangerous commands in background mode
      commandConfirmCallback: async () => false,
    });
    console.log(`[FileWatcher] Task completed for rule ${rule.id}: ${fileName}`);
  } catch (err) {
    console.error(`[FileWatcher] Task failed for rule ${rule.id}:`, err);
  }
}

/**
 * Start watching for a single rule.
 */
async function startWatcher(rule: FileWatchRule): Promise<void> {
  if (activeWatchers.has(rule.id)) return;

  try {
    // Validate path exists before creating a watcher resource to avoid
    // Tauri plugin-fs "resource id is invalid" errors on non-existent paths
    const pathExists = await exists(rule.path);
    if (!pathExists) {
      console.warn(`[FileWatcher] Path does not exist, skipping rule ${rule.id}: ${rule.path}`);
      return;
    }

    const unwatch = await watch(rule.path, (event) => {
      const kind = event.type;
      // Determine if event matches rule
      let matches = false;
      if (rule.event === 'any') {
        matches = true;
      } else if (rule.event === 'create' && typeof kind === 'object' && 'create' in kind) {
        matches = true;
      } else if (rule.event === 'modify' && typeof kind === 'object' && 'modify' in kind) {
        matches = true;
      }

      if (!matches) return;

      // Check each affected path
      for (const p of event.paths) {
        const name = getBaseName(p);
        if (matchPattern(name, rule.pattern)) {
          handleWatchTrigger(rule, p).catch(console.error);
        }
      }
    }, { recursive: false });

    activeWatchers.set(rule.id, unwatch);
    console.log(`[FileWatcher] Started watching: ${rule.path} (rule: ${rule.id})`);
  } catch (err) {
    console.error(`[FileWatcher] Failed to start watcher for rule ${rule.id}:`, err);
  }
}

/**
 * Stop a single watcher.
 */
function stopWatcher(ruleId: string): void {
  const unwatch = activeWatchers.get(ruleId);
  if (unwatch) {
    unwatch();
    activeWatchers.delete(ruleId);
    console.log(`[FileWatcher] Stopped watcher: ${ruleId}`);
  }
}

/**
 * Initialize all enabled watchers from stored rules.
 */
export async function initFileWatchers(): Promise<void> {
  const rules = await loadWatchRules();
  for (const rule of rules) {
    if (rule.enabled) {
      await startWatcher(rule);
    }
  }
}

/**
 * Stop all active watchers.
 */
export function stopAllWatchers(): void {
  for (const [id] of activeWatchers) {
    stopWatcher(id);
  }
}

/**
 * Add a new watch rule, save, and start if enabled.
 */
export async function addWatchRule(rule: FileWatchRule): Promise<void> {
  const rules = await loadWatchRules();
  rules.push(rule);
  await saveWatchRules(rules);
  if (rule.enabled) {
    await startWatcher(rule);
  }
}

/**
 * Remove a watch rule by id.
 */
export async function removeWatchRule(ruleId: string): Promise<void> {
  stopWatcher(ruleId);
  const rules = await loadWatchRules();
  const filtered = rules.filter((r) => r.id !== ruleId);
  await saveWatchRules(filtered);
}

/**
 * Toggle a watch rule's enabled state.
 */
export async function toggleWatchRule(ruleId: string): Promise<void> {
  const rules = await loadWatchRules();
  const rule = rules.find((r) => r.id === ruleId);
  if (!rule) return;
  rule.enabled = !rule.enabled;
  await saveWatchRules(rules);
  if (rule.enabled) {
    await startWatcher(rule);
  } else {
    stopWatcher(ruleId);
  }
}

/**
 * List all watch rules with their active status.
 */
export async function listWatchRules(): Promise<(FileWatchRule & { active: boolean })[]> {
  const rules = await loadWatchRules();
  return rules.map((r) => ({
    ...r,
    active: activeWatchers.has(r.id),
  }));
}
