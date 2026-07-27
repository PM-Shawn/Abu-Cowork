/**
 * Packaged-build smoke test (F12, first packaging slice).
 *
 * Launches the ACTUAL electron-builder output (an unsigned, unpacked app under
 * release-electron/) via Playwright-for-Electron and asserts the packaging
 * wiring is correct end-to-end — the thing a `--dir` build can prove without a
 * signing certificate:
 *   1. The packaged app launches and opens a window (no boot crash — which also
 *      transitively proves node-pty, required at boot by tauriHost→ptyHost,
 *      loads under the packaged Electron ABI).
 *   2. It reports app.isPackaged === true (we're testing the real bundle, not
 *      a dev `electron .`).
 *   3. The bundled resources resolve under process.resourcesPath: sidecar
 *      bundle, builtin-skills, and the native-helper binary all exist there —
 *      i.e. extraResources landed where appEnv.cjs / tauriHost.cjs
 *      (BaseDirectory.Resource) / nativeHelperManager.cjs now look when packaged.
 *   4. The REAL frontend rendered (React mounted into #root), not the
 *      placeholder page — i.e. dist-electron-spike was bundled and loads.
 *   5. A packaged HTML preview receives the shared element-picker script.
 *   6. With fully isolated temporary app data, the packaged frontend reaches
 *      the packaged sidecar, completes a loopback-only model request, persists
 *      the conversation, and restores it after a packaged-app restart.
 *
 * Run: npm run smoke:electron:packaged   (after `npm run pack:electron`)
 *
 * NOT covered (documented, needs signing/real user flow): signed-install
 * behavior, auto-update, and cross-arch native rebuilds — later slices.
 */
import { _electron as electron } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const OUT = 'release-electron';
const READY_TIMEOUT = 45_000;
const CHAT_PLACEHOLDER = '想让阿布帮你做点什么？';
const TEST_API_KEY = 'abu-packaged-e2e-key-not-a-real-secret';
const TEST_MODEL_ID = 'abu-packaged-e2e-model';
const E2E_APP_DATA_ROOT_ENV = 'ABU_E2E_APP_DATA_ROOT';
const PACKAGED_E2E_ENV = 'ABU_PACKAGED_E2E';

/** Locate the packaged binary + its Resources dir across mac/win/linux --dir outputs. */
function findPackagedApp() {
  const macArches = ['mac-arm64', 'mac', 'mac-x64', 'mac-universal'];
  for (const a of macArches) {
    const appDir = path.join(OUT, a, 'Abu.app');
    const bin = path.join(appDir, 'Contents', 'MacOS', 'Abu');
    if (fs.existsSync(bin)) {
      return { bin, resources: path.join(appDir, 'Contents', 'Resources') };
    }
  }
  // linux --dir
  for (const name of ['abu', 'Abu']) {
    const bin = path.join(OUT, 'linux-unpacked', name);
    if (fs.existsSync(bin)) {
      return { bin, resources: path.join(OUT, 'linux-unpacked', 'resources') };
    }
  }
  // win --dir
  const winBin = path.join(OUT, 'win-unpacked', 'Abu.exe');
  if (fs.existsSync(winBin)) {
    return { bin: winBin, resources: path.join(OUT, 'win-unpacked', 'resources') };
  }
  return null;
}

function requestPreview({ port, pathAndQuery }) {
  return new Promise((resolve, reject) => {
    const request = http.request(
      { host: '127.0.0.1', port, method: 'GET', path: pathAndQuery },
      (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => {
          resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString('utf8') });
        });
      }
    );
    request.on('error', reject);
    request.end();
  });
}

function sseChunk(content, finishReason) {
  return `data: ${JSON.stringify({
    id: 'chatcmpl-abu-packaged-e2e',
    object: 'chat.completion.chunk',
    created: 0,
    model: TEST_MODEL_ID,
    choices: [{
      index: 0,
      delta: content ? { content } : {},
      finish_reason: finishReason,
    }],
  })}\n\n`;
}

