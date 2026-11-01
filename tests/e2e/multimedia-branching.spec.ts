import { expect, test } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import type { ElectronApplication } from 'playwright';
import type { Message } from '../../src/types';
import type { ImageEditRequest, MediaArtifact, MediaJobRecord } from '../../src/types/media';
import { closeAbuElectron, configureLocalMockProvider, createElectronDataRoot, dismissFirstRunOverlays, launchAbuElectron, removeElectronDataRoot } from './electronHelpers';
import { CHAT_PLACEHOLDER, READY_TIMEOUT, startOpenAiMock, taskRequests, waitForApp } from './openAiMock';

const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');

test('image branches retain comparison and editing after deleting their ancestors and restarting', async () => {
  test.setTimeout(180_000);
  const dataRoot = createElectronDataRoot();
  const llm = await startOpenAiMock([{ kind: 'complete', responseText: 'BRANCH-CONTINUED' }]);
  let app: ElectronApplication | undefined;
  try {
    app = (await launchAbuElectron(dataRoot)).app;
    let page = await app.firstWindow();
    await waitForApp(page);
    await dismissFirstRunOverlays(page);
    await configureLocalMockProvider(page, llm.baseUrl);
    const appData = await page.evaluate(async () => await window.__TAURI_INTERNALS__.invoke('plugin:path|resolve_directory', { directory: 14 }) as string);
    const model = await page.evaluate(() => JSON.parse(localStorage.getItem('abu-settings')!).state.activeModel);
    await closeAbuElectron(app);
    app = undefined;
    const conversationId = 'media-source';
    const captureId = '12345678-1234-1234-1234-123456789abc';
    const scope = `local:${hash(appData)}`;
    const bytes = await sharp({ create: { width: 320, height: 240, channels: 3, background: '#aabbcc' } }).png().toBuffer();
    const output = await sharp({ create: { width: 320, height: 240, channels: 3, background: '#bbccaa' } }).png().toBuffer();
    const source = {
      kind: 'source' as const, fileRef: { originalPath: path.join(dataRoot.rootDir, 'original.png'), captureId, contentDigest: hash(bytes) },
      mimeType: 'image/png' as const, width: 320, height: 240, byteLength: bytes.length,
    };
    const request: ImageEditRequest = {
      schemaVersion: 1, id: 'edit-request', scope, conversationId, messageId: 'image-question',
      sourceArtifactId: 'source-image', sourceCaptureId: captureId, sourceDigest: source.fileRef.contentDigest,
      prompt: 'MEDIA-BRANCH-QUESTION', comments: [], markup: [], region: [], attachmentRefs: [source], backendId: 'images', capabilityVersion: '1',
    };
    const resultPath = path.join(appData, 'media/results', hash(conversationId), hash(request.id), 'image.png');
    const artifact: MediaArtifact = {
      schemaVersion: 1, id: 'edited-image', conversationId, messageId: 'image-result', kind: 'image', mimeType: 'image/png',
      fileRef: { originalPath: resultPath, contentDigest: hash(output) }, byteLength: output.length, width: 320, height: 240,
      groupId: request.id, order: 0, editRequestId: request.id, parentArtifactId: request.sourceArtifactId,
    };
    const messages: Message[] = [
      { id: request.messageId, role: 'user', content: request.prompt, timestamp: 100, runState: 'completed', imageEditRequest: request },
      { id: artifact.messageId, role: 'assistant', content: '', timestamp: 200, mediaArtifacts: [artifact] },
    ];
    const job: MediaJobRecord = { request, artifacts: [artifact], job: {
      schemaVersion: 1, id: request.id, requestId: request.id, scope, conversationId,
      attempt: 1, generationState: 'completed', waitState: 'waiting', sequence: 4, outputArtifactIds: [artifact.id],
    } };
    const write = (filename: string, value: string | Buffer) => {
      fs.mkdirSync(path.dirname(filename), { recursive: true });
      fs.writeFileSync(filename, value);
    };
    write(path.join(appData, 'media/captures', hash(conversationId), `${captureId}.png`), bytes);
    write(path.join(appData, 'media/captures', hash(conversationId), `${captureId}.json`), JSON.stringify(source));
    write(path.join(appData, 'media/jobs', hash(conversationId), `${hash(request.id)}.json`), JSON.stringify(job));
    write(resultPath, output);
    write(path.join(appData, 'conversations', conversationId, 'messages.jsonl'), messages.map(value => JSON.stringify(value)).join('\n') + '\n');
    write(path.join(appData, 'conversations/index.json'), JSON.stringify({ version: 1, entries: {
      [conversationId]: { id: conversationId, title: 'Media source', createdAt: 100, updatedAt: 200, messageCount: 2, model },
    } }));

    app = (await launchAbuElectron(dataRoot)).app;
    page = await app.firstWindow();
    await waitForApp(page);
    expect(fs.existsSync(path.join(appData, 'media/captures', hash(conversationId), `${captureId}.png`))).toBe(true);
    expect(fs.existsSync(resultPath)).toBe(true);
    await page.getByRole('button', { name: /^Media source/ }).first().click();
    const image = page.getByRole('img', { name: 'image.png', exact: true });
    await expect(image).toBeVisible({ timeout: READY_TIMEOUT });
    await expect.poll(() => image.evaluate(element => (element as HTMLImageElement).naturalWidth)).toBe(320);
    const turn = page.locator('[data-index]').filter({ has: image });
    await turn.hover();
    await turn.getByRole('button', { name: '分支到新聊天', exact: true }).click();
    await expect(page.getByTestId('branch-origin')).toBeVisible({ timeout: READY_TIMEOUT });
    await expect(image).toBeVisible();
    await expect.poll(() => image.evaluate(element => (element as HTMLImageElement).naturalWidth)).toBe(320);
    const readIndex = () => JSON.parse(fs.readFileSync(path.join(appData, 'conversations/index.json'), 'utf8')).entries;
    const childId = Object.keys(readIndex()).find(id => readIndex()[id].branchOrigin?.sourceConversationId === conversationId)!;
    expect(childId).toBeTruthy();
    expect(fs.existsSync(path.join(appData, 'media/jobs', hash(childId)))).toBe(false);
    await turn.hover();
    await turn.getByRole('button', { name: '分支到新聊天', exact: true }).click();
    await expect.poll(() => Object.keys(readIndex()).find(id => readIndex()[id].branchOrigin?.sourceConversationId === childId), { timeout: READY_TIMEOUT }).toBeTruthy();
    await expect(page.getByRole('main').getByText('Media source · 分支 · 分支', { exact: true })).toBeVisible({ timeout: READY_TIMEOUT });
    await expect(page.getByTestId('branch-origin').getByRole('button', { name: '从聊天中继续', exact: true })).toBeVisible({ timeout: READY_TIMEOUT });
    const grandchildId = Object.keys(readIndex()).find(id => readIndex()[id].branchOrigin?.sourceConversationId === childId)!;
    expect(grandchildId).toBeTruthy();
    for (const id of [conversationId, childId]) {
      const row = page.locator(`[data-conversation-row="${id}"]`);
      await row.click({ button: 'right' });
      await page.getByRole('menuitem', { name: '删除会话', exact: true }).click();
      await expect(row).toHaveCount(0);
    }
    await closeAbuElectron(app);
    app = (await launchAbuElectron(dataRoot)).app;
    page = await app.firstWindow();
    await waitForApp(page);
    await page.getByRole('button', { name: /^Media source · 分支 · 分支/ }).first().click();
    const resultImage = page.getByRole('img', { name: 'image.png', exact: true });
    await expect.poll(() => resultImage.evaluate(element => (element as HTMLImageElement).naturalWidth)).toBe(320);
    await expect(page.getByText('原聊天已删除', { exact: true })).toBeVisible();
    await expect(page.getByRole('region', { name: '通知', exact: true })).not.toContainText('Media request');
    expect(taskRequests(llm)).toHaveLength(0);
    const card = page.locator('.group\\/card').filter({ has: resultImage }).first();
    await resultImage.click();
    const preview = page.locator('[role="tabpanel"]:not([hidden])');
    await preview.getByRole('button', { name: '比较原图', exact: true }).click();
    await expect(preview.getByRole('slider', { name: '比较原图', exact: true })).toBeVisible();
    await expect.poll(() => preview.getByRole('img', { name: '查看原图', exact: true }).evaluate(element => (element as HTMLImageElement).naturalWidth)).toBe(320);
    await preview.getByRole('button', { name: '比较原图', exact: true }).click();
    await card.hover();
    await card.getByRole('button', { name: '修改图片', exact: true }).click();
    await expect(page.getByTestId('image-edit-reference')).toBeVisible();
    const captureFolder = path.join(appData, 'media/captures', hash(grandchildId));
    await expect.poll(() => fs.existsSync(captureFolder) && fs.readdirSync(captureFolder).some(name => name.endsWith('.png'))).toBe(true);
    const composer = page.getByPlaceholder(CHAT_PLACEHOLDER);
    await composer.fill('Keep editing the independent image');
    await expect(composer).toHaveValue('Keep editing the independent image');
    expect(fs.existsSync(path.join(appData, 'media/jobs', hash(grandchildId)))).toBe(false);
    expect(taskRequests(llm)).toHaveLength(0);
  } finally {
    if (app) await closeAbuElectron(app);
    await llm.close();
    removeElectronDataRoot(dataRoot);
  }
});
