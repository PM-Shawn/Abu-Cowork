import { expect, test } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import type { ElectronApplication } from 'playwright';
import { conversationBranchPrefix } from '../../src/core/session/conversationBranchProtocol';
import { projectLedger } from '../../src/core/session/ledgerReader';
import { createMaxTurnsNoticeMessage } from '../../src/core/agent/maxTurnsNotice';
import type { Message } from '../../src/types';
import { closeAbuElectron, configureLocalMockProvider, createElectronDataRoot, launchAbuElectron, removeElectronDataRoot, type ElectronDataRoot } from './electronHelpers';
import { CHAT_PLACEHOLDER, READY_TIMEOUT, startOpenAiMock, taskRequests, waitForApp, type OpenAiMock } from './openAiMock';

let app: ElectronApplication | undefined;
let dataRoot: ElectronDataRoot | undefined;
let llm: OpenAiMock | undefined;
test.afterEach(async () => {
  if (app) await closeAbuElectron(app);
  if (llm) await llm.close();
  if (dataRoot) removeElectronDataRoot(dataRoot);
  app = undefined; dataRoot = undefined; llm = undefined;
});

test('keeps saved tool images through two branches, continuation and restart', async () => {
  test.setTimeout(180_000);
  llm = await startOpenAiMock([{ kind: 'complete', responseText: 'IMAGE-BRANCH-CONTINUED' }]);
  dataRoot = createElectronDataRoot();
  app = (await launchAbuElectron(dataRoot)).app;
  let page = await app.firstWindow({ timeout: READY_TIMEOUT });
  await waitForApp(page);
  await page.keyboard.press('Escape');
  await configureLocalMockProvider(page, llm.baseUrl, { supportsImages: true });
  const appData = await page.evaluate(async () => await window.__TAURI_INTERNALS__.invoke('plugin:path|resolve_directory', { directory: 14 }) as string);
  const model = await page.evaluate(() => JSON.parse(localStorage.getItem('abu-settings')!).state.activeModel);
  const imageData = await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 32; canvas.height = 32;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Canvas encoder unavailable');
    context.fillStyle = '#fa8c16';
    context.fillRect(0, 0, 32, 32);
    return canvas.toDataURL('image/png').split(',')[1];
  });
  await closeAbuElectron(app);
  app = undefined;
  const root = path.join(appData, 'conversations');
  const sourceId = 'image-branch-source';
  const imagePath = path.join(root, sourceId, 'outputs/files/image.png');
  const bytes = Buffer.from(imageData, 'base64');
  fs.mkdirSync(path.dirname(imagePath), { recursive: true });
  fs.writeFileSync(imagePath, bytes);
  const image = { type: 'image' as const, source: { type: 'base64' as const, media_type: 'image/png', data: '' },
    outputRef: { relPath: 'files/image.png', basename: 'image.png', sizeBytes: bytes.length } };
  const call = { id: 'image-call', name: 'read_file', input: { path: imagePath }, result: 'Saved image', resultContent: [image] };
  const messages: Message[] = [
    { id: 'image-question', role: 'user', content: 'IMAGE-BRANCH-QUESTION', timestamp: 1, runState: 'completed' },
    { id: 'image-answer', role: 'assistant', content: 'IMAGE-BRANCH-REPLY', timestamp: 2, streamEnded: true,
      toolCalls: [call], toolCallsForContext: [call] },
  ];
  const sourceBytes = messages.map(message => JSON.stringify(message) + '\n').join('');
  fs.writeFileSync(path.join(root, sourceId, 'messages.jsonl'), sourceBytes);
  fs.writeFileSync(path.join(root, sourceId, 'outputs/manifest.json'), JSON.stringify({ version: 1, entries: {
    'tool-result://image-call': { originalPath: 'tool-result://image-call', basename: 'image.png', snapshotRelPath: 'files/image.png',
      size: bytes.length, originalMtime: 1, snapshottedAt: 1, source: 'tool-output', refId: 'image-call', refKind: 'result-image' },
  } }));
  fs.writeFileSync(path.join(root, 'index.json'), JSON.stringify({ version: 1, entries: {
    [sourceId]: { id: sourceId, title: 'Image branch source', createdAt: 1, updatedAt: 2, messageCount: 2, model },
  } }));
  app = (await launchAbuElectron(dataRoot)).app;
  page = await app.firstWindow({ timeout: READY_TIMEOUT });
  await waitForApp(page);
  const sidebar = page.getByRole('button', { name: '显示侧栏', exact: true });
  if (await sidebar.isVisible()) await sidebar.click();
  await page.locator(`[data-conversation-row="${sourceId}"]`).click();
  let parentId = sourceId;
  const ancestors = [sourceId];
  function assertSavedImage(id: string): void {
    const loaded = projectLedger({ ledgerText: fs.readFileSync(path.join(root, id, 'messages.jsonl'), 'utf8') }).messages;
    const answer = loaded.find(message => message.content === 'IMAGE-BRANCH-REPLY');
    expect(answer).toBeDefined();
    for (const projection of [answer!.toolCalls, answer!.toolCallsForContext]) {
      const block = projection?.[0].resultContent?.[0];
      expect(block?.type).toBe('image');
      if (block?.type !== 'image' || !block.outputRef) throw new Error('Saved tool image reference missing');
      expect(block.source.data).toBe('');
      expect(fs.readFileSync(path.join(root, id, 'outputs', block.outputRef.relPath))).toEqual(bytes);
    }
  }
  for (let generation = 0; generation < 2; generation += 1) {
    await page.getByRole('button', { name: '分支到新聊天', exact: true }).click();
    await expect(page.getByTestId('branch-origin')).toBeVisible({ timeout: READY_TIMEOUT });
    await expect(page.getByPlaceholder(CHAT_PLACEHOLDER)).toBeFocused();
    const index = JSON.parse(fs.readFileSync(path.join(root, 'index.json'), 'utf8'));
    const childId = Object.keys(index.entries).find(id => index.entries[id].branchOrigin?.sourceConversationId === parentId);
    if (!childId) throw new Error('Created image branch missing');
    assertSavedImage(childId);
    expect(fs.readFileSync(path.join(root, sourceId, 'messages.jsonl'), 'utf8')).toBe(sourceBytes);
    parentId = childId;
    if (generation === 0) ancestors.push(childId);
  }
  await page.getByPlaceholder(CHAT_PLACEHOLDER).fill('Describe the inherited image.');
  await page.getByPlaceholder(CHAT_PLACEHOLDER).press('Enter');
  await expect(page.getByText('IMAGE-BRANCH-CONTINUED', { exact: true })).toBeVisible({ timeout: READY_TIMEOUT });
  expect(JSON.stringify(taskRequests(llm)[0].body)).toContain(`data:image/png;base64,${imageData}`);
  for (const id of ancestors) {
    const row = page.locator(`[data-conversation-row="${id}"]`);
    await row.click({ button: 'right' });
    await page.getByRole('menuitem', { name: '删除会话', exact: true }).click();
    await expect(row).toHaveCount(0);
    await expect.poll(() => fs.existsSync(path.join(root, id))).toBe(false);
  }
  await closeAbuElectron(app);
  app = undefined;
  app = (await launchAbuElectron(dataRoot)).app;
  page = await app.firstWindow({ timeout: READY_TIMEOUT });
  await waitForApp(page);
  await page.locator(`[data-conversation-row="${parentId}"]`).click();
  await expect(page.getByText('IMAGE-BRANCH-CONTINUED', { exact: true })).toBeVisible({ timeout: READY_TIMEOUT });
  await expect(page.getByText('原聊天已删除', { exact: true })).toBeVisible();
  assertSavedImage(parentId);
});

