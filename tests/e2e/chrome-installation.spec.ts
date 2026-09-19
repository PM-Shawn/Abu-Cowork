import { expect, test } from '@playwright/test';
import { closeAbuElectron, dismissFirstRunOverlays, launchAbuElectron, removeElectronDataRoot } from './electronHelpers';

test('installation metadata drives Chrome settings independently of live connection', async () => {
  const launched = await launchAbuElectron();
  const { app } = launched;
  try {
    // Isolate Chrome metadata too: exercise real host parsing and IPC without
    // reading or changing the developer's Chrome profile or live extension.
    await app.evaluate((_, fixtureRoot) => {
      const os = process.getBuiltinModule('os');
      const fs = process.getBuiltinModule('fs');
      const path = process.getBuiltinModule('path');
      const originalRoot = process.platform === 'darwin'
        ? path.join(os.homedir(), 'Library', 'Application Support', 'Google', 'Chrome')
        : path.join(process.env.LOCALAPPDATA!, 'Google', 'Chrome', 'User Data');
      const isolatedRoot = path.join(fs.realpathSync(fixtureRoot), 'chrome-metadata');
      // Redirect only external Chrome metadata I/O. Keep home and application
      // resource resolution real, so installation folder checks remain valid.
      for (const method of ['lstat', 'readdir', 'open'] as const) {
        const original = fs.promises[method].bind(fs.promises);
        fs.promises[method] = ((file: string, ...args: unknown[]) => {
          // Hosted runners may have no Google/Chrome parent directories. Keep
          // ancestor checks isolated too; absence of a local Chrome install is
          // not the state this synthetic registration test is exercising.
          if (method === 'lstat' && typeof file === 'string'
            && file.startsWith(path.join(os.homedir(), 'Library') + path.sep)
            && originalRoot.startsWith(file + path.sep)) {
            return original(fs.realpathSync(fixtureRoot), ...args);
          }
          return original(typeof file === 'string' && (file === originalRoot || file.startsWith(originalRoot + path.sep))
            ? isolatedRoot + file.slice(originalRoot.length) : file, ...args);
        }) as typeof fs.promises[typeof method];
      }
      (globalThis as typeof globalThis & { chromeFixtureRoot: string }).chromeFixtureRoot = isolatedRoot;
    }, launched.rootDir);
    const page = await app.firstWindow();
    await expect(page.getByPlaceholder(/想让阿布帮你做点什么|What can Abu help/)).toBeVisible({ timeout: 45_000 });
    await dismissFirstRunOverlays(page);
    await page.getByRole('button', { name: /^(我|Me|登录 \/ 注册|Sign in \/ Sign up)$/ }).click();
    await page.getByRole('menuitem', { name: /^(设置|Settings)$/ }).click();
    await page.getByRole('button', { name: /^(能力|Capabilities)$/ }).click();
    await page.getByRole('button', { name: /^(我的 Chrome|My Chrome)/ }).click();
    await expect(page.getByText(/^(未安装扩展|Extension not installed)$/)).toBeVisible();
    await page.getByRole('button', { name: /^(安装扩展|Install extension)$/ }).click();
    await expect(page.getByText(/首次连接需要在 Chrome|Install the Abu extension in Chrome/)).toBeVisible();
    await expect(page.getByRole('button', { name: /^(检查连接|Check connection)$/ })).toHaveCount(0);
    await page.screenshot({ path: 'test-results/browser-alpha-chrome-install.png' });

    await app.evaluate(() => {
      const fs = process.getBuiltinModule('fs');
      const path = process.getBuiltinModule('path');
      const root = (globalThis as typeof globalThis & { chromeFixtureRoot: string }).chromeFixtureRoot;
      fs.mkdirSync(path.join(root, 'Default'), { recursive: true });
      fs.writeFileSync(path.join(root, 'Default', 'Preferences'), JSON.stringify({ extensions: { settings: {
        abu: { manifest: { name: 'Abu Browser Bridge', manifest_version: 3,
          background: { service_worker: 'background.js' }, action: { default_popup: 'popup.html' } } },
      } } }));
    });
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect(page.getByText(/^(已安装|Installed)$/)).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText(/首次连接需要在 Chrome|Install the Abu extension in Chrome/)).toHaveCount(0);
    await expect(page.getByText(/^(操作权限|Action permissions)$/)).toHaveCount(0);
    await page.screenshot({ path: 'test-results/browser-alpha-chrome-installed.png' });
  } finally {
    await closeAbuElectron(app);
    removeElectronDataRoot(launched);
  }
});
