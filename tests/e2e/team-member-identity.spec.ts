/**
 * Real-Electron acceptance for team member identity integrity
 * (docs/abu-team-member-integrity-brief-2026-09-11.md). Deterministic per
 * TESTING.md: no LLM provider is configured and nothing here triggers a model
 * run — the leader-prompt half is pinned by leaderRoute unit tests.
 *
 * Journey (the brief's 场景 A/B/D/E, in the shell):
 * 1. create a user expert + a team that lists it → card reads 1 名成员;
 * 2. EDIT the expert (avatar only) → the team still resolves it (identity kept);
 * 3. DELETE the expert → the delete asks first and names the team;
 * 4. the team card reads 0 名成员; the detail shows one 已失效 row with 移除;
 *    the edit dialog lists the same ghost; nothing was dropped silently;
 * 5. a conversation pinned to the team opens (the member bar's 已失效 pill only
 *    mounts after the first message, so it is pinned by its unit test instead);
 * 6. 移除 in the detail clears the ghost.
 * The plugin-agent case (plugin:<name> ids) has no fixture plugin in E2E and is
 * covered by src/core/team/roleIdentity.test.ts.
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
// The editor lower-cases and validates names as kebab-case (useItemName → ITEM_NAME_RE).
const AGENT_NAME = 'e2e-member';
const TEAM_NAME = 'E2E身份小队';

async function waitForApp(page: Page): Promise<void> {
  await page.waitForLoadState('domcontentloaded');
  await expect(page.getByPlaceholder(CHAT_PLACEHOLDER)).toBeVisible({ timeout: READY_TIMEOUT });
}

async function openTeamSurface(page: Page): Promise<void> {
  await expect(page.getByTestId('sidebar-team')).toBeVisible();
  await page.getByTestId('sidebar-team').click();
}

async function switchTab(page: Page, label: '队员' | '团队'): Promise<void> {
  await page.getByTestId('top-tab-nav').getByRole('button', { name: label }).click();
}

/** The 队员 detail's "…" menu has no testid; it is the only ellipsis button once the detail is open. */
function detailMenuButton(page: Page) {
  return page.locator('button:has(svg[class*="ellipsis"]), button:has(svg[class*="more-horizontal"])').last();
}

async function openAgentDetail(page: Page): Promise<void> {
  // Re-entering the 队员 tab after a manual create replays the create trigger
  // and reopens a blank editor over the list (pre-existing quirk); back out first.
  const editorTitle = page.getByText('代理编辑器', { exact: true });
  if (await editorTitle.isVisible().catch(() => false)) {
    await page.locator('button').filter({ has: page.locator('svg[class*="arrow-left"]') }).first().click();
    await expect(editorTitle).toHaveCount(0);
  }
  await page.getByText(AGENT_NAME, { exact: true }).first().click();
  await expect(page.getByRole('button', { name: '开始对话' })).toBeVisible();
}

