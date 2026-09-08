/**
 * Black-box signed deployment regression, separate from the seven unsigned
 * install-loop cases. An opt-in private runner publishes real fixtures and
 * supplies a local Console endpoint with transport-level tampering on two of
 * them. No renderer/main network mocks or private implementation imports.
 */
import { expect, test } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import type { ElectronApplication, Page } from 'playwright';
import { closeAbuElectron, dismissFirstRunOverlays, launchAbuElectron, removeElectronDataRoot, type ElectronDataRoot } from './electronHelpers';

const url = process.env.ABU_E2E_SIGNED_CONSOLE_URL ?? '';
const email = process.env.ABU_E2E_CONSOLE_EMAIL ?? '';
const password = process.env.ABU_E2E_CONSOLE_PASSWORD ?? '';
const validName = process.env.ABU_E2E_SIGNED_VALID_PLUGIN ?? '';
const zipName = process.env.ABU_E2E_SIGNED_ZIP_PLUGIN ?? '';
const signatureName = process.env.ABU_E2E_SIGNED_SIGNATURE_PLUGIN ?? '';
const timeout = 60_000;
interface CatalogItem { name: string; latestVersion: string; sha256: string; signature: string | null }

function card(page: Page, name: string) {
  return page.getByTestId('enterprise-plugin-row').filter({ has: page.getByTitle(name, { exact: true }) });
}
function pluginRoot(root: ElectronDataRoot) {
  return path.join(root.appDataDir, 'Home', '.abu', 'plugin-packages');
}
function records(root: ElectronDataRoot): { name: string; version: string; checksum: string }[] {
  const file = path.join(pluginRoot(root), 'installed.json');
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : [];
}

async function bind(page: Page) {
  await page.waitForLoadState('domcontentloaded');
  await expect(page.getByText(/交给阿布就行啦|Leave it to Abu/).or(page.getByPlaceholder(/想让阿布帮你做点什么？|What can Abu help you with\?/)).first()).toBeVisible({ timeout });
  await dismissFirstRunOverlays(page);
  await page.getByRole('button', { name: /^(我|Me)$/ }).first().click();
  await page.getByRole('menuitem', { name: /^(设置|Settings)$/ }).click();
  await page.getByRole('button', { name: /^(企业模式|Enterprise)$/ }).click();
  await page.getByRole('button', { name: /^(切换到企业模式|Switch to enterprise mode)$/ }).click();
  await page.getByPlaceholder('https://abu.your-company.com').fill(url);
  await page.getByRole('button', { name: /^(继续|Continue)$/ }).click();
  await page.getByPlaceholder('you@company.com').fill(email);
  await page.getByPlaceholder(/^(输入密码|Enter password)$/).fill(password);
  await page.getByRole('button', { name: /^(登录|Sign in)$/ }).click();
  await expect(page.getByText(/已绑定到企业实例|Connected to enterprise instance/)).toBeVisible({ timeout });
  await page.keyboard.press('Escape');
  await page.getByLabel('Main navigation').getByRole('button', { name: /^(扩展|Extensions)$/ }).click();
  await page.getByRole('main').getByRole('button', { name: /^(插件|Plugins)$/ }).click();
  await page.getByTestId('extensions-source-market').click();
}

test.describe.serial('signed organization plugin distribution (real Electron)', () => {
  test.skip(!url || !email || !password || !validName || !zipName || !signatureName,
    'run with a signed Console and the opt-in private transport fixture runner');
  let app: ElectronApplication;
  let page: Page;
  let dataRoot: ElectronDataRoot;
  let valid: CatalogItem;

  test.beforeAll(async () => {
    const login = await fetch(`${url}/api/client/v1/auth/password`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }),
    });
    expect(login.ok).toBe(true);
    const { access_token: token } = await login.json() as { access_token: string };
    const headers = { authorization: `Bearer ${token}` };
    const session = await fetch(`${url}/api/client/v1/session`, { headers });
    expect(session.ok).toBe(true);
    expect((await session.json()).signing.skillPublicKey).toMatch(/^[0-9a-f]{64}$/);
    const catalog = await fetch(`${url}/api/skills/catalog?kinds=plugin`, { headers });
    expect(catalog.ok).toBe(true);
    const { items } = await catalog.json() as { items: CatalogItem[] };
    const found = items.find(item => item.name === validName);
    expect(found).toBeDefined();
    valid = found!;
    expect(valid.signature).toMatch(/^[A-Za-z0-9_-]{86}$/);
    const launched = await launchAbuElectron();
    dataRoot = launched; app = launched.app; page = await app.firstWindow();
    await bind(page);
  });
  test.afterAll(async () => {
    if (app) await closeAbuElectron(app);
    if (dataRoot) removeElectronDataRoot(dataRoot);
  });

  test('uses the advertised key, confirms a signed artifact and installs its files and record', async () => {
    await card(page, validName).getByRole('button', { name: '安装', exact: true }).click();
    const dialog = page.getByTestId('plugin-install-disclosure');
    await expect(page.getByTestId('plugin-install-confirm')).toBeVisible({ timeout });
    // This warning is driven by the actual verifier result, not catalog metadata.
    await expect(dialog.getByTestId('plugin-disclosure-unsigned')).toHaveCount(0);
    await expect(dialog).not.toContainText('未签名');
    await page.screenshot({ path: 'test-results/e2e-enterprise-signed-disclosure.png' });
    await page.getByTestId('plugin-install-confirm').click();
    await expect(dialog).toBeHidden({ timeout });
    const installed = path.join(pluginRoot(dataRoot), 'enterprise', validName, valid.latestVersion);
    await expect.poll(() => fs.existsSync(path.join(installed, '.abu-plugin', 'plugin.json')) &&
      fs.existsSync(path.join(installed, 'skills', 'signing-fixture', 'SKILL.md')), { timeout }).toBe(true);
    expect(records(dataRoot).find(item => item.name === validName)).toMatchObject({ version: valid.latestVersion, checksum: valid.sha256 });
    await expect.poll(() => fs.existsSync(path.join(pluginRoot(dataRoot), 'enterprise', '.staging', validName)), { timeout }).toBe(false);
    await expect(card(page, validName)).toContainText('已安装');
  });

  for (const [name, reason] of [[zipName, 'sha256_mismatch'], [signatureName, 'signature_invalid']]) {
    test(`rejects ${reason} without a plugin directory, staging tree or install record`, async () => {
      await card(page, name).getByRole('button', { name: '安装', exact: true }).click();
      const dialog = page.getByTestId('plugin-install-disclosure');
      await expect(page.getByRole('main').getByText(reason, { exact: false })).toBeVisible({ timeout });
      await expect(dialog).toHaveCount(0);
      await expect(page.getByTestId('plugin-install-confirm')).toHaveCount(0);
      expect(fs.existsSync(path.join(pluginRoot(dataRoot), 'enterprise', name))).toBe(false);
      expect(fs.existsSync(path.join(pluginRoot(dataRoot), 'enterprise', '.staging', name))).toBe(false);
      expect(records(dataRoot).some(item => item.name === name)).toBe(false);
      await page.screenshot({ path: `test-results/e2e-enterprise-${reason}.png` });
    });
  }
});