test('branches from the last action icon, continues independently, and survives source deletion and restart', async () => {
  test.setTimeout(180_000);
  llm = await startOpenAiMock([{ kind: 'complete', responseText: 'CHILD-CONTINUED' }]);
  dataRoot = createElectronDataRoot();
  app = (await launchAbuElectron(dataRoot)).app;
  let page = await app.firstWindow({ timeout: READY_TIMEOUT });
  await waitForApp(page);
  const guide = page.getByRole('dialog', { name: '快速入门' });
  await expect(guide).toBeVisible({ timeout: READY_TIMEOUT });
  await page.keyboard.press('Escape');
  await expect(guide).toBeHidden();
  await configureLocalMockProvider(page, llm.baseUrl);
  const appData = await page.evaluate(async () => await window.__TAURI_INTERNALS__.invoke('plugin:path|resolve_directory', { directory: 14 }) as string);
  const settings = await page.evaluate(() => JSON.parse(localStorage.getItem('abu-settings')!).state.activeModel);
  await closeAbuElectron(app);
  app = undefined;
  const root = path.join(appData, 'conversations');
  fs.mkdirSync(path.join(root, 'branch-source/results'), { recursive: true });
  fs.writeFileSync(path.join(root, 'branch-source/results/report.txt'), 'INDEPENDENT-FULL-RESULT');
  const sourceMessages = [
    { id: 'source-question', role: 'user', content: 'BRANCH-QUESTION', timestamp: 100, loopId: 'first-loop', runState: 'completed' },
    { id: 'source-tool', role: 'assistant', content: '', timestamp: 150, loopId: 'first-loop', toolCalls: [{ id: 'source-call', name: 'read_file', input: { path: '/work/report.txt' }, result: 'Saved report', fullResultRef: { relPath: 'results/report.txt' } }] },
    { id: 'source-reply', role: 'assistant', content: 'BRANCH-REPLY', timestamp: 200, loopId: 'first-loop', streamEnded: true },
    { id: 'later-question', role: 'user', content: 'LATER-QUESTION-EXCLUDED', timestamp: 300, loopId: 'later-loop', runState: 'completed' },
    { id: 'later-answer', role: 'assistant', content: 'LATER-ANSWER-EXCLUDED', timestamp: 400, loopId: 'later-loop', streamEnded: true },
  ];
  const sourceBytes = sourceMessages.map(message => JSON.stringify(message) + '\n').join('');
  fs.writeFileSync(path.join(root, 'branch-source/messages.jsonl'), sourceBytes);
  fs.writeFileSync(path.join(root, 'index.json'), JSON.stringify({ version: 1, entries: {
    'branch-source': { id: 'branch-source', title: 'Branch source', createdAt: 100, updatedAt: 400, messageCount: sourceMessages.length, model: settings },
  } }));
  app = (await launchAbuElectron(dataRoot)).app;
  page = await app.firstWindow({ timeout: READY_TIMEOUT });
  page.on('console', event => { if (event.text().includes('[conversation-branch]')) console.log(event.text()); });
  await waitForApp(page);
  const showSidebar = page.getByRole('button', { name: '显示侧栏', exact: true });
  if (await showSidebar.isVisible()) await showSidebar.click();
  await page.getByRole('button', { name: /^Branch source/ }).first().click();
  const firstTurn = page.locator('[data-index]').filter({ has: page.getByText('BRANCH-REPLY', { exact: true }) });
  await expect(firstTurn).toBeVisible({ timeout: READY_TIMEOUT });
  await page.getByPlaceholder(CHAT_PLACEHOLDER).fill('UNSENT-SOURCE-DRAFT');
  await expect(page.getByPlaceholder(CHAT_PLACEHOLDER)).toHaveValue('UNSENT-SOURCE-DRAFT');
  await firstTurn.hover();
  const branchButton = firstTurn.getByRole('button', { name: '分支到新聊天', exact: true });
  expect(await branchButton.evaluate(button => button.parentElement?.querySelector('button:last-of-type') === button)).toBe(true);
  await branchButton.click();
  await expect(page.getByTestId('branch-origin')).toBeVisible({ timeout: READY_TIMEOUT });
  await expect(page.getByText('LATER-ANSWER-EXCLUDED', { exact: true })).toHaveCount(0);
  const composer = page.getByPlaceholder(CHAT_PLACEHOLDER);
  await expect(composer).toBeEmpty();
  await expect(composer).toBeFocused();
  expect(taskRequests(llm)).toHaveLength(0);
  const savedIndex = JSON.parse(fs.readFileSync(path.join(root, 'index.json'), 'utf8'));
  const childId = Object.keys(savedIndex.entries).find(id => savedIndex.entries[id].branchOrigin?.sourceConversationId === 'branch-source');
  expect(childId).toBeDefined();
  if (!childId) throw new Error('Created branch missing from saved index');
  expect(childId).not.toBe('branch-source');
  expect(fs.readFileSync(path.join(root, 'branch-source/messages.jsonl'), 'utf8')).toBe(sourceBytes);
  expect(fs.readFileSync(path.join(root, childId, 'results/branch-1.txt'), 'utf8')).toBe('INDEPENDENT-FULL-RESULT');
  await page.getByRole('button', { name: '从聊天中继续', exact: true }).click();
  await expect(composer).toHaveValue('UNSENT-SOURCE-DRAFT');
  await expect(page.getByText('BRANCH-REPLY', { exact: true })).toBeInViewport();
  await expect(page.getByText('LATER-ANSWER-EXCLUDED', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: /^Branch source · 分支/ }).first().click();
  await composer.fill('Continue the branch');
  await composer.press('Enter');
  await expect(page.getByText('CHILD-CONTINUED', { exact: true })).toBeVisible({ timeout: READY_TIMEOUT });
  expect(JSON.stringify(taskRequests(llm)[0].body)).toContain('BRANCH-REPLY');
  expect(JSON.stringify(taskRequests(llm)[0].body)).not.toContain('LATER-QUESTION-EXCLUDED');
  expect(fs.readFileSync(path.join(root, 'branch-source/messages.jsonl'), 'utf8')).toBe(sourceBytes);
  await composer.fill('UNSENT-CHILD-DRAFT');
  const completedTurn = page.locator('[data-index]').filter({ has: page.getByText('CHILD-CONTINUED', { exact: true }) });
  const branchAgain = completedTurn.getByRole('button', { name: '分支到新聊天', exact: true });
  await branchAgain.focus();
  await branchAgain.press('Enter');
  await expect(page.getByRole('button', { name: '从聊天中继续', exact: true })).toBeVisible({ timeout: READY_TIMEOUT });
  await expect(composer).toBeEmpty();
  expect(taskRequests(llm)).toHaveLength(1);
  const grandchildRow = page.locator('[data-conversation-row]').filter({ hasText: 'Branch source · 分支 · 分支' });
  await grandchildRow.click({ button: 'right' });
  await page.getByRole('menuitem', { name: '删除会话', exact: true }).click();
  await expect(grandchildRow).toHaveCount(0);
  await page.getByRole('button', { name: /^Branch source · 分支/ }).first().click();
  await expect(composer).toHaveValue('UNSENT-CHILD-DRAFT');
  expect(fs.readFileSync(path.join(root, childId, 'results/branch-1.txt'), 'utf8')).toBe('INDEPENDENT-FULL-RESULT');
  await closeAbuElectron(app);
  app = undefined;
  fs.rmSync(path.join(root, 'branch-source'), { recursive: true });
  const index = JSON.parse(fs.readFileSync(path.join(root, 'index.json'), 'utf8'));
  delete index.entries['branch-source'];
  fs.writeFileSync(path.join(root, 'index.json'), JSON.stringify(index));
  app = (await launchAbuElectron(dataRoot)).app;
  page = await app.firstWindow({ timeout: READY_TIMEOUT });
  await waitForApp(page);
  if (await page.getByRole('button', { name: '显示侧栏', exact: true }).isVisible()) await page.getByRole('button', { name: '显示侧栏', exact: true }).click();
  await page.getByRole('button', { name: /^Branch source · 分支/ }).first().click();
  await expect(page.getByText('CHILD-CONTINUED', { exact: true })).toBeVisible({ timeout: READY_TIMEOUT });
  await expect(page.getByText('原聊天已删除', { exact: true })).toBeVisible();
  expect(fs.readFileSync(path.join(root, childId, 'results/branch-1.txt'), 'utf8')).toBe('INDEPENDENT-FULL-RESULT');
});

