/**
 * The ORGANIZATION plugin loop in the real Electron shell, against a real
 * enterprise console over HTTP: bind through the product's own login UI, open
 * the 插件 tab's 「市场」 — which for a bound client IS the organization catalog —
 * read the disclosure, install, verify the ON-DISK layout, uninstall, and (on a
 * spec-owned package) update.
 *
 * What the IA assertions here prove, and what they do NOT: on a bound shell
 * 「市场」 is the console catalog and 「我的」 is what this user wrote
 * themselves, so an organization install shows up in the first and never in the
 * second. That is a statement about which panel lists what — it is NOT the
 * proof that installs are keyed `name@marketplace`. A bound client has no
 * personal-market surface left to install a same-named plugin from, so that
 * keying is pinned by unit tests instead: src/core/plugin/enterpriseMarket.test.ts
 * (an install is enterprise by its marketplace, not its name) and
 * src/core/plugin/installedStore.test.ts (records are stored and removed by the
 * composite key).
 *
 * Why this exists: every other test of this feature mocks either the installer
 * or the filesystem, so the on-disk layout it produces had never been proven by
 * an end-to-end run. That layout broke twice during development —
 *   1. the staging tree was written UNDER `enterprise/<name>/`, which the
 *      update path's uninstall deletes, so every update wiped the tree it was
 *      about to copy from;
 *   2. `.abu-plugin/` is a dot-directory and a dotfile-skipping copy dropped it
 *      silently, producing an installed package with no manifest.
 * Both are invisible to a mocked filesystem, so the paths below are asserted
 * LITERALLY rather than through any helper that could drift with the product.
 *
 * Nothing here is stubbed: the catalog fetch, the artifact download, the
 * signature-verification key and the install-log POST all go to the console
 * named by ABU_E2E_CONSOLE_URL.
 *
 * Requires (spec skips itself when unset):
 *   ABU_E2E_CONSOLE_URL       e.g. http://127.0.0.1:3000
 *   ABU_E2E_CONSOLE_EMAIL     a console account that can sign in AND publish
 *   ABU_E2E_CONSOLE_PASSWORD
 * plus an enterprise renderer build — run with ABU_BUILD_TARGET=enterprise so
 * the suite's global setup rebuilds dist-electron-spike against the private
 * modules (the organization plugin tab does not exist in an OSS build).
 */
import { expect, test } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { strToU8, zipSync } from 'fflate';
import type { ElectronApplication, Page } from 'playwright';
import {
  closeAbuElectron,
  dismissFirstRunOverlays,
  launchAbuElectron,
  removeElectronDataRoot,
  REPO_ROOT,
  type ElectronDataRoot,
} from './electronHelpers';

const READY_TIMEOUT = 45_000;
/** Install/update round trips include a real download + extract + copy. */
const INSTALL_TIMEOUT = 60_000;
const SCREENSHOT_DIR = path.join(REPO_ROOT, 'test-results');

const CONSOLE_URL = process.env.ABU_E2E_CONSOLE_URL ?? '';
const CONSOLE_EMAIL = process.env.ABU_E2E_CONSOLE_EMAIL ?? '';
const CONSOLE_PASSWORD = process.env.ABU_E2E_CONSOLE_PASSWORD ?? '';

/** The administrator-published package this walkthrough installs. */
const CATALOG_PLUGIN = 'abu-prd-doctor';
/**
 * A second package the spec publishes ITSELF, used only by the update test.
 * Updating the administrator's package would mean publishing a 1.1.0 of it,
 * which permanently moves the catalog's "latest" and would make a re-run
 * install a different version than the first run did. A spec-owned package
 * that is deleted again in teardown keeps both tests re-runnable.
 */
const OWNED_PLUGIN = 'abu-e2e-org-plugin';
const OWNED_SKILL = 'e2e-org-skill';
/**
 * Versions are stamped per run because the console's package DELETE is a SOFT
 * delete — it deprecates the versions (hiding them from the client catalog)
 * but keeps the rows, and the upload endpoint still rejects a repeat of any
 * version string it has ever seen with 409 `version_exists`. A fixed
 * "1.0.0 → 1.1.0" pair would therefore pass exactly once per database.
 */
