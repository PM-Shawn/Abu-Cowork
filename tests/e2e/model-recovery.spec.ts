import { expect, test } from '@playwright/test';
import { createServer, type ServerResponse } from 'node:http';
import type { ElectronApplication } from 'playwright';
import {
  closeAbuElectron, configureLocalMockProvider, createElectronDataRoot,
  dismissFirstRunOverlays, launchAbuElectron, removeElectronDataRoot, type ElectronDataRoot,
} from './electronHelpers';

const task = 'model-recovery-verification';
const completed = 'The selected model completed the preserved task.';
const placeholder = '想让阿布帮你做点什么？';
const timeout = 45000;

interface RecordedRequest { model: unknown; authorization: string | undefined; messages: unknown[] }

async function startProvider(quota: boolean) {
  const requests: RecordedRequest[] = [];
  const responses = new Set<ServerResponse>();
  const server = createServer(async (request, response) => {
    responses.add(response);
    response.once('close', () => responses.delete(response));
    if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
      response.writeHead(404).end();
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString()) as {
      model: string; stream?: boolean; messages: Array<{ role: string; content: unknown }>;
    };
    const isTask = body.messages.some(message => message.role === 'user' && message.content === task);
    if (isTask) requests.push({ model: body.model, authorization: request.headers.authorization, messages: body.messages });
    if (isTask && quota) {
      response.writeHead(429, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { message: 'Provider quota exhausted', code: 'quota_exceeded', type: 'insufficient_quota' } }));
      return;
    }
    const content = isTask ? completed : '[]';
    if (body.stream === false) {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ id: 'recovery-response', model: body.model, object: 'chat.completion',
        choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }] }));
      return;
    }
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    for (const [delta, finishReason] of [[{ content }, null], [{}, 'stop']] as const) {
      response.write(`data: ${JSON.stringify({ id: 'recovery-response', object: 'chat.completion.chunk', created: 0,
        model: body.model, choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`);
    }
    response.end('data: [DONE]\n\n');
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); });
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Provider fixture has no listening port');
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`, requests,
    close: () => new Promise<void>(resolve => {
      for (const response of responses) response.destroy();
      server.close(() => resolve());
      server.closeAllConnections();
    }),
  };
}

test.describe('model recovery in Electron', () => {
  let app: ElectronApplication | undefined;
  let root: ElectronDataRoot | undefined;
  const providers: Array<Awaited<ReturnType<typeof startProvider>>> = [];

  test.afterEach(async () => {
    if (app) await closeAbuElectron(app);
    app = undefined;
    for (const provider of providers.splice(0)) await provider.close();
    if (root) removeElectronDataRoot(root);
    root = undefined;
  });

  for (const action of ['select', 'stop'] as const) {
    test(`preserves the task until the user chooses to ${action}`, async () => {
      const exhausted = await startProvider(true);
      const available = await startProvider(false);
      providers.push(exhausted, available);
      root = createElectronDataRoot();
      ({ app } = await launchAbuElectron(root));
      const page = await app.firstWindow({ timeout });
      await expect(page.getByPlaceholder(placeholder)).toBeVisible({ timeout });
      await dismissFirstRunOverlays(page);
      await configureLocalMockProvider(page, available.baseUrl, {
        providerId: 'recovery-available', providerName: 'Recovery available', apiKey: 'recovery-key',
        modelId: 'recovery-model', modelLabel: '恢复模型', supportsTools: true, supportsImages: false,
      });
      await configureLocalMockProvider(page, exhausted.baseUrl, {
        providerId: 'recovery-exhausted', providerName: 'Recovery exhausted', apiKey: 'exhausted-key',
        modelId: 'exhausted-model', modelLabel: '额度不足模型', supportsTools: true, supportsImages: false, keepOtherProviders: true,
      });
      await page.getByPlaceholder(placeholder).fill(task);
      await page.getByPlaceholder(placeholder).press('Enter');
      const choose = page.getByRole('button', { name: '选择模型并继续', exact: true });
      await expect(choose).toBeVisible({ timeout });
      expect(exhausted.requests).toHaveLength(1);
      expect(available.requests).toHaveLength(0);
      await choose.click();
      await page.keyboard.press('Escape');
      await expect(choose).toBeVisible();
      expect(available.requests).toHaveLength(0);

      if (action === 'stop') {
        await page.getByRole('button', { name: '停止', exact: true }).click();
        await expect(choose).toHaveCount(0, { timeout });
        expect(available.requests).toHaveLength(0);
      } else {
        await choose.click();
        await page.getByRole('button', { name: '恢复模型', exact: true }).last().click();
        await expect(page.getByText(completed, { exact: true })).toBeVisible({ timeout });
        await expect(choose).toHaveCount(0);
        await expect(page.getByRole('button', { name: '停止', exact: true })).toHaveCount(0, { timeout });
        expect(available.requests).toHaveLength(1);
        expect(available.requests[0]).toMatchObject({ model: 'recovery-model', authorization: 'Bearer recovery-key' });
        expect(available.requests[0].messages).toContainEqual(expect.objectContaining({ role: 'user', content: task }));
        expect(exhausted.requests).toHaveLength(1);
        await expect(page.getByTestId('composer-toolbar').getByRole('button', { name: '恢复模型', exact: true })).toBeVisible();
      }
    });
  }
});