test('recovers a committed branch after restarting before its index publication', async () => {
  dataRoot = createElectronDataRoot();
  app = (await launchAbuElectron(dataRoot)).app;
  let page = await app.firstWindow({ timeout: READY_TIMEOUT });
  await waitForApp(page);
  await expect(page.getByRole('dialog', { name: '快速入门' })).toBeVisible({ timeout: READY_TIMEOUT });
  await page.keyboard.press('Escape');
  const appData = await page.evaluate(async () => await window.__TAURI_INTERNALS__.invoke('plugin:path|resolve_directory', { directory: 14 }) as string);
  await closeAbuElectron(app);
  app = undefined;
  const root = path.join(appData, 'conversations');
  const messages: Message[] = [
    { id: 'question', role: 'user', content: 'RECOVERY-QUESTION', timestamp: 1, runState: 'completed' },
    { id: 'answer', role: 'assistant', content: 'RECOVERY-ANSWER', timestamp: 2, streamEnded: true },
  ];
  const ledger = messages.map(message => JSON.stringify(message) + '\n').join('');
  fs.mkdirSync(path.join(root, 'recovery-source'), { recursive: true });
  fs.writeFileSync(path.join(root, 'recovery-source/messages.jsonl'), ledger);
  fs.writeFileSync(path.join(root, 'index.json'), JSON.stringify({ version: 1, entries: {
    'recovery-source': { id: 'recovery-source', title: 'Recovery source', createdAt: 1, updatedAt: 2, messageCount: 2 },
  } }));
  app = (await launchAbuElectron(dataRoot)).app;
  page = await app.firstWindow({ timeout: READY_TIMEOUT });
  await waitForApp(page);
  await expect.poll(() => page.evaluate(() => window.__TAURI_INTERNALS__.invoke('catalog_get_conversation',
    { convId: 'recovery-source' })), { timeout: READY_TIMEOUT }).toMatchObject({ conv_id: 'recovery-source' });
  const identity = { sourceConversationId: 'recovery-source', targetMessageId: 'answer', childConversationId: 'recovered-child' };
  const request = { ...identity, title: 'Recovered branch', errorEmptyBody: '', watermark: Buffer.byteLength(ledger),
    prefix: conversationBranchPrefix(messages, identity.sourceConversationId, identity.targetMessageId, () => null) };
  await page.evaluate(async request => {
    const bridge = (window as unknown as { __ABU_SHELL__: { conversationBranch: (action: string, input: unknown) => Promise<{ token: string }> } }).__ABU_SHELL__;
    const prepared = await bridge.conversationBranch('prepare', request);
    await bridge.conversationBranch('commit', { sourceConversationId: request.sourceConversationId,
      targetMessageId: request.targetMessageId, childConversationId: request.childConversationId, token: prepared.token });
  }, request);
  expect(fs.existsSync(path.join(root, 'recovered-child/branch-recovery.json'))).toBe(true);
  expect(JSON.parse(fs.readFileSync(path.join(root, 'index.json'), 'utf8')).entries['recovered-child']).toBeUndefined();
  await closeAbuElectron(app);
  app = undefined;
  app = (await launchAbuElectron(dataRoot)).app;
  page = await app.firstWindow({ timeout: READY_TIMEOUT });
  await waitForApp(page);
  if (await page.getByRole('button', { name: '显示侧栏', exact: true }).isVisible()) await page.getByRole('button', { name: '显示侧栏', exact: true }).click();
  await page.getByRole('button', { name: /^Recovered branch/ }).first().click();
  await expect(page.getByText('RECOVERY-ANSWER', { exact: true })).toBeVisible({ timeout: READY_TIMEOUT });
  await expect(page.getByPlaceholder(CHAT_PLACEHOLDER)).toBeFocused();
  expect(fs.existsSync(path.join(root, 'recovered-child/branch-recovery.json'))).toBe(false);
  expect(JSON.parse(fs.readFileSync(path.join(root, 'index.json'), 'utf8')).entries['recovered-child'].branchOrigin.sourceConversationId).toBe('recovery-source');
});

