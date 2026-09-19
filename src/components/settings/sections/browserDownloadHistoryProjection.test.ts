import { describe, expect, it } from 'vitest';
import type { ConversationMeta } from '@/core/session/conversationStorage';
import type { BrowserRunReportArtifact, BrowserRunReportSnapshot } from '@/core/observability/browserRunReport';
import type { Message } from '@/types';
import {
  filterBrowserDownloadHistoryRows,
  projectBrowserDownloadHistory,
  type BrowserDownloadConversationSnapshot,
} from './browserDownloadHistoryProjection';

function meta(id: string, title = id): ConversationMeta {
  return {
    id,
    title,
    createdAt: 1,
    updatedAt: 2,
    messageCount: 2,
  };
}

function report(artifacts: BrowserRunReportArtifact[], omitted = 0): BrowserRunReportSnapshot {
  return {
    v: 1,
    variant: 'downloads',
    outcome: 'completed',
    actions: { total: 0, failed: 0 },
    scriptRuns: 0,
    sites: [],
    denials: [],
    problems: [],
    approvals: { approved: 0, declined: 0, timedOut: 0, unreachable: 0 },
    blockedPages: 0,
    skippedByMasterSwitch: false,
    nextSteps: [],
    artifacts,
    omitted: { sites: 0, problems: 0, artifacts: omitted },
  };
}

function artifact(downloadId: string, path: string, name = 'report.csv'): BrowserRunReportArtifact {
  return { downloadId, path, name, bytes: 42, mime: 'text/csv' };
}

function toolMessage(
  id: string,
  name: string,
  result: unknown,
): Message {
  return {
    id,
    role: 'assistant',
    content: '',
    timestamp: 1,
    toolCalls: [{
      id: `call-${id}`,
      name,
      input: {},
      result: JSON.stringify(result),
    }],
  };
}

function reportMessage(id: string, value: BrowserRunReportSnapshot): Message {
  return {
    id: `browser-run-report-${id}`,
    role: 'system',
    content: '',
    timestamp: 2,
    browserRunReport: value,
  };
}

function snapshot(
  id: string,
  messages: Message[],
  patch?: Partial<ConversationMeta>,
): BrowserDownloadConversationSnapshot {
  return { meta: { ...meta(id), ...patch }, messages };
}

