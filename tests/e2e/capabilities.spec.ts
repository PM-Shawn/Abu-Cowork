import { expect, test } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import type { ElectronApplication, Page } from 'playwright';
import {
  closeAbuElectron,
  launchAbuElectron,
  removeElectronDataRoot,
  REPO_ROOT,
  type ElectronDataRoot,
} from './electronHelpers';

const READY_TIMEOUT = 45_000;
const SCREENSHOT_PATH = path.join(REPO_ROOT, 'test-results', 'e2e-capabilities.png');
const COMPUTER_SETUP_SCREENSHOT_PATH = path.join(
  REPO_ROOT,
  'test-results',
  'e2e-computer-use-setup.png',
);
/** Visual record of every screen in the capability IA, for design review. */
const IA_SCREENSHOT_DIR = path.join(REPO_ROOT, 'test-results', 'capabilities-redesign');

function iaScreenshot(name: string): string {
  fs.mkdirSync(IA_SCREENSHOT_DIR, { recursive: true });
  return path.join(IA_SCREENSHOT_DIR, `${name}.png`);
}

const WELCOME = /交给阿布就行啦|Leave it to Abu/;
const CHAT_PLACEHOLDER = /^(想让阿布帮你做点什么？|What can Abu help you with\?)$/;
const ACCOUNT = /^(我|Me)$/;
const SETTINGS = /^(设置|Settings)$/;
const CAPABILITIES = /^(能力|Capabilities)$/;
const BUILTIN_BROWSER = /^(阿布内置浏览器|Abu built-in browser)$/;
const MY_CHROME = /^(我的 Chrome|My Chrome)$/;
const COMPUTER_USE = /^(电脑操控|Computer Use)$/;
const READY = /^(已就绪|Ready)$/;
const NOT_CONNECTED = /^(未连接|Not connected)$/;
const SETUP_REQUIRED = /^(需要设置|Setup required)$/;
const OFF = /^(已关闭|Off)$/;
const START_SETUP = /^(开始设置|Start setup)$/;
const ENABLE = /^(开启|Enable)$/;
const CONNECT_CHROME = /^(连接 Chrome|Connect Chrome)$/;
const CHROME_HEADER = /^(我的 Chrome|My Chrome)$/;
const COMPUTER_OFF_ACTION = /^(开启|Enable)$/;
const DISCONNECT = /^(断开|Disconnect)$/;
const INSTALL_STEPS = /^(安装扩展|Install the extension)$/;
const BACK_TO_CAPABILITIES = /^(返回能力|Back to Capabilities)$/;
const COMPUTER_SETUP = /^(开启电脑操控|Enable Computer Use)$/;
const QUICK_START = /^(快速入门|Quick Start)$/;
const MANAGE = /^(管理|Manage)$/;
const ACTION_PERMISSIONS = /^(操作权限|Action permissions)$/;
const AUTOMATIC_TASKS = /^(自动任务|Automatic tasks)$/;
const RUN_SCRIPTS = /^(运行脚本（高级）|Run scripts \(advanced\))$/;
const SITE_PERMISSIONS = /^(网站授权|Site permissions)$/;
const VIEW_PAGES = /^(只看页面|View pages)$/;
const CLICK_AND_FILL = /^(点击和填写|Click and fill in)$/;
const CHROME_CAVEAT = /(登录失效|expired sign-in)/;
const ADD_SITE_LABEL = /^(网站地址|Site address)$/;
const ADD_SITE_BUTTON = /^(添加|Add)$/;
const AUTOMATION_NAV = /^(自动化|Automation)$/;
const SCHEDULED_TASKS_TAB = /^(定时任务|Scheduled Tasks)$/;
const NEW_TASK = /^(新建任务|New Task)$/;

/** Seeded site verdicts, so the list page has something to show. */
const SEEDED_SITES = {
  'https://example.com': 'denied',
  'https://reports.example.com': 'allowed',
  'https://www.baidu.com': 'allowed',
} as const;

async function waitForWelcomeScreen(page: Page): Promise<void> {
  await page.waitForLoadState('domcontentloaded');
  await expect(
    page.getByText(WELCOME).or(page.getByPlaceholder(CHAT_PLACEHOLDER)).first(),
  ).toBeVisible({ timeout: READY_TIMEOUT });

  const quickStart = page.getByText(QUICK_START, { exact: true });
  await quickStart.waitFor({ state: 'visible', timeout: 1_500 }).catch(() => {});
  if (await quickStart.isVisible()) {
    await page.keyboard.press('Escape');
    await expect(quickStart).toBeHidden();
  }
}