test('branches after a real stop, continues with the partial reply, and reopens after restart', async () => {
  test.setTimeout(150_000);
  llm = await startOpenAiMock([
    { kind: 'hold-open', partialText: 'STOPPED-BRANCH-PROGRESS' },
    { kind: 'complete', responseText: 'STOPPED-BRANCH-CONTINUED' },
  ]);
  dataRoot = createElectronDataRoot();
  app = (await launchAbuElectron(dataRoot)).app;
  let page = await app.firstWindow({ timeout: READY_TIMEOUT });
  await waitForApp(page);
  await configureLocalMockProvider(page, llm.baseUrl);
  const composer = page.getByPlaceholder(CHAT_PLACEHOLDER);
  await composer.fill('Stopped branch source');
  await composer.press('Enter');
  await expect(page.getByText('STOPPED-BRANCH-PROGRESS', { exact: true })).toBeVisible({ timeout: READY_TIMEOUT });
  await page.getByRole('button', { name: '停止', exact: true }).click();
  const stoppedTurn = page.locator('[data-index]').filter({ has: page.getByText('STOPPED-BRANCH-PROGRESS', { exact: true }) });
  await stoppedTurn.hover();
  const branch = stoppedTurn.getByRole('button', { name: '分支到新聊天', exact: true });
  await expect(branch).toBeEnabled({ timeout: READY_TIMEOUT });
  await branch.click();
  await expect(page.getByTestId('branch-origin')).toBeVisible({ timeout: READY_TIMEOUT });
  await expect(composer).toBeFocused();
  expect(taskRequests(llm)).toHaveLength(1);
  await composer.fill('Continue in a different direction');
  await composer.press('Enter');
  await expect(page.getByText('STOPPED-BRANCH-CONTINUED', { exact: true })).toBeVisible({ timeout: READY_TIMEOUT });
  expect(JSON.stringify(taskRequests(llm)[1].body)).toContain('STOPPED-BRANCH-PROGRESS');
  await closeAbuElectron(app);
  app = undefined;
  app = (await launchAbuElectron(dataRoot)).app;
  page = await app.firstWindow({ timeout: READY_TIMEOUT });
  await waitForApp(page);
  if (await page.getByRole('button', { name: '显示侧栏', exact: true }).isVisible()) await page.getByRole('button', { name: '显示侧栏', exact: true }).click();
  await page.getByRole('button', { name: /^Stopped branch source · 分支/ }).first().click();
  await expect(page.getByText('STOPPED-BRANCH-CONTINUED', { exact: true })).toBeVisible({ timeout: READY_TIMEOUT });
  await expect(page.getByText('STOPPED-BRANCH-PROGRESS', { exact: true })).toBeVisible();
});

