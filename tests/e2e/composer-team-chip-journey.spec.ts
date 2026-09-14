/**
 * Real-Electron journey for the in-conversation team composer (batch 1,
 * design docs/abu-team-in-conversation-design-2026-09.md §2.1):
 *
 *   `@` → pick the team → a 👥 chip appears next to `+` and stays while typing
 *   → the `+` menu offers 添加文件 / 专家·专家团 / 技能 → 专家·专家团 reopens the
 *   grouped picker → clicking the chip clears it.
 *
 * Deterministic: no model run — nothing is sent. Pinning on send is covered by
 * the ChatView dispatch unit test (needs a configured provider).
 */
import fs from 'node:fs';
import path from 'node:path';
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

      // Sticky while typing — and the text stays plain (no `@专家团` prefix).
      await textbox.type('出一版周报');
      await expect(chip).toBeVisible();
      await expect(textbox).toHaveValue('出一版周报');

      // `+` is a menu: 添加文件 / 专家·专家团 / 技能.
      await page.getByTestId('composer-plus').click();
      const menu = page.getByRole('menu');
      await expect(menu).toBeVisible();
      await expect(menu.getByRole('menuitem')).toHaveCount(3);
      await expect(page.getByTestId('composer-menu-add-file')).toBeVisible();
      await expect(page.getByTestId('composer-menu-skill')).toBeVisible();
      // The independent picker leaves the draft and existing team pin untouched.
      await page.getByTestId('composer-menu-team').click();
      await expect(page.getByRole('listbox')).toBeVisible();
      await expect(page.getByRole('option', { name: /zz数据小队/ })).toBeVisible();
      await expect(textbox).toHaveValue('出一版周报');
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

  test('skill and expert menus preserve a multiline draft through search, cancel, and replacement', async () => {
    test.setTimeout(180_000);
    const dataRoot = createElectronDataRoot();
    let app: Awaited<ReturnType<typeof launchAbuElectron>>['app'] | undefined;
    try {
      const dir = path.join(dataRoot.appDataDir, 'Home', '.abu', 'skills', 'e2e-draft-skill');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'SKILL.md'), '---\nname: e2e-draft-skill\ndescription: Draft preservation fixture\n---\nHelp with the draft.\n');
      ({ app } = await launchAbuElectron(dataRoot));
      const page = await app.firstWindow();
      await expect(page.getByPlaceholder(CHAT_PLACEHOLDER)).toBeVisible({ timeout: READY_TIMEOUT });
      await dismissFirstRunOverlays(page);
      const box = page.locator('[data-chat-composer]');
      const expectBody = async (body: string) => expect.poll(() => box.evaluate((element) => {
        if (element instanceof HTMLTextAreaElement) return element.value;
        const copy = element.cloneNode(true) as HTMLElement;
        copy.querySelectorAll<HTMLElement>('[data-skill-boundary]').forEach((node) => { node.textContent = node.dataset.skillBoundary === 'before' ? node.textContent!.replace(/\u200b$/, '') : node.textContent!.replace(/^\u200b/, ''); });
        copy.querySelectorAll('[data-inline-skill], [data-editor-tail]').forEach((node) => node.remove());
        return copy.textContent;
      })).toBe(body);
      const body = '保留这段正文\n  保留缩进和第二行';
      await box.fill(body);
      await box.press('Control+Home');
      await page.getByTestId('composer-plus').click();
      await page.getByTestId('composer-menu-skill').click();
      const search = page.getByRole('textbox', { name: '搜索', exact: true });
      await expect(search).toBeFocused();
      await page.keyboard.insertText('e2e-draft-skill');
      await expect(search).toHaveValue('e2e-draft-skill');
      await expectBody(body);
      await page.getByRole('option', { name: /e2e-draft-skill/ }).click();
      await expect(page.getByRole('button', { name: '/e2e-draft-skill', exact: true })).toBeVisible();
      await expectBody(body);
      await expect(box).toBeFocused();

      await page.getByTestId('composer-plus').click();
      await page.getByTestId('composer-menu-team').click();
      await expect(search).toBeFocused();
      await search.fill('不存在的专家');
      await search.press('Escape');
      await expect(page.getByRole('button', { name: '/e2e-draft-skill', exact: true })).toBeVisible();
      await expectBody(body);

      await page.getByTestId('composer-plus').click();
      await page.getByTestId('composer-menu-team').click();
      const expertOption = page.getByRole('group', { name: '专家', exact: true }).getByRole('option').first();
      await expect(expertOption).toBeVisible();
      await expertOption.click();
      await expect(page.getByRole('button', { name: '/e2e-draft-skill', exact: true })).toHaveCount(0);
      await expectBody(body);
      await page.getByTestId('composer-plus').click();
      await page.getByTestId('composer-menu-skill').click();
      await search.fill('e2e-draft-skill');
      await search.press('Enter');
      await expect(page.getByRole('button', { name: '/e2e-draft-skill', exact: true })).toBeVisible();
      await expectBody(body);
      await page.screenshot({ path: '/private/tmp/abu-composer-preserved-electron.png' });

      // Detail trial updates the skill without overwriting the same welcome draft.
      await page.getByLabel('Main navigation').getByRole('button', { name: '扩展', exact: true }).click();
      await page.getByRole('button', { name: '技能', exact: true }).click();
      await page.getByTestId('extensions-source-mine').click();
      await page.getByRole('button', { name: /^e2e-draft-skill / }).click();
      await page.getByRole('button', { name: '立即试用', exact: true }).click();
      await expectBody(body);
      await expect(page.getByRole('button', { name: '/e2e-draft-skill', exact: true })).toBeVisible();

      // A new-task template adds text, and must not inherit the old skill route.
      await page.getByLabel('Main navigation').getByRole('button', { name: '自动化', exact: true }).click();
      await page.getByRole('button', { name: '让阿布帮你创建', exact: true }).click();
      await expectBody(body + '\n帮我创建一个定时任务');
      await expect(page.getByRole('button', { name: '/e2e-draft-skill', exact: true })).toHaveCount(0);

    } finally {
      if (app) await closeAbuElectron(app);
      removeElectronDataRoot(dataRoot);
    }
  });
  test('inline skills follow the insertion caret and support editing, deletion, undo and IME', async () => {
    test.setTimeout(180_000);
    const dataRoot = createElectronDataRoot();
    let app: Awaited<ReturnType<typeof launchAbuElectron>>['app'] | undefined;
    try {
      const dir = path.join(dataRoot.appDataDir, 'Home', '.abu', 'skills', 'e2e-draft-skill');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'SKILL.md'), '---\nname: e2e-draft-skill\ndescription: Draft preservation fixture\n---\nHelp with the draft.\n');
      ({ app } = await launchAbuElectron(dataRoot));
      const page = await app.firstWindow();
      await expect(page.getByPlaceholder(CHAT_PLACEHOLDER)).toBeVisible({ timeout: READY_TIMEOUT });
      await dismissFirstRunOverlays(page);
      const box = page.locator('[data-chat-composer]');
      const atom = box.locator('[data-inline-skill]');
      const body = '前文后文\n  保留缩进';
      const readBody = () => box.evaluate((element) => {
        if (element instanceof HTMLTextAreaElement) return element.value;
        const copy = element.cloneNode(true) as HTMLElement;
        copy.querySelectorAll<HTMLElement>('[data-skill-boundary]').forEach((node) => { node.textContent = node.dataset.skillBoundary === 'before' ? node.textContent!.replace(/\u200b$/, '') : node.textContent!.replace(/^\u200b/, ''); });
        copy.querySelectorAll('[data-inline-skill], [data-editor-tail]').forEach((node) => node.remove());
        return copy.textContent;
      });
      const beforeAtom = () => atom.evaluate((element) => {
        const range = document.createRange();
        range.selectNodeContents(element.parentNode!);
        range.setEndBefore(element);
        const copy = range.cloneContents();
        copy.querySelectorAll<HTMLElement>('[data-skill-boundary]').forEach((node) => { node.textContent = node.dataset.skillBoundary === 'before' ? node.textContent!.replace(/\u200b$/, '') : node.textContent!.replace(/^\u200b/, ''); });
        return copy.textContent;
      });
      const pickSkill = async () => {
        await page.getByTestId('composer-plus').click();
        await page.getByTestId('composer-menu-skill').click();
        await page.getByRole('textbox', { name: '搜索', exact: true }).fill('e2e-draft-skill');
        await page.getByRole('option', { name: /e2e-draft-skill/ }).click();
        await expect(atom).toBeVisible();
        await expect(box).toBeFocused();
      };
      for (const offset of [0, 2, body.length]) {
        await box.fill(body);
        await box.evaluate((element, point) => (element as HTMLTextAreaElement).setSelectionRange(point, point), offset);
        // Real select event updates the composer before opening the menu.
        await box.dispatchEvent('select');
        await pickSkill();
        await expect.poll(readBody).toBe(body);
        await expect.poll(beforeAtom).toBe(body.slice(0, offset));
        await page.keyboard.insertText('继续');
        await expect.poll(readBody).toBe(body.slice(0, offset) + '继续' + body.slice(offset));
        await expect.poll(beforeAtom).toBe(body.slice(0, offset));
        // First remove the typed text, then delete only the adjacent atom.
        await box.press('Backspace');
        await box.press('Backspace');
        await box.press('Backspace');
        await expect(atom).toHaveCount(0);
        await expect.poll(readBody).toBe(body);
        await box.press('Meta+z');
        await expect(atom).toBeVisible();
        await expect.poll(readBody).toBe(body);
        await box.press('Meta+Shift+z');
        await expect(atom).toHaveCount(0);
      }
      // A typed slash in the middle consumes only its trigger range.
      await box.fill('前文 /e2e-draft 后文');
      await box.press('ArrowLeft');
      await box.press('ArrowLeft');
      await box.press('ArrowLeft');
      await page.getByRole('option', { name: /e2e-draft-skill/ }).click();
      await expect.poll(readBody).toBe('前文  后文');
      await expect.poll(beforeAtom).toBe('前文 ');
      // Paste + newline before an atom must keep the caret on that side.
      await atom.evaluate((element) => {
        const range = document.createRange();
        range.setStartBefore(element);
        range.collapse(true);
        window.getSelection()!.removeAllRanges();
        window.getSelection()!.addRange(range);
      });
      await box.evaluate((element) => {
        const data = new DataTransfer();
        data.setData('text/plain', '粘贴');
        data.setData('text/html', '<b>粘贴</b>');
        element.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
      });
      await box.press('Shift+Enter');
      await page.keyboard.insertText('继续');
      await expect.poll(beforeAtom).toBe('前文 粘贴\n继续');
      expect(await box.locator('b').count()).toBe(0);
      // Real Chromium IME protocol, with Enter never sent to the model.
      const cdp = await page.context().newCDPSession(page);
      await cdp.send('Input.imeSetComposition', { text: '中文', selectionStart: 2, selectionEnd: 2 });
      await cdp.send('Input.insertText', { text: '中文' });
      await expect.poll(beforeAtom).toBe('前文 粘贴\n继续中文');
      await page.screenshot({ path: '/private/tmp/abu-composer-inline-skill-electron.png' });
      const preserved = await readBody();
      await atom.evaluate((element) => {
        const range = document.createRange();
        range.setStartBefore(element); range.collapse(true);
        window.getSelection()!.removeAllRanges(); window.getSelection()!.addRange(range);
      });
      await box.press('Delete');
      await expect(atom).toHaveCount(0);
      await expect.poll(readBody).toBe(preserved);
      await box.press('Meta+z');
      await expect(atom).toBeVisible();
      await box.press('Meta+a');
      await cdp.send('Input.imeSetComposition', { text: '替换', selectionStart: 2, selectionEnd: 2 });
      await cdp.send('Input.insertText', { text: '替换' });
      await expect(atom).toHaveCount(0);
      await expect(box).toBeFocused();
      await page.keyboard.insertText('继续');
      await expect.poll(readBody).toBe('替换继续');
      await cdp.detach();
    } finally {
      if (app) await closeAbuElectron(app);
      removeElectronDataRoot(dataRoot);
    }
  });

});