/**
 * The overview card for a capability: a single button whose accessible name
 * is `<capability> · <status>` (the badge is the point of the row, so it is
 * part of the name). Matched on the leading capability name, which is why the
 * shared `$`-anchored constants get their tail anchor dropped here.
 */
function capabilityCard(page: Page, title: RegExp) {
  return page.getByRole('button', { name: new RegExp(title.source.replace(/\$$/, '')) });
}

/**
 * Write persisted settings straight into the real store and reload, so the
 * page under test renders the state a returning user would actually see.
 */
async function seedSettings(
  page: Page,
  patch: Record<string, unknown>,
): Promise<void> {
  await page.evaluate((state) => {
    const raw = window.localStorage.getItem('abu-settings');
    if (!raw) throw new Error('abu-settings was not initialized');
    const persisted = JSON.parse(raw) as { state: Record<string, unknown>; version: number };
    Object.assign(persisted.state, state);
    window.localStorage.setItem('abu-settings', JSON.stringify(persisted));
  }, patch);
  await page.reload();
}

async function openCapabilities(page: Page): Promise<void> {
  await page.getByRole('button', { name: ACCOUNT }).click();
  await page.getByRole('menuitem', { name: SETTINGS }).click();
  await page.getByRole('button', { name: CAPABILITIES }).click();
}

let app: ElectronApplication | undefined;
let dataRoot: ElectronDataRoot | undefined;