test('branches from failed, tool-only, legacy and turn-limit histories through the real Host', async () => {
  test.setTimeout(180_000);
  const cases = ['failed', 'tool-only', 'legacy', 'turn-limit'] as const;
  llm = await startOpenAiMock(cases.map(kind => ({ kind: 'complete', responseText: `CONTINUED-${kind}` })));
  dataRoot = createElectronDataRoot();
  app = (await launchAbuElectron(dataRoot)).app;
  let page = await app.firstWindow({ timeout: READY_TIMEOUT });
  await waitForApp(page);
  await configureLocalMockProvider(page, llm.baseUrl);
  const appData = await page.evaluate(async () => await window.__TAURI_INTERNALS__.invoke('plugin:path|resolve_directory', { directory: 14 }) as string);
  const model = await page.evaluate(() => JSON.parse(localStorage.getItem('abu-settings')!).state.activeModel);
  await closeAbuElectron(app);
  app = undefined;
  const root = path.join(appData, 'conversations');
  const entries: Record<string, unknown> = {};
  for (const kind of cases) {
    const id = `source-${kind}`;
    const tool = { id: `call-${kind}`, name: 'write_file', input: { path: '/work/report.txt' },
      ...(kind === 'failed' ? {} : { result: `SAVED-${kind}` }) };
    const messages: Message[] = [
      { id: `question-${kind}`, role: 'user', content: `QUESTION-${kind}`, timestamp: 100, loopId: `loop-${kind}`,
        ...(kind === 'legacy' ? {} : { runState: kind === 'failed' ? 'failed' : 'completed' }) },
      { id: `reply-${kind}`, role: 'assistant', content: kind === 'tool-only' ? '' : `REPLY-${kind}`, timestamp: 200,
        loopId: `loop-${kind}`, toolCalls: kind === 'legacy' ? [{ ...tool, isExecuting: true, result: undefined }] : [tool] },
      ...(kind === 'turn-limit' ? [createMaxTurnsNoticeMessage({ id: 'limit', timestamp: 210, limit: 20, streak: 1 })] : []),
    ];
    fs.mkdirSync(path.join(root, id), { recursive: true });
    fs.writeFileSync(path.join(root, id, 'messages.jsonl'), messages.map(message => JSON.stringify(message) + '\n').join(''));
    entries[id] = { id, title: `Source ${kind}`, createdAt: 100, updatedAt: 200, messageCount: messages.length, model };
  }
  fs.writeFileSync(path.join(root, 'index.json'), JSON.stringify({ version: 1, entries }));
  app = (await launchAbuElectron(dataRoot)).app;
  page = await app.firstWindow({ timeout: READY_TIMEOUT });
  await waitForApp(page);
  if (await page.getByRole('button', { name: '显示侧栏', exact: true }).isVisible()) await page.getByRole('button', { name: '显示侧栏', exact: true }).click();
  for (const [index, kind] of cases.entries()) {
    await page.getByRole('button', { name: new RegExp(`^Source ${kind}`) }).first().click();
    await expect(page.getByText(`QUESTION-${kind}`, { exact: true })).toBeVisible({ timeout: READY_TIMEOUT });
    const branch = page.getByRole('button', { name: '分支到新聊天', exact: true });
    await expect(branch).toHaveCount(1, { timeout: READY_TIMEOUT });
    await branch.focus();
    await branch.press('Enter');
    await expect(page.getByRole('button', { name: '从聊天中继续', exact: true })).toBeVisible({ timeout: READY_TIMEOUT });
    const composer = page.getByPlaceholder(CHAT_PLACEHOLDER);
    await expect(composer).toBeFocused();
    expect(taskRequests(llm)).toHaveLength(index);
    await composer.fill(`Continue ${kind}`);
    await composer.press('Enter');
    await expect(page.getByText(`CONTINUED-${kind}`, { exact: true })).toBeVisible({ timeout: READY_TIMEOUT });
    const body = JSON.stringify(taskRequests(llm)[index].body);
    expect(body).toContain(`QUESTION-${kind}`);
    if (kind === 'failed') {
      expect(body).toContain('Its outcome is unknown');
      expect(body).toContain('Do not automatically replay it');
    } else if (kind !== 'legacy') expect(body).toContain(`SAVED-${kind}`);
    else expect(body).toContain('REPLY-legacy');
  }
});