test.describe('team member identity integrity', () => {
  test('edit keeps identity, delete warns about teams, ghosts are visible and removable, team conversation opens', async () => {
    test.setTimeout(300_000);
    const dataRoot = createElectronDataRoot();
    try {
      const launched = await launchAbuElectron(dataRoot);
      const page = await launched.app.firstWindow();
      await waitForApp(page);
      await dismissFirstRunOverlays(page);
      await openTeamSurface(page);

      // ---- 1. A user expert (file-backed, so it has a real role-id) ------------
      await switchTab(page, '队员');
      await page.getByTestId('member-create-trigger').click();
      await page.getByText('手动创建').click();
      await page.getByPlaceholder('my-agent').fill(AGENT_NAME);
      await page.getByRole('button', { name: '保存', exact: true }).click();
      await expect(page.getByText(AGENT_NAME, { exact: true }).first()).toBeVisible();

      // ---- 1b. A team that lists it -------------------------------------------
      await switchTab(page, '团队');
      await page.getByText('新建团队').first().click();
      await page.getByTestId('team-name-input').fill(TEAM_NAME);
      await page.getByTestId('team-leader-select').click();
      await page.getByTestId('search-select-query').fill('产品');
      await page.getByTestId('search-select-option-产品经理').click();
      await page.getByTestId('team-members-select').click();
      await page.getByTestId('search-select-query').fill(AGENT_NAME);
      await page.getByTestId(`search-select-option-${AGENT_NAME}`).click();
      // Escape would close the whole DialogShell; a click inside the dialog just
      // dismisses the member picker's popover.
      await page.getByTestId('team-name-input').click();
      await page.getByTestId('team-save').click();
      const row = page.getByTestId(`team-row-${TEAM_NAME}`);
      await expect(row).toBeVisible();
      await expect(row).toContainText('1 名成员');

      // ---- 2. Editing the expert must not change who it is (brief 场景 A) -----
      await switchTab(page, '队员');
      await openAgentDetail(page);
      await detailMenuButton(page).click();
      // The "…" menu items are plain buttons with an icon; match by text like the component tests do.
      await page.getByText('编辑', { exact: true }).click();
      await page.getByPlaceholder('🤖').fill('🧪');
      await page.getByRole('button', { name: '保存', exact: true }).click();
      await switchTab(page, '团队');
      await expect(row).toContainText('1 名成员');
      await row.click();
      await expect(page.getByText('成员（1）')).toBeVisible();
      await expect(page.locator('[data-testid^="team-member-invalid-"]')).toHaveCount(0);
      await page.keyboard.press('Escape');

      // ---- 3. Deleting the expert asks first and names the team (场景 B) ------
      await switchTab(page, '队员');
      await openAgentDetail(page);
      await detailMenuButton(page).click();
      await page.getByText('卸载', { exact: true }).click();
      await expect(page.getByText(`删除「${AGENT_NAME}」？`)).toBeVisible();
      await expect(page.getByText(TEAM_NAME)).toBeVisible();
      await page.getByRole('button', { name: '仍然删除' }).click();
      await expect(page.getByText(AGENT_NAME, { exact: true })).toHaveCount(0);

      // ---- 4. The team shows the gap instead of hiding it (场景 D/E) ----------
      await switchTab(page, '团队');
      await expect(row).toContainText('0 名成员');
      await row.click();
      await expect(page.getByText('成员（0）')).toBeVisible();
      const invalidRow = page.locator('[data-testid^="team-member-invalid-"]');
      await expect(invalidRow).toHaveCount(1);
      await expect(invalidRow).toContainText('已失效');
      await page.getByTestId('team-detail-menu').click();
      await page.getByTestId('team-detail-edit').click();
      // Rows only — each row also carries a `team-edit-invalid-remove-<id>` button.
      await expect(page.locator('[data-testid^="team-edit-invalid-"]:not([data-testid*="-remove-"])')).toHaveCount(1);
      await page.getByRole('button', { name: '取消' }).click();

      // ---- 5. A conversation pinned to the team opens ----------------------------
      // The member bar (and its 已失效 pill) lives in the in-conversation layout,
      // which only mounts after the first message; a deterministic E2E has no
      // model turn, so the pill itself is pinned by TeamMemberBar.unresolved.test.tsx.
      await row.click();
      await page.getByTestId('team-detail-start-chat').click();
      await expect(page.getByPlaceholder(CHAT_PLACEHOLDER)).toBeVisible();
      await expect(page.getByTestId('top-tab-nav')).toHaveCount(0);

      // ---- 6. 移除 clears the ghost ------------------------------------------
      await openTeamSurface(page);
      await switchTab(page, '团队');
      await row.click();
      await page.getByRole('button', { name: '移除' }).click();
      await expect(page.locator('[data-testid^="team-member-invalid-"]')).toHaveCount(0);
      await expect(page.getByText('成员（0）')).toBeVisible();

      await closeAbuElectron(launched.app);
    } finally {
      removeElectronDataRoot(dataRoot);
    }
  });
});
