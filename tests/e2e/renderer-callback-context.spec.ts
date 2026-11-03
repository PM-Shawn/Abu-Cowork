import path from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { test, expect, type Page } from '@playwright/test';
import { closeAbuElectron, launchAbuElectron, removeElectronDataRoot } from './electronHelpers';

interface Acceptance {
  create(gui: boolean, registered?: boolean): Promise<number>;
  context(id: number): string;
  registrations(id: number): { id: number; mainFrame: boolean }[];
  resources(id: number): { shortcut: boolean; destroyedListeners: number; watchesOpened: number; watchesClosed: number };
  watchPath(): string;
  subscriptions(id: number): string[];
  deliver(id: number, contextId: string, value: string, remove?: boolean): void;
  emit(id: number, value: string): number;
  startNavigation(id: number, url: string): void;
  cancelNavigation(id: number): Promise<void>;
  startHeldNavigation(id: number, url: string): void;
  finishNavigation(): Promise<void>;
  verifySuspendedInvokes(id: number): Promise<void>;
  errorPage(id: number): Promise<void>;
  crash(id: number): Promise<void>;
  destroy(id: number): void;
}

declare global {
  var __abuCallbackContextAcceptance: Acceptance;
}

async function listen(page: Page, gui: boolean) {
  await page.evaluate(async useGui => {
    const scope = window as unknown as {
      received: string[];
      __TAURI__: { event: { listen: (event: string, callback: (event: { payload: string }) => void) => Promise<unknown> } };
      __TAURI_INTERNALS__: { transformCallback: (callback: (event: { payload: string }) => void) => number; invoke: (cmd: string, args: unknown) => Promise<unknown> };
    };
    scope.received = [];
    const callback = (event: { payload: string }) => scope.received.push(event.payload);
    if (useGui) await scope.__TAURI__.event.listen('computer-use-status', callback);
    else {
      const handler = scope.__TAURI_INTERNALS__.transformCallback(callback);
      await scope.__TAURI_INTERNALS__.invoke('plugin:event|listen', { event: 'computer-use-status', handler });
    }
  }, gui);
}

for (const gui of [false, true]) {
  test(`${gui ? 'GUI' : 'main'} callbacks retain document ownership across reload and cancelled navigation`, async () => {
    const launched = await launchAbuElectron(undefined, {
      mainProcessPreload: path.resolve('tests/e2e/callbackContextLifecycle.cjs'),
    });
    let id: number | undefined;
    const server = createServer();
    try {
      id = await launched.app.evaluate(async (_, useGui) => globalThis.__abuCallbackContextAcceptance.create(useGui), gui);
      await expect.poll(() => launched.app.windows().some(page => page.url().includes('/callback-context.html'))).toBe(true);
      const page = launched.app.windows().find(candidate => candidate.url().includes('/callback-context.html'))!;
      await listen(page, gui);
      const first = await launched.app.evaluate((_, windowId) => globalThis.__abuCallbackContextAcceptance.context(windowId), id);
      expect(first).toBeTruthy();
      await page.reload();
      const second = await launched.app.evaluate((_, windowId) => globalThis.__abuCallbackContextAcceptance.context(windowId), id);
      expect(second).not.toBe(first);
      expect(await launched.app.evaluate((_, windowId) => globalThis.__abuCallbackContextAcceptance.subscriptions(windowId), id)).toEqual([]);
      await listen(page, gui);
      await launched.app.evaluate((_, { windowId, oldContext, currentContext }) => {
        const bridge = globalThis.__abuCallbackContextAcceptance;
        bridge.deliver(windowId, oldContext, 'stale');
        bridge.deliver(windowId, oldContext, 'stale removal', true);
        bridge.deliver(windowId, currentContext, 'current');
      }, { windowId: id, oldContext: first, currentContext: second });
      const received = () => page.evaluate(() => (window as unknown as { received: string[] }).received);
      await expect.poll(received).toEqual(['current']);
      await page.evaluate(() => { history.pushState({}, '', '#same-document'); });
      expect(await launched.app.evaluate((_, windowId) => globalThis.__abuCallbackContextAcceptance.context(windowId), id)).toBe(second);

      await page.evaluate(() => {
        const frame = document.createElement('iframe');
        frame.src = location.href;
        document.body.appendChild(frame);
      });
      await expect.poll(() => launched.app.evaluate((_, windowId) => globalThis.__abuCallbackContextAcceptance.registrations(windowId).some(entry => !entry.mainFrame), id!)).toBe(true);
      expect(await page.frames().at(-1)!.evaluate(() => '__TAURI_INTERNALS__' in window || '__TAURI__' in window)).toBe(false);
      expect(await launched.app.evaluate((_, windowId) => globalThis.__abuCallbackContextAcceptance.context(windowId), id)).toBe(second);

      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      const address = server.address();
      expect(address && typeof address !== 'string').toBeTruthy();
      const port = (address as { port: number }).port;
      const requested = once(server, 'request');
      await launched.app.evaluate((_, { windowId, url }) => globalThis.__abuCallbackContextAcceptance.startNavigation(windowId, url), { windowId: id, url: `http://127.0.0.1:${port}/held` });
      const [, response] = await requested;
      await launched.app.evaluate((_, windowId) => globalThis.__abuCallbackContextAcceptance.cancelNavigation(windowId), id);
      response.end();
      expect(await launched.app.evaluate((_, windowId) => globalThis.__abuCallbackContextAcceptance.context(windowId), id)).toBe(second);
      expect(await launched.app.evaluate((_, windowId) => globalThis.__abuCallbackContextAcceptance.subscriptions(windowId), id)).toEqual(['computer-use-status']);
      expect(await launched.app.evaluate((_, windowId) => globalThis.__abuCallbackContextAcceptance.emit(windowId, 'after cancellation'), id)).toBe(1);
      await expect.poll(received).toEqual(['current', 'after cancellation']);
      await Promise.all([
        page.waitForEvent('load'),
        launched.app.evaluate((_, windowId) => globalThis.__abuCallbackContextAcceptance.errorPage(windowId), id),
      ]);
      await expect.poll(() => launched.app.evaluate((_, windowId) => globalThis.__abuCallbackContextAcceptance.subscriptions(windowId), id!)).toEqual([]);
      expect(await launched.app.evaluate((_, windowId) => globalThis.__abuCallbackContextAcceptance.context(windowId), id)).not.toBe(second);
      await expect(page.evaluate(async useGui => {
        const scope = window as unknown as {
          __TAURI__: { event: { emit: (event: string) => Promise<unknown> } };
          __TAURI_INTERNALS__: { invoke: (cmd: string, args: unknown) => Promise<unknown> };
        };
        return useGui
          ? scope.__TAURI__.event.emit('computer-use-abort')
          : scope.__TAURI_INTERNALS__.invoke('get_trigger_server_port', {});
      }, gui)).rejects.toThrow(/registered privileged page/);
    } finally {
      server.closeAllConnections();
      if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
      if (id !== undefined) await launched.app.evaluate((_, windowId) => globalThis.__abuCallbackContextAcceptance.destroy(windowId), id);
      await closeAbuElectron(launched.app);
      removeElectronDataRoot(launched);
    }
  });
}

