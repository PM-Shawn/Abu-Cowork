/**
 * Real-Electron acceptance for a provider content-policy 403. The mock binds
 * only to loopback, receives a fixed synthetic prompt, and the app runs with
 * an isolated Chromium profile + app-data root.
 */
import { expect, test } from '@playwright/test';
import { createServer, type Server } from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import type { ElectronApplication } from 'playwright';
import {
  closeAbuElectron,
  configureLocalMockProvider,
  createElectronDataRoot,
  launchAbuElectron,
  removeElectronDataRoot,
  REPO_ROOT,
  type ElectronDataRoot,
} from './electronHelpers';

const READY_TIMEOUT = 45_000;
const CHAT_PLACEHOLDER = '想让阿布帮你做点什么？';
const ERROR_TYPE = 'governance.alicloud_content_safety_input_rejected';
const TRACE_ID = 'e2e-governance-trace-403';
const PROVIDER_SUMMARY = 'Input rejected by the upstream content-safety policy.';
const RAW_ONLY_MARKER = 'raw-provider-body-must-not-render';
const SCREENSHOT_PATH = path.join(REPO_ROOT, 'test-results', 'content-policy-error-card.png');

interface ContentPolicyMock {
  baseUrl: string;
  close: () => Promise<void>;
  requestCount: () => number;
}

async function startContentPolicyMock(): Promise<ContentPolicyMock> {
  let requests = 0;
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    for await (const _chunk of req) {
      // Drain the fixed synthetic request before responding.
    }
    if (req.method !== 'POST' || url.pathname !== '/v1/chat/completions') {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'unexpected E2E route' }));
      return;
    }
    requests += 1;
    res.writeHead(403, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({
      error: { message: PROVIDER_SUMMARY },
      error_type: ERROR_TYPE,
      traceId: TRACE_ID,
      private: RAW_ONLY_MARKER,
    }));
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    await closeServer(server);
    throw new Error('Content-policy mock did not receive a TCP port');
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    close: () => closeServer(server),
    requestCount: () => requests,
  };
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
    server.closeAllConnections?.();
  });
}

let app: ElectronApplication | undefined;
let dataRoot: ElectronDataRoot | undefined;
let mock: ContentPolicyMock | undefined;

test.describe.serial('Content-policy error card — real Electron', () => {
  test.afterEach(async () => {
    if (app) {
      await closeAbuElectron(app);
      app = undefined;
    }
    if (mock) {
      await mock.close();
      mock = undefined;
    }
    if (dataRoot) {
      removeElectronDataRoot(dataRoot);
      dataRoot = undefined;
    }
  });

  test('shows bounded structured fields without rendering the raw 403 body', async () => {
    mock = await startContentPolicyMock();
    dataRoot = createElectronDataRoot();
    const launched = await launchAbuElectron(dataRoot);
    app = launched.app;
    const page = await app.firstWindow({ timeout: READY_TIMEOUT });
    await page.waitForLoadState('domcontentloaded');
    await expect(page.getByPlaceholder(CHAT_PLACEHOLDER)).toBeVisible({ timeout: READY_TIMEOUT });
    await configureLocalMockProvider(page, mock.baseUrl);

    const input = page.getByPlaceholder(CHAT_PLACEHOLDER);
    await input.fill('fixed synthetic E2E prompt for a controlled 403');
    await input.press('Enter');

    await expect.poll(() => mock!.requestCount(), { timeout: READY_TIMEOUT }).toBe(1);
    const card = page.getByRole('alert').filter({ hasText: TRACE_ID });
    await expect(card).toBeVisible({ timeout: READY_TIMEOUT });
    await expect(card).toContainText('HTTP 403');
    await expect(card).toContainText(`error_type: ${ERROR_TYPE}`);
    await expect(card).toContainText(`traceId: ${TRACE_ID}`);
    await expect(card).toContainText(PROVIDER_SUMMARY);
    await expect(page.getByText(/上游内容安全系统拒绝了请求/)).toBeVisible();
    await expect(page.locator('body')).not.toContainText(RAW_ONLY_MARKER);
    await expect.poll(() => mock!.requestCount()).toBe(1);

    fs.mkdirSync(path.dirname(SCREENSHOT_PATH), { recursive: true });
    await page.screenshot({ path: SCREENSHOT_PATH, fullPage: true });
  });
});
