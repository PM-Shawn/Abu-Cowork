import { expect, test } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ElectronApplication, Page } from 'playwright';
import {
  closeAbuElectron,
  terminateAbuElectron,
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
const EXTENSIONS = /^(扩展|Extensions)(\s.*)?$/;
const PLUGINS_TAB = /^(插件|Plugins)(\s.*)?$/;
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
        ...Array.from({ length: 30 }, (_, index) => ({
          name: `preview-${String(index).padStart(2, '0')}`,
          description: index % 2 ? 'A longer description that spans several lines in a narrow card, keeping disclosure metadata independently visible.' : 'Short description',
          category: 'utilities',
          version: '1.0.0',
          source: './plugins/e2e-weather',
        })),
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
      mcpServers: { forecast: { command: 'abu-e2e-offline-connector', args: [] } },
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
  // My and Market are vertically stacked sections, without a nested tab.
}

async function openAddMarketplace(page: Page): Promise<void> {
  await page.getByTestId('plugin-create-trigger').click();
  await page.getByTestId('plugin-create-menu').getByRole('button', { name: /添加插件市场|Add marketplace/ }).click();
}

test('loads custom skill directories and standalone MCP configuration in Electron', async () => {
  const marketDir = seedMarketplace();
  const pkg = path.join(marketDir, 'plugins', 'e2e-weather');
  // Only this fixture is changed; the existing legacy-inline journey remains.
  fs.rmSync(path.join(pkg, '.abu-plugin'), { recursive: true });
  fs.mkdirSync(path.join(pkg, '.codex-plugin'));
  fs.writeFileSync(path.join(pkg, '.codex-plugin', 'plugin.json'), JSON.stringify({
    name: 'e2e-weather', version: '1.0.0', skills: './extras', mcpServers: './.mcp.json',
  }));
  fs.writeFileSync(path.join(pkg, '.mcp.json'), JSON.stringify({ mcp_servers: {
    'e2e-config-server': { command: 'abu-e2e-must-not-run', args: ['--stdio'], env: { REGION: 'cn east', OPTIONAL: '' } },
  } }));
  fs.mkdirSync(path.join(pkg, 'extras', 'custom'), { recursive: true });
  fs.writeFileSync(path.join(pkg, 'extras', 'custom', 'SKILL.md'), '---\nname: e2e-custom-skill\ndescription: From the declared extras directory\n---\n\nFixture body.\n');

  let launched: Awaited<ReturnType<typeof launchAbuElectron>> | undefined;
  try {
    launched = await launchAbuElectron();
    const page = await launched.app.firstWindow();
    await waitForWelcomeScreen(page);
    await dismissFirstRunOverlays(page);
    await openPluginsTab(page);
    await openAddMarketplace(page);
    await page.getByTestId('plugin-marketplace-dir-input').fill(marketDir);
    await page.getByTestId('plugin-marketplace-submit').click();
    const entry = page.getByTestId('plugin-marketplace-entry').filter({ hasText: 'e2e-weather' }).first();
    await expect(entry).toBeVisible({ timeout: READY_TIMEOUT });
    // Verify the privileged service uses this application's isolated home
    // before allowing the UI to materialize any package.
    const prepared = await page.evaluate(async (dir) => {
      const shell = (window as unknown as { __ABU_SHELL__: {
        pluginSnapshot: (action: string, request: object) => Promise<{ token: string; packageDir: string }>;
      } }).__ABU_SHELL__;
      const snapshot = await shell.pluginSnapshot('prepare', { marketplaceDir: dir, marketplaceName: 'e2e-market', entryName: 'e2e-weather' });
      await shell.pluginSnapshot('release', { token: snapshot.token });
      return snapshot;
    }, marketDir);
    expect(prepared.packageDir.startsWith(path.join(launched.appDataDir, 'Home', '.abu', 'plugin-prepared') + path.sep)).toBe(true);
    await entry.getByRole('button', { name: /^(安装|Install): e2e-weather$/ }).click();
    const disclosure = page.getByTestId('plugin-install-disclosure');
    await expect(disclosure).toContainText('e2e-custom-skill');
    await expect(disclosure).toContainText('abu-e2e-must-not-run');
    // The source may change while the user is deciding. Confirmation must
    // consume the prepared bytes, including the original MCP command/skill.
    fs.writeFileSync(path.join(pkg, '.mcp.json'), JSON.stringify({ mcp_servers: {
      'e2e-config-server': { command: 'abu-e2e-changed-after-confirmation' },
    } }));
    fs.writeFileSync(path.join(pkg, 'extras', 'custom', 'SKILL.md'), '---\nname: e2e-mutated-after-preview\ndescription: Must not install\n---\n\nChanged body.\n');
    await expect(disclosure).not.toContainText('cn east');
    await page.getByTestId('plugin-install-confirm').click();
    await expect(disclosure).toBeHidden({ timeout: READY_TIMEOUT });

    const recordPath = path.join(installRoot(launched), 'installed.json');
    await expect.poll(() => fs.existsSync(recordPath)).toBe(true);
    const records = JSON.parse(fs.readFileSync(recordPath, 'utf8')) as Array<{ key: string; skillPaths?: string[]; componentLayoutVersion?: number }>;
    const installed = records.find(record => record.key === 'e2e-weather@e2e-market');
    expect(installed?.skillPaths).toEqual(['skills/today', 'extras/custom']);
    expect(installed?.componentLayoutVersion).toBe(1);

    const persisted = await page.evaluate(() => JSON.parse(localStorage.getItem('abu-mcp-store') ?? '{}'));
    expect(persisted.state.servers['e2e-config-server'].config).toMatchObject({
      enabled: true, command: 'abu-e2e-must-not-run', args: ['--stdio'], env: { REGION: 'cn east', OPTIONAL: '' },
    });
    await page.getByRole('main').getByRole('button', { name: /^(技能|Skills)$/ }).click();
    await expect(page.getByText('e2e-custom-skill', { exact: true })).toBeVisible({ timeout: READY_TIMEOUT });
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'e2e-plugin-custom-components.png') });

    const customCard = page.getByRole('button').filter({ has: page.getByText('e2e-custom-skill', { exact: true }) });
    await customCard.getByRole('switch').click();
    await expect(customCard.getByRole('switch')).toHaveAttribute('aria-checked', 'false');
    const childPreferences = await page.evaluate(() => JSON.parse(localStorage.getItem('abu-settings') ?? '{}').state.disabledSkills);
    await page.getByRole('main').getByRole('button', { name: PLUGINS_TAB }).click();
    await expect(entry.getByRole('switch')).toHaveAttribute('aria-checked', 'true');
    await entry.getByRole('switch').click();
    await expect(entry.getByRole('switch')).toHaveAttribute('aria-checked', 'false');
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem('abu-settings') ?? '{}').state.disabledSkills)).toEqual(childPreferences);
    await page.reload();
    await waitForWelcomeScreen(page);
    await openPluginsTab(page);
    await expect(entry.getByRole('switch')).toHaveAttribute('aria-checked', 'false', { timeout: READY_TIMEOUT });
    await page.getByRole('main').getByRole('button', { name: /^(技能|Skills)$/ }).click();
    await expect(customCard.getByRole('switch')).toHaveAttribute('aria-checked', 'false');
    await page.getByRole('main').getByRole('button', { name: PLUGINS_TAB }).click();
    await entry.getByRole('switch').click();
    await expect(entry.getByRole('switch')).toHaveAttribute('aria-checked', 'true');
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem('abu-settings') ?? '{}').state.disabledSkills)).toEqual(childPreferences);
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem('abu-mcp-store') ?? '{}').state.servers['e2e-config-server'].config.enabled)).toBe(true);
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'e2e-plugin-master-switch.png'), animations: 'disabled' });

    // Reload reconstructs discovery from the persisted layout, not from memory.
    await page.reload();
    await waitForWelcomeScreen(page);
    await openPluginsTab(page);
    await page.getByRole('main').getByRole('button', { name: /^(技能|Skills)$/ }).click();
    await expect(page.getByText('e2e-custom-skill', { exact: true })).toBeVisible({ timeout: READY_TIMEOUT });
    await page.getByRole('main').getByRole('button', { name: /^(连接器|Connectors)$/ }).click();
    await page.getByText('e2e-config-server', { exact: true }).click();
    await expect(page.getByTestId('mcp-server-toggle-connection')).toHaveAttribute('data-connected', 'false');
  } finally {
    if (launched) {
      await closeAbuElectron(launched.app);
      removeElectronDataRoot(launched);
    }
    fs.rmSync(marketDir, { recursive: true, force: true });
  }
});

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
    await openAddMarketplace(page);
    await page.getByTestId('plugin-marketplace-dir-input').fill(marketDir);
    await page.getByTestId('plugin-marketplace-submit').click();

    // A freshly added market is auto-selected, so its entries are what shows.
    const entry = page.getByTestId('plugin-marketplace-entry')
      .filter({ hasText: 'e2e-weather' }).first();
    await expect(entry).toBeVisible({ timeout: READY_TIMEOUT });

    // Different-height card rows must remain reachable through virtualization.
    // The accepted layout scrolls My and Market together in the page.
    const list = page.getByTestId('plugin-mine-group').locator('..');
    const lastCard = page.getByTestId('plugin-marketplace-entry').filter({ hasText: 'preview-29' });
    await expect.poll(async () => {
      await list.evaluate(element => { element.scrollTop = element.scrollHeight; });
      return lastCard.isVisible();
    }, { timeout: READY_TIMEOUT }).toBe(true);
    await list.evaluate(element => { element.scrollTop = 0; });
    await expect(entry).toBeVisible();
    await page.screenshot({ animations: 'disabled', path: path.join(SCREENSHOT_DIR, 'e2e-plugin-grid.png') });

    // --- disclosure must name the executable before anything is installed ----
    await entry.getByText(INSTALL).first().click();
    const disclosure = page.getByTestId('plugin-install-disclosure');
    await expect(disclosure).toBeVisible({ timeout: READY_TIMEOUT });
    // The whole point of the screen: the user sees the command that will run.
    await expect(page.getByTestId('plugin-disclosure-server').first()).toContainText('abu-e2e-offline-connector');
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'e2e-plugin-disclosure.png') });

    await page.getByTestId('plugin-install-confirm').click();

    // --- installed, on real disk, manifest intact ---------------------------
    // homeDir and the privileged snapshot host share the isolated E2E home.
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

    // Installation is reflected in place with the plugin's master switch.
    await expect(entry.getByRole('switch')).toHaveAttribute('aria-checked', 'true', { timeout: READY_TIMEOUT });
    await expect(entry.getByText(INSTALL)).toHaveCount(0);
    await expect(entry.getByTestId('plugin-item-menu')).toHaveCount(0);
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'e2e-plugin-installed.png') });

    // A relative source from a market does not establish local authorship.
    const mine = page.getByTestId('plugin-mine-group');
    await expect(mine).toContainText(MINE_EMPTY);
    await expect(mine).not.toContainText('e2e-weather');

    // Removing and reconnecting a source preserves the installation identity.
    await page.getByRole('button', { name: /^(移除市场|Remove marketplace)$/ }).click();
    await page.getByRole('button', { name: /^(移除市场|Remove marketplace)$/ }).last().click();
    const orphan = page.getByTestId('plugin-orphan-group');
    await expect(orphan).toContainText('e2e-weather');
    expect(fs.existsSync(manifestPath)).toBe(true);
    await openAddMarketplace(page);
    await page.getByTestId('plugin-marketplace-dir-input').fill(marketDir);
    await page.getByTestId('plugin-marketplace-submit').click();
    await expect(entry.getByRole('switch')).toHaveAttribute('aria-checked', 'true');
    await expect(orphan).toHaveCount(0);

    // --- uninstall removes the package from disk ----------------------------
    await entry.getByText('e2e-weather', { exact: true }).click();
    await expect(page.getByTestId('plugin-manage-dialog')).toBeVisible();
    await page.getByRole('button', { name: UNINSTALL }).click();
    await expect(page.getByText(UNINSTALL_TITLE)).toBeVisible({ timeout: READY_TIMEOUT });
    await page.getByRole('button', { name: UNINSTALL }).click();

    await expect.poll(() => fs.existsSync(pkgDir), { timeout: READY_TIMEOUT }).toBe(false);

    // The row returns to offering an install rather than disappearing.
    await expect(entry.getByText(INSTALL).first()).toBeVisible({ timeout: READY_TIMEOUT });
    await expect(entry.getByTestId('plugin-item-menu')).toHaveCount(0);
    await expect(entry.getByRole('switch')).toHaveCount(0);

    await expect(mine).toContainText(MINE_EMPTY);
  });
});

