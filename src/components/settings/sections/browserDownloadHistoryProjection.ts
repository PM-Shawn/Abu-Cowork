import type { ConversationMeta } from '@/core/session/conversationStorage';
import { parseNamespacedToolName } from '@/core/mcp/toolName';
import { browserChannelForTool } from '@/core/observability/browserSignals';
import {
  isBrowserRunReportMessage,
  type BrowserRunReportArtifact,
} from '@/core/observability/browserRunReport';
import { normalizeBrowserOrigin } from '@/core/permissions/browserToolPolicy';
import type { Message, ToolCall, ToolCallForContext } from '@/types';

export type BrowserDownloadAvailability = 'completed' | 'unavailable' | 'unknown';

export interface BrowserDownloadHistoryRow {
  key: string;
  conversationId: string;
  reportMessageId: string;
  conversationTitle: string;
  downloadId: string;
  name: string;
  path: string;
  bytes: number;
  mime?: string;
  sourceOrigin: string;
  recordedAt: number;
  availability: BrowserDownloadAvailability;
}

export interface BrowserDownloadHistoryOmission {
  key: string;
  conversationId: string;
  reportMessageId: string;
  conversationTitle: string;
  count: number;
}

export interface BrowserDownloadHistoryProjection {
  rows: BrowserDownloadHistoryRow[];
  omissions: BrowserDownloadHistoryOmission[];
}

export interface BrowserDownloadConversationSnapshot {
  meta: ConversationMeta;
  messages: Message[];
}

