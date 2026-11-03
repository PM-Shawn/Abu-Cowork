import { createServer, type Server } from 'node:http';
import { expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from 'playwright';
import { closeAbuElectron, launchAbuElectron, removeElectronDataRoot, type ElectronDataRoot } from './electronHelpers';

async function createProbe(app: ElectronApplication, url: string) {
  return app.evaluateHandle(async ({ app, webContents }, fixtureUrl) => {
    const require = process.getBuiltinModule('module').createRequire(`${app.getAppPath()}/main.cjs`);
    const host = require('./browserHost.cjs');
    const id = 'dialog-recovery';
    const previous = new Set(webContents.getAllWebContents().map(contents => contents.id));
    host.browserDispatch(null, 'browser_create', { id, url: fixtureUrl, x: 400, y: 60, width: 600, height: 400 });
    const contents = webContents.getAllWebContents().find(item => !previous.has(item.id))!;
    await new Promise<void>(resolve => contents.once('did-finish-load', resolve));
    const args = { ownerId: 'dialog-recovery', tabId: contents.id };
    await host.performBrowserAutomation('click', { ...args, locator: { css: '#arm' } });

    let now = 0;
    let nextTimer = 0;
    const timers = new Map<number, { at: number; callback: () => void }>();
    host.__testing.setClock({
      now: () => now,
      sleep: async (ms: number) => { now += ms; },
      setTimeout(callback: () => void, ms: number) {
        const key = ++nextTimer;
        timers.set(key, { at: now + ms, callback });
        return key;
      },
      clearTimeout(key: number) { timers.delete(key); },
    });

    const original = contents.debugger.sendCommand.bind(contents.debugger);
    const commands = new Set<Promise<unknown>>();
    const protocolErrors: string[] = [];
    let failures = 0;
    let delayNext = false;
    let releaseReply: (() => void) | undefined;
    let replyReached: (() => void) | undefined;
    let delayedAnswer: Promise<unknown> | undefined;
    contents.debugger.sendCommand = (method, params, sessionId) => {
      // Chromium itself rejects the malformed external request. The host's
      // timer, dialog records and error handling run unchanged.
      const rejectRequest = method === 'Page.handleJavaScriptDialog' && failures-- > 0;
      const holdReply = method === 'Page.handleJavaScriptDialog' && delayNext;
      if (holdReply) delayNext = false;
      const request = original(method, rejectRequest ? { accept: 'invalid' } : params, sessionId)
        .then(async result => {
          if (holdReply) {
            const released = new Promise<void>(resolve => { releaseReply = resolve; });
            replyReached!();
            await released;
          }
          return result;
        }, error => {
          if (rejectRequest) protocolErrors.push(error.message);
          throw error;
        });
      commands.add(request);
      void request.then(() => commands.delete(request), () => commands.delete(request));
      return request;
    };

    return {
      async open(message: string) {
        const opened = new Promise<void>(resolve => {
          const listener = (_event: unknown, method: string) => {
            if (method !== 'Page.javascriptDialogOpening') return;
            contents.debugger.removeListener('message', listener);
            resolve();
          };
          contents.debugger.on('message', listener);
        });
        void contents.executeJavaScript(`window.answer = confirm(${JSON.stringify(message)})`);
        await opened;
      },
      failNext(count: number) { failures = count; },
      async advance(ms: number) {
        now += ms;
        for (const [key, timer] of [...timers]) {
          if (timer.at > now) continue;
          timers.delete(key);
          timer.callback();
        }
        await Promise.allSettled([...commands]);
        await Promise.resolve();
      },
      read: () => host.performBrowserAutomation('get_dialog', args),
      dismiss: () => host.performBrowserAutomation('handle_dialog', { ...args, action: 'dismiss' }),
      errors: () => protocolErrors,
      pageAnswer: () => contents.executeJavaScript('window.answer'),
      async holdAnswer() {
        delayNext = true;
        const reached = new Promise<void>(resolve => { replyReached = resolve; });
        delayedAnswer = host.performBrowserAutomation('handle_dialog', { ...args, action: 'dismiss' });
        await reached;
      },
      async releaseAnswer() { releaseReply!(); await delayedAnswer; },
      async takeControl() {
        const phase = await host.browserDispatch(null, 'browser_control', { id, action: 'take' });
        return { phase, attached: contents.debugger.isAttached() };
      },
      close() {
        host.browserDispatch(null, 'browser_close', { id });
        host.__testing.setClock();
      },
    };
  }, url);
}

let app: ElectronApplication | undefined;
let dataRoot: ElectronDataRoot | undefined;
let server: Server | undefined;
let probe: Awaited<ReturnType<typeof createProbe>> | undefined;

test.beforeEach(async () => {
  server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end('<!doctype html><button id="arm">Arm</button>');
  });
  await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected loopback address');
  const launched = await launchAbuElectron();
  app = launched.app;
  dataRoot = launched;
  const keepOpen = (page: Page) => page.on('dialog', () => {});
  app.on('window', keepOpen);
  for (const page of app.windows()) keepOpen(page);
  const page = await app.firstWindow();
  await expect(page.getByPlaceholder('想让阿布帮你做点什么？')).toBeVisible({ timeout: 45_000 });
  probe = await createProbe(app, `http://127.0.0.1:${address.port}`);
});

