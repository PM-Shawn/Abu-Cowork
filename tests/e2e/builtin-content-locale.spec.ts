/**
 * What ships with Abu reads in the interface language: the six expert teams
 * (card and detail), the built-in skills (card), and the three apps of the
 * official market (market card, who they hand work to, home page). Runs the
 * real Electron shell once and walks the same places in en-US and in zh-CN.
 *
 * Each walk attaches what it read (`texts.json`), so a run also serves as a
 * record of the shipped copy in that language.
 */
import { test, expect, type ElectronApplication, type Locator, type Page } from '@playwright/test';
import {
  closeAbuElectron,
  dismissFirstRunOverlays,
  launchAbuElectron,
  pressWhenSettled,
  removeElectronDataRoot,
  type ElectronDataRoot,
} from './electronHelpers';

type Locale = 'zh-CN' | 'en-US';

const READY_TIMEOUT = 45_000;
const CJK = /[㐀-鿿]/;
const COMPOSER = /^(想让阿布帮你做点什么？|What can Abu help you with\?)$/;
const TEAM_NAV = /^(专家|Experts)$/;
const TEAMS_TAB = /^(专家团|Expert Teams)(\s.*)?$/;
const EXTENSIONS = /^(扩展|Extensions)(\s.*)?$/;
const SKILLS_TAB = /^(技能|Skills)(\s.*)?$/;

/** Team cards carry their test id by the stored (Chinese) name in every language. */
const TEAMS: Array<{ stored: string } & Record<Locale, { name: string; description: string }>> = [
  {
    stored: '软件研发专家团',
    'zh-CN': { name: '软件研发专家团', description: '从需求到可运行的软件：产品经理拆需求，工程师、设计师实现，测试把关' },
    'en-US': { name: 'Software Development Team', description: 'From requirements to working software: the product manager scopes it, the engineer and designer build it, QA signs off' },
  },
  {
    stored: '数据分析专家团',
    'zh-CN': { name: '数据分析专家团', description: '从数据到结论：分析师主导，调研补外部事实，文档专家出交付件' },
    'en-US': { name: 'Data Analysis Team', description: 'From data to conclusions: the analyst leads, the researcher adds outside facts, the document expert delivers the files' },
  },
  {
    stored: '内容创作专家团',
    'zh-CN': { name: '内容创作专家团', description: '从选题到成稿：编辑定选题写稿，调研补素材，设计师出配图和页面' },
    'en-US': { name: 'Content Creation Team', description: 'From topic to finished piece: the editor picks the topic and writes, the researcher finds material, the designer makes the visuals and pages' },
  },
  {
    stored: '汇报材料专家团',
    'zh-CN': { name: '汇报材料专家团', description: '周报、月报、季度汇报一站式：文档专家统稿，分析师出数据，调研补背景' },
    'en-US': { name: 'Reporting Team', description: 'Weekly, monthly and quarterly reports in one place: the document expert edits, the analyst provides the numbers, the researcher adds background' },
  },
  {
    stored: '财务对账专家团',
    'zh-CN': { name: '财务对账专家团', description: '从票据到台账：财务助理对账，分析师查异常，文档专家出报表' },
    'en-US': { name: 'Finance Reconciliation Team', description: 'From receipts to ledger: the finance assistant reconciles, the analyst checks anomalies, the document expert produces the reports' },
  },
  {
    stored: '招聘专家团',
    'zh-CN': { name: '招聘专家团', description: '从岗位到 offer：招聘官定标准，调研专家摸行情，文档专家出材料' },
    'en-US': { name: 'Recruiting Team', description: 'From role to offer: the recruiter sets the bar, the researcher checks the market, the document expert prepares the materials' },
  },
];

const RECRUITING_DETAIL: Record<Locale, { expertise: string[]; prompts: string[] }> = {
  'zh-CN': {
    expertise: ['岗位画像与 JD 撰写', '薪资行情与候选人背景调研', '面试题与评估表'],
    prompts: ['帮我写一份高级前端的 JD 并定好面试题', '查一下这个岗位在北京的薪资行情', '把这几份简历按岗位要求排个序', '准备一套后端岗的面试评估表'],
  },
  'en-US': {
    expertise: ['Role profiles and JD writing', 'Salary market and candidate background research', 'Interview questions and scorecards'],
    prompts: ['Write a senior front-end JD with interview questions', 'Check the salary market for this role in Beijing', 'Rank these resumes against the role', 'Prepare interview scorecards for a back-end role'],
  },
};

const RECRUITING_LEADER_NOTE = '先把岗位要求、预算和时间线问清楚再动手；薪资行情必须让调研专家去取证并附来源，不要凭印象报数。';

// The official market's app. Its experts and teams come with the plugin 电商运营包, installed
// together with the app; `firstSceneLead` is the team on the first scene of its home.
const APPS: Array<{ appId: string } & Record<Locale, { name: string; description: string; firstSceneLead: string }>> = [
  {
    appId: 'ecommerce@abu-official',
    'zh-CN': { name: '电商运营', description: '上新、大促、店铺诊断、客服售后、库存，一个应用办完', firstSceneLead: '新品上架团' },
    'en-US': { name: 'E-commerce Ops', description: 'Launches, campaigns, store diagnosis, customer service and inventory in one app', firstSceneLead: 'New Product Launch Team' },
  },
];