async function startOpenAiMock(responseText) {
  const requests = [];
  const server = http.createServer(async (request, response) => {
    const requestUrl = new URL(request.url ?? '/', 'http://127.0.0.1');
    let rawBody = '';
    for await (const chunk of request) rawBody += String(chunk);

    let body = rawBody;
    try {
      body = JSON.parse(rawBody);
    } catch {
      // Preserve malformed input in the smoke output if this regresses.
    }
    requests.push({
      authorization: request.headers.authorization,
      body,
      method: request.method,
      pathname: requestUrl.pathname,
    });

    if (request.method !== 'POST' || requestUrl.pathname !== '/v1/chat/completions') {
      response.writeHead(404, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: 'unexpected packaged-smoke route' }));
      return;
    }

    response.writeHead(200, {
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'content-type': 'text/event-stream; charset=utf-8',
    });
    const splitAt = Math.ceil(responseText.length / 2);
    response.write(sseChunk(responseText.slice(0, splitAt), null));
    await new Promise((resolve) => setTimeout(resolve, 50));
    response.write(sseChunk(responseText.slice(splitAt), null));
    await new Promise((resolve) => setTimeout(resolve, 50));
    response.write(sseChunk('', 'stop'));
    response.end('data: [DONE]\n\n');
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw new Error('The packaged-smoke mock did not receive a TCP port');
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    requests,
    close: () => new Promise((resolve, reject) => {
      server.closeAllConnections?.();
      server.close((error) => error ? reject(error) : resolve());
    }),
  };
}

async function configureLocalMockProvider(window, baseUrl) {
  await window.getByPlaceholder(CHAT_PLACEHOLDER).waitFor({
    state: 'visible',
    timeout: READY_TIMEOUT,
  });
  await window.evaluate(({ mockBaseUrl, testApiKey, testModelId }) => {
    const raw = window.localStorage.getItem('abu-settings');
    if (!raw) throw new Error('abu-settings was not initialized before packaged-smoke setup');
    const persisted = JSON.parse(raw);
    const state = persisted.state;
    state.providers = [{
      id: 'abu-packaged-e2e-provider',
      source: 'custom',
      name: 'Abu packaged E2E loopback mock',
      enabled: true,
      apiFormat: 'openai-compatible',
      baseUrl: mockBaseUrl,
      apiKey: testApiKey,
      models: [{
        id: testModelId,
        label: 'Abu packaged E2E deterministic model',
        isCustom: true,
        declaredCapabilities: { supportsTools: false },
      }],
      defaultModelId: testModelId,
      status: 'verified',
      sortOrder: 0,
      userAdded: true,
      declaredCapabilities: { supportsTools: false },
    }];
    state.activeModel = {
      providerId: 'abu-packaged-e2e-provider',
      modelId: testModelId,
    };
    state.recentModels = [];
    state.favoriteModels = [];
    state.guideShown = true;
    state.guideOpen = false;
    state.hasAcknowledgedDisclaimer = true;
    state.hasRunSensitiveAudit_v015 = true;
    window.localStorage.setItem(
      'abu-settings',
      JSON.stringify({ ...persisted, state, version: 42 }),
    );
  }, {
    mockBaseUrl: baseUrl,
    testApiKey: TEST_API_KEY,
    testModelId: TEST_MODEL_ID,
  });
  await window.reload();
  await window.getByPlaceholder(CHAT_PLACEHOLDER).waitFor({
    state: 'visible',
    timeout: READY_TIMEOUT,
  });
}

