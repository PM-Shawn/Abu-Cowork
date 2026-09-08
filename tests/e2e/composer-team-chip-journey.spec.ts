/**
 * Real-Electron journey for the in-conversation team composer (batch 1,
 * design docs/abu-team-in-conversation-design-2026-09.md §2.1):
 *
 *   `@` → pick the team → a 👥 chip appears next to `+` and stays while typing
 *   → the `+` menu offers 添加文件 / 队员·团队 / 技能 → 队员·团队 reopens the
 *   grouped picker → clicking the chip clears it.
 *
 * Deterministic: no model run — nothing is sent. Pinning on send is covered by
 * the ChatView dispatch unit test (needs a configured provider).
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

async function seedTeam(page: Page): Promise<void> {
  await page.evaluate(() => {
    const raw = window.localStorage.getItem('abu-settings');
    if (!raw) throw new Error('abu-settings was not initialized');
    const persisted = JSON.parse(raw) as { state: Record<string, unknown>; version: number };
    window.localStorage.setItem('abu-settings', JSON.stringify(persisted));
    window.localStorage.setItem('abu-team', JSON.stringify({
      state: {
        teams: [{ id: 'team-e2e', name: 'zz数据小队', leaderRoleId: 'builtin:产品经理', memberRoleIds: ['builtin:产品经理'], createdAt: 1 }],
        tasks: [],
      },
      version: 5,
    }));
  });
  await page.reload();
  await page.waitForLoadState('domcontentloaded');
  await expect(page.getByPlaceholder(CHAT_PLACEHOLDER)).toBeVisible({ timeout: READY_TIMEOUT });
}

test.describe('composer team chip journey', () => {
  test('pick a team from @, keep the chip while typing, reopen the picker from +, clear the chip', async () => {
    test.setTimeout(180_000);
    const dataRoot = createElectronDataRoot();
    try {
      const launched = await launchAbuElectron(dataRoot);
      const page = await launched.app.firstWindow();
      await page.waitForLoadState('domcontentloaded');
      await expect(page.getByPlaceholder(CHAT_PLACEHOLDER)).toBeVisible({ timeout: READY_TIMEOUT });
      await dismissFirstRunOverlays(page);
      await seedTeam(page);

      const textbox = page.getByRole('textbox').first();
      await textbox.click();
      await textbox.type('@');
      await expect(page.getByRole('listbox')).toBeVisible();
      await page.getByRole('option', { name: /zz数据小队/ }).click();

      // The team is the 接活方: a chip next to `+`, the text is empty again,
      // and the picker is closed.
      const chip = page.getByTestId('composer-team-chip');
      await expect(chip).toBeVisible();
      await expect(chip).toContainText('zz数据小队');
      await expect(textbox).toHaveValue('');
      await expect(page.getByRole('listbox')).toHaveCount(0);

      // Sticky while typing — and the text stays plain (no `@团队` prefix).
      await textbox.type('出一版周报');
      await expect(chip).toBeVisible();
      await expect(textbox).toHaveValue('出一版周报');

      // `+` is a menu: 添加文件 / 队员·团队 / 技能.
      await page.getByTestId('composer-plus').click();
      const menu = page.getByRole('menu');
      await expect(menu).toBeVisible();
      await expect(menu.getByRole('menuitem')).toHaveCount(3);
      await expect(page.getByTestId('composer-menu-add-file')).toBeVisible();
      await expect(page.getByTestId('composer-menu-skill')).toBeVisible();
      // 队员·团队 drops an `@` at the caret and the grouped picker opens.
      await page.getByTestId('composer-menu-team').click();
      await expect(page.getByRole('listbox')).toBeVisible();
      await expect(page.getByRole('option', { name: /zz数据小队/ })).toBeVisible();
      await expect(textbox).toHaveValue('出一版周报 @');
      await page.keyboard.press('Escape');
      await expect(page.getByRole('listbox')).toHaveCount(0);

      // Clicking the chip clears the team pin.
      await chip.click();
      await expect(page.getByTestId('composer-team-chip')).toHaveCount(0);

      await closeAbuElectron(launched.app);
    } finally {
      removeElectronDataRoot(dataRoot);
    }
  });
});
