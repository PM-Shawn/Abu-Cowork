import type { SnapshotEntry } from './outputSnapshots';
import { createLogger } from '../logging/logger';
import { applyOutputManifestRecord, readOutputManifestRecords } from './outputManifest';

const logger = createLogger('outputSnapshots');

/** Incomplete append records do not prevent reading subsequent complete records. */
export function foldLog(convId: string, text: string, entries: Record<string, SnapshotEntry>): void {
  const records = readOutputManifestRecords(text, errorKind => logger.warn('manifest log line skipped', { convId, errorKind }));
  for (const record of records) applyOutputManifestRecord(entries, record);
}