const SKILL_SAMPLES: Array<{ name: string } & Record<Locale, string>> = [
  { name: 'alert-sop', 'zh-CN': '自动分析告警信息，按 SOP 排查问题并生成处理报告', 'en-US': 'Analyze an alert, investigate it by the SOP and write a handling report' },
  { name: 'docx', 'zh-CN': '创建、读取和编辑 Word 文档（.docx）', 'en-US': 'Create, read and edit Word documents (.docx)' },
  { name: 'pdf', 'zh-CN': '读取、合并、分割 PDF，提取内容、填写表单和渲染预览', 'en-US': 'Read, merge, split, create, fill in and preview PDF files' },
  { name: 'trigger', 'zh-CN': '创建和管理监听：事件发生或文件变化时自动执行任务', 'en-US': 'Create and manage listeners that run a task when an event fires' },
];

async function setLanguage(page: Page, language: Locale): Promise<void> {
  await Promise.all([page.waitForEvent('load'), page.evaluate(async (value) => {
    await navigator.locks.request('abu-browser-permission-config-v2', () => {
      const raw = window.localStorage.getItem('abu-settings');
      if (!raw) throw new Error('abu-settings was not initialized');
      const persisted = JSON.parse(raw) as { state: Record<string, unknown>; version: number };
      persisted.state.language = value;
      window.localStorage.setItem('abu-settings', JSON.stringify(persisted));
      window.location.reload();
    });
  }, language)]);
  await expect(page.locator('html')).toHaveAttribute('lang', language, { timeout: READY_TIMEOUT });
  await expect(page.getByTestId('app-switcher-trigger')).toBeVisible({ timeout: READY_TIMEOUT });
}

const textOf = async (locator: Locator): Promise<string> => (await locator.innerText()).replace(/\s+/g, ' ').trim();

async function openSwitcher(page: Page): Promise<void> {
  await page.getByTestId('app-switcher-trigger').click();
  await expect(page.getByTestId('app-switcher-menu')).toBeVisible();
}

/** The walk assumes the general shell: inside an app the experts page opens on the app's own teams. */
async function leaveApp(page: Page): Promise<void> {
  await openSwitcher(page);
  const general = page.getByTestId('app-switcher-item-__general__');
  if (await general.count() > 0) await general.click();
  else await page.keyboard.press('Escape');
  await expect(page.getByTestId('app-switcher-menu')).toBeHidden();
  await expect(page.getByPlaceholder(COMPOSER)).toBeVisible({ timeout: READY_TIMEOUT });
}

async function readTeams(page: Page, locale: Locale) {
  await page.getByLabel('Main navigation').getByRole('button', { name: TEAM_NAV }).click();
  await page.getByRole('button', { name: TEAMS_TAB }).click();
  await page.getByTestId('team-source-market').click();
  // 市场 also lists the teams the e-commerce app's plugin brought, each tagged with its source.
  const shipped = page.locator('[data-team-card]').filter({ hasNot: page.getByTestId('source-badge') });
  await expect(shipped).toHaveCount(TEAMS.length, { timeout: READY_TIMEOUT });
  const cards: string[] = [];
  for (const team of TEAMS) {
    const card = page.getByTestId(`team-row-${team.stored}`);
    await expect(card).toContainText(team[locale].name);
    await expect(card).toContainText(team[locale].description);
    cards.push(await textOf(card));
  }

  const recruiting = TEAMS[TEAMS.length - 1];
  await page.getByTestId(`team-row-${recruiting.stored}`).click();
  const detail = page.getByRole('dialog', { name: recruiting[locale].name });
  await expect(detail).toBeVisible();
  // The name is there twice: the window's hidden title and the header row.
  await expect(detail.getByText(recruiting[locale].name, { exact: true }).last()).toBeVisible();
  await expect(detail.getByText(recruiting[locale].description, { exact: true })).toBeVisible();
  const expertise = detail.getByTestId('team-detail-expertise').getByRole('listitem');
  const prompts = detail.getByTestId('team-detail-sample-prompts').getByRole('listitem');
  await expect(expertise).toHaveText(RECRUITING_DETAIL[locale].expertise);
  await expect(prompts).toHaveText(RECRUITING_DETAIL[locale].prompts);
  // The leader's briefing is the work instruction the leader's prompt carries. It has one text,
  // shown as written in every language, so it is read apart from the rest of the window.
  const leaderNote = await textOf(detail.getByTestId('team-detail-leader-note'));
  expect(leaderNote).toContain(RECRUITING_LEADER_NOTE);
  const windowLines = (await detail.innerText()).split('\n').map((line) => line.trim()).filter((line) => line !== '');
  const read = {
    cards,
    detail: {
      name: recruiting[locale].name,
      description: recruiting[locale].description,
      expertise: await expertise.allInnerTexts(),
      samplePrompts: await prompts.allInnerTexts(),
      leaderNote,
      /** Every line of the window but the briefing's own text: leader, members, labels, skills, buttons. */
      window: windowLines.filter((line) => line !== RECRUITING_LEADER_NOTE),
    },
  };
  await page.keyboard.press('Escape');
  await expect(detail).toBeHidden();
  return read;
}