test.describe.serial('Electron capability overview', () => {
  test.afterEach(async () => {
    if (app) {
      await closeAbuElectron(app);
      app = undefined;
    }
    if (dataRoot) {
      removeElectronDataRoot(dataRoot);
      dataRoot = undefined;
    }
  });

  test('shows real runtime readiness and keeps optional capabilities explicit', async () => {
    const launched = await launchAbuElectron();
    app = launched.app;
    dataRoot = launched;

    const page = await app.firstWindow({ timeout: READY_TIMEOUT });
    await waitForWelcomeScreen(page);

    await openCapabilities(page);

    const builtinBrowser = capabilityCard(page, BUILTIN_BROWSER);
    const myChrome = capabilityCard(page, MY_CHROME);
    const computerUse = capabilityCard(page, COMPUTER_USE);

    await expect(builtinBrowser.getByText(READY)).toBeVisible({ timeout: READY_TIMEOUT });
    await expect(computerUse.getByText(OFF)).toBeVisible({ timeout: READY_TIMEOUT });

    // This machine has no extension installed, and that is ONE state with one
    // description. It used to depend on whether the local bridge finished
    // connecting before the probe answered — amber "setup required" if the
    // probe won, grey "not connected" if it lost. The badge is now decided by
    // whether the extension has ever handshaked, which never un-happens, so
    // the amber fault must not appear at any point.
    await expect(myChrome.getByText(NOT_CONNECTED))
      .toBeVisible({ timeout: READY_TIMEOUT });
    await expect(myChrome.getByText(SETUP_REQUIRED)).toHaveCount(0);
    await expect(myChrome.getByText(READY)).toHaveCount(0);

    // Not connected is not a fault, so the card spends its one line on what
    // connecting would buy rather than restating the badge next to it.
    await expect(myChrome).toContainText(/Chrome tabs|Chrome 标签页/);
    // The overview carries decisions ABOUT capabilities, never the rules
    // inside them — those all live one level down now.
    await expect(page.getByText(ACTION_PERMISSIONS)).toHaveCount(0);
    await expect(page.getByText(SITE_PERMISSIONS)).toHaveCount(0);
    // User ruling 2026-09-04: the card row IS the control. No per-card text
    // buttons anywhere on the overview.
    await expect(page.getByRole('button', { name: MANAGE })).toHaveCount(0);
    await expect(page.getByRole('button', { name: CONNECT_CHROME })).toHaveCount(0);
    await expect(page.getByRole('button', { name: START_SETUP })).toHaveCount(0);
    await expect(builtinBrowser).toBeVisible();
    // ...and the row itself is the button, including for the capability whose
    // card used to carry "Start setup": clicking it drills in.
    await expect(computerUse).toHaveJSProperty('tagName', 'BUTTON');

    // Let the previous navigation item's color transition finish so the visual
    // artifact reflects the stable selected state.
    await page.waitForTimeout(250);
    fs.mkdirSync(path.dirname(SCREENSHOT_PATH), { recursive: true });
    await page.screenshot({ path: SCREENSHOT_PATH });

    // Entering setup is side-effect free: installation and OS permission
    // prompts only start from explicit buttons inside each guide. Abu's
    // first-party local bridge is already prepared in the background.
    await myChrome.click();
    await expect(page.getByRole('heading', { name: CHROME_HEADER })).toBeVisible();
    // Install guidance is for someone with no extension attached, and the
    // developer-mode warning now lives inside it rather than on its own.
    await expect(page.getByText(INSTALL_STEPS)).toBeVisible();
    await expect(page.getByText(/local extension|本地扩展/)).toBeVisible();
    await expect(page.getByText(/Chrome Web Store|Chrome 应用商店/)).toBeVisible();
    // Nothing is connected, so nothing offers to disconnect it.
    await expect(page.getByRole('button', { name: DISCONNECT })).toHaveCount(0);
    const chromeCheckButton = page.getByRole('button', {
      name: /^(检查连接|Check connection)$/,
    });
    await expect(chromeCheckButton).toBeEnabled({ timeout: READY_TIMEOUT });
    await expect(chromeCheckButton.locator('.animate-spin')).toHaveCount(0);
    await page.waitForTimeout(2_500);
    await expect(chromeCheckButton.locator('.animate-spin')).toHaveCount(0);
    await page.getByRole('button', { name: BACK_TO_CAPABILITIES }).click();

    await computerUse.click();
    await expect(page.getByRole('heading', { name: COMPUTER_USE })).toBeVisible();
    await expect(page.getByRole('button', { name: ENABLE })).toBeVisible();
    await expect(page.getByText(/current task needs|当前任务需要/)).toHaveCount(0);
    await page.getByRole('button', { name: ENABLE }).click();
    await expect(page.getByText(/View screen|查看屏幕/, { exact: true }).first()).toBeVisible();
    await expect(page.getByText(/Control interface|操作界面/, { exact: true }).first()).toBeVisible();

    const computerCheckButton = page.getByRole('button', {
      name: /^(重新检查|Check again)$/,
    });
    if (await computerCheckButton.isVisible()) {
      await expect(computerCheckButton).toBeEnabled({ timeout: READY_TIMEOUT });
      await expect(computerCheckButton.locator('.animate-spin')).toHaveCount(0);
      await page.waitForTimeout(2_500);
      await expect(computerCheckButton.locator('.animate-spin')).toHaveCount(0);
    }
    await page.screenshot({ path: COMPUTER_SETUP_SCREENSHOT_PATH });
  });

  /**
   * The capability information architecture, walked end to end in the real
   * shell: overview → each channel's own page → the site list two levels down,
   * and back out through the breadcrumb every time.
   *
   * It also captures one screenshot per screen. Layout of a settings page is
   * not something an assertion can review, and these are the artifacts a human
   * looks at before the redesign ships.
   */
  test('drills into every capability page and back out through the breadcrumb', async () => {
    const launched = await launchAbuElectron();
    app = launched.app;
    dataRoot = launched;

    const page = await app.firstWindow({ timeout: READY_TIMEOUT });
    await waitForWelcomeScreen(page);
    // The master switch is seeded on because the scripting risk warning only
    // fires while it is, and that warning is what screenshot 08 is about.
    await seedSettings(page, {
      browserSitePermissions: SEEDED_SITES,
      allowUnattendedBrowser: true,
    });
    await waitForWelcomeScreen(page);
    await openCapabilities(page);

    // ---- Level 1 --------------------------------------------------------
    await expect(capabilityCard(page, BUILTIN_BROWSER).getByText(READY))
      .toBeVisible({ timeout: READY_TIMEOUT });
    await page.waitForTimeout(250);
    await page.screenshot({ path: iaScreenshot('01-capabilities-overview-zh') });

    // ---- Built-in browser detail ----------------------------------------
    await capabilityCard(page, BUILTIN_BROWSER).click();

    await expect(page.getByText(ACTION_PERMISSIONS)).toBeVisible();
    await expect(page.getByText(VIEW_PAGES)).toBeVisible();
    await expect(page.getByText(CLICK_AND_FILL)).toBeVisible();
    // Scripting is its own card, not a third row of the matrix.
    const matrix = page.locator('div.rounded-lg.border').filter({
      has: page.getByText(ACTION_PERMISSIONS, { exact: true }),
    }).first();
    await expect(matrix.getByText(RUN_SCRIPTS)).toHaveCount(0);
    await expect(page.getByText(RUN_SCRIPTS).first()).toBeVisible();
    await expect(page.getByText(AUTOMATIC_TASKS).first()).toBeVisible();
    // The Chrome-channel caveat belongs to the Chrome page only.
    await expect(page.getByText(CHROME_CAVEAT)).toHaveCount(0);
    // U1 — a working built-in browser reports no status: the badge and the
    // "its own session" note were the title and the card badge said twice.
    await expect(page.getByText(READY)).toHaveCount(0);
    await page.screenshot({ path: iaScreenshot('02-builtin-browser-detail-zh') });

    // The page is taller than the settings pane, and the scripting card plus
    // the site-authorization card are the half a reviewer most needs to see.
    const siteCardHeading = page.getByText(SITE_PERMISSIONS, { exact: true }).first();
    await siteCardHeading.scrollIntoViewIfNeeded();
    await page.waitForTimeout(150);
    await page.screenshot({ path: iaScreenshot('02b-builtin-browser-detail-scrolled-zh') });

    /*
      What each option MEANS lives inside the option — the reason there is no
      ⓘ anywhere on this page — and that is only visible with a menu open.

      The scripting card is the one worth photographing: it is the menu that
      used to be painted over by the site-permissions card directly below it,
      and since the 2026-09-04 column collapse there is exactly ONE dropdown
      on it, not one per run mode.
    */
    const scriptCard = page
      .locator('div.rounded-lg.border')
      .filter({ has: page.getByText(RUN_SCRIPTS, { exact: true }) })
      .first();
    const scriptCell = scriptCard.locator('button[aria-expanded]');
    await expect(scriptCell).toHaveCount(1);
    await scriptCell.scrollIntoViewIfNeeded();
    await scriptCell.click();

    /*
      One setting, two execution contexts — so 「每次询问」 has to say both, on
      one line: a dialog while the user is here, and the IM channel the task
      itself named when it is running alone (`core/im/approvalTarget.ts`),
      refused when none is bound. The two withdrawn per-column strings must
      not survive anywhere on this surface.
    */
    const askOption = page.getByText(
      /你在场时弹窗确认，自动任务发到 IM 审批|Asks you here, and over IM in automatic tasks/,
    );
    await expect(askOption).toBeVisible();
    await expect(page.getByText(/只在始终允许的网站上生效|Only on sites set to Always allow/))
      .toHaveCount(0);
    await expect(page.getByText(/发到任务绑定的 IM 频道确认|Asks in the task's IM channel/))
      .toHaveCount(0);

    /*
      The menu is exactly as wide as the trigger that opened it. It used to be
      shrink-to-fit with a min-width floor, so this description — one unbroken
      line — set the width and the menu spilled ~560px across a 185px control.
    */
    const [menuBox, triggerBox] = await Promise.all([
      page.locator(`#${await scriptCell.getAttribute('aria-controls')}`).boundingBox(),
      scriptCell.boundingBox(),
    ]);
    expect(menuBox).not.toBeNull();
    expect(Math.abs(menuBox!.width - triggerBox!.width)).toBeLessThanOrEqual(1);

    /*
      Unclipped is the whole point of the portal fix, and "visible" does not
      prove it — the card below used to paint straight over this menu while
      every element in it stayed "visible" to the DOM. So ask the document
      what is actually on top at the option's own centre.
    */
    const askBox = await askOption.boundingBox();
    expect(askBox).not.toBeNull();
    const topmostText = await page.evaluate(({ x, y }) => {
      const el = document.elementFromPoint(x, y);
      return el?.closest('button')?.textContent?.trim() ?? el?.textContent?.trim() ?? '';
    }, {
      x: askBox!.x + askBox!.width / 2,
      y: askBox!.y + askBox!.height / 2,
    });
    expect(topmostText).toMatch(/每次询问|Ask every time/);

    /*
      The ⚠ line the 2026-09-04 ruling requires: it must NOT be sitting there
      by default (scripting ships as 「每次询问」), and it must appear directly
      under this select the moment 「允许」 is the selected value.
      Photographed for the IA record.
    */
    const riskWarning = page.getByText(/风险升高|Elevated risk/);
    await expect(riskWarning).toHaveCount(0);
    await page.getByText(/^在允许的网站上不再询问$|^Never asks again on allowed sites$/).click();
    await expect(riskWarning).toBeVisible();
    await page.waitForTimeout(150);
    await page.screenshot({ path: iaScreenshot('08-script-allow-warning-zh') });

    // Put the row back to the SHIPPED DEFAULT — 「每次询问」, not 「拒绝」 —
    // so the shot below photographs the surface a new install actually shows.
    // (It used to click 「拒绝」, which was the default only until the ruling
    // moved the automatic-task scripting cell to 「每次询问」.)
    await scriptCell.click();
    await askOption.click();
    await expect(scriptCell).toContainText(/每次询问|Ask every time/);
    await expect(riskWarning).toHaveCount(0);
    await scriptCell.click();
    await expect(askOption).toBeVisible();

    await page.waitForTimeout(150);
    await page.screenshot({ path: iaScreenshot('07-select-open-zh') });

    // Dismiss by clicking outside, NOT with Escape: the settings dialog closes
    // itself on Escape regardless of what is open inside it, so Escape here
    // would take the whole page down rather than just this menu.
    await page.getByText(ACTION_PERMISSIONS).first().click();
    await expect(askOption).toHaveCount(0);

    // ---- Site list, two levels down -------------------------------------
    // Same rule as the overview: the row drills in, no text button.
    await expect(page.getByRole('button', { name: MANAGE })).toHaveCount(0);
    await page.getByRole('button', { name: SITE_PERMISSIONS }).click();

    await expect(page.getByTitle('https://reports.example.com')).toBeVisible();
    await expect(page.getByTitle('https://example.com')).toBeVisible();
    await page.screenshot({ path: iaScreenshot('03-site-permissions-list-zh') });

    /*
      F1 — the list is also where a verdict is CREATED. Until this row existed
      the only road to 「始终允许」 ran through the confirmation dialog, so
      preparing a scheduled task meant running it attended, being refused,
      clicking allow, and re-running. Driven here through the real keyboard,
      because "Enter submits" is the interaction a user actually performs and
      no unit test exercises the real shell's key handling.
    */
    const addField = page.getByLabel(ADD_SITE_LABEL);
    await expect(addField).toBeVisible();
    await addField.fill('https://Added.Example.com/reports?q=1');
    await addField.press('Enter');

    // Normalized the same way the gate resolves a live tab: lowercased host,
    // no path, no query.
    await expect(page.getByTitle('https://added.example.com')).toBeVisible();
    await expect(addField).toHaveValue('');
    await page.screenshot({ path: iaScreenshot('09-site-list-add-zh') });

    // A bank cannot be given a standing grant by typing its address, the same
    // way the confirmation dialog withholds one there.
    await addField.fill('https://www.paypal.com');
    await page.getByRole('button', { name: ADD_SITE_BUTTON }).click();
    await expect(
      page.getByText(/不能设为「始终允许」|cannot be set to Always allow/),
    ).toBeVisible();
    await expect(page.getByTitle('https://www.paypal.com')).toHaveCount(0);
    await addField.fill('');

    // One step up lands on the page we came from, not the overview.
    await page.getByRole('button', { name: BUILTIN_BROWSER }).click();
    await expect(page.getByText(ACTION_PERMISSIONS)).toBeVisible();
    await expect(page.getByTitle('https://example.com')).toHaveCount(0);

    await page.getByRole('button', { name: BACK_TO_CAPABILITIES }).click();
    await expect(capabilityCard(page, MY_CHROME)).toBeVisible();

    // ---- My Chrome detail: same skeleton, one extra warning -------------
    await capabilityCard(page, MY_CHROME).click();
    await expect(page.getByRole('heading', { name: CHROME_HEADER })).toBeVisible();
    // Header carries the one-liner, not the paragraph it used to open with.
    await expect(page.getByText(/复用你已登录的 Chrome 标签页/)).toBeVisible();
    await expect(page.getByText(/让阿布在你明确要求时使用现有标签页/)).toHaveCount(0);
    // One status row, one action — and on a machine with no extension the
    // action is never "disconnect".
    await expect(page.getByText(NOT_CONNECTED)).toBeVisible();
    await expect(page.getByRole('button', { name: DISCONNECT })).toHaveCount(0);
    await expect(page.getByText(ACTION_PERMISSIONS)).toBeVisible();
    await expect(page.getByText(SITE_PERMISSIONS).first()).toBeVisible();
    await page.screenshot({ path: iaScreenshot('04-my-chrome-detail-zh') });

    // The one warning this page exists to carry sits below the fold, so the
    // visual record scrolls to it rather than proving only that it rendered.
    const caveat = page.getByText(CHROME_CAVEAT).first();
    await expect(caveat).toBeVisible();
    await caveat.scrollIntoViewIfNeeded();
    await page.waitForTimeout(150);
    await page.screenshot({ path: iaScreenshot('04b-my-chrome-caveat-zh') });

    await page.getByRole('button', { name: BACK_TO_CAPABILITIES }).click();

    // ---- Computer Use detail: now owns the active-model block -----------
    await capabilityCard(page, COMPUTER_USE).click();
    // Titled by the capability, like the other two pages — the verb lives on
    // the status row's button.
    await expect(page.getByRole('heading', { name: COMPUTER_USE })).toBeVisible();
    await expect(page.getByText(COMPUTER_SETUP, { exact: true })).toHaveCount(0);
    await expect(page.getByText(/^(当前模型|Current model)$/)).toBeVisible();
    // Same skeleton: the one-line subtitle, then ONE status row saying it is
    // off with the single button that changes that — no consent callout, and
    // no closing paragraph restating both.
    await expect(page.getByText(/读取屏幕并操作界面|Reads the screen and operates/)).toBeVisible();
    await expect(page.getByText(OFF)).toBeVisible();
    await expect(page.getByRole('button', { name: COMPUTER_OFF_ACTION })).toBeVisible();
    await expect(page.getByText(/阿布不会自行开启电脑操控|cannot enable Computer Use by itself/))
      .toHaveCount(0);
    await expect(page.getByText(/敏感应用和危险按键|dangerous key combinations/)).toHaveCount(0);
    await page.screenshot({ path: iaScreenshot('05-computer-use-detail-zh') });

    await page.getByRole('button', { name: BACK_TO_CAPABILITIES }).click();
    await expect(capabilityCard(page, BUILTIN_BROWSER)).toBeVisible();

    // ---- The same overview in en-US -------------------------------------
    await seedSettings(page, { language: 'en-US' });
    await waitForWelcomeScreen(page);
    await openCapabilities(page);
    await expect(page.getByText(/^Abu built-in browser$/)).toBeVisible();
    await expect(
      capabilityCard(page, /^Abu built-in browser$/).getByText(/^Ready$/),
    ).toBeVisible({ timeout: READY_TIMEOUT });
    await page.waitForTimeout(250);
    await page.screenshot({ path: iaScreenshot('06-capabilities-overview-en') });
  });

  /**
   * F2 — the other half of the approval story, on the screen where a user
   * actually sets an automatic task up.
   *
   * The field is the only IM-channel-shaped control on that page, and it
   * invites exactly one question: "is this where the task asks me?" It now
   * is. The scheduler builds its approval target from these same fields
   * (`core/im/approvalTarget.ts`), so a confirmation lands where the results
   * land — and 「不推送」 means an ask has nowhere to go and is refused. The
   * label and the hint have to say both halves, or the user learns the second
   * one as a nightly task that quietly achieved nothing.
   */
  test('names the task editor channel as the approvals channel too', async () => {
    const launched = await launchAbuElectron();
    app = launched.app;
    dataRoot = launched;

    const page = await app.firstWindow({ timeout: READY_TIMEOUT });
    await waitForWelcomeScreen(page);

    await page
      .getByRole('navigation', { name: /^(Main navigation|主导航)$/ })
      .getByRole('button', { name: AUTOMATION_NAV })
      .evaluate((element: HTMLElement) => element.click());
    const tab = page.getByRole('button', { name: SCHEDULED_TASKS_TAB });
    await expect(tab).toBeVisible({ timeout: READY_TIMEOUT });
    await tab.click();
    // Scoped to the content area: the sidebar carries a "new task" of its own
    // (it starts a chat), and only the header one opens this editor.
    await page.getByRole('main').getByRole('button', { name: NEW_TASK }).click();

    const hint = page.getByText(
      /运行中需要你确认的操作也会发到这里|actions that need your confirmation during the run are sent here too/,
    );
    await hint.scrollIntoViewIfNeeded();
    await expect(hint).toBeVisible();
    // ...and the other half: choosing 不推送 is choosing to have those asks
    // refused, which is the fact a user setting up a task must not learn later.
    await expect(
      page.getByText(/需要确认的操作会被自动拒绝|refused automatically/),
    ).toBeVisible();
    // The label carries both jobs now, because the field does both.
    await expect(
      page.getByText(/^(结果与审批推送频道|Results & approvals channel)$/),
    ).toBeVisible();

    await page.waitForTimeout(150);
    await page.screenshot({ path: iaScreenshot('10-schedule-editor-channel-zh') });
  });

  test('rejects a direct privileged Computer Use IPC call without a task token', async () => {
    const launched = await launchAbuElectron();
    app = launched.app;
    dataRoot = launched;

    const page = await app.firstWindow({ timeout: READY_TIMEOUT });
    await waitForWelcomeScreen(page);

    const result = await page.evaluate(async () => {
      try {
        const tauri = (
          globalThis as typeof globalThis & {
            __TAURI_INTERNALS__?: {
              invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown>;
            };
          }
        ).__TAURI_INTERNALS__;
        if (!tauri) return { error: 'Tauri bridge unavailable' };
        await tauri.invoke('capture_screen', {});
        return { error: null };
      } catch (error) {
        return {
          error: error instanceof Error ? error.message : String(error),
        };
      }
    });

    expect(result.error).toMatch(
      /(?:requires an authorization token|authorization token is required)/i,
    );
  });

  // RB-04, in the real shell: drives the actual main process over the real
  // IPC for 31 actions in ONE task (same conversation + loop), which is what
  // the renderer would spread across many batches and reset each time.
  //
  // Which property this can prove depends on whether this machine grants the
  // OS permission a Computer Use action needs, so it asserts whichever one
  // the environment allows — both are properties of the same fix, and
  // neither branch lets a regression through:
  //
  //  - permission granted → actions authorize, so the 31st must be refused
  //    for budget. A per-batch reset would let it run forever.
  //  - permission absent → every action is refused before it is charged, so
  //    NO call may ever come back with a step-limit error. Charging up front
  //    (the shape this fix corrected) would burn the budget on refusals and
  //    surface a bogus "30-step limit" for a task that never acted.
  test('enforces the Computer Use step budget in the main process, across batches', async () => {
    const launched = await launchAbuElectron();
    app = launched.app;
    dataRoot = launched;

    const page = await app.firstWindow({ timeout: READY_TIMEOUT });
    await waitForWelcomeScreen(page);

    const errors = await page.evaluate(async () => {
      const tauri = (
        globalThis as typeof globalThis & {
          __TAURI_INTERNALS__?: {
            invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown>;
          };
        }
      ).__TAURI_INTERNALS__;
      if (!tauri) return ['Tauri bridge unavailable'];

      await tauri.invoke('computer_use_set_enabled', { enabled: true });

      const collected: string[] = [];
      for (let i = 0; i < 31; i++) {
        try {
          await tauri.invoke('computer_use_begin_session', {
            conversationId: 'e2ecuconv',
            loopId: 'e2eculoop',
            toolCallId: `e2ecutool${i}`,
            interactionMode: 'foreground',
            scope: 'screen-read',
            permissionMode: 'standard',
            actionIntent: { action: 'screenshot', category: 'none', summary: '' },
          });
          collected.push('');
        } catch (error) {
          collected.push(error instanceof Error ? error.message : String(error));
        }
      }
      return collected;
    });

    expect(errors).toHaveLength(31);
    const actionsAuthorize = errors[0] === '';

    if (actionsAuthorize) {
      for (const [index, message] of errors.slice(0, 30).entries()) {
        expect(message, `step ${index + 1}`).not.toMatch(/step limit/i);
      }
      expect(errors[30]).toMatch(/30-step limit/i);
    } else {
      for (const [index, message] of errors.entries()) {
        expect(message, `attempt ${index + 1}`).not.toMatch(/step limit/i);
      }
    }
  });
});