test('serializes registry mutations through the real Electron host without overwriting unrelated plugins', async () => {
  let launched: Awaited<ReturnType<typeof launchAbuElectron>> | undefined;
  try {
    launched = await launchAbuElectron();
    const page = await launched.app.firstWindow();
    await waitForWelcomeScreen(page);
    const home = fs.realpathSync(path.join(launched.appDataDir, 'Home'));
    const result = await page.evaluate(async profile => {
      const bridge = (window as unknown as { __ABU_SHELL__: {
        pluginRegistry: (action: string, request: object) => Promise<unknown>;
      } }).__ABU_SHELL__.pluginRegistry;
      const record = (name: string) => ({ key: `${name}@registry-e2e`, name, marketplace: 'registry-e2e', version: '1',
        installedAt: '2026-09-09T00:00:00.000Z', contributed: { skills: [], mcpServers: [], agents: [] } });
      await Promise.all(['a', 'b', 'c'].map(name => bridge('upsert', { home: profile, record: record(name) })));
      await Promise.all([
        bridge('remove', { home: profile, key: 'b@registry-e2e' }),
        bridge('upsert', { home: profile, record: { ...record('a'), version: '2' } }),
      ]);
      const raw = await bridge('read', { home: profile }) as string;
      const rejected = await bridge('read', { home: profile + '-outside' }).then(() => false, () => true);
      return { raw, rejected };
    }, home);
    expect(result.rejected).toBe(true);
    expect(JSON.parse(result.raw).map((record: { name: string; version: string }) => [record.name, record.version])).toEqual([['a', '2'], ['c', '1']]);
    const file = path.join(installRoot(launched), 'installed.json');
    expect(fs.readFileSync(file, 'utf8')).toBe(result.raw);
    await page.reload();
    await waitForWelcomeScreen(page);
    const reloaded = await page.evaluate(async profile => {
      const bridge = (window as unknown as { __ABU_SHELL__: {
        pluginRegistry: (action: string, request: object) => Promise<unknown>;
      } }).__ABU_SHELL__.pluginRegistry;
      return bridge('read', { home: profile });
    }, home);
    expect(reloaded).toBe(result.raw);
  } finally {
    if (launched) { await closeAbuElectron(launched.app); removeElectronDataRoot(launched); }
  }
});