async function readSkills(page: Page, locale: Locale) {
  await page.getByLabel('Main navigation').getByRole('button', { name: EXTENSIONS }).click();
  await page.getByRole('main').getByRole('button', { name: SKILLS_TAB }).click();
  await page.getByTestId('extensions-source-market').click();
  // 市场 also lists the skills the e-commerce app's plugin brought, each tagged with its source.
  const cards = page.locator('[data-skill-entry]').filter({ hasNot: page.getByTestId('source-badge') });
  await expect(page.locator('[data-skill-entry="docx"]')).toBeVisible({ timeout: READY_TIMEOUT });
  for (const sample of SKILL_SAMPLES) {
    await expect(page.locator(`[data-skill-entry="${sample.name}"]`)).toContainText(sample[locale]);
  }
  const read: Record<string, string> = {};
  for (const card of await cards.all()) {
    read[(await card.getAttribute('data-skill-entry'))!] = await textOf(card);
  }
  return read;
}

async function readAppMarket(page: Page, locale: Locale) {
  await openSwitcher(page);
  await page.getByTestId('app-switcher-discover').click();
  const market = page.getByTestId('app-market-dialog');
  await expect(market).toBeVisible({ timeout: READY_TIMEOUT });
  const read: Record<string, string> = {};
  for (const app of APPS) {
    const entry = market.locator(`[data-testid="app-market-entry"][data-app-id="${app.appId}"]`);
    await expect(entry).toBeVisible({ timeout: READY_TIMEOUT });
    await expect(entry.getByText(app[locale].name, { exact: true })).toBeVisible();
    await expect(entry).toContainText(app[locale].description);
    read[app.appId] = await textOf(entry);
  }
  return { market, read };
}

/** Enter the e-commerce app from the market (adding it and its plugin the first time) and read its home. */
async function readAppHome(page: Page, market: Locator, locale: Locale) {
  const ecommerce = APPS[0];
  const entry = market.locator(`[data-testid="app-market-entry"][data-app-id="${ecommerce.appId}"]`);
  const enter = entry.getByTestId('app-market-enter');
  if (await enter.count() > 0) {
    await enter.click();
  } else {
    await entry.getByTestId('app-market-use').click();
    await pressWhenSettled(page.getByTestId('app-add-confirm'));
  }
  await expect(page.getByTestId('app-switcher-current')).toHaveText(ecommerce[locale].name, { timeout: READY_TIMEOUT });
  await expect(market).toBeHidden();
  const scenes = page.getByTestId('app-home-scenes');
  await expect(scenes).toBeVisible({ timeout: READY_TIMEOUT });
  await expect(scenes.locator('[data-testid^="app-home-scene-"]').first()).toContainText(ecommerce[locale].firstSceneLead);
  return {
    switcher: await textOf(page.getByTestId('app-switcher-current')),
    title: await textOf(page.getByTestId('app-home-title')),
    scenes: await scenes.locator('[data-testid^="app-home-scene-"]').allInnerTexts(),
  };
}

test.describe.serial('built-in content follows the interface language', () => {
  let dataRoot: ElectronDataRoot;
  let app: ElectronApplication;
  let page: Page;

  test.beforeAll(async () => {
    const launched = await launchAbuElectron();
    dataRoot = launched;
    app = launched.app;
    page = await app.firstWindow();
    await expect(page.getByLabel('Main navigation')).toBeVisible({ timeout: READY_TIMEOUT });
    await dismissFirstRunOverlays(page, { apps: true });
  });

  test.afterAll(async () => {
    if (app) await closeAbuElectron(app);
    if (dataRoot) removeElectronDataRoot(dataRoot);
  });

  for (const locale of ['en-US', 'zh-CN'] as const) {
    test(`${locale}: expert teams, skills, the app market and an app home`, async ({ browserName: _browserName }, testInfo) => {
      test.setTimeout(240_000);
      await setLanguage(page, locale);
      await leaveApp(page);

      const teams = await readTeams(page, locale);
      const skills = await readSkills(page, locale);
      const { market, read: marketEntries } = await readAppMarket(page, locale);
      const home = await readAppHome(page, market, locale);

      const texts = { locale, teams, skills, market: marketEntries, home };
      await testInfo.attach('texts.json', { body: JSON.stringify(texts, null, 2), contentType: 'application/json' });

      const shown = [
        ...teams.cards, ...teams.detail.window,
        ...Object.values(skills), ...Object.values(marketEntries), home.switcher, home.title, ...home.scenes,
      ];
      expect(Object.keys(skills).length).toBeGreaterThanOrEqual(20);
      if (locale === 'en-US') {
        for (const text of shown) expect(text, text).not.toMatch(CJK);
      } else {
        for (const text of [...teams.cards, ...Object.values(skills), ...Object.values(marketEntries), home.title, ...home.scenes]) {
          expect(text, text).toMatch(CJK);
        }
      }
    });
  }
});
