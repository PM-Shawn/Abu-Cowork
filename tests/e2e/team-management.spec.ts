/**
 * Real-Electron smoke for the 专家团 (Agent Team) management surface — shipped by
 * MVP (docs/abu-team-prd-v2.md). Deterministic per TESTING.md: no LLM provider
 * is configured and nothing here triggers a model run — this covers the
 * management journeys only (execution paths live in orchestrator unit tests).
 *
 * Journey: sidebar entry is there out of the box → tab order
 * 专家·专家团 (task board shelved) → create a team with a builtin leader →
 * team survives an app restart → a row opens the read-only detail (not the
 * edit form) → 删除 behind "…" removes it for good.
 */
import { expect, test } from '@playwright/test';
import type { Page } from 'playwright';
import {
  closeAbuElectron,
  createElectronDataRoot,
  dismissFirstRunOverlays,
  launchAbuElectron,
  removeElectronDataRoot,
} from './electronHelpers';

const READY_TIMEOUT = 45_000;
const CHAT_PLACEHOLDER = '想让阿布帮你做点什么？';
const TEAM_NAME = 'E2E数据小队';
const INTRO = '我们负责梳理需求和检查方案';
const QUESTION = '帮我梳理下个版本的需求';

async function waitForApp(page: Page): Promise<void> {
  await page.waitForLoadState('domcontentloaded');
  await expect(page.getByPlaceholder(CHAT_PLACEHOLDER)).toBeVisible({ timeout: READY_TIMEOUT });
}

async function openTeamSurface(page: Page): Promise<void> {
  await expect(page.getByTestId('sidebar-team')).toBeVisible();
  await page.getByTestId('sidebar-team').click();
}

