/**
 * Memory Migrator — one-time migration from flat memory.md to structured entries.
 *
 * On first run, checks if legacy memory.md exists and structured entries.json does not.
 * If so, imports the entire memory.md content as a single 'conversation_fact' entry.
 * The legacy file is preserved (not deleted) as a backup.
 */

import { readTextFile } from '@tauri-apps/plugin-fs';
import { homeDir } from '@tauri-apps/api/path';
import { joinPath } from '../../utils/pathUtils';
import { getMemoryBackend } from './router';

let migrated = false;

export async function migrateIfNeeded(): Promise<void> {
  if (migrated) return;
  migrated = true;

  try {
    const home = await homeDir();

    // Check if structured entries already exist (skip migration)
    const entriesPath = joinPath(home, '.abu', 'memory', 'entries.json');
    try {
      const existing = await readTextFile(entriesPath);
      const parsed = JSON.parse(existing);
      if (Array.isArray(parsed) && parsed.length > 0) return; // has entries, skip
    } catch {
      // entries.json doesn't exist or is invalid — proceed with migration
    }

    // Check if legacy memory.md exists
    const legacyPath = joinPath(home, '.abu', 'agents', 'abu', 'memory.md');
    let legacyContent: string;
    try {
      legacyContent = await readTextFile(legacyPath);
    } catch {
      return; // No legacy memory — nothing to migrate
    }

    if (!legacyContent.trim()) return;

    // Import as a single entry
    const backend = getMemoryBackend();
    await backend.add({
      category: 'conversation_fact',
      summary: '从旧版记忆迁移的内容',
      content: legacyContent.trim(),
      keywords: extractKeywords(legacyContent),
      sourceType: 'user_manual',
      scope: 'user',
    });

    console.log('[Memory] Migrated legacy memory.md to structured entries');
  } catch (err) {
    console.warn('[Memory] Migration failed (non-critical):', err);
  }
}

/** Extract basic keywords from text (CJK-aware, deduped) */
function extractKeywords(text: string): string[] {
  const words = text
    .toLowerCase()
    .split(/[\s,;.!?，。！？、；：""''（）[\]{}:：\-\n]+/)
    .filter(w => w.length >= 2 && w.length <= 20)
    .filter(w => !/^\d+$/.test(w)); // exclude pure numbers

  // Deduplicate and take top 20
  const unique = [...new Set(words)];
  return unique.slice(0, 20);
}