test('stops a real pending tool and keeps its cancellation in branch context', async () => {
  test.setTimeout(120_000);
  llm = await startOpenAiMock([
    { kind: 'tool-call', toolCallId: 'branch-question', toolName: 'ask_user_question', arguments: {
      questions: [{ header: '方向', question: '选择继续方向', multiSelect: false,
        options: [{ label: '方向一' }, { label: '方向二' }] }],
    } },
    { kind: 'complete', responseText: 'TOOL-STOP-BRANCH-CONTINUED' },
  ]);
  dataRoot = createElectronDataRoot();
  app = (await launchAbuElectron(dataRoot)).app;
  const page = await app.firstWindow({ timeout: READY_TIMEOUT });
  await waitForApp(page);
  await configureLocalMockProvider(page, llm.baseUrl, { supportsTools: true });
  const composer = page.getByPlaceholder(CHAT_PLACEHOLDER);
  await composer.fill('Ask me a question');
  await composer.press('Enter');
  await expect(page.getByText('选择继续方向', { exact: true }).first()).toBeVisible({ timeout: READY_TIMEOUT });
  await page.getByRole('button', { name: '停止', exact: true }).click();
  const branch = page.getByRole('button', { name: '分支到新聊天', exact: true });
  await expect(branch).toHaveCount(1, { timeout: READY_TIMEOUT });
  await branch.focus();
  await branch.press('Enter');
  await expect(page.getByTestId('branch-origin')).toBeVisible({ timeout: READY_TIMEOUT });
  expect(taskRequests(llm)).toHaveLength(1);
  await composer.fill('Continue with a new direction');
  await composer.press('Enter');
  await expect(page.getByText('TOOL-STOP-BRANCH-CONTINUED', { exact: true })).toBeVisible({ timeout: READY_TIMEOUT });
  const context = JSON.stringify(taskRequests(llm)[1].body);
  expect(context).toContain('ask_user_question');
  expect(context).toMatch(/interrupted|cancelled|取消|中断/i);
});