test('renderer replacement and termination release native callback resources', async () => {
  const launched = await launchAbuElectron(undefined, { mainProcessPreload: path.resolve('tests/e2e/callbackContextLifecycle.cjs') });
  let id: number | undefined;
  try {
    id = await launched.app.evaluate(() => globalThis.__abuCallbackContextAcceptance.create(false));
    await expect.poll(() => launched.app.windows().some(page => page.url().includes('/callback-context.html'))).toBe(true);
    const page = launched.app.windows().find(candidate => candidate.url().includes('/callback-context.html'))!;
    const watchPath = await launched.app.evaluate(() => globalThis.__abuCallbackContextAcceptance.watchPath());
    for (const ending of ['reload', 'crash'] as const) {
      const baseline = await launched.app.evaluate((_, windowId) => globalThis.__abuCallbackContextAcceptance.resources(windowId), id);
      await page.evaluate(async file => {
        const bridge = (window as unknown as { __TAURI_INTERNALS__: { transformCallback: (fn: () => void) => number; invoke: (cmd: string, args: unknown) => Promise<unknown> } }).__TAURI_INTERNALS__;
        const callback = bridge.transformCallback(() => {});
        await bridge.invoke('plugin:fs|watch', { paths: [file], options: {}, onEvent: `__CHANNEL__:${callback}` });
        await bridge.invoke('plugin:global-shortcut|register', { shortcuts: ['CommandOrControl+Shift+F20'], handler: `__CHANNEL__:${callback}` });
      }, watchPath);
      const active = await launched.app.evaluate((_, windowId) => globalThis.__abuCallbackContextAcceptance.resources(windowId), id);
      expect(active.shortcut).toBe(true);
      expect(active.watchesOpened).toBe(baseline.watchesOpened + 1);
      expect(active.destroyedListeners).toBeGreaterThan(baseline.destroyedListeners);
      if (ending === 'reload') await page.reload();
      else await launched.app.evaluate((_, windowId) => globalThis.__abuCallbackContextAcceptance.crash(windowId), id);
      const cleared = await launched.app.evaluate((_, windowId) => globalThis.__abuCallbackContextAcceptance.resources(windowId), id);
      expect(cleared.shortcut).toBe(false);
      expect(cleared.destroyedListeners).toBeLessThan(active.destroyedListeners);
      await expect.poll(() => launched.app.evaluate((_, windowId) => globalThis.__abuCallbackContextAcceptance.resources(windowId).watchesClosed, id!)).toBe(active.watchesOpened);
    }
  } finally {
    if (id !== undefined) await launched.app.evaluate((_, windowId) => globalThis.__abuCallbackContextAcceptance.destroy(windowId), id);
    await closeAbuElectron(launched.app);
    removeElectronDataRoot(launched);
  }
});