test('recovers an interrupted same-version replacement before plugin activation on restart', async () => {
  const marketDir = seedMarketplace();
  const sourceAgent = path.join(marketDir, 'plugins/e2e-weather/agents/e2e-reviewer.md');
  fs.mkdirSync(path.dirname(sourceAgent), { recursive: true });
  fs.writeFileSync(sourceAgent, '---\nname: e2e-reviewer\ndescription: Review the local fixture\n---\nOriginal agent instructions.\n');
  let launched: Awaited<ReturnType<typeof launchAbuElectron>> | undefined;
  try {
    launched = await launchAbuElectron();
    let page = await launched.app.firstWindow();
    await waitForWelcomeScreen(page);
    await dismissFirstRunOverlays(page);
    await openPluginsTab(page);
    await openAddMarketplace(page);
    await page.getByTestId('plugin-marketplace-dir-input').fill(marketDir);
    await page.getByTestId('plugin-marketplace-submit').click();
    const entry = page.getByTestId('plugin-marketplace-entry').filter({ hasText: 'e2e-weather' }).first();
    await entry.getByRole('button', { name: /^(安装|Install): e2e-weather$/ }).click();
    await page.getByTestId('plugin-install-confirm').click();
    await expect(entry.getByRole('switch')).toHaveAttribute('aria-checked', 'true', { timeout: READY_TIMEOUT });
    const registry = path.join(installRoot(launched), 'installed.json');
    const previous = JSON.parse(fs.readFileSync(registry, 'utf8'))[0];
    const installedSkill = path.join(installRoot(launched), 'e2e-market/e2e-weather/1.0.0/skills/today/SKILL.md');
    const originalBody = fs.readFileSync(installedSkill, 'utf8');
    const installedAgent = path.join(launched.appDataDir, 'Home/.abu/agents/e2e-reviewer/AGENT.md');
    const originalAgent = fs.readFileSync(installedAgent, 'utf8');
    fs.appendFileSync(sourceAgent, '\nRevised agent instructions.\n');
    fs.writeFileSync(path.join(marketDir, 'plugins/e2e-weather/skills/today/SKILL.md'), originalBody + '\nNew revision.\n');
    // Stop at the real IPC boundary after files move but before commit/ack.
    await page.evaluate(async ({ marketDir, previous }) => {
      const shell = (window as unknown as { __ABU_SHELL__: {
        pluginSnapshot: (action: string, request: object) => Promise<{ token: string; checksum: string }>;
        pluginOperation: (action: string, request: object) => Promise<unknown>;
      } }).__ABU_SHELL__;
      const snapshot = await shell.pluginSnapshot('prepare', { marketplaceDir: marketDir, marketplaceName: 'e2e-market', entryName: 'e2e-weather' });
      const mcp = JSON.parse(localStorage.getItem('abu-mcp-store') ?? '{}');
      const runtime = { enabled: true, servers: { forecast: mcp.state.servers.forecast.config }, disabledSkills: { today: false }, disabledAgents: { 'e2e-reviewer': false } };
      await shell.pluginOperation('begin', { kind: 'update', key: previous.key, expected: previous,
        record: { ...previous, checksum: snapshot.checksum }, token: snapshot.token, runtime });
      await shell.pluginSnapshot('materialize', { token: snapshot.token });
    }, { marketDir, previous });
    expect(fs.readFileSync(installedSkill, 'utf8')).toContain('New revision.');
    expect(fs.readFileSync(installedAgent, 'utf8')).toContain('Revised agent instructions.');
    await terminateAbuElectron(launched.app);
    launched = await launchAbuElectron(launched);
    page = await launched.app.firstWindow();
    await waitForWelcomeScreen(page);
    await openPluginsTab(page);
    await expect.poll(() => fs.existsSync(installedSkill) ? fs.readFileSync(installedSkill, 'utf8') : null, { timeout: READY_TIMEOUT }).toBe(originalBody);
    expect(JSON.parse(fs.readFileSync(registry, 'utf8'))).toEqual([previous]);
    expect(fs.readFileSync(installedAgent, 'utf8')).toBe(originalAgent);
    const recovered = page.getByTestId('plugin-marketplace-entry').filter({ hasText: 'e2e-weather' }).first();
    await expect(recovered.getByRole('switch')).toHaveAttribute('aria-checked', 'true', { timeout: READY_TIMEOUT });
    const journal = path.join(launched.appDataDir, 'Home/.abu/plugin-operations/active.enc');
    await expect.poll(() => fs.existsSync(journal), { timeout: READY_TIMEOUT }).toBe(false);
    await expect(recovered.getByRole('switch')).toBeEnabled();
    const mcp = await page.evaluate(() => JSON.parse(localStorage.getItem('abu-mcp-store') ?? '{}'));
    expect(mcp.state.servers.forecast.config.enabled).toBe(true);
  } finally {
    if (launched) { await closeAbuElectron(launched.app); removeElectronDataRoot(launched); }
    fs.rmSync(marketDir, { recursive: true, force: true });
  }
});