async function waitUntil(predicate, description, timeoutMs = READY_TIMEOUT) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${description}`);
}

function diskContains(rootDir, expectedText, fileName = 'messages.jsonl') {
  let entries;
  try {
    entries = fs.readdirSync(rootDir, { withFileTypes: true });
  } catch {
    return false;
  }
  return entries.some((entry) => {
    const entryPath = path.join(rootDir, entry.name);
    if (entry.isDirectory()) return diskContains(entryPath, expectedText, fileName);
    if (entry.name !== fileName) return false;
    try {
      return fs.readFileSync(entryPath, 'utf8').includes(expectedText);
    } catch {
      return false;
    }
  });
}

async function closePackagedApp(app) {
  if (!app) return;
  const child = app.process();
  try {
    await app.evaluate(({ app: electronApp }) => electronApp.quit());
  } catch {
    // Playwright commonly loses its transport before quit() returns.
  }
  if (await waitForChildExit(child, 5_000)) return;
  child.kill('SIGTERM');
  if (await waitForChildExit(child, 3_000)) return;
  child.kill('SIGKILL');
  await waitForChildExit(child, 2_000);
}

function waitForChildExit(child, timeoutMs) {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve(true);
      return;
    }
    const timer = setTimeout(() => {
      child.removeListener('exit', onExit);
      resolve(false);
    }, timeoutMs);
    const onExit = () => {
      clearTimeout(timer);
      resolve(true);
    };
    child.once('exit', onExit);
  });
}

function launchPackagedApp(found, userDataDir, appDataDir) {
  fs.mkdirSync(userDataDir, { recursive: true });
  fs.mkdirSync(appDataDir, { recursive: true });
  return electron.launch({
    executablePath: found.bin,
    args: [`--user-data-dir=${userDataDir}`],
    env: {
      ...process.env,
      [E2E_APP_DATA_ROOT_ENV]: appDataDir,
      [PACKAGED_E2E_ENV]: '1',
    },
    timeout: 60_000,
  });
}

async function main() {
  const found = findPackagedApp();
  if (!found) {
    console.error(
      `[packaged-smoke] no packaged app found under ${OUT}/ — run \`npm run pack:electron\` first`
    );
    process.exit(1);
  }
  console.log(`[packaged-smoke] launching ${found.bin}`);

  const checks = {};
  const errors = {};
  const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'abu-packaged-e2e-'));
  const previewFixtureDir = path.join(testRoot, 'preview');
  const userDataDir = path.join(testRoot, 'user-data');
  const appDataDir = path.join(testRoot, 'app-data');
  fs.mkdirSync(previewFixtureDir, { recursive: true });
  fs.writeFileSync(
    path.join(previewFixtureDir, 'index.html'),
    '<!doctype html><html><body><main>packaged preview smoke</main></body></html>'
  );
  const prompt = `abu-packaged-prompt-${randomUUID()}`;
  const responseText = `abu-packaged-answer-${randomUUID()}`;
  const recentTitle = `${prompt.slice(0, 30)}...`;
  const mock = await startOpenAiMock(responseText);

  let app;
  try {
    app = await launchPackagedApp(found, userDataDir, appDataDir);
    let window = await app.firstWindow({ timeout: 30_000 });
    checks.windowOpened = !!window;
    await window.waitForLoadState('domcontentloaded', { timeout: 30_000 });

    // ── main-process assertion: we launched the REAL packaged bundle ──
    // (Keep this evaluate trivial — Playwright's eval scope has no `require`, so
    // do filesystem checks below from the test process instead.)
    const isPackaged = await app.evaluate(({ app: a }) => a.isPackaged);
    checks.isPackaged = isPackaged === true;
    const reportedAppData = await app.evaluate(({ app: a }) => a.getPath('appData'));
    checks.appDataIsolated = path.resolve(reportedAppData) === path.resolve(appDataDir);

    // ── bundled resources landed under Contents/Resources ── (checked locally)
    checks.sidecarInResources = fs.existsSync(path.join(found.resources, 'sidecar', 'index.mjs'));
    checks.skillsInResources = fs.existsSync(path.join(found.resources, 'builtin-skills'));
    const helperName = process.platform === 'win32' ? 'native-helper.exe' : 'native-helper';
    checks.helperInResources = fs.existsSync(
      path.join(found.resources, 'native-helper', helperName)
    );

    // ── renderer assertion: real frontend mounted (not the placeholder) ──
    try {
      await window.waitForFunction(
        () => {
          const root = document.querySelector('#root');
          return !!root && root.children.length > 0;
        },
        { timeout: 20_000 }
      );
      checks.realFrontendRendered = true;
    } catch (err) {
      checks.realFrontendRendered = false;
      errors.frontend = String(err);
    }

    // ── packaged preview assertion: the picker must be inside app.asar ──
    try {
      const preview = await window.evaluate(async (directory) => {
        const info = await window.__TAURI_INTERNALS__.invoke('get_preview_server_info');
        const rootId = await window.__TAURI_INTERNALS__.invoke('register_preview_root', { path: directory });
        return { ...info, rootId };
      }, previewFixtureDir);
      const response = await requestPreview({
        port: preview.port,
        pathAndQuery: `/files/${preview.token}/${preview.rootId}/index.html`,
      });
      checks.previewPickerInjected =
        response.status === 200 && response.body.includes('__ABU_PREVIEW_INSPECT__');

      await window.evaluate((rootId) => window.__TAURI_INTERNALS__.invoke('unregister_preview_root', { rootId }), preview.rootId);
    } catch (err) {
      checks.previewPickerInjected = false;
      errors.preview = String(err);
    }

    // ── packaged task assertion: renderer → packaged sidecar → local mock ──
    try {
      await configureLocalMockProvider(window, mock.baseUrl);
      const input = window.getByPlaceholder(CHAT_PLACEHOLDER);
      await input.fill(prompt);
      await input.press('Enter');
      await waitUntil(() => mock.requests.length === 1, 'the packaged model request');
      const request = mock.requests[0];
      checks.packagedTaskReachedMock =
        request.method === 'POST' &&
        request.pathname === '/v1/chat/completions' &&
        request.authorization === `Bearer ${TEST_API_KEY}` &&
        JSON.stringify(request.body).includes(prompt);
      await window.getByText(responseText, { exact: true }).waitFor({
        state: 'visible',
        timeout: READY_TIMEOUT,
      });
      checks.packagedTaskRendered = true;
      await waitUntil(
        () => diskContains(appDataDir, prompt) && diskContains(appDataDir, responseText),
        'the packaged conversation to persist',
      );
      checks.packagedTaskPersisted = true;

      await closePackagedApp(app);
      app = undefined;
      app = await launchPackagedApp(found, userDataDir, appDataDir);
      window = await app.firstWindow({ timeout: READY_TIMEOUT });
      await window.getByPlaceholder(CHAT_PLACEHOLDER).waitFor({
        state: 'visible',
        timeout: READY_TIMEOUT,
      });
      await window.getByTitle(/显示侧栏|Show sidebar/).click();
      const recentConversation = window.getByRole('button', { name: recentTitle }).first();
      await recentConversation.waitFor({ state: 'visible', timeout: READY_TIMEOUT });
      await recentConversation.click();
      await window.getByText(prompt, { exact: true }).waitFor({
        state: 'visible',
        timeout: READY_TIMEOUT,
      });
      await window.getByText(responseText, { exact: true }).waitFor({
        state: 'visible',
        timeout: READY_TIMEOUT,
      });
      checks.packagedConversationRestored = true;
    } catch (err) {
      checks.packagedTaskReachedMock ??= false;
      checks.packagedTaskRendered ??= false;
      checks.packagedTaskPersisted ??= false;
      checks.packagedConversationRestored ??= false;
      errors.packagedTask = String(err);
    }
  } catch (err) {
    errors.launch = String(err);
  } finally {
    await closePackagedApp(app);
    await mock.close();
    fs.rmSync(testRoot, { recursive: true, force: true });
  }

  const passed =
    Object.values(checks).length > 0 &&
    Object.values(checks).every(Boolean) &&
    Object.keys(errors).length === 0;
  console.log('[packaged-smoke] checks = ' + JSON.stringify(checks, null, 2));
  if (Object.keys(errors).length) {
    console.log('[packaged-smoke] errors = ' + JSON.stringify(errors, null, 2));
  }
  console.log('[packaged-smoke] PASSED = ' + passed);
  process.exit(passed ? 0 : 1);
}

main().catch((err) => {
  console.error('[packaged-smoke] fatal', err);
  process.exit(1);
});
