import { expect, test } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import type { ElectronApplication } from 'playwright';
import type { Message } from '../../src/types';
import { buildConversationBranchHistory } from '../../src/core/session/conversationBranchHistory';
import {
  closeAbuElectron, createElectronDataRoot, launchAbuElectron, removeElectronDataRoot,
  type ElectronDataRoot,
} from './electronHelpers';
import { READY_TIMEOUT, waitForApp } from './openAiMock';

let app: ElectronApplication | undefined;
let dataRoot: ElectronDataRoot | undefined;

test.afterEach(async () => {
  if (app) await closeAbuElectron(app);
  app = undefined;
  if (dataRoot) removeElectronDataRoot(dataRoot);
  dataRoot = undefined;
});

test('built branch history loads independently and keeps its origin across an Electron restart', async () => {
  dataRoot = createElectronDataRoot();
  app = (await launchAbuElectron(dataRoot)).app;
  let page = await app.firstWindow({ timeout: READY_TIMEOUT });
  await waitForApp(page);
  const guide = page.getByRole('dialog', { name: '快速入门' });
  await expect(guide).toBeVisible({ timeout: READY_TIMEOUT });
  await page.keyboard.press('Escape');
  await expect(guide).toBeHidden();
  const appData = await page.evaluate(async () =>
    await window.__TAURI_INTERNALS__.invoke('plugin:path|resolve_directory', { directory: 14 }) as string);
  await closeAbuElectron(app);
  app = undefined;

  const source: Message[] = [
    { id: 'source-user-1', role: 'user', content: 'BRANCH-FIRST-QUESTION', timestamp: 100, loopId: 'source-loop-1', runState: 'completed' },
    { id: 'source-answer-1', role: 'assistant', content: 'BRANCH-FIRST-ANSWER', timestamp: 200, loopId: 'source-loop-1', streamEnded: true },
    { id: 'source-user-2', role: 'user', content: 'SOURCE-LATER-QUESTION', timestamp: 300, loopId: 'source-loop-2', runState: 'completed' },
    { id: 'source-answer-2', role: 'assistant', content: 'SOURCE-LATER-ANSWER', timestamp: 400, loopId: 'source-loop-2', streamEnded: true },
  ];
  let nextId = 0;
  const branch = buildConversationBranchHistory({
    sourceConversationId: 'history-source', childConversationId: 'history-child', sourceTitle: 'History source',
    messages: source, targetMessageId: 'source-answer-1', accessAllowed: true,
    createId: kind => `history-${kind}-${++nextId}`,
  });
  const root = path.join(appData, 'conversations');
  for (const [id, messages] of [['history-source', source], ['history-child', branch.messages]] as const) {
    fs.mkdirSync(path.join(root, id), { recursive: true });
    fs.writeFileSync(path.join(root, id, 'messages.jsonl'), messages.map(message => JSON.stringify(message)).join('\n') + '\n');
  }
  fs.writeFileSync(path.join(root, 'index.json'), JSON.stringify({ version: 1, entries: {
    'history-source': { id: 'history-source', title: 'History source', createdAt: 100, updatedAt: 400, messageCount: 4 },
    'history-child': { id: 'history-child', title: 'History child', createdAt: 500, updatedAt: 500, messageCount: 2,
      branchOrigin: branch.branchOrigin, branchInitialOpenPending: true },
  } }));
  const sourceBytes = fs.readFileSync(path.join(root, 'history-source', 'messages.jsonl'), 'utf8');

  for (let launch = 0; launch < 2; launch += 1) {
    app = (await launchAbuElectron(dataRoot)).app;
    page = await app.firstWindow({ timeout: READY_TIMEOUT });
    await waitForApp(page);
    const showSidebar = page.getByRole('button', { name: '显示侧栏', exact: true });
    if (await showSidebar.isVisible()) await showSidebar.click();
    await page.getByRole('button', { name: /^History child/ }).first().click();
    await expect(page.getByText('BRANCH-FIRST-ANSWER', { exact: true })).toBeVisible({ timeout: READY_TIMEOUT });
    await expect(page.getByText('SOURCE-LATER-ANSWER', { exact: true })).toHaveCount(0);
    const persisted = await page.evaluate(() => JSON.parse(localStorage.getItem('abu-chat')!).state.conversationIndex['history-child']);
    expect(persisted.branchOrigin).toEqual(branch.branchOrigin);
    expect(persisted.branchInitialOpenPending).toBeUndefined();
    await page.getByRole('button', { name: /^History source/ }).first().click();
    await expect(page.getByText('SOURCE-LATER-ANSWER', { exact: true })).toBeVisible({ timeout: READY_TIMEOUT });
    await closeAbuElectron(app);
    app = undefined;
  }
  expect(fs.readFileSync(path.join(root, 'history-source', 'messages.jsonl'), 'utf8')).toBe(sourceBytes);
});