// Files written here stand in for the author conversation's generated output;
// all preparation, installation, updates and removal use the real UI and IPC.
test('creates a plugin without a marketplace, updates the same version, and preserves its editable source', async () => {
  let launched: Awaited<ReturnType<typeof launchAbuElectron>> | undefined;
  try {
    launched = await launchAbuElectron();
    let page = await launched.app.firstWindow();
    await waitForWelcomeScreen(page);
    await dismissFirstRunOverlays(page);
    await openPluginsTab(page);
    await page.getByTestId('plugin-create-trigger').click();
    await page.getByTestId('plugin-create-menu').getByRole('button', { name: /创建插件|Create plugin/ }).click();
    const authorsPath = path.join(launched.appDataDir, 'Home/.abu/plugin-authors/authors.json');
    await expect.poll(() => fs.existsSync(authorsPath) ? JSON.parse(fs.readFileSync(authorsPath, 'utf8'))[0]?.conversationId : null).toBeTruthy();
    const author = JSON.parse(fs.readFileSync(authorsPath, 'utf8'))[0];
    await expect(page.getByRole('button', { name: '/abu-plugin-builder', exact: true })).toBeVisible();
    await expect(page.locator('textarea').first()).not.toHaveValue(/plugin_prepare/);
    const sourceDir = path.join(launched.appDataDir, 'Home/Abu Plugins', author.id);
    expect(fs.existsSync(sourceDir)).toBe(true);
    fs.mkdirSync(path.join(sourceDir, '.abu-plugin'));
    fs.writeFileSync(path.join(sourceDir, '.abu-plugin/plugin.json'), JSON.stringify({ name: 'e2e-author', version: '1.0.0', description: 'My editable plugin' }));
    fs.mkdirSync(path.join(sourceDir, 'skills/greeting'), { recursive: true });
    const sourceSkill = path.join(sourceDir, 'skills/greeting/SKILL.md');
    fs.writeFileSync(sourceSkill, '---\nname: author-greeting\ndescription: A local author fixture\n---\nOriginal instructions.\n');
    await openPluginsTab(page);
    await page.getByTestId('plugin-mine-draft').click();
    const detailBounds = await page.getByTestId('plugin-author-detail').boundingBox();
    await page.getByRole('button', { name: /^(校验并预览|Validate and preview)$/ }).click();
    await expect(page.getByTestId('plugin-install-disclosure')).toContainText('author-greeting');
    expect(await page.getByTestId('plugin-install-disclosure').boundingBox()).toEqual(detailBounds);
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'e2e-plugin-author-preview.png'), animations: 'disabled' });
    await page.getByTestId('plugin-install-disclosure').getByRole('button', { name: /^(取消|关闭|Cancel|Close)$/ }).click();
    await expect(page.getByTestId('plugin-install-disclosure')).toBeHidden();
    expect(fs.existsSync(path.join(installRoot(launched), `author-${author.id}/e2e-author/1.0.0`))).toBe(false);
    await page.keyboard.press('Escape');
    await page.getByTestId('plugin-mine-draft').click();
    await page.getByRole('button', { name: /^(校验并预览|Validate and preview)$/ }).click();
    await page.getByTestId('plugin-install-confirm').click();
    await expect(page.getByTestId('plugin-install-disclosure')).toBeHidden({ timeout: READY_TIMEOUT });
    await page.keyboard.press('Escape');
    const row = page.getByTestId('plugin-mine-row');
    await expect(row.getByRole('switch')).toHaveAttribute('aria-checked', 'true', { timeout: READY_TIMEOUT });
    const registryPath = path.join(installRoot(launched), 'installed.json');
    const first = JSON.parse(fs.readFileSync(registryPath, 'utf8'))[0];
    expect(first.authoringId).toBe(author.id);
    expect(first.marketplace).toBe(`author-${author.id}`);
    await row.getByText('e2e-author', { exact: true }).click();
    await page.getByRole('button', { name: /^(检查更新|Check for updates)$/ }).click();
    await expect(page.getByTestId('plugin-install-disclosure')).toContainText(/内容与已安装版本一致|already has this content/);
    await expect(page.getByTestId('plugin-install-confirm')).toHaveCount(0);
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: /^(立即试用|Try now)$/ }).click();
    await expect(page.getByTestId('plugin-mine-group')).toBeHidden();
    await expect(page.locator('textarea').first()).toHaveValue(/e2e-author/);
    await openPluginsTab(page);
    await row.getByRole('switch').click();
    await expect(row.getByRole('switch')).toHaveAttribute('aria-checked', 'false');
    fs.appendFileSync(sourceSkill, '\nRevised same-version instructions.\n');
    await row.getByText('e2e-author', { exact: true }).click();
    await page.getByRole('button', { name: /^(检查更新|Check for updates)$/ }).click();
    await expect(page.getByRole('heading', { name: /^(更新前请确认|Review plugin update)$/ })).toBeVisible();
    await expect(page.getByTestId('plugin-install-confirm')).toHaveText(/^(更新|Update)$/);
    await page.getByRole('button', { name: /^(取消|Cancel)$/ }).click();
    await expect(row).toContainText(/可更新|Update available/);
    await page.getByRole('button', { name: /^(预览更新|Preview update)$/ }).click();
    await page.getByTestId('plugin-install-confirm').click();
    await expect(page.getByTestId('plugin-install-disclosure')).toBeHidden({ timeout: READY_TIMEOUT });
    await page.keyboard.press('Escape');
    const second = JSON.parse(fs.readFileSync(registryPath, 'utf8'))[0];
    expect(second.version).toBe(first.version);
    expect(second.checksum).not.toBe(first.checksum);
    await expect(row.getByRole('switch')).toHaveAttribute('aria-checked', 'false');
    const installedSkill = path.join(installRoot(launched), `author-${author.id}/e2e-author/1.0.0/skills/greeting/SKILL.md`);
    expect(fs.readFileSync(installedSkill, 'utf8')).toContain('Revised same-version');
    await closeAbuElectron(launched.app);
    launched = await launchAbuElectron(launched);
    page = await launched.app.firstWindow();
    await waitForWelcomeScreen(page);
    await openPluginsTab(page);
    await expect(page.getByTestId('plugin-mine-row').getByRole('switch')).toHaveAttribute('aria-checked', 'false');
    await page.getByTestId('plugin-mine-row').getByText('e2e-author', { exact: true }).click();
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'e2e-plugin-author-installed.png'), animations: 'disabled' });
    await page.getByRole('button', { name: UNINSTALL }).click();
    await page.getByRole('button', { name: UNINSTALL }).click();
    await expect(page.getByTestId('plugin-mine-draft')).toContainText('e2e-author');
    expect(fs.existsSync(installedSkill)).toBe(false);
    expect(fs.readFileSync(sourceSkill, 'utf8')).toContain('Revised same-version');
    expect(JSON.parse(fs.readFileSync(authorsPath, 'utf8'))[0].conversationId).toBe(author.conversationId);
    await page.getByTestId('plugin-mine-draft').click();
    await page.getByRole('button', { name: /^(校验并预览|Validate and preview)$/ }).click();
    await page.getByTestId('plugin-install-confirm').click();
    await expect(page.getByTestId('plugin-install-disclosure')).toBeHidden({ timeout: READY_TIMEOUT });
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('plugin-mine-row').getByRole('switch')).toHaveAttribute('aria-checked', 'true');
    expect(fs.readFileSync(installedSkill, 'utf8')).toContain('Revised same-version');
    await page.getByTestId('plugin-mine-row').getByText('e2e-author', { exact: true }).click();
    await page.getByTestId('plugin-detail-menu').click();
    await page.getByTestId('plugin-detail-menu-edit').click();
    await expect(page.getByTestId('plugin-mine-group')).toBeHidden();
    expect(JSON.parse(fs.readFileSync(authorsPath, 'utf8'))).toHaveLength(1);
    expect(JSON.parse(fs.readFileSync(authorsPath, 'utf8'))[0].conversationId).toBe(author.conversationId);
  } finally {
    if (launched) { await closeAbuElectron(launched.app); removeElectronDataRoot(launched); }
  }
});

