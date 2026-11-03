import { expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from 'playwright';
import {
  closeAbuElectron, configureLocalMockProvider, launchAbuElectron, removeElectronDataRoot,
  type ElectronDataRoot, windowListenerRegistered,
} from './electronHelpers';
import { startOpenAiMock, waitForApp, type OpenAiMock } from './openAiMock';
import { persistedStoreVersion } from './storeVersions';
import { readRuntimeEventLines } from './runtimeEvents';

let app: ElectronApplication | undefined;
let dataRoot: ElectronDataRoot | undefined;
let model: OpenAiMock | undefined;
let diagnosticPage: Page | undefined;
let diagnostics: { time: number; kind: string; data: unknown }[] = [];

function record(kind: string, data: unknown): void {
  diagnostics.push({ time: performance.now(), kind, data });
}

async function imPolicyState() {
  const channels = JSON.parse(localStorage.getItem('abu-im-channel') ?? '{}') as {
    state?: {
      channels?: Record<string, { platform?: string; enabled?: boolean; status?: string }>;
      sessions?: Record<string, unknown>;
    };
  };
  const triggers = JSON.parse(localStorage.getItem('abu-triggers') ?? '{}') as {
    state?: { triggers?: Record<string, {
      status?: string; source?: { type?: string; channelId?: string }; runs?: { status: string }[];
    }> };
  };
  const host = window as unknown as { __TAURI_INTERNALS__: { invoke<T>(command: string): Promise<T> } };
  return {
    port: await host.__TAURI_INTERNALS__.invoke<number>('get_trigger_server_port'),
    channels: Object.entries(channels.state?.channels ?? {}).map(([id, channel]) => ({
      id, platform: channel.platform, enabled: channel.enabled, status: channel.status,
    })),
    sessionKeys: Object.keys(channels.state?.sessions ?? {}),
    triggers: Object.entries(triggers.state?.triggers ?? {}).map(([id, trigger]) => ({
      id, status: trigger.status,
      source: { type: trigger.source?.type, channelId: trigger.source?.channelId },
      runs: trigger.runs?.map(run => ({ status: run.status })),
    })),
  };
}

test.beforeEach(() => { diagnostics = []; });

test.afterEach(async () => {
  const testInfo = test.info();
  try {
    if (testInfo.status !== testInfo.expectedStatus) {
      try {
        if (diagnosticPage && !diagnosticPage.isClosed()) {
          record('failure-state', await diagnosticPage.evaluate(imPolicyState));
          record('failure-listeners', {
            inbound: await windowListenerRegistered(app!, diagnosticPage.url(), 'im-inbound-event'),
            trigger: await windowListenerRegistered(app!, diagnosticPage.url(), 'trigger-http-event'),
          });
          record('runtime-events', await readRuntimeEventLines(diagnosticPage));
        }
      } finally {
        await testInfo.attach('im-policy-diagnostics.json', {
          body: JSON.stringify(diagnostics, null, 2), contentType: 'application/json',
        });
      }
    }
  } finally {
    diagnosticPage = undefined;
    if (app) await closeAbuElectron(app);
    app = undefined;
    if (model) await model.close();
    model = undefined;
    if (dataRoot) removeElectronDataRoot(dataRoot);
    dataRoot = undefined;
  }
});

async function runs(page: Page, store: string, collection: string, id: string) {
  return page.evaluate(({ store, collection, id }) => {
    const data = JSON.parse(localStorage.getItem(store) ?? '{}');
    return (data.state?.[collection]?.[id]?.runs ?? []) as { status: string }[];
  }, { store, collection, id });
}

async function sentMessages() {
  return app!.evaluate(() => (globalThis as typeof globalThis & {
    imPolicyRequests: { channel: string }[];
  }).imPolicyRequests);
}

for (const outputEnabled of [false, true]) {
  test(`automatic IM delivery respects enabled=${outputEnabled} and inbound identity`, async () => {
    model = await startOpenAiMock(Array.from({ length: 8 }, () => ({
      kind: 'complete' as const, responseText: 'IM policy task completed.',
    })));
    const launched = await launchAbuElectron(undefined, { recordMainProcess: true });
    app = launched.app;
    dataRoot = launched;
    await app.evaluate(() => {
      const scope = globalThis as typeof globalThis & { imPolicyRequests: { channel: string }[] };
      scope.imPolicyRequests = [];
      const originalFetch = globalThis.fetch;
      globalThis.fetch = async (input, init) => {
        if (String(input) === 'https://slack.com/api/chat.postMessage') {
          const body = JSON.parse(String(init?.body));
          scope.imPolicyRequests.push(body);
          return Response.json({ ok: true, ts: `sent-${scope.imPolicyRequests.length}` });
        }
        return originalFetch(input, init);
      };
    });
    const page = await app.firstWindow();
    diagnosticPage = page;
    page.on('framenavigated', frame => {
      if (frame === page.mainFrame()) record('navigation', frame.url());
    });
    page.on('pageerror', error => record('page-error', error.message));
    const completionLogs: string[] = [];
    page.on('console', message => {
      record('console', { type: message.type(), text: message.text() });
      if (message.text().startsWith('[Trigger] Completed:') || message.text().startsWith('[Scheduler] Task completed:')) {
        completionLogs.push(message.text());
      }
    });
    await waitForApp(page);
    await configureLocalMockProvider(page, model.baseUrl);
    await page.evaluate(({ enabled, versions }) => {
      const stamp = 1_800_000_000_000;
      const channel = (id: string, enabled: boolean) => ({
        id, platform: 'slack', name: id, appId: id, appSecret: 'test-bot-token', enabled,
        status: 'connected', capability: 'read_tools', responseMode: 'mention_only',
        allowedUsers: [], workspacePaths: [], sessionTimeoutMinutes: 0, maxRoundsPerSession: 50,
        createdAt: stamp, updatedAt: stamp,
      });
      localStorage.setItem('abu-im-channel', JSON.stringify({ version: versions.channels, state: {
        channels: {
          source: channel('source', true), output: channel('output', enabled), off: channel('off', false),
          ding: { ...channel('ding', true), platform: 'dingtalk' },
        },
        sessions: {}, archivedSessions: {},
      } }));
      const trigger = (id: string, channelId: string) => ({
        id, name: id, status: 'active', source: { type: 'im', channelId, listenScope: 'all' },
        filter: { type: 'always' }, action: { prompt: 'Reply with a short completion message.' },
        debounce: { enabled: false, windowSeconds: 0 },
        output: { enabled: true, target: 'im_channel', outputChannelId: 'output',
          outputChatIds: 'recipient-a,recipient-a,recipient-b', extractMode: 'last_message' },
        createdAt: stamp, updatedAt: stamp, runs: [], totalRuns: 0,
      });
      localStorage.setItem('abu-triggers', JSON.stringify({ version: versions.triggers, state: {
        triggers: {
          incoming: trigger('incoming', 'source'), disabled: trigger('disabled', 'off'), ding: trigger('ding', 'ding'),
        },
      } }));
      localStorage.setItem('abu-schedule', JSON.stringify({ version: versions.schedule, state: { tasks: {
        scheduled: {
          id: 'scheduled', name: 'IM policy scheduled result', prompt: 'Reply with a short completion message.',
          schedule: { frequency: 'manual' }, status: 'active', runs: [], totalRuns: 0,
          outputChannelId: 'output', outputChatIds: 'recipient-a,recipient-a,recipient-b',
          createdAt: stamp, updatedAt: stamp,
        },
      } } }));
    }, { enabled: outputEnabled, versions: {
      channels: persistedStoreVersion('abu-im-channel'), triggers: persistedStoreVersion('abu-triggers'),
      schedule: persistedStoreVersion('abu-schedule'),
    } });
    await page.reload();
    await waitForApp(page);
    await expect.poll(() => windowListenerRegistered(app!, page.url(), 'im-inbound-event'),
      { timeout: 45_000 }).toBe(true);
    const initialState = await page.evaluate(imPolicyState);
    record('before-first-webhook', initialState);
    const { port } = initialState;
    expect(port).toBeGreaterThan(0);
    const send = async (ts: string, extra: Record<string, unknown> = {}) => {
      record('slack-webhook-send', { ts, port });
      const response = await fetch(`http://127.0.0.1:${port}/im/slack/webhook`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ event: {
          type: 'message', ts, user: 'U1', channel: 'C1', channel_type: 'im', text: 'Hello', ...extra,
        } }),
      });
      record('slack-webhook-response', { ts, status: response.status, body: await response.text() });
      expect(response.ok).toBe(true);
    };
    await send('1.000001');
    await expect.poll(async () => (await runs(page, 'abu-triggers', 'triggers', 'incoming')).map(run => run.status),
      { timeout: 45_000 }).toEqual(['completed']);
    await send('1.000001');
    await send('2.000001', { bot_id: 'B1' });
    await send('3.000001', { bot_profile: { id: 'B1' } });
    await send('4.000001');
    await expect.poll(async () => (await runs(page, 'abu-triggers', 'triggers', 'incoming')).map(run => run.status),
      { timeout: 45_000 }).toEqual(['completed', 'completed']);
    expect(await runs(page, 'abu-triggers', 'triggers', 'disabled')).toEqual([]);

    const sendDingTalk = async (msgId: string) => {
      record('dingtalk-webhook-send', { msgId, port });
      const response = await fetch(`http://127.0.0.1:${port}/im/dingtalk/webhook`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          msgId, conversationId: 'ding-chat', senderStaffId: 'ding-user',
          text: { content: 'Hello' }, conversationType: '1',
        }),
      });
      record('dingtalk-webhook-response', { msgId, status: response.status, body: await response.text() });
      expect(response.ok).toBe(true);
    };
    await sendDingTalk('ding-one');
    await expect.poll(async () => (await runs(page, 'abu-triggers', 'triggers', 'ding')).map(run => run.status),
      { timeout: 45_000 }).toEqual(['completed']);
    await sendDingTalk('ding-one');
    await sendDingTalk('ding-two');
    await expect.poll(async () => (await runs(page, 'abu-triggers', 'triggers', 'ding')).map(run => run.status),
      { timeout: 45_000 }).toEqual(['completed', 'completed']);

    await page.getByRole('navigation', { name: /Main navigation|主导航/ })
      .getByRole('button', { name: /^(自动化|Automation)$/ }).evaluate((element: HTMLElement) => element.click());
    await page.getByRole('button', { name: /^(定时任务|Scheduled Tasks)$/ }).click();
    await page.getByText('IM policy scheduled result', { exact: true }).click();
    await page.getByRole('button', { name: /^(立即执行|Run Now)$/ }).click();
    await expect.poll(async () => (await runs(page, 'abu-schedule', 'tasks', 'scheduled')).map(run => run.status),
      { timeout: 45_000 }).toEqual(['completed']);
    await expect.poll(() => completionLogs).toEqual([
      '[Trigger] Completed: incoming', '[Trigger] Completed: incoming',
      '[Trigger] Completed: ding', '[Trigger] Completed: ding',
      '[Scheduler] Task completed: IM policy scheduled result',
    ]);
    await expect.poll(async () => (await sentMessages()).length).toBe(outputEnabled ? 10 : 0);
    if (outputEnabled) {
      expect((await sentMessages()).map(message => message.channel)).toEqual([
        'recipient-a', 'recipient-b', 'recipient-a', 'recipient-b', 'recipient-a', 'recipient-b',
        'recipient-a', 'recipient-b', 'recipient-a', 'recipient-b',
      ]);
    }
    expect(await runs(page, 'abu-triggers', 'triggers', 'incoming')).toHaveLength(2);
  });
}
