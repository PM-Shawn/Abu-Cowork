import { expect, test } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ElectronApplication, Page } from 'playwright';
import {
  closeAbuElectron,
  dismissFirstRunOverlays,
  launchAbuElectron,
  removeElectronDataRoot,
  REPO_ROOT,
  type ElectronDataRoot,
} from './electronHelpers';

/**
 * The plugin loop in the real Electron shell: open Extensions → 插件, add a
 * marketplace directory, read the install disclosure, install, see the plugin
 * listed, uninstall, see it gone.
 *
 * Unit tests mock the filesystem. This is the only place that proves the
 * renderer's plugin-fs calls clear Electron's capability scope
 * (`assertAllowed`) — in particular that the manifest's **dot-directory**
 * (`.abu-plugin/`) survives the copy. The skill installer's dotfile-skipping
 * copy would have dropped it silently, producing an installed package with no
 * manifest that only fails later, at use time.
 */

const READY_TIMEOUT = 45_000;
const SCREENSHOT_DIR = path.join(REPO_ROOT, 'test-results');

/**
 * Plugin install root inside the ISOLATED E2E home. `launchAbuElectron`
 * redirects `homeDir()` to `<appDataDir>/Home` (electron/main.cjs), so installs
 * land there, not in the developer's real ~/.abu — the whole run is torn down
 * by `removeElectronDataRoot`, so no manual cleanup is needed.
 */
function installRoot(dataRoot: ElectronDataRoot): string {
  return path.join(dataRoot.appDataDir, 'Home', '.abu', 'plugin-packages');
}

const WELCOME = /交给阿布就行啦|Leave it to Abu/;
const CHAT_PLACEHOLDER = /^(想让阿布帮你做点什么？|What can Abu help you with\?)$/;
const EXTENSIONS = /^(扩展|Extensions)$/;
const PLUGINS_TAB = /^(插件|Plugins)$/;
const INSTALL = /^(安装|Install)$/;
const UNINSTALL = /^(卸载|Uninstall)$/;
const UNINSTALL_TITLE = /^(卸载插件|Uninstall plugin)$/;
const MINE_EMPTY = /还没有你自己开发的插件|No plugins of your own yet/;


/** A self-contained marketplace + plugin written to a temp dir for this run. */
function seedMarketplace(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'abu-e2e-market-'));
  const pkg = path.join(dir, 'plugins', 'e2e-weather');

  fs.mkdirSync(path.join(dir, '.claude-plugin'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, '.claude-plugin', 'marketplace.json'),
    JSON.stringify({
      name: 'e2e-market',
      owner: { name: 'E2E' },
      plugins: [
        {
          name: 'e2e-weather',
          description: 'Weather helper used by the plugin E2E',
          category: 'utilities',
          source: './plugins/e2e-weather',
        },
      ],
    }),
  );

  // The manifest lives in a dot-directory on purpose — see the file header.
  fs.mkdirSync(path.join(pkg, '.abu-plugin'), { recursive: true });
  fs.writeFileSync(
    path.join(pkg, '.abu-plugin', 'plugin.json'),
    JSON.stringify({
      name: 'e2e-weather',
      version: '1.0.0',
      description: 'Weather helper',
      mcpServers: { forecast: { command: 'npx', args: ['-y', 'weather-mcp'] } },
    }),
  );
  fs.mkdirSync(path.join(pkg, 'skills', 'today'), { recursive: true });
  fs.writeFileSync(
    path.join(pkg, 'skills', 'today', 'SKILL.md'),
    '---\nname: today\ndescription: today\n---\nbody\n',
  );

  return dir;
}

async function waitForWelcomeScreen(page: Page): Promise<void> {
  await page.waitForLoadState('domcontentloaded');
  await expect(
    page.getByText(WELCOME).or(page.getByPlaceholder(CHAT_PLACEHOLDER)).first(),
  ).toBeVisible({ timeout: READY_TIMEOUT });
}

async function openPluginsTab(page: Page): Promise<void> {
  // Extensions is reachable straight from the sidebar. It reopens on whatever
  // tab was last active, so select the Plugins tab explicitly rather than
  // assuming. Scope the sidebar entry to the navigation region and the tab to
  // the panel so neither can match the other by accident.
  await page.getByLabel('Main navigation').getByRole('button', { name: EXTENSIONS }).click();
  // The plugin page carries no separate title heading — it matches the original
  // toolbox layout, where the tabs are the header. Wait on the panel's own
  // Plugins tab button, then select it.
  const panel = page.getByRole('main');
  await expect(panel.getByRole('button', { name: PLUGINS_TAB })).toBeVisible({
    timeout: READY_TIMEOUT,
  });
  await panel.getByRole('button', { name: PLUGINS_TAB }).click();
  // 市场 | 我的 replaced the old 已安装 / 插件市场 sub-tabs: installed plugins
  // are now shown in place inside 市场, and 我的 lists only what the user wrote.
  await page.getByTestId('extensions-source-market').click();
}