test('configures an authored MCP without putting its credential in source or runtime settings', async () => {
  let launched: Awaited<ReturnType<typeof launchAbuElectron>> | undefined;
  const credential = 'e2e-placeholder-secret-4931';
  try {
    launched = await launchAbuElectron();
    let page = await launched.app.firstWindow();
    await waitForWelcomeScreen(page);
    await dismissFirstRunOverlays(page);
    await openPluginsTab(page);
    await page.getByTestId('plugin-create-trigger').click();
    await page.getByTestId('plugin-create-menu').getByRole('button', { name: /创建插件|Create plugin/ }).click();
    const authorsPath = path.join(launched.appDataDir, 'Home/.abu/plugin-authors/authors.json');
    await expect.poll(() => fs.existsSync(authorsPath) ? JSON.parse(fs.readFileSync(authorsPath, 'utf8'))[0]?.conversationId : null).toBeTruthy();
    const author = JSON.parse(fs.readFileSync(authorsPath, 'utf8'))[0];
    const sourceDir = path.join(launched.appDataDir, 'Home/Abu Plugins', author.id);
    const serverFile = path.join(sourceDir, 'server.cjs');
    fs.writeFileSync(serverFile, `const readline = require('node:readline');
readline.createInterface({input:process.stdin}).on('line', line => {
  const request=JSON.parse(line); if (request.id === undefined) return;
  let result={};
  if(request.method==='initialize') result={protocolVersion:'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'local-author-test',version:'1'}};
  if(request.method==='tools/list') result={tools:process.env.API_TOKEN ? [{name:'ready',description:'Configured local fixture',inputSchema:{type:'object',properties:{}}}] : []};
  process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request.id,result})+'\\n');
});`);
    fs.mkdirSync(path.join(sourceDir, '.abu-plugin'));
    const manifest = { name: 'configured-author', version: '1', mcpServers: { 'author-mcp': { command: process.execPath, args: [serverFile], env: { API_TOKEN: '${config.API_TOKEN}' } } } };
    const manifestFile = path.join(sourceDir, '.abu-plugin/plugin.json');
    fs.writeFileSync(manifestFile, JSON.stringify(manifest));
    await openPluginsTab(page);
    await page.getByTestId('plugin-mine-draft').click();
    await page.getByRole('button', { name: /^(校验并预览|Validate and preview)$/ }).click();
    const input = page.getByLabel('API_TOKEN', { exact: true });
    await expect(input).toBeVisible({ timeout: READY_TIMEOUT });
    await expect(page.getByTestId('plugin-install-confirm')).toBeDisabled();
    await input.fill(credential);
    await page.getByTestId('plugin-install-confirm').click();
    await expect(page.getByTestId('plugin-install-disclosure')).toBeHidden({ timeout: READY_TIMEOUT });
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('plugin-mine-row').getByRole('switch')).toHaveAttribute('aria-checked', 'true');
    const settings = await page.evaluate(() => ({ mcp: localStorage.getItem('abu-mcp-store'), all: JSON.stringify(localStorage) }));
    expect(settings.all).not.toContain(credential);
    const config = JSON.parse(settings.mcp!).state.servers['author-mcp'].config;
    expect(config.enabled).toBe(true);
    expect(config.env.API_TOKEN).toBe('${config.API_TOKEN}');
    expect(config.pluginConfiguration).toMatch(/^plugin-config:/);
    expect(fs.readFileSync(manifestFile, 'utf8')).not.toContain(credential);
    const secretFiles = fs.readdirSync(launched.appDataDir, { recursive: true }).filter(name => String(name).endsWith('secrets.enc.json'));
    expect(secretFiles).toHaveLength(1);
    expect(fs.readFileSync(path.join(launched.appDataDir, String(secretFiles[0])), 'utf8')).not.toContain(credential);
    await page.getByRole('main').getByRole('button', { name: /^(连接器|Connectors)$/ }).click();
    await page.getByText('author-mcp', { exact: true }).click();
    await expect(page.getByTestId('mcp-server-toggle-connection')).toHaveAttribute('data-connected', 'true', { timeout: READY_TIMEOUT });
    await expect(page.getByText('ready', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: /^(测试连接|Test connection)$/ }).click();
    await expect(page.getByTestId('mcp-server-toggle-connection')).toHaveAttribute('data-connected', 'true');
    await expect(page.getByText(/连接成功.*1.*工具/)).toBeVisible();
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'e2e-plugin-author-configured-mcp.png'), animations: 'disabled' });
    // Same-version editing rotates configuration, reclaims the old reference,
    // and preserves the existing enabled intent.
    const secretsPath = path.join(launched.appDataDir, String(secretFiles[0]));
    await page.keyboard.press('Escape');
    await page.getByRole('main').getByRole('button', { name: PLUGINS_TAB }).click();
    fs.appendFileSync(serverFile, '\n// Same-version author revision.\n');
    await page.getByTestId('plugin-mine-row').getByText('configured-author', { exact: true }).click();
    await page.getByRole('button', { name: /^(检查更新|Check for updates)$/ }).click();
    await expect(page.getByRole('heading', { name: /^(更新前请确认|Review plugin update)$/ })).toBeVisible();
    await expect(page.getByTestId('plugin-install-confirm')).toHaveText(/^(更新|Update)$/);
    await page.getByLabel('API_TOKEN', { exact: true }).fill('e2e-rotated-placeholder-4932');
    await page.getByTestId('plugin-install-confirm').click();
    await expect(page.getByTestId('plugin-install-disclosure')).toBeHidden({ timeout: READY_TIMEOUT });
    await page.keyboard.press('Escape');
    const updatedConfig = await page.evaluate(() => JSON.parse(localStorage.getItem('abu-mcp-store')!).state.servers['author-mcp'].config);
    expect(updatedConfig.pluginConfiguration).not.toBe(config.pluginConfiguration);
    expect(updatedConfig.enabled).toBe(true);
    await expect.poll(() => Object.keys(JSON.parse(fs.readFileSync(secretsPath, 'utf8')))).not.toContain(config.pluginConfiguration);
    config.pluginConfiguration = updatedConfig.pluginConfiguration;
    // The new reference survives restart, and removal reclaims only its secret.
    await closeAbuElectron(launched.app);
    launched = await launchAbuElectron(launched);
    page = await launched.app.firstWindow();
    await waitForWelcomeScreen(page);
    await openPluginsTab(page);
    await expect(page.getByTestId('plugin-mine-row').getByRole('switch')).toHaveAttribute('aria-checked', 'true');
    expect(Object.keys(JSON.parse(fs.readFileSync(secretsPath, 'utf8')))).toContain(config.pluginConfiguration);
    await page.getByTestId('plugin-mine-row').getByText('configured-author', { exact: true }).click();
    await page.getByRole('button', { name: UNINSTALL }).click();
    await page.getByRole('button', { name: UNINSTALL }).click();
    await expect(page.getByTestId('plugin-mine-draft')).toBeVisible();
    await expect.poll(() => Object.keys(JSON.parse(fs.readFileSync(secretsPath, 'utf8')))).not.toContain(config.pluginConfiguration);
    expect(fs.existsSync(manifestFile)).toBe(true);

  } finally {
    if (launched) { await closeAbuElectron(launched.app); removeElectronDataRoot(launched); }
  }
});

