/**
 * Real Electron coverage for importing a conversation file from disk: the
 * conversation comes in without the workspace the file names, so reading a
 * file under that folder goes through the ordinary permission request. The
 * provider is a loopback-only OpenAI-compatible SSE server.
 */
import { expect, test } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ElectronApplication } from 'playwright';
import {
  closeAbuElectron,
  configureLocalMockProvider,
  createElectronDataRoot,
  launchAbuElectron,
  pressWhenSettled,
  removeElectronDataRoot,
  type ElectronDataRoot,
} from './electronHelpers';
import {
  CHAT_PLACEHOLDER,
  READY_TIMEOUT,
  startOpenAiMock,
  taskRequests,
  waitForApp,
  type OpenAiMock,
} from './openAiMock';

const FIXED_TIMESTAMP = 1_700_000_000_000;

let app: ElectronApplication | undefined;
let dataRoot: ElectronDataRoot | undefined;
let mock: OpenAiMock | undefined;
let senderFolder: string | undefined;

test.afterEach(async () => {
  if (app) await closeAbuElectron(app);
  app = undefined;
  if (mock) await mock.close();
  mock = undefined;
  if (dataRoot) removeElectronDataRoot(dataRoot);
  dataRoot = undefined;
  if (senderFolder) fs.rmSync(senderFolder, { recursive: true, force: true });
  senderFolder = undefined;
});

test('a conversation file is imported without its workspace, and a read under that folder asks first', async () => {
  test.setTimeout(180_000);
  // A folder under the user's Documents stands in for the folder the file
  // names: outside every always-allowed location, so a read there needs a grant.
  senderFolder = fs.mkdtempSync(path.join(os.homedir(), 'Documents', 'abu-e2e-imported-'));
  const targetFile = path.join(senderFolder, 'notes.txt');
  fs.writeFileSync(targetFile, 'from the sender\n');

  mock = await startOpenAiMock([
    {
      kind: 'tool-call',
      toolName: 'read_file',
      toolCallId: `call-read-imported-${randomUUID()}`,
      arguments: { path: targetFile },
    },
    { kind: 'complete', responseText: `imported read complete ${randomUUID()}` },
  ]);

  dataRoot = createElectronDataRoot();
  const conversationFile = path.join(dataRoot.rootDir, 'shared-conversation.json');
  fs.writeFileSync(conversationFile, JSON.stringify({
    id: 'sender-conv',
    title: 'Imported from a file',
    createdAt: FIXED_TIMESTAMP,
    updatedAt: FIXED_TIMESTAMP,
    status: 'idle',
    workspacePath: senderFolder,
    permissionMode: 'autonomous',
    messages: [{ id: 'm1', role: 'user', content: 'hello from the sender', timestamp: FIXED_TIMESTAMP }],
  }));

  const launched = await launchAbuElectron(dataRoot);
  app = launched.app;
  const page = await app.firstWindow({ timeout: READY_TIMEOUT });
  await waitForApp(page);
  await configureLocalMockProvider(page, mock.baseUrl, { supportsTools: true, permissionMode: 'standard' });

  await app.evaluate(({ dialog }, selectedPath) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selectedPath] });
  }, conversationFile);
  // The import button shows on hover of the recents header; click it through the DOM.
  await page.getByRole('button', { name: /^(导入会话|Import session)$/ }).evaluate((element: HTMLElement) => element.click());

  await expect(page.getByText('hello from the sender', { exact: true })).toBeVisible({ timeout: READY_TIMEOUT });
  // The right panel offers to choose a folder: nothing is bound.
  await page.getByRole('button', { name: /^(显示面板|Show panel)$/ }).click();
  await expect(page.getByRole('button', { name: /选择工作区|Select Workspace/ })).toBeVisible();
  await expect(page.getByText(senderFolder, { exact: true })).toHaveCount(0);
  await expect(page.getByText(path.basename(senderFolder), { exact: true })).toHaveCount(0);

  const input = page.getByPlaceholder(CHAT_PLACEHOLDER);
  await expect(input).toBeEditable({ timeout: READY_TIMEOUT });
  await input.fill(`read the notes ${randomUUID()}`);
  await input.press('Enter');

  await expect(page.getByRole('heading', { name: /^(文件读取权限|File Read Permission)$/ })).toBeVisible({
    timeout: READY_TIMEOUT,
  });
  // The grant is asked for the top-level folder of the request, under the user's Documents.
  await expect(page.getByRole('alertdialog')).toContainText('Documents');
  await pressWhenSettled(page.getByRole('button', { name: /^(拒绝|Deny)$/ }));

  await expect.poll(() => taskRequests(mock!).length, { timeout: READY_TIMEOUT }).toBe(2);
  const secondRequest = taskRequests(mock)[1].body as { messages?: Array<{ role?: string; content?: unknown }> };
  const toolResult = secondRequest.messages?.find((message) => message.role === 'tool');
  expect(toolResult).toBeDefined();
  expect(String(toolResult?.content)).toMatch(/用户拒绝|denied/i);
  expect(String(toolResult?.content)).not.toContain('from the sender');
});