test('actual host dispatch rejects suspended registrations and removals from a replaced context', async () => {
  const launched = await launchAbuElectron(undefined, { mainProcessPreload: path.resolve('tests/e2e/callbackContextLifecycle.cjs') });
  let id: number | undefined;
  try {
    id = await launched.app.evaluate(() => globalThis.__abuCallbackContextAcceptance.create(false));
    await launched.app.evaluate((_, windowId) => globalThis.__abuCallbackContextAcceptance.verifySuspendedInvokes(windowId), id);
  } finally {
    if (id !== undefined) await launched.app.evaluate((_, windowId) => globalThis.__abuCallbackContextAcceptance.destroy(windowId), id);
    await closeAbuElectron(launched.app);
    removeElectronDataRoot(launched);
  }
});

test('a listener registered by the old document during navigation is released on document replacement', async () => {
  const launched = await launchAbuElectron(undefined, { mainProcessPreload: path.resolve('tests/e2e/callbackContextLifecycle.cjs') });
  let id: number | undefined;
  const server = createServer();
  try {
    id = await launched.app.evaluate(() => globalThis.__abuCallbackContextAcceptance.create(false));
    await expect.poll(() => launched.app.windows().some(page => page.url().includes('/callback-context.html'))).toBe(true);
    const page = launched.app.windows().find(candidate => candidate.url().includes('/callback-context.html'))!;
    await page.evaluate(() => {
      const bridge = (window as unknown as { __TAURI_INTERNALS__: { transformCallback: (fn: () => void) => number; invoke: (cmd: string, args: unknown) => Promise<unknown> } }).__TAURI_INTERNALS__;
      bridge.transformCallback(() => {
        const handler = bridge.transformCallback(() => {});
        void bridge.invoke('plugin:event|listen', { event: 'im-inbound-event', handler });
      });
    });
    const oldUrl = page.url();
    const first = await launched.app.evaluate((_, windowId) => globalThis.__abuCallbackContextAcceptance.context(windowId), id);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const port = (server.address() as { port: number }).port;
    const requested = once(server, 'request');
    await launched.app.evaluate((_, { windowId, url }) => globalThis.__abuCallbackContextAcceptance.startHeldNavigation(windowId, url), { windowId: id, url: `http://127.0.0.1:${port}/replacement` });
    const [, response] = await requested;
    await launched.app.evaluate((_, { windowId, contextId }) => globalThis.__abuCallbackContextAcceptance.deliver(windowId, contextId, 'continue registration'), { windowId: id, contextId: first });
    await expect.poll(() => launched.app.evaluate((_, windowId) => globalThis.__abuCallbackContextAcceptance.subscriptions(windowId), id!)).toEqual(['im-inbound-event']);
    expect(page.url()).toBe(oldUrl);
    response.writeHead(200, { 'Content-Type': 'text/html' });
    response.end('<!doctype html><title>Replacement</title>');
    await launched.app.evaluate(() => globalThis.__abuCallbackContextAcceptance.finishNavigation());
    expect(await launched.app.evaluate((_, windowId) => globalThis.__abuCallbackContextAcceptance.context(windowId), id)).not.toBe(first);
    expect(await launched.app.evaluate((_, windowId) => globalThis.__abuCallbackContextAcceptance.subscriptions(windowId), id)).toEqual([]);
  } finally {
    server.closeAllConnections();
    if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
    if (id !== undefined) await launched.app.evaluate((_, windowId) => globalThis.__abuCallbackContextAcceptance.destroy(windowId), id);
    await closeAbuElectron(launched.app);
    removeElectronDataRoot(launched);
  }
});

test('an unregistered native window cannot initialize the privileged callback bridge', async () => {
  const launched = await launchAbuElectron(undefined, { mainProcessPreload: path.resolve('tests/e2e/callbackContextLifecycle.cjs') });
  let id: number | undefined;
  try {
    id = await launched.app.evaluate(() => globalThis.__abuCallbackContextAcceptance.create(false, false));
    await expect.poll(() => launched.app.windows().some(page => page.url().includes('/callback-context.html'))).toBe(true);
    const page = launched.app.windows().find(candidate => candidate.url().includes('/callback-context.html'))!;
    expect(await page.evaluate(() => '__TAURI_INTERNALS__' in window)).toBe(false);
    expect(await launched.app.evaluate((_, windowId) => globalThis.__abuCallbackContextAcceptance.subscriptions(windowId), id)).toEqual([]);
  } finally {
    if (id !== undefined) await launched.app.evaluate((_, windowId) => globalThis.__abuCallbackContextAcceptance.destroy(windowId), id);
    await closeAbuElectron(launched.app);
    removeElectronDataRoot(launched);
  }
});