describe('projectBrowserDownloadHistory', () => {
  it('requires an exact id and path match and strips credentials, query, and fragment from source', () => {
    const path = '/app/browser-downloads/task-a/report.csv';
    const projection = projectBrowserDownloadHistory([
      snapshot('task-a', [
        toolMessage('tool', 'abu-browser__download', {
          complete: true,
          download: {
            downloadId: 'dl-1',
            path,
            filename: 'report.csv',
            state: 'completed',
            time: 1_757_000_000_000,
            url: 'https://user:secret@Example.COM./export.csv?token=secret#part',
          },
        }),
        reportMessage('one', report([
          artifact('dl-1', path),
          artifact('dl-1', '/decoy/report.csv', 'decoy.csv'),
        ])),
      ]),
    ]);

    expect(projection.rows).toHaveLength(1);
    expect(projection.rows[0]).toMatchObject({
      conversationId: 'task-a',
      reportMessageId: 'browser-run-report-one',
      downloadId: 'dl-1',
      path,
      sourceOrigin: 'https://example.com',
      recordedAt: 1_757_000_000_000,
    });
    expect(JSON.stringify(projection)).not.toContain('secret');
    expect(JSON.stringify(projection)).not.toContain('/export.csv');
  });

  it('reads completed get_downloads entries but excludes Chrome and unfinished download results', () => {
    const completedPath = '/app/browser-downloads/task-a/completed.csv';
    const projection = projectBrowserDownloadHistory([
      snapshot('task-a', [
        toolMessage('list', 'abu-browser__get_downloads', [
          {
            downloadId: 'done',
            path: completedPath,
            filename: 'completed.csv',
            state: 'completed',
            time: 200,
            url: 'https://files.example/export',
          },
          {
            downloadId: 'pending',
            path: '/app/pending.part',
            filename: 'pending.part',
            state: 'progressing',
            time: 201,
            url: 'https://files.example/export',
          },
        ]),
        toolMessage('chrome', 'abu-browser-bridge__download', {
          complete: true,
          download: {
            downloadId: 'chrome',
            path: '/app/chrome.csv',
            state: 'completed',
            time: 202,
            url: 'https://files.example/export',
          },
        }),
        toolMessage('partial', 'abu-browser__download', {
          complete: false,
          download: {
            downloadId: 'partial',
            path: '/app/partial.csv',
            state: 'completed',
            time: 203,
            url: 'https://files.example/export',
          },
        }),
        reportMessage('one', report([
          artifact('done', completedPath, 'completed.csv'),
          artifact('pending', '/app/pending.part', 'pending.part'),
          artifact('chrome', '/app/chrome.csv', 'chrome.csv'),
          artifact('partial', '/app/partial.csv', 'partial.csv'),
        ])),
      ]),
    ]);

    expect(projection.rows.map((row) => row.downloadId)).toEqual(['done']);
  });

  it('excludes imported and read-only task histories', () => {
    const messages = [
      toolMessage('tool', 'abu-browser__download', {
        complete: true,
        download: {
          downloadId: 'dl',
          path: '/app/file.csv',
          state: 'completed',
          time: 100,
          url: 'https://example.com/file.csv',
        },
      }),
      reportMessage('one', report([artifact('dl', '/app/file.csv')])),
    ];
    const projection = projectBrowserDownloadHistory([
      snapshot('read-only', messages, { readOnly: true }),
      snapshot('imported', messages, {
        importedFrom: { schemaVersion: 1, importedAt: 10 },
      }),
    ]);

    expect(projection).toEqual({ rows: [], omissions: [] });
  });

  it('sorts rows deterministically and only carries omissions from a report with a built-in match', () => {
    const one = '/app/one.csv';
    const two = '/app/two.csv';
    const projection = projectBrowserDownloadHistory([
      snapshot('b-task', [
        toolMessage('one', 'abu-browser__download', {
          complete: true,
          download: {
            downloadId: 'one',
            path: one,
            state: 'completed',
            time: 100,
            url: 'https://example.com/one',
          },
        }),
        reportMessage('builtin', report([artifact('one', one, 'zeta.csv')], 1)),
        reportMessage('chrome-only', report([artifact('chrome', '/chrome.csv')], 9)),
      ]),
      snapshot('a-task', [
        toolMessage('two', 'abu-browser__download', {
          complete: true,
          download: {
            downloadId: 'two',
            path: two,
            state: 'completed',
            time: 100,
            url: 'https://example.com/two',
          },
        }),
        reportMessage('builtin', report([artifact('two', two, 'alpha.csv')])),
      ]),
    ]);

    expect(projection.rows.map((row) => row.conversationId)).toEqual(['a-task', 'b-task']);
    expect(projection.omissions).toEqual([expect.objectContaining({
      conversationId: 'b-task',
      count: 1,
    })]);
  });

  it('keeps a later report omission when its visible built-in artifact was already listed', () => {
    const path = '/app/repeated.csv';
    const messages = [
      toolMessage('one', 'abu-browser__download', {
        complete: true,
        download: {
          downloadId: 'repeated',
          path,
          state: 'completed',
          time: 100,
          url: 'https://example.com/repeated',
        },
      }),
      reportMessage('first', report([artifact('repeated', path, 'repeated.csv')])),
      reportMessage('later', report([artifact('repeated', path, 'repeated.csv')], 1)),
    ];

    const projection = projectBrowserDownloadHistory([snapshot('task', messages)]);

    expect(projection.rows).toHaveLength(1);
    expect(projection.omissions).toEqual([expect.objectContaining({
      reportMessageId: 'browser-run-report-later',
      count: 1,
    })]);
  });

  it('filters only by filename without changing the stable input order', () => {
    const rows = [
      {
        key: 'one',
        conversationId: 'a',
        reportMessageId: 'r',
        conversationTitle: 'Task',
        downloadId: '1',
        name: 'Résumé.csv',
        path: '/one',
        bytes: 1,
        sourceOrigin: 'https://example.com',
        recordedAt: 2,
        availability: 'completed' as const,
      },
      {
        key: 'two',
        conversationId: 'b',
        reportMessageId: 'r',
        conversationTitle: 'Another',
        downloadId: '2',
        name: 'budget.xlsx',
        path: '/two',
        bytes: 2,
        sourceOrigin: 'https://example.com',
        recordedAt: 1,
        availability: 'completed' as const,
      },
    ];

    expect(filterBrowserDownloadHistoryRows(rows, 'RÉSUMÉ')).toEqual([rows[0]]);
    expect(filterBrowserDownloadHistoryRows(rows, 'another')).toEqual([]);
    expect(filterBrowserDownloadHistoryRows(rows, '')).toBe(rows);
  });
});
