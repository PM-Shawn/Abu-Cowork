/**
 * Real-Electron smoke for the 团队 (Agent Team) management surface — labs-gated
 * MVP (docs/abu-team-prd-v2.md). Deterministic per TESTING.md: no LLM provider
 * is configured and nothing here triggers a model run — this covers the
 * management journeys only (execution paths live in orchestrator unit tests).
 *
 * Journey: enable the labs flag → sidebar entry appears → tab order
 * 任务·收件箱·队员·团队·流水线 → create a team with a builtin leader →
 * task tab loses its dead end → team survives an app restart → archive
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

/** Flip the labs.team flag in the persisted settings store, then reload. */
async function enableTeamLab(page: Page): Promise<void> {
  await page.evaluate(() => {
    const raw = window.localStorage.getItem('abu-settings');
    if (!raw) throw new Error('abu-settings was not initialized before E2E configuration');
    const persisted = JSON.parse(raw) as { state: Record<string, unknown>; version: number };
    const labs = (persisted.state.labs ?? {}) as Record<string, boolean>;
    persisted.state.labs = { ...labs, team: true };
    window.localStorage.setItem('abu-settings', JSON.stringify(persisted));
  });
  await page.reload();
  await waitForApp(page);
}

async function openTeamSurface(page: Page): Promise<void> {
  await expect(page.getByTestId('sidebar-team')).toBeVisible();
  await page.getByTestId('sidebar-team').click();
}

test.describe('team management surface (labs)', () => {
  test('labs gate, tab order, create team, no dead ends, restart persistence, archive/restore', async () => {
    test.setTimeout(240_000);
    const dataRoot = createElectronDataRoot();
    try {
      // ---- First launch: gate off by default ------------------------------
      let launched = await launchAbuElectron(dataRoot);
      let page = await launched.app.firstWindow();
      await waitForApp(page);
      await dismissFirstRunOverlays(page);
      await expect(page.getByTestId('sidebar-team')).toHaveCount(0);

      await enableTeamLab(page);
      await openTeamSurface(page);

      // ---- Tab order (user-pinned 2026-08-31) -----------------------------
      const nav = page.getByTestId('top-tab-nav');
      const labels = await nav.locator('button').allInnerTexts();
      const tabLabels = labels
        .map((l) => l.trim().replace(/\d+$/, '').trim())
        .filter((l) => ['任务', '收件箱', '队员', '团队', '流水线'].includes(l));
      expect(tabLabels).toEqual(['任务', '收件箱', '队员', '团队', '流水线']);

      // Default tab is 任务; builtin agents exist, so the empty state offers
      // 新建任务 (single-member tasks are legal) — no dead end either way.
      await expect(page.getByText('还没有团队任务')).toBeVisible();

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

      // Back on 任务: the empty state now offers 新建任务.
      await nav.getByRole('button', { name: '任务' }).click();
      await expect(page.getByRole('main').getByRole('button', { name: '新建任务' })).toBeVisible();

      // ---- Restart persistence -------------------------------------------
      await closeAbuElectron(launched.app);
      launched = await launchAbuElectron(dataRoot);
      page = await launched.app.firstWindow();
      await waitForApp(page);
      await openTeamSurface(page);
      await page.getByTestId('top-tab-nav').getByRole('button', { name: '团队' }).click();
      await expect(page.getByTestId(`team-row-${TEAM_NAME}`)).toBeVisible();

      // ---- Archive → 已归档 section → 恢复 --------------------------------
      await page.getByTestId(`team-row-${TEAM_NAME}`).click();
      await page.getByTestId('team-archive').click();
      await page.getByRole('button', { name: '归档', exact: true }).nth(1).click(); // ConfirmDialog's solid confirm
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
