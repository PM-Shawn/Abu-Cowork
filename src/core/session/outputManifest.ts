import type { SnapshotEntry } from './outputSnapshots';

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

export function applyOutputManifestRecord(entries: Record<string, SnapshotEntry>, record: ManifestLogRecord): void {
  if (record.op === 'set') {
    entries[record.entry.originalPath] = record.entry;
    return;
  }
  if (entries[record.originalPath]?.snapshottedAt === record.snapshottedAt
    && (record.captureId === undefined || entries[record.originalPath]?.captureId === record.captureId)) {
    delete entries[record.originalPath];
  }
}

/** Shared manifest-log reader. Branch preparation requires every record to be readable. */
export function readOutputManifestRecords(text: string, onInvalid?: (kind: string) => void): ManifestLogRecord[] {
  const records: ManifestLogRecord[] = [];
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    let record: unknown;
    if (onInvalid) {
      try {
        record = JSON.parse(line);
      } catch (error) {
        onInvalid(error instanceof Error ? error.name : 'unknown');
        continue;
      }
    } else {
      record = JSON.parse(line);
    }
    if (!isLogRecord(record)) {
      if (!onInvalid) throw new Error('Unreadable output manifest record');
      onInvalid('not-a-record');
      continue;
    }
    records.push(record);
  }
  return records;
}