test('deletes only draft metadata and explicitly archives an unreadable operation in Electron', async () => {
  let launched: Awaited<ReturnType<typeof launchAbuElectron>> | undefined;
  try {
    launched = await launchAbuElectron();
    let page = await launched.app.firstWindow();
    await waitForWelcomeScreen(page);
    await dismissFirstRunOverlays(page);
    await openPluginsTab(page);
    await page.getByTestId('plugin-create-trigger').click();
    await page.getByTestId('plugin-create-menu').getByRole('button', { name: /创建插件|Create plugin/ }).click();
    const home = fs.realpathSync(path.join(launched.appDataDir, 'Home'));
    const authorsPath = path.join(home, '.abu/plugin-authors/authors.json');
    await expect.poll(() => fs.existsSync(authorsPath) ? JSON.parse(fs.readFileSync(authorsPath, 'utf8'))[0]?.conversationId : null).toBeTruthy();
    const author = JSON.parse(fs.readFileSync(authorsPath, 'utf8'))[0];
    const sourceDir = path.join(home, 'Abu Plugins', author.id);
    const sourceFile = path.join(sourceDir, 'notes.md');
    fs.writeFileSync(sourceFile, 'Keep my source.');
    await openPluginsTab(page);
    await page.getByTestId('plugin-mine-draft').click();
    await page.getByTestId('plugin-author-menu').click();
    await page.getByTestId('plugin-author-menu-delete').click();
    await expect(page.getByText(/本期无法重新接管该目录|This release cannot re-adopt/)).toBeVisible();
    await expect(page.getByText(sourceDir, { exact: true })).toBeVisible();
    await page.getByRole('button', { name: /^(删除草稿|Delete draft)$/ }).click();
    await expect(page.getByTestId('plugin-mine-draft')).toHaveCount(0);
    expect(JSON.parse(fs.readFileSync(authorsPath, 'utf8'))).toEqual([]);
    expect(fs.readFileSync(sourceFile, 'utf8')).toBe('Keep my source.');
    await closeAbuElectron(launched.app);
    const operations = path.join(home, '.abu/plugin-operations');
    const journal = path.join(operations, 'active.enc');
    fs.mkdirSync(operations, { recursive: true });
    fs.writeFileSync(journal, 'unreadable journal fixture');
    const backup = path.join(home, '.abu/plugin-packages/market/demo/.abu-plugin-backup-fixture');
    fs.mkdirSync(backup, { recursive: true });
    fs.writeFileSync(path.join(backup, 'original.md'), 'Old version.');
    launched = await launchAbuElectron(launched);
    page = await launched.app.firstWindow();
    await waitForWelcomeScreen(page);
    await openPluginsTab(page);
    await page.getByRole('button', { name: /^(归档并继续|Archive and continue)$/ }).click();
    await expect(page.getByText(/不会删除任何文件|No files are deleted/)).toBeVisible();
    expect(fs.existsSync(journal)).toBe(true);
    await page.getByRole('button', { name: /^(归档并继续|Archive and continue)$/ }).last().click();
    await expect.poll(() => fs.existsSync(journal)).toBe(false);
    const archived = fs.readdirSync(operations).find(name => /^corrupt-\d+\.enc$/.test(name));
    expect(archived).toBeTruthy();
    expect(fs.readFileSync(path.join(operations, archived!), 'utf8')).toBe('unreadable journal fixture');
    expect(fs.readFileSync(path.join(backup, 'original.md'), 'utf8')).toBe('Old version.');
    const backupNotice = page.getByRole('status');
    await expect(backupNotice).toBeVisible();
    await expect.poll(async () => (await backupNotice.locator('li').allTextContents()).map(file => fs.realpathSync(file))).toEqual([backup]);
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'e2e-plugin-batch1-archived.png'), animations: 'disabled' });
  } finally {
    if (launched) { await closeAbuElectron(launched.app); removeElectronDataRoot(launched); }
  }
});