test.describe('team management surface', () => {
  test('creates and edits a team, persists its identity, prefills a chat and deletes it', async () => {
    test.setTimeout(240_000);
    const dataRoot = createElectronDataRoot();
    try {
      // ---- First launch: the entry is reachable out of the box ------------
      let launched = await launchAbuElectron(dataRoot);
      let page = await launched.app.firstWindow();
      await waitForApp(page);
      await dismissFirstRunOverlays(page);
      await openTeamSurface(page);

      // ---- Tab order (user-pinned 2026-08-31) -----------------------------
      const nav = page.getByTestId('top-tab-nav');
      const labels = await nav.locator('button').allInnerTexts();
      const tabLabels = labels
        .map((l) => l.trim().replace(/\d+$/, '').trim())
        .filter((l) => ['任务', '收件箱', '专家', '专家团'].includes(l));
      expect(tabLabels).toEqual(['专家', '专家团']);

      // ---- Create a team with a builtin leader ----------------------------
      await nav.getByRole('button', { name: '专家团' }).click();
      await page.getByText('新建专家团').first().click();
      await expect(page.getByTestId('team-name-input')).toBeVisible();
      await page.getByTestId('team-name-input').fill(TEAM_NAME);
      const save = page.getByTestId('team-save');
      await expect(save).toBeDisabled(); // no leader yet

      await page.getByTestId('team-leader-select').click();
      await page.getByTestId('search-select-query').fill('产品');
      await page.getByTestId('search-select-option-产品经理').click();
      await page.getByTestId('avatar-option-users-blue').click();
      await expect(save).toBeEnabled();
      await save.click();

      await expect(page.getByTestId(`team-row-${TEAM_NAME}`)).toBeVisible();
      await expect(page.getByTestId(`team-row-${TEAM_NAME}`).getByTestId('team-avatar')).toHaveAttribute('data-avatar-kind', 'icon');

      // ---- Restart persistence -------------------------------------------
      await closeAbuElectron(launched.app);
      launched = await launchAbuElectron(dataRoot);
      page = await launched.app.firstWindow();
      await waitForApp(page);
      await openTeamSurface(page);
      await page.getByTestId('top-tab-nav').getByRole('button', { name: '专家团' }).click();
      await expect(page.getByTestId(`team-row-${TEAM_NAME}`)).toBeVisible();

      // ---- Detail (not the edit form) → delete ----------------------------
      // A row opens the read-only detail; 编辑 and 删除 live behind "…",
      // matching the 专家 detail. Archive is gone: a team is deleted outright.
      await page.getByTestId(`team-row-${TEAM_NAME}`).click();
      await expect(page.getByTestId('team-detail-start-chat')).toBeVisible();
      await expect(page.getByTestId('team-name-input')).toHaveCount(0);
      await page.getByTestId('team-detail-menu').click();
      await page.getByTestId('team-detail-edit').click();
      await page.getByLabel('介绍（可选）', { exact: true }).fill('帮你把需求变成可执行的方案');
      await page.getByLabel('开场白（可选）', { exact: true }).fill(INTRO);
      await page.getByLabel('擅长（可选）', { exact: true }).fill('需求分析\n方案检查\n计划整理');
      await page.getByLabel('推荐提问（可选）', { exact: true }).fill(QUESTION);
      await page.screenshot({ path: test.info().outputPath('team-editor.png') });
      await page.getByTestId('team-save').click();
      await page.getByTestId(`team-row-${TEAM_NAME}`).click();
      for (const label of ['擅长', '推荐提问', '需求分析']) {
        await expect(page.getByText(label, { exact: true })).toBeVisible();
      }
      await page.screenshot({ path: test.info().outputPath('team-detail.png') });
      await page.getByRole('button', { name: QUESTION, exact: true }).click();
      const welcome = page.getByTestId('team-welcome');
      await expect(welcome.getByRole('heading', { name: TEAM_NAME })).toBeVisible();
      await expect(page.getByText(INTRO, { exact: true })).toHaveCount(0);
      await expect(welcome.getByText('产品经理', { exact: true })).toBeVisible();
      await expect(page.getByPlaceholder(CHAT_PLACEHOLDER)).toHaveValue(QUESTION);
      // The team pin is durable; the question remains a draft, with no message.
      const conversations = await page.evaluate(() => {
        const stored = JSON.parse(localStorage.getItem('abu-chat') ?? '{}');
        return Object.values(stored.state.conversationIndex) as Array<{ teamId?: string; messageCount: number }>;
      });
      expect(conversations.filter((conversation) => conversation.teamId)).toHaveLength(0);
      await page.screenshot({ path: test.info().outputPath('team-welcome.png') });

      await openTeamSurface(page);
      await page.getByTestId('top-tab-nav').getByRole('button', { name: '专家团', exact: true }).click();
      await page.getByTestId(`team-row-${TEAM_NAME}`).click();
      await page.getByTestId('team-detail-menu').click();
      await page.getByTestId('team-detail-delete').click();
      // The "…" menu closes on click, so the ConfirmDialog's is the only 删除 left.
      await page.getByRole('button', { name: '删除', exact: true }).last().click();
      await expect(page.getByTestId(`team-row-${TEAM_NAME}`)).toHaveCount(0);
      await expect(page.getByText('还没有专家团')).toBeVisible();

      await closeAbuElectron(launched.app);
    } finally {
      removeElectronDataRoot(dataRoot);
    }
  });

  test('AI creation prefills the explicit shared skill command and the member editor offers the same avatar picker', async () => {
    const dataRoot = createElectronDataRoot();
    const launched = await launchAbuElectron(dataRoot);
    try {
      const page = await launched.app.firstWindow();
      await waitForApp(page);
      await dismissFirstRunOverlays(page);
      for (const [tab, trigger, prompt] of [
        ['专家团', 'team-create-trigger', '帮我组建一个专家团，我的需求是：'],
        ['专家', 'member-create-trigger', '帮我创建一个专家，我的需求是：'],
      ]) {
        await openTeamSurface(page);
        await page.getByTestId('top-tab-nav').getByRole('button', { name: tab, exact: true }).click();
        await page.getByTestId(trigger).click();
        await page.getByText('使用阿布创建', { exact: true }).click();
        // create-agent is hidden from suggestions by default. The complete
        // slash command still reaches the explicit skill route on send.
        await expect(page.getByRole('textbox')).toHaveValue(`/create-agent ${prompt}`);
      }
      await page.screenshot({ path: test.info().outputPath('member-ai-create.png') });
      await openTeamSurface(page);
      await page.getByTestId('top-tab-nav').getByRole('button', { name: '专家', exact: true }).click();
      await page.getByTestId('member-create-trigger').click();
      await page.getByText('手动创建', { exact: true }).click();
      await expect(page.getByTestId('avatar-picker')).toBeVisible();
      await page.getByTestId('avatar-option-code-purple').click();
      await expect(page.getByTestId('avatar-option-code-purple')).toHaveAttribute('aria-pressed', 'true');
      await page.screenshot({ path: test.info().outputPath('agent-avatar-picker.png') });
    } finally {
      await closeAbuElectron(launched.app);
      removeElectronDataRoot(dataRoot);
    }
  });
});
