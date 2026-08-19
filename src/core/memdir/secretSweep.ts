/**
 * One-shot secret sweep over EXISTING memory files.
 *
 * The write-funnel sanitizer (see ./sanitize.ts) protects new writes, but
 * memories written before it existed can already hold credential-shaped text
 * — and they are replayed into every future prompt (index → system prompt,
 * relevant memories → context tail). This sweep rewrites those files with the
 * secrets redacted, preserving created/updated/accessCount (hygiene, not an
 * edit — a swept 8-month-old memory must not look freshly updated).
 *
 * Gate: a marker file inside each memory directory (`.secret-sweep-v1`), so
 * the sweep runs once per directory — store-free, works independently for the
 * global dir and each workspace dir. ⚠️ Bump the marker version whenever the
 * redaction patterns (sanitize.ts / shareRedactor.RULES) are added to or
 * widened, so already-marked directories get re-swept with the new patterns.
 *
 * Precedent: the v0.38.1 orphaned `imagegen:*` secret sweep (settingsStore).
 */

import { exists, readTextFile } from '@tauri-apps/plugin-fs';
import { atomicWrite } from '../../utils/atomicFs';
import { joinPath } from '../../utils/pathUtils';
import { MEMORY_INDEX_FILENAME } from './types';
import { getMemoryDir } from './paths';
import { scanMemoryFiles, invalidateScanCache, readMemoryFile } from './scan';
import { writeMemory } from './write';
import { sanitizeMemoryText } from './sanitize';
import { createLogger } from '../logging/logger';

const logger = createLogger('memdir-sweep');

const SWEEP_MARKER = '.secret-sweep-v1';

export interface SecretSweepResult {
  scanned: number;
  redactedFiles: string[];
}

/**
 * Sweep one memory directory (global when `workspacePath` is null). Safe to
 * call on every startup / workspace switch — the marker file makes repeat
 * calls a single exists() check. Returns null when the sweep was already
 * done, or when it failed (failure is logged, never thrown: a broken sweep
 * must not take the app down, and without a marker it retries next launch).
 */
export async function sweepMemorySecrets(
  workspacePath?: string | null,
): Promise<SecretSweepResult | null> {
  try {
    const dir = await getMemoryDir(workspacePath ?? null);
    const markerPath = joinPath(dir, SWEEP_MARKER);
    if (await exists(markerPath)) return null;

    const headers = await scanMemoryFiles(workspacePath ?? null);
    const redactedFiles: string[] = [];

    for (const h of headers) {
      try {
        const file = await readMemoryFile(h.filePath);
        if (!file) continue;
        const name = sanitizeMemoryText(file.header.name);
        const description = sanitizeMemoryText(file.header.description);
        const content = sanitizeMemoryText(file.content);
        const hit = name.redactions.length + description.redactions.length + content.redactions.length > 0;
        if (!hit) continue;

        // Rewrite through the normal funnel so index/frontmatter stay coherent.
        // bypassScan: this is grandfathered data — contentGuard blocking here
        // would strand the user's existing memory (same rationale as migrate).
        await writeMemory({
          name: name.text,
          description: description.text,
          type: file.header.type,
          content: content.text,
          source: file.header.source,
          workspacePath: workspacePath ?? null,
          filename: h.filename,
          private: file.header.private,
          bypassScan: true,
          created: file.header.created,
          updated: file.header.updated,
          accessCount: file.header.accessCount,
        });
        redactedFiles.push(h.filename);
      } catch (err) {
        // Per-file best effort — one unreadable file must not abort the sweep.
        logger.warn('secret sweep: failed to process file', { file: h.filename, err: String(err) });
      }
    }

    // The per-file rewrites update matching index lines, but a legacy index
    // can hold lines the rewrite can't reach — orphan entries for deleted
    // files, or foreign label formats from hand edits / imports. Sanitize the
    // index text itself so no credential-shaped bytes survive in the one
    // artifact injected into EVERY conversation's system prompt.
    try {
      const indexPath = joinPath(dir, MEMORY_INDEX_FILENAME);
      const raw = await readTextFile(indexPath);
      const cleaned = sanitizeMemoryText(raw);
      if (cleaned.redactions.length > 0) {
        await atomicWrite(indexPath, cleaned.text);
        redactedFiles.push(MEMORY_INDEX_FILENAME);
      }
    } catch {
      // No index yet — nothing to sanitize.
    }

    await atomicWrite(markerPath, `swept at ${new Date().toISOString()}\n`);
    invalidateScanCache(workspacePath ?? null);

    if (redactedFiles.length > 0) {
      logger.info('secret sweep: redacted credential-shaped content', { count: redactedFiles.length, files: redactedFiles });
    }
    return { scanned: headers.length, redactedFiles };
  } catch (err) {
    // Whole-sweep failure (dir unreadable, scan threw, marker unwritable):
    // log it — App.tsx fire-and-forgets this call, and a silent failure would
    // leave legacy secrets leaking with zero diagnostic trace.
    logger.warn('secret sweep failed', { workspacePath: workspacePath ?? null, err: String(err) });
    return null;
  }
}
