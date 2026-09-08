/**
 * Real-Electron smoke for the 团队 (Agent Team) management surface — shipped by
 * MVP (docs/abu-team-prd-v2.md). Deterministic per TESTING.md: no LLM provider
 * is configured and nothing here triggers a model run — this covers the
 * management journeys only (execution paths live in orchestrator unit tests).
 *
 * Journey: sidebar entry is there out of the box → tab order
 * 队员·团队 (task board shelved) → create a team with a builtin leader →
 * team survives an app restart → archive
 * moves it to the 已归档 section and 恢复 brings it back.
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

async function waitForApp(page: Page): Promise<void> {
  await page.waitForLoadState('domcontentloaded');
  await expect(page.getByPlaceholder(CHAT_PLACEHOLDER)).toBeVisible({ timeout: READY_TIMEOUT });
}

async function openTeamSurface(page: Page): Promise<void> {
  await expect(page.getByTestId('sidebar-team')).toBeVisible();
  await page.getByTestId('sidebar-team').click();
}

test.describe('team management surface', () => {
  test('entry ships on by default, tab order, create team, no dead ends, restart persistence, archive/restore', async () => {
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
        .filter((l) => ['任务', '收件箱', '队员', '团队'].includes(l));
      expect(tabLabels).toEqual(['队员', '团队']);

      // ---- Create a team with a builtin leader ----------------------------
      await nav.getByRole('button', { name: '团队' }).click();
      await page.getByText('新建团队').first().click();
      await expect(page.getByTestId('team-name-input')).toBeVisible();
      await page.getByTestId('team-name-input').fill(TEAM_NAME);
      const save = page.getByTestId('team-save');
      await expect(save).toBeDisabled(); // no leader yet

      await page.getByTestId('team-leader-select').click();
      await page.getByTestId('search-select-query').fill('产品');
      await page.getByTestId('search-select-option-产品经理').click();
      await expect(save).toBeEnabled();
      await save.click();

      await expect(page.getByTestId(`team-row-${TEAM_NAME}`)).toBeVisible();

      // ---- Restart persistence -------------------------------------------
      await closeAbuElectron(launched.app);
      launched = await launchAbuElectron(dataRoot);
      page = await launched.app.firstWindow();
      await waitForApp(page);
      await openTeamSurface(page);
      await page.getByTestId('top-tab-nav').getByRole('button', { name: '团队' }).click();
      await expect(page.getByTestId(`team-row-${TEAM_NAME}`)).toBeVisible();

      // ---- Detail (not the edit form) → archive → 已归档 → 恢复 -----------
      // A row opens the read-only detail; 编辑 and 归档 live behind "…",
      // matching the 队员 detail.
      await page.getByTestId(`team-row-${TEAM_NAME}`).click();
      await expect(page.getByTestId('team-detail-start-chat')).toBeVisible();
      await expect(page.getByTestId('team-name-input')).toHaveCount(0);
      await page.getByTestId('team-detail-menu').click();
      await page.getByTestId('team-detail-archive').click();
      // The "…" menu closes on click, so the ConfirmDialog's is the only 归档 left.
      await page.getByRole('button', { name: '归档', exact: true }).last().click();
      await expect(page.getByText('已归档（1）')).toBeVisible();
      // Zero active teams → the archived <details> renders open by default.
      await page.getByRole('button', { name: '恢复' }).click();
      await expect(page.getByTestId(`team-row-${TEAM_NAME}`)).toBeVisible();

      await closeAbuElectron(launched.app);
    } finally {
      removeElectronDataRoot(dataRoot);
    }
  });
});