const RUN_STAMP = Math.floor(Date.now() / 1000);
const OWNED_V1 = `1.${RUN_STAMP}.0`;
const OWNED_V2 = `1.${RUN_STAMP}.1`;

// Public (localized) UI. Placeholders that are URLs/emails are locale-neutral.
const WELCOME = /交给阿布就行啦|Leave it to Abu/;
const CHAT_PLACEHOLDER = /^(想让阿布帮你做点什么？|What can Abu help you with\?)$/;
const ME_BUTTON = /^(我|Me)$/;
const SETTINGS_ITEM = /^(设置|Settings)$/;
const ENTERPRISE_NAV = /^(企业模式|Enterprise)$/;
const BIND_BUTTON = /^(切换到企业模式|Switch to enterprise mode)$/;
const CONTINUE_BUTTON = /^(继续|Continue)$/;
const PASSWORD_PLACEHOLDER = /^(输入密码|Enter password)$/;
const SIGN_IN_BUTTON = /^(登录|Sign in)$/;
const BOUND_STATUS = /已绑定到企业实例|Connected to enterprise instance/;
const EXTENSIONS = /^(扩展|Extensions)$/;
const PLUGINS_TAB = /^(插件|Plugins)$/;
const CANCEL_BUTTON = /^(取消|Cancel)$/;

// EnterprisePluginTab is single-locale by design (see its module header), so
// these are exact strings, not alternations.
const BADGE_REVIEWED = '组织审核';
const BADGE_INSTALLED = '已安装';
const BADGE_UPDATABLE = '可更新';
const ACTION_INSTALL = '安装';
const ACTION_UPDATE = '更新';

// ─── console API (node side; the app talks to the same console over HTTP) ────

interface CatalogEntry {
  id: string;
  name: string;
  latestVersion: string;
  latestVersionId: string;
  sha256: string;
  signature: string | null;
  disclosure: { skills: string[]; mcpServers: { name: string }[]; ignoredPayloads: string[] };
}

/** Console admin session cookie header, established once in `beforeAll`. */
let adminCookie = '';

