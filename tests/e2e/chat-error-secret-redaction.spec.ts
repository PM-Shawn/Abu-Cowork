/**
 * Real-Electron acceptance for a provider that echoes the request's own
 * credential in its error body. The mock binds only to loopback and repeats
 * the Authorization header it actually received, so the assertion covers the
 * whole path: request → provider body → sidecar → store → chat error card.
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
// 明显是假的密钥，形状也不在任何按形状脱敏的规则里：只有按原文替换能去掉它
const FAKE_API_KEY = 'abu-e2e-not-a-secret';
const TRACE_ID = 'e2e-echoed-credential-trace-401';
const SCREENSHOT_PATH = path.join(REPO_ROOT, 'test-results', 'chat-error-secret-redaction-card.png');

interface EchoingMock {
  baseUrl: string;
  close: () => Promise<void>;
  receivedAuthorization: () => string[];
}

async function startEchoingMock(): Promise<EchoingMock> {
  const received: string[] = [];
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
    const authorization = req.headers.authorization ?? '';
    received.push(authorization);
    res.writeHead(401, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({
      error: {
        message: `Incorrect API key provided: ${authorization.replace(/^Bearer\s+/i, '')}. Received header Authorization: ${authorization}`,
      },
      traceId: TRACE_ID,
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
    throw new Error('Echoing mock did not receive a TCP port');
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    close: () => closeServer(server),
    receivedAuthorization: () => received,
  };
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
    server.closeAllConnections?.();
  });
}

/** True once any messages.jsonl under the app data root contains `text`. */
function diskContains(rootDir: string, text: string): boolean {
  const visit = (dir: string): boolean => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return false;
    }
    return entries.some((entry) => {
      const entryPath = path.join(dir, entry.name);
      if (entry.isDirectory()) return visit(entryPath);
      if (entry.name !== 'messages.jsonl') return false;
      try {
        return fs.readFileSync(entryPath, 'utf8').includes(text);
      } catch {
        return false;
      }
    });
  };
  return visit(rootDir);
}

let app: ElectronApplication | undefined;
let dataRoot: ElectronDataRoot | undefined;
let mock: EchoingMock | undefined;

test.describe.serial('Chat error card — echoed credential, real Electron', () => {
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

  test('never renders the request key a provider echoed in its 401 body', async () => {
    mock = await startEchoingMock();
    dataRoot = createElectronDataRoot();
    const launched = await launchAbuElectron(dataRoot);
    app = launched.app;
    const page = await app.firstWindow({ timeout: READY_TIMEOUT });
    await page.waitForLoadState('domcontentloaded');
    await expect(page.getByPlaceholder(CHAT_PLACEHOLDER)).toBeVisible({ timeout: READY_TIMEOUT });
    await configureLocalMockProvider(page, mock.baseUrl, { apiKey: FAKE_API_KEY });

    const input = page.getByPlaceholder(CHAT_PLACEHOLDER);
    await input.fill('fixed synthetic E2E prompt for a controlled 401');
    await input.press('Enter');

    const card = page.getByRole('alert').filter({ hasText: TRACE_ID });
    await expect(card).toBeVisible({ timeout: READY_TIMEOUT });
    // The provider really received the key, so the body really echoed it.
    expect(mock.receivedAuthorization()[0]).toBe(`Bearer ${FAKE_API_KEY}`);
    await expect(card).toContainText('HTTP 401');
    await expect(card).toContainText('Incorrect API key provided: [REDACTED]');
    await expect(page.locator('body')).not.toContainText(FAKE_API_KEY);

    // The conversation file on disk carries the same redacted text.
    await expect.poll(() => diskContains(dataRoot!.rootDir, TRACE_ID), { timeout: READY_TIMEOUT }).toBe(true);
    expect(diskContains(dataRoot.rootDir, FAKE_API_KEY)).toBe(false);

    fs.mkdirSync(path.dirname(SCREENSHOT_PATH), { recursive: true });
    await page.screenshot({ path: SCREENSHOT_PATH, fullPage: true });
  });
});
