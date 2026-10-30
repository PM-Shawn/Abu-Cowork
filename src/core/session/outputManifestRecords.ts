import type { SnapshotEntry } from './outputSnapshots';
import { createLogger } from '../logging/logger';

const logger = createLogger('outputSnapshots');

export type ManifestLogRecord =
  | { op: 'set'; entry: SnapshotEntry }
  | { op: 'remove'; originalPath: string; snapshottedAt: number; captureId?: string };

function isLogRecord(value: unknown): value is ManifestLogRecord {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  if (record.op === 'remove') {
    return typeof record.originalPath === 'string' && typeof record.snapshottedAt === 'number';
  }
  if (record.op !== 'set' || typeof record.entry !== 'object' || record.entry === null) return false;
  const entry = record.entry as Record<string, unknown>;
  return typeof entry.originalPath === 'string'
    && typeof entry.snapshotRelPath === 'string'
    && typeof entry.snapshottedAt === 'number';
}

export function applyRecord(entries: Record<string, SnapshotEntry>, record: ManifestLogRecord): void {
  if (record.op === 'set') {
    entries[record.entry.originalPath] = record.entry;
    return;
  }
  if (entries[record.originalPath]?.snapshottedAt === record.snapshottedAt
    && (record.captureId === undefined || entries[record.originalPath]?.captureId === record.captureId)) {
    delete entries[record.originalPath];
  }
}

/** Incomplete append records do not prevent reading subsequent complete records. */
export function foldLog(convId: string, text: string, entries: Record<string, SnapshotEntry>): void {
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch (error) {
      logger.warn('manifest log line skipped', {
        convId,
        errorKind: error instanceof Error ? error.name : 'unknown',
      });
      continue;
    }
    if (!isLogRecord(record)) {
      logger.warn('manifest log line skipped', { convId, errorKind: 'not-a-record' });
      continue;
    }
    applyRecord(entries, record);
  }
}