test.afterEach(async () => {
  if (probe) await probe.evaluate(value => value.close());
  probe = undefined;
  if (app) await closeAbuElectron(app);
  app = undefined;
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server!.close(error => error ? reject(error) : resolve()));
  }
  server = undefined;
  if (dataRoot) removeElectronDataRoot(dataRoot);
  dataRoot = undefined;
});

test('retries failed automatic cancellation and restores user control after the dialog closes', async () => {
  await probe!.evaluate(value => value.open('Cancel this operation'));
  await probe!.evaluate(value => value.failNext(2));
  for (let attempt = 0; attempt < 2; attempt++) {
    await probe!.evaluate(value => value.advance(60_000));
    expect((await probe!.evaluate(value => value.read())).pending).toBe(true);
  }
  expect(await probe!.evaluate(value => value.errors())).toHaveLength(2);
  await probe!.evaluate(value => value.advance(59_999));
  expect((await probe!.evaluate(value => value.read())).pending).toBe(true);
  await probe!.evaluate(value => value.advance(1));
  const result = await probe!.evaluate(value => value.read());
  expect(result.pending).toBe(false);
  expect(result.last.disposition).toBe('auto-dismissed');
  expect(await probe!.evaluate(value => value.pageAnswer())).toBe(false);
  expect(await probe!.evaluate(value => value.takeControl())).toEqual({ phase: 'human', attached: false });
});

test('a manual answer cancels the retry without shortening the next dialog deadline', async () => {
  await probe!.evaluate(value => value.open('First'));
  await probe!.evaluate(value => value.failNext(1));
  await probe!.evaluate(value => value.advance(60_000));
  await probe!.evaluate(value => value.dismiss());
  await probe!.evaluate(value => value.advance(30_000));
  await probe!.evaluate(value => value.open('Second'));
  await probe!.evaluate(value => value.advance(30_000));
  expect((await probe!.evaluate(value => value.read())).dialog.message).toBe('Second');
  await probe!.evaluate(value => value.advance(30_000));
  expect((await probe!.evaluate(value => value.read())).pending).toBe(false);
});

test('user takeover cancels a pending retry and releases the debugger', async () => {
  await probe!.evaluate(value => value.open('Cancel before takeover'));
  await probe!.evaluate(value => value.failNext(1));
  await probe!.evaluate(value => value.advance(60_000));
  expect((await probe!.evaluate(value => value.read())).pending).toBe(true);
  expect(await probe!.evaluate(value => value.takeControl())).toEqual({ phase: 'human', attached: false });
  await probe!.evaluate(value => value.advance(60_000));
  await expect(probe!.evaluate(value => value.read())).rejects.toThrow('The user has taken control');
  expect(await probe!.evaluate(value => value.pageAnswer())).toBe(false);
  expect(await probe!.evaluate(value => value.takeControl())).toEqual({ phase: 'human', attached: false });
});

for (const closeSecond of [false, true]) {
  test(`a delayed answer preserves the following dialog ${closeSecond ? 'history' : 'pending state'}`, async () => {
    await probe!.evaluate(value => value.open('First'));
    await probe!.evaluate(value => value.holdAnswer());
    await probe!.evaluate(value => value.open('Second'));
    if (closeSecond) await probe!.evaluate(value => value.dismiss());
    await probe!.evaluate(value => value.releaseAnswer());
    const result = await probe!.evaluate(value => value.read());
    expect(result.pending).toBe(!closeSecond);
    expect((closeSecond ? result.last : result.dialog).message).toBe('Second');
    if (!closeSecond) await probe!.evaluate(value => value.dismiss());
  });
}