async function adminLogin(): Promise<void> {
  const res = await fetch(`${CONSOLE_URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: CONSOLE_EMAIL, password: CONSOLE_PASSWORD }),
  });
  if (!res.ok) throw new Error(`console admin login failed: HTTP ${res.status}`);
  // Node's fetch does not keep a cookie jar; carry the session forward by hand.
  const cookies = res.headers.getSetCookie();
  if (cookies.length === 0) throw new Error('console admin login returned no cookie');
  adminCookie = cookies.map((c) => c.split(';')[0]).join('; ');
}

async function admin(pathname: string, init?: RequestInit): Promise<Response> {
  return fetch(`${CONSOLE_URL}${pathname}`, {
    ...init,
    headers: { ...(init?.headers as Record<string, string> | undefined), cookie: adminCookie },
  });
}

/** The catalog exactly as the CLIENT sees it — same endpoint the app polls. */
async function clientCatalog(): Promise<CatalogEntry[]> {
  const auth = await fetch(`${CONSOLE_URL}/api/client/v1/auth/password`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: CONSOLE_EMAIL, password: CONSOLE_PASSWORD }),
  });
  if (!auth.ok) throw new Error(`console client login failed: HTTP ${auth.status}`);
  const { access_token: token } = (await auth.json()) as { access_token: string };
  const session = await fetch(`${CONSOLE_URL}/api/client/v1/session`, {
    headers: { authorization: `Bearer ${token}` },
  });
  expect(session.ok).toBe(true);
  expect((await session.json()).signing.skillPublicKey).toBeNull();
  const res = await fetch(`${CONSOLE_URL}/api/skills/catalog?kinds=plugin`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`plugin catalog failed: HTTP ${res.status}`);
  return ((await res.json()) as { items: CatalogEntry[] }).items;
}

function ownedPluginZip(version: string): Uint8Array {
  const manifest = {
    name: OWNED_PLUGIN,
    version,
    description: 'Fixture package published by the organization-plugin E2E',
    author: { name: 'Abu E2E' },
    license: 'MIT',
    skills: [`./skills/${OWNED_SKILL}`],
    interface: {
      displayName: 'E2E Org Plugin',
      shortDescription: 'E2E fixture',
      developerName: 'Abu E2E',
      category: 'productivity',
    },
  };
  // The manifest lives in a DOT-directory on purpose — see the file header.
  return zipSync({
    '.abu-plugin/plugin.json': strToU8(JSON.stringify(manifest, null, 2)),
    [`skills/${OWNED_SKILL}/SKILL.md`]: strToU8(
      `---\nname: ${OWNED_SKILL}\ndescription: E2E fixture skill (v${version})\n---\n\nfixture body v${version}\n`,
    ),
  });
}

/** Publish one version of the spec-owned package. Upload auto-publishes it. */
async function publishOwnedVersion(version: string): Promise<void> {
  const form = new FormData();
  form.append('file', new Blob([ownedPluginZip(version)]), `${OWNED_PLUGIN}-${version}.zip`);
  const res = await admin('/api/admin/skills/packages', { method: 'POST', body: form });
  if (!res.ok) throw new Error(`publish ${OWNED_PLUGIN}@${version} failed: HTTP ${res.status} ${await res.text()}`);
}

/** Remove the spec-owned package if a previous run left it behind. */
async function deleteOwnedPackage(): Promise<void> {
  const res = await admin('/api/admin/skills/packages');
  if (!res.ok) return;
  const { items } = (await res.json()) as { items: { id: string; name: string }[] };
  for (const pkg of items.filter((p) => p.name === OWNED_PLUGIN)) {
    await admin(`/api/admin/skills/packages/${pkg.id}`, { method: 'DELETE' });
  }
}

// ─── on-disk layout (asserted literally — see the file header) ───────────────

/**
 * `<appDataDir>/Home` is the isolated HOME `launchAbuElectron` gives the shell
 * (electron/main.cjs redirects app.getPath('home') under ABU_E2E_APP_DATA_ROOT),
 * so `~/.abu/...` below is this run's own tree and never a developer's real one.
 */
function homeDir(dataRoot: ElectronDataRoot): string {
  return path.join(dataRoot.appDataDir, 'Home');
}

function enterpriseRoot(dataRoot: ElectronDataRoot): string {
  return path.join(homeDir(dataRoot), '.abu', 'plugin-packages', 'enterprise');
}

function stagingRoot(dataRoot: ElectronDataRoot): string {
  return path.join(enterpriseRoot(dataRoot), '.staging');
}

/**
 * Names left under the staging root.
 *
 * The commit removes `.staging/<name>` — the tree that actually holds the
 * unpacked third-party files — but not the `.staging` parent itself, which
 * survives as an empty directory. So the invariant worth asserting is that
 * nothing is STAGED, not that the directory is absent: an empty `.staging`
 * holds no package. Returns `[]` when the root was never created.
 */
function stagedEntries(dataRoot: ElectronDataRoot): string[] {
  const root = stagingRoot(dataRoot);
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root);
}

function installedManifest(dataRoot: ElectronDataRoot): string {
  return path.join(homeDir(dataRoot), '.abu', 'plugin-packages', 'installed.json');
}

interface InstalledRecord {
  key: string;
  marketplace: string;
  name: string;
  version: string;
  checksum?: string;
  contributed: { skills: string[]; mcpServers: string[] };
}

function readInstalled(dataRoot: ElectronDataRoot): InstalledRecord[] {
  const file = installedManifest(dataRoot);
  if (!fs.existsSync(file)) return [];
  return JSON.parse(fs.readFileSync(file, 'utf8')) as InstalledRecord[];
}

function installedRecord(dataRoot: ElectronDataRoot, name: string): InstalledRecord | undefined {
  return readInstalled(dataRoot).find((p) => p.name === name);
}

// ─── UI journey ──────────────────────────────────────────────────────────────

async function waitForWelcomeScreen(page: Page): Promise<void> {
  await page.waitForLoadState('domcontentloaded');
  await expect(
    page.getByText(WELCOME).or(page.getByPlaceholder(CHAT_PLACEHOLDER)).first(),
  ).toBeVisible({ timeout: READY_TIMEOUT });
}

/**
 * Bind through the PRODUCT's own flow: Settings → 企业模式 → server URL →
 * password login. Nothing is seeded: the bootstrap probe, the credential
 * exchange and the first session poll are real requests to CONSOLE_URL, and
 * the binding that lands on disk is the one the app wrote itself. That last
 * step matters beyond convenience — the session response is what carries the
 * license modules and the artifact-signing public key, without which the tab
 * renders its "组织插件暂不可用" state and no download would verify.
 */
async function bindToConsole(page: Page): Promise<void> {
  await page.getByRole('button', { name: ME_BUTTON }).first().click();
  await page.getByRole('menuitem', { name: SETTINGS_ITEM }).click();
  await page.getByRole('button', { name: ENTERPRISE_NAV }).click();
  await page.getByRole('button', { name: BIND_BUTTON }).click();

  await page.getByPlaceholder('https://abu.your-company.com').fill(CONSOLE_URL);
  await page.getByRole('button', { name: CONTINUE_BUTTON }).click();

  await page.getByPlaceholder('you@company.com').fill(CONSOLE_EMAIL);
  await page.getByPlaceholder(PASSWORD_PLACEHOLDER).fill(CONSOLE_PASSWORD);
  await page.getByRole('button', { name: SIGN_IN_BUTTON }).click();

  await expect(page.getByText(BOUND_STATUS)).toBeVisible({ timeout: READY_TIMEOUT });
  await page.keyboard.press('Escape');
  await expect(page.getByText(BOUND_STATUS)).toBeHidden({ timeout: READY_TIMEOUT });
}

async function openPluginsTab(page: Page): Promise<void> {
  // Scope the sidebar entry to the navigation region and the tab to the panel
  // so neither can match the other by accident.
  await page.getByLabel('Main navigation').getByRole('button', { name: EXTENSIONS }).click();
  const panel = page.getByRole('main');
  await expect(panel.getByRole('button', { name: PLUGINS_TAB })).toBeVisible({ timeout: READY_TIMEOUT });
  await panel.getByRole('button', { name: PLUGINS_TAB }).click();
  await selectSource(page, 'market');
}

/**
 * 市场 | 我的 — the source sub-nav every Extensions tab carries. There is no
 * 我的/组织 scope toggle any more: for a bound client the organization catalog
 * IS the 「市场」 panel, so 「市场」 is where the whole organization loop happens
 * and 「我的」 stays what the user wrote themselves.
 */
function sourceTab(page: Page, source: 'market' | 'mine') {
  return page.getByTestId(`extensions-source-${source}`);
}

async function selectSource(page: Page, source: 'market' | 'mine'): Promise<void> {
  await sourceTab(page, source).click();
  await expect(sourceTab(page, source)).toHaveAttribute('aria-selected', 'true');
}

/**
 * The organization catalog row for `name`.
 *
 * The catalog is a full-width list (`MarketplaceEntryRow`, the same row the OSS
 * 插件 市场 uses), so the row itself carries a testid; `has:` then picks the one
 * whose name element matches EXACTLY — filtering rows by text would also match
 * a row whose name merely contains this one.
 */
function orgCard(page: Page, name: string) {
  return page
    .getByRole('main')
    .getByTestId('enterprise-plugin-row')
    .filter({ has: page.getByTitle(name, { exact: true }) });
}

/** 卸载 lives behind the row's `···` menu, exactly as it does in the OSS 市场. */
async function uninstallOrgPlugin(page: Page, name: string): Promise<void> {
  await orgCard(page, name).getByTestId('enterprise-plugin-menu').click();
  await orgCard(page, name).getByTestId('enterprise-plugin-menu-uninstall').click();
}

/** Force a catalog re-sync: the tab polls every 5 min, but re-syncs on mount.
 *  Leaving for 「我的」 unmounts it; coming back remounts it. */
async function resyncOrgCatalog(page: Page): Promise<void> {
  await selectSource(page, 'mine');
  await selectSource(page, 'market');
}

// ─── the walkthrough ─────────────────────────────────────────────────────────

test.describe.serial('organization plugin install loop (real shell + real console)', () => {
  test.skip(
    CONSOLE_URL === '' || CONSOLE_EMAIL === '' || CONSOLE_PASSWORD === '',
    'set ABU_E2E_CONSOLE_URL / _EMAIL / _PASSWORD to run the enterprise plugin walkthrough',
  );

  let dataRoot: ElectronDataRoot;
  let app: ElectronApplication;
  let page: Page;
  let catalogEntry: CatalogEntry;

  test.beforeAll(async () => {
    await adminLogin();
    // Leftovers from an interrupted run would 409 the 1.0.0 publish below.
    await deleteOwnedPackage();
    await publishOwnedVersion(OWNED_V1);

    const catalog = await clientCatalog();
    // Keep this suite on the supported unsigned deployment shape. Signed
    // installs and tampering have their own opt-in regression suite.
    expect(catalog.find(entry => entry.name === OWNED_PLUGIN)?.signature).toBeNull();
    const found = catalog.find((e) => e.name === CATALOG_PLUGIN);
    if (!found) throw new Error(`console has no published plugin named ${CATALOG_PLUGIN}`);
    catalogEntry = found;

    const launched = await launchAbuElectron();
    dataRoot = launched;
    app = launched.app;
    page = await app.firstWindow();
    await waitForWelcomeScreen(page);
    await dismissFirstRunOverlays(page);
    await bindToConsole(page);
  });

  test.afterAll(async () => {
    if (app) await closeAbuElectron(app);
    if (dataRoot) removeElectronDataRoot(dataRoot);
    if (adminCookie) await deleteOwnedPackage();
  });

  test('the bound shell renders the organization catalog as the 插件 「市场」', async () => {
    await openPluginsTab(page);

    // 「市场」 is the landing source, and for a bound client it is the console's
    // catalog rather than Abu's own market.
    await expect(sourceTab(page, 'market')).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('main').getByText(CATALOG_PLUGIN).first()).toBeVisible({
      timeout: READY_TIMEOUT,
    });
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'e2e-enterprise-plugin-catalog.png') });

    // 「我的」 is the other half of the same tab and stays personal: the
    // organization catalog must not be what it shows.
    await selectSource(page, 'mine');
    await expect(page.getByTestId('plugin-mine-row').filter({ hasText: CATALOG_PLUGIN })).toHaveCount(0);
    await selectSource(page, 'market');
  });

  test('the catalog row states the disclosure counts and the 组织审核 badge', async () => {
    // What the console published — the row must be a faithful rendering of it.
    expect(catalogEntry.disclosure.skills).toEqual(['prd-doctor']);
    expect(catalogEntry.disclosure.mcpServers).toEqual([]);

    const card = orgCard(page, CATALOG_PLUGIN);
    await expect(card).toContainText(
      `${catalogEntry.disclosure.skills.length} 个技能 · ${catalogEntry.disclosure.mcpServers.length} 个连接器`,
    );
    await expect(card).toContainText(`最新 v${catalogEntry.latestVersion}`);
    await expect(card).toContainText(BADGE_REVIEWED);
  });

  test('cancelling the disclosure installs nothing and leaves no staging tree', async () => {
    await orgCard(page, CATALOG_PLUGIN).getByRole('button', { name: ACTION_INSTALL }).click();

    const disclosure = page.getByTestId('plugin-install-disclosure');
    await expect(disclosure).toBeVisible({ timeout: INSTALL_TIMEOUT });
    // The confirm button only exists in the `ready` state, so waiting on it is
    // what proves the download + verify + plan actually completed — and the
    // 取消 button only replaces 关闭 there too.
    await expect(page.getByTestId('plugin-install-confirm')).toBeVisible({ timeout: INSTALL_TIMEOUT });
    await expect(page.getByTestId('plugin-disclosure-unsigned')).toBeVisible();
    await expect(disclosure.getByText('prd-doctor', { exact: true })).toBeVisible();
    await disclosure.getByRole('button', { name: CANCEL_BUTTON }).click();
    await expect(disclosure).toBeHidden({ timeout: READY_TIMEOUT });

    // A cancel must undo the download it already staged: no install record, and
    // — the invariant that broke before — no orphaned third-party tree left
    // under $HOME with nobody holding its path.
    expect(installedRecord(dataRoot, CATALOG_PLUGIN)).toBeUndefined();
    await expect
      .poll(() => fs.existsSync(path.join(stagingRoot(dataRoot), CATALOG_PLUGIN)), {
        timeout: READY_TIMEOUT,
      })
      .toBe(false);
    // The card is unchanged: still offered for install, still not installed.
    await expect(orgCard(page, CATALOG_PLUGIN)).toContainText(BADGE_REVIEWED);
  });

  test('installing writes the documented on-disk layout and clears staging', async () => {
    await orgCard(page, CATALOG_PLUGIN).getByRole('button', { name: ACTION_INSTALL }).click();

    const disclosure = page.getByTestId('plugin-install-disclosure');
    await expect(disclosure).toBeVisible({ timeout: INSTALL_TIMEOUT });
    await expect(page.getByTestId('plugin-install-confirm')).toBeVisible({ timeout: INSTALL_TIMEOUT });
    // The disclosure names the skill the package will contribute, and declares
    // no connector — the same two facts the catalog row summarised as counts.
    await expect(page.getByTestId('plugin-disclosure-unsigned')).toBeVisible();
    await expect(disclosure.getByText('prd-doctor', { exact: true })).toBeVisible();
    await expect(page.getByTestId('plugin-disclosure-server')).toHaveCount(0);
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'e2e-enterprise-plugin-disclosure.png') });
    await page.getByTestId('plugin-install-confirm').click();
    await expect(disclosure).toBeHidden({ timeout: INSTALL_TIMEOUT });

    // ── on real disk, literal paths ───────────────────────────────────────
    const version = catalogEntry.latestVersion;
    const packageDir = path.join(enterpriseRoot(dataRoot), CATALOG_PLUGIN, version);
    const manifestPath = path.join(packageDir, '.abu-plugin', 'plugin.json');
    const skillPath = path.join(packageDir, 'skills', 'prd-doctor', 'SKILL.md');

    // Poll the WHOLE postcondition: the copy lands file by file and this probe
    // watches it from outside the process, so waiting on the manifest alone can
    // resolve mid-copy.
    await expect
      .poll(() => fs.existsSync(manifestPath) && fs.existsSync(skillPath), { timeout: INSTALL_TIMEOUT })
      .toBe(true);

    // The manifest survived the copy intact (dot-directory and all) and still
    // describes this package.
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as { name: string; version: string };
    expect(manifest.name).toBe(CATALOG_PLUGIN);
    expect(manifest.version).toBe(version);

    // installed.json records it as an ENTERPRISE install, checksummed with the
    // catalog's own sha256 — that equality is what the 已安装 / 可更新 badge
    // and the whole update path are computed from.
    const record = installedRecord(dataRoot, CATALOG_PLUGIN);
    expect(record).toBeDefined();
    expect(record?.marketplace).toBe('enterprise');
    expect(record?.version).toBe(version);
    expect(record?.checksum).toBe(catalogEntry.sha256);
    expect(record?.key).toBe(`${CATALOG_PLUGIN}@enterprise`);
    expect(record?.contributed.skills.length).toBeGreaterThan(0);

    // The staging tree is a sibling of the installed packages and is removed
    // once the commit copied out of it — nothing unreviewed is left under $HOME.
    await expect
      .poll(() => stagedEntries(dataRoot), { timeout: INSTALL_TIMEOUT })
      .toEqual([]);
    expect(fs.existsSync(path.join(stagingRoot(dataRoot), CATALOG_PLUGIN))).toBe(false);
  });

  test('the card reads 已安装 and 「我的」 does not list it', async () => {
    await expect(orgCard(page, CATALOG_PLUGIN)).toContainText(BADGE_INSTALLED, { timeout: READY_TIMEOUT });
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'e2e-enterprise-plugin-installed.png') });

    // 「我的」 lists what this user wrote. An organization install is not that,
    // so it must not appear there — the row asserted absent here is the same
    // `plugin-mine-row` the personal spec asserts PRESENT for a self-authored
    // plugin, so an implementation that simply rendered nothing would fail
    // that spec rather than pass this one.
    await selectSource(page, 'mine');
    await expect(page.getByTestId('plugin-mine-row').filter({ hasText: CATALOG_PLUGIN })).toHaveCount(0);

    await selectSource(page, 'market');
  });

  test('uninstalling from the 「市场」 card removes the record and the directory', async () => {
    const packageRoot = path.join(enterpriseRoot(dataRoot), CATALOG_PLUGIN);
    expect(fs.existsSync(packageRoot)).toBe(true);

    await uninstallOrgPlugin(page, CATALOG_PLUGIN);

    await expect
      .poll(() => fs.existsSync(packageRoot), { timeout: INSTALL_TIMEOUT })
      .toBe(false);
    await expect
      .poll(() => installedRecord(dataRoot, CATALOG_PLUGIN) === undefined, { timeout: INSTALL_TIMEOUT })
      .toBe(true);
    await expect(orgCard(page, CATALOG_PLUGIN)).toContainText(BADGE_REVIEWED, { timeout: READY_TIMEOUT });
  });

  test('a newly published version shows 可更新 and 更新 swaps the version directory', async () => {
    // Install the spec-owned first version — the update path needs something to
    // update, and using its own package keeps the administrator's catalog
    // untouched (see OWNED_PLUGIN).
    await expect(orgCard(page, OWNED_PLUGIN)).toContainText(BADGE_REVIEWED, { timeout: READY_TIMEOUT });
    await orgCard(page, OWNED_PLUGIN).getByRole('button', { name: ACTION_INSTALL }).click();
    await expect(page.getByTestId('plugin-install-confirm')).toBeVisible({ timeout: INSTALL_TIMEOUT });
    await page.getByTestId('plugin-install-confirm').click();
    await expect(page.getByTestId('plugin-install-disclosure')).toBeHidden({ timeout: INSTALL_TIMEOUT });

    const oldDir = path.join(enterpriseRoot(dataRoot), OWNED_PLUGIN, OWNED_V1);
    await expect
      .poll(() => fs.existsSync(path.join(oldDir, '.abu-plugin', 'plugin.json')), { timeout: INSTALL_TIMEOUT })
      .toBe(true);

    // Publish the next version to the real console, then make the tab re-poll.
    await publishOwnedVersion(OWNED_V2);
    await resyncOrgCatalog(page);

    await expect(orgCard(page, OWNED_PLUGIN)).toContainText(BADGE_UPDATABLE, { timeout: INSTALL_TIMEOUT });
    await orgCard(page, OWNED_PLUGIN).getByRole('button', { name: ACTION_UPDATE }).click();
    await expect(page.getByTestId('plugin-install-confirm')).toBeVisible({ timeout: INSTALL_TIMEOUT });
    await page.getByTestId('plugin-install-confirm').click();
    await expect(page.getByTestId('plugin-install-disclosure')).toBeHidden({ timeout: INSTALL_TIMEOUT });

    // The new version is on disk, the old one is gone — an update must not
    // leave the record and the tree straddling two versions.
    const newDir = path.join(enterpriseRoot(dataRoot), OWNED_PLUGIN, OWNED_V2);
    await expect
      .poll(() => fs.existsSync(path.join(newDir, '.abu-plugin', 'plugin.json')), { timeout: INSTALL_TIMEOUT })
      .toBe(true);
    await expect.poll(() => fs.existsSync(oldDir), { timeout: INSTALL_TIMEOUT }).toBe(false);
    await expect
      .poll(() => installedRecord(dataRoot, OWNED_PLUGIN)?.version, { timeout: INSTALL_TIMEOUT })
      .toBe(OWNED_V2);
    // …and the update, like the install, cleaned its staging tree up.
    await expect.poll(() => stagedEntries(dataRoot), { timeout: INSTALL_TIMEOUT }).toEqual([]);

    // Leave the isolated home clean for the teardown.
    await uninstallOrgPlugin(page, OWNED_PLUGIN);
    await expect
      .poll(() => fs.existsSync(path.join(enterpriseRoot(dataRoot), OWNED_PLUGIN)), { timeout: INSTALL_TIMEOUT })
      .toBe(false);
  });
});