test.describe('plugin install loop', () => {
  let dataRoot: ElectronDataRoot;
  let app: ElectronApplication;
  let page: Page;
  let marketDir: string;

  test.beforeAll(async () => {
    marketDir = seedMarketplace();
    const launched = await launchAbuElectron();
    dataRoot = launched;
    app = launched.app;
    page = await app.firstWindow();
    await waitForWelcomeScreen(page);
    await dismissFirstRunOverlays(page);
  });

  test.afterAll(async () => {
    if (app) await closeAbuElectron(app);
    if (dataRoot) removeElectronDataRoot(dataRoot);
    if (marketDir) fs.rmSync(marketDir, { recursive: true, force: true });
  });

  test('installs from a local marketplace, keeps the manifest, and uninstalls', async () => {
    await openPluginsTab(page);

    // --- add the marketplace -------------------------------------------------
    // Opener testid differs by state: the empty-state CTA when no market exists,
    // the top-bar button once one does. The built-in abu-official is preloaded,
    // so in practice it's the top-bar opener.
    await page.getByTestId('plugin-add-marketplace-cta').or(
      page.getByTestId('plugin-add-marketplace-open'),
    ).first().click();
    await page.getByTestId('plugin-marketplace-dir-input').fill(marketDir);
    await page.getByTestId('plugin-marketplace-submit').click();

    // A freshly added market is auto-selected, so its entries are what shows.
    const entry = page.getByTestId('plugin-marketplace-entry')
      .filter({ hasText: 'e2e-weather' }).first();
    await expect(entry).toBeVisible({ timeout: READY_TIMEOUT });

    // --- disclosure must name the executable before anything is installed ----
    await entry.getByText(INSTALL).first().click();
    const disclosure = page.getByTestId('plugin-install-disclosure');
    await expect(disclosure).toBeVisible({ timeout: READY_TIMEOUT });
    // The whole point of the screen: the user sees the command that will run.
    await expect(page.getByTestId('plugin-disclosure-server').first()).toContainText('npx');
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'e2e-plugin-disclosure.png') });

    await page.getByTestId('plugin-install-confirm').click();

    // --- installed, on real disk, manifest intact ---------------------------
    // NOTE: the plugin root is derived from `homeDir()`, which this harness
    // does NOT redirect (`ElectronDataRoot` only moves userData/appData). So
    // the install genuinely lands in the developer's ~/.abu — hence the
    // distinctive `e2e-` names and the afterAll cleanup below.
    const pkgDir = path.join(installRoot(dataRoot), 'e2e-market', 'e2e-weather', '1.0.0');
    // The copy lands file by file, and this probe watches it from *outside* the
    // process, so both expected artifacts must be in the poll: `.abu-plugin/`
    // (a dot-directory) is copied before `skills/`, so a poll that waits only
    // on the manifest can resolve mid-copy and then find `SKILL.md` not yet
    // written. Poll the whole postcondition — manifest dot-directory intact AND
    // the skill file present — so a partially-copied snapshot never passes.
    const manifestPath = path.join(pkgDir, '.abu-plugin', 'plugin.json');
    const skillPath = path.join(pkgDir, 'skills', 'today', 'SKILL.md');
    await expect
      .poll(() => fs.existsSync(manifestPath) && fs.existsSync(skillPath), {
        timeout: READY_TIMEOUT,
      })
      .toBe(true);

    // The installed plugin stays on its market row — no separate 已安装 tab —
    // and swaps its install button for the `···` menu.
    await expect(entry.getByTestId('plugin-item-menu')).toBeVisible({ timeout: READY_TIMEOUT });
    await expect(entry.getByText(INSTALL)).toHaveCount(0);
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'e2e-plugin-installed.png') });

    // --- uninstall removes the package from disk ----------------------------
    await entry.getByTestId('plugin-item-menu').click();
    await page.getByTestId('plugin-item-menu-uninstall').click();
    // ConfirmDialog renders a portal without role="dialog", so anchor on its
    // title. The menu is closed by now, and its items claim role="menuitem"
    // rather than button, so this exact-name button match hits only the dialog.
    await expect(page.getByText(UNINSTALL_TITLE)).toBeVisible({ timeout: READY_TIMEOUT });
    await page.getByRole('button', { name: UNINSTALL }).click();

    await expect.poll(() => fs.existsSync(pkgDir), { timeout: READY_TIMEOUT }).toBe(false);

    // The row returns to offering an install rather than disappearing.
    await expect(entry.getByText(INSTALL).first()).toBeVisible({ timeout: READY_TIMEOUT });
    await expect(entry.getByTestId('plugin-item-menu')).toHaveCount(0);

    // --- 我的 lists authored plugins only -----------------------------------
    // Nothing is installed at all now, so 我的 shows its own empty state — not
    // "no matches", and not a marketplace pitch.
    await page.getByTestId('extensions-source-mine').click();
    await expect(page.getByText(MINE_EMPTY)).toBeVisible({ timeout: READY_TIMEOUT });
  });
});