interface CompletedDownloadRecord {
  downloadId: string;
  path: string;
  sourceOrigin: string;
  recordedAt: number;
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function completedRecord(value: unknown): CompletedDownloadRecord | null {
  const record = objectRecord(value);
  if (!record || record.state !== 'completed') return null;
  const downloadId = typeof record.downloadId === 'string' ? record.downloadId : '';
  const path = typeof record.path === 'string' ? record.path : '';
  const url = typeof record.url === 'string' ? record.url : undefined;
  const sourceOrigin = normalizeBrowserOrigin(url);
  const recordedAt = typeof record.time === 'number' && Number.isFinite(record.time)
    ? record.time
    : NaN;
  if (
    !downloadId
    || !path
    || !sourceOrigin
    || !Number.isFinite(recordedAt)
    || Number.isNaN(new Date(recordedAt).getTime())
  ) return null;
  return { downloadId, path, sourceOrigin, recordedAt };
}

function recordsFromToolCall(call: ToolCall | ToolCallForContext): CompletedDownloadRecord[] {
  if (browserChannelForTool(call.name) !== 'builtin') return [];
  const parsedName = parseNamespacedToolName(call.name);
  if (!parsedName || (parsedName.toolName !== 'download' && parsedName.toolName !== 'get_downloads')) {
    return [];
  }
  let result: unknown;
  try {
    result = JSON.parse(call.result ?? '');
  } catch {
    return [];
  }
  if (parsedName.toolName === 'download') {
    const envelope = objectRecord(result);
    if (!envelope || envelope.complete !== true) return [];
    const record = completedRecord(envelope.download);
    return record ? [record] : [];
  }
  if (!Array.isArray(result)) return [];
  return result.map(completedRecord).filter((record): record is CompletedDownloadRecord => (
    record !== null
  ));
}

function recordKey(downloadId: string, path: string): string {
  return `${downloadId}\u0000${path}`;
}

function reportRowKey(
  conversationId: string,
  reportMessageId: string,
  artifact: BrowserRunReportArtifact,
): string {
  return [conversationId, reportMessageId, artifact.downloadId, artifact.path].join('\u0000');
}

function addCompletedRecords(
  message: Message,
  records: Map<string, CompletedDownloadRecord>,
  seenCalls: Set<string>,
): void {
  const calls: Array<ToolCall | ToolCallForContext> = [
    ...(message.toolCalls ?? []),
    ...(message.toolCallsForContext ?? []),
  ];
  for (const call of calls) {
    // The persisted UI and context copies normally describe the same call.
    // Dedupe them before reading the result so one execution cannot appear
    // twice merely because both durable representations survived.
    const callKey = [call.id ?? '', call.name, call.result ?? ''].join('\u0000');
    if (seenCalls.has(callKey)) continue;
    seenCalls.add(callKey);
    for (const record of recordsFromToolCall(call)) {
      const key = recordKey(record.downloadId, record.path);
      const previous = records.get(key);
      if (!previous || record.recordedAt > previous.recordedAt) records.set(key, record);
    }
  }
}

/**
 * Project the durable transcript into the narrow history the settings page
 * can verify. A row exists only when a frozen report artifact and a completed
 * built-in-browser result in the SAME conversation agree byte-for-byte on
 * both download id and path. This deliberately does not infer ownership from
 * a filename or from the downloads directory.
 */
export function projectBrowserDownloadHistory(
  snapshots: BrowserDownloadConversationSnapshot[],
): BrowserDownloadHistoryProjection {
  const rows: BrowserDownloadHistoryRow[] = [];
  const omissions: BrowserDownloadHistoryOmission[] = [];

  for (const { meta, messages } of snapshots) {
    if (meta.readOnly || meta.importedFrom) continue;
    const records = new Map<string, CompletedDownloadRecord>();
    const seenCalls = new Set<string>();
    const seenArtifacts = new Set<string>();
    for (const message of messages) {
      // Reports are appended after the run's tool results. Walking in ledger
      // order prevents a later, malformed duplicate id/path from rewriting
      // the source or time shown for an older frozen report.
      addCompletedRecords(message, records, seenCalls);
      if (!isBrowserRunReportMessage(message)) continue;
      const report = message.browserRunReport;
      if (!report) continue;
      let matchedBuiltinArtifacts = 0;
      for (const artifact of report.artifacts ?? []) {
        if (
          typeof artifact.downloadId !== 'string'
          || artifact.downloadId === ''
          || typeof artifact.path !== 'string'
          || artifact.path === ''
          || typeof artifact.name !== 'string'
          || artifact.name === ''
        ) continue;
        const identity = recordKey(artifact.downloadId, artifact.path);
        const record = records.get(identity);
        if (!record) continue;
        // This remains a built-in-associated REPORT even when its visible
        // artifact row was already emitted by an earlier report. Its own
        // omitted count is report-level evidence and must survive row dedupe.
        matchedBuiltinArtifacts++;
        // A later download(wait) can emit the same completed signal and leave
        // a second frozen report referencing the same file. Keep the first
        // report in ledger order: it is closest to the original completed
        // result, and one physical download remains one history row.
        if (seenArtifacts.has(identity)) continue;
        seenArtifacts.add(identity);
        rows.push({
          key: reportRowKey(meta.id, message.id, artifact),
          conversationId: meta.id,
          reportMessageId: message.id,
          conversationTitle: meta.title,
          downloadId: artifact.downloadId,
          name: artifact.name,
          path: artifact.path,
          bytes: artifact.bytes,
          ...(artifact.mime ? { mime: artifact.mime } : {}),
          sourceOrigin: record.sourceOrigin,
          recordedAt: record.recordedAt,
          availability: 'unknown',
        });
      }
      const omittedCount = report.omitted.artifacts ?? 0;
      // The frozen report does not label an omitted artifact with a browser
      // channel. Only carry its honest report-level notice when this same
      // report contains at least one artifact we could tie to a built-in
      // result; a Chrome-only report must not create a built-in history note.
      if (matchedBuiltinArtifacts > 0 && omittedCount > 0) {
        omissions.push({
          key: `${meta.id}\u0000${message.id}`,
          conversationId: meta.id,
          reportMessageId: message.id,
          conversationTitle: meta.title,
          count: omittedCount,
        });
      }
    }
  }

  rows.sort((a, b) => (
    b.recordedAt - a.recordedAt
    || a.conversationId.localeCompare(b.conversationId)
    || a.reportMessageId.localeCompare(b.reportMessageId)
    || a.downloadId.localeCompare(b.downloadId)
    || a.path.localeCompare(b.path)
  ));
  omissions.sort((a, b) => (
    a.conversationId.localeCompare(b.conversationId)
    || a.reportMessageId.localeCompare(b.reportMessageId)
  ));
  return { rows, omissions };
}

export function filterBrowserDownloadHistoryRows(
  rows: BrowserDownloadHistoryRow[],
  query: string,
): BrowserDownloadHistoryRow[] {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return rows;
  return rows.filter((row) => row.name.toLocaleLowerCase().includes(needle));
}
