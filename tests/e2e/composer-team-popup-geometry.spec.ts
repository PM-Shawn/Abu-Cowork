/**
 * Real-Electron geometry probe for the composer @ popup (user report
 * 2026-09-03: "卡片还是上面被截断了" — the 团队 section header was not visible
 * above the first team row). Seeds one team, opens the popup on the welcome
 * screen, and asserts the listbox starts inside the window with its first
 * group header fully visible and no initial scroll offset.
 *
 * Deterministic: no model run — typing `@` only opens the local suggestion list.
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

test.describe('composer @ popup geometry', () => {
  test('the 团队 header is fully visible and the list opens unscrolled', async () => {
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
      const listbox = page.getByRole('listbox');
      await expect(listbox).toBeVisible();
      await expect(page.getByRole('option', { name: /zz数据小队/ })).toBeVisible();

      const readGeometry = () => page.evaluate(() => {
        const box = document.querySelector<HTMLElement>('[role="listbox"]');
        if (!box) throw new Error('no listbox');
        const groups = Array.from(box.querySelectorAll<HTMLElement>('[role="group"]'));
        const header = groups[0]?.firstElementChild as HTMLElement | null;
        const b = box.getBoundingClientRect();
        const h = header?.getBoundingClientRect();
        const anchor = box.parentElement?.getBoundingClientRect();
        return {
          scrollTop: box.scrollTop,
          clientHeight: box.clientHeight,
          scrollHeight: box.scrollHeight,
          styleMaxHeight: box.style.maxHeight,
          boxTop: b.top,
          boxBottom: b.bottom,
          headerText: header?.textContent ?? null,
          headerTop: h?.top ?? null,
          headerBottom: h?.bottom ?? null,
          anchorTop: anchor?.top ?? null,
          innerHeight: window.innerHeight,
          groupLabels: groups.map((g) => g.getAttribute('aria-label')),
          // Occlusion: what is actually painted on top at the header's centre
          // and at the popup's first row? Geometry alone cannot see a chrome
          // band stacked above the listbox.
          onTopOfHeader: (() => {
            if (!h) return null;
            const el = document.elementFromPoint(h.left + 40, (h.top + h.bottom) / 2) as HTMLElement | null;
            const chain: string[] = [];
            let cur: HTMLElement | null = el;
            for (let i = 0; cur && i < 4; i += 1) {
              const cs = getComputedStyle(cur);
              chain.push(`${cur.tagName.toLowerCase()}${cur.id ? '#' + cur.id : ''}.${String(cur.className).split(' ').slice(0, 4).join('.')}[z=${cs.zIndex},pos=${cs.position},bg=${cs.backgroundColor}]`);
              cur = cur.parentElement;
            }
            return { insideListbox: !!el?.closest('[role="listbox"]'), chain };
          })(),
          onTopOfPopupTopLeft: (() => {
            const el = document.elementFromPoint(b.left + 20, b.top + 4) as HTMLElement | null;
            return { insideListbox: !!el?.closest('[role="listbox"]'), tag: el ? `${el.tagName.toLowerCase()}.${String(el.className).split(' ').slice(0, 4).join('.')}` : null };
          })(),
        };
      });
      const geo = await readGeometry();
      console.log('[popup-geometry:first-open]', JSON.stringify(geo));

      const assertHeaderVisible = (g: Awaited<ReturnType<typeof readGeometry>>) => {
        // The popup must start inside the window…
        expect(g.boxTop).toBeGreaterThanOrEqual(0);
        // …open unscrolled…
        expect(g.scrollTop).toBe(0);
        // …with the 团队 header the first thing in it, fully inside its own box.
        expect(g.groupLabels[0]).toBe('团队');
        expect(g.headerTop).not.toBeNull();
        expect(g.headerTop as number).toBeGreaterThanOrEqual(g.boxTop);
        expect(g.headerBottom as number).toBeLessThanOrEqual(g.boxBottom);
        // …and actually PAINTED: geometry is blind to an overflow ancestor
        // clipping the popup's top, so hit-test the header's centre and the
        // popup's own top-left — both must land inside the listbox.
        expect(g.onTopOfHeader?.insideListbox).toBe(true);
        expect(g.onTopOfPopupTopLeft.insideListbox).toBe(true);
      };
      assertHeaderVisible(geo);

      // Regression (2026-09-03): navigate down the list, close it by deleting
      // the @, then reopen — the stale selection index from the first open
      // must not leave the list scrolled past its header. (Escape is not used
      // here: it deliberately suppresses the same token until it changes.)
      // Walk the selection to the last option. Whether the list scrolls
      // depends on the builtin roster size vs. the popup's max height, which
      // dev changes over time — so the scroll itself is asserted only when the
      // list overflows; the reopen-unscrolled check below holds either way.
      const optionCount = await page.getByRole('option').count();
      for (let i = 0; i < optionCount; i += 1) await textbox.press('ArrowDown');
      const beforeClose = await page.evaluate(() => {
        const box = document.querySelector<HTMLElement>('[role="listbox"]');
        return box ? { scrollTop: box.scrollTop, overflows: box.scrollHeight > box.clientHeight } : { scrollTop: -1, overflows: false };
      });
      console.log('[popup-geometry:scrolled-before-close]', JSON.stringify(beforeClose));
      if (beforeClose.overflows) expect(beforeClose.scrollTop).toBeGreaterThan(0);
      await textbox.press('Backspace');
      await expect(listbox).toHaveCount(0);
      await textbox.type('@');
      await expect(page.getByRole('listbox')).toBeVisible();
      const reopened = await readGeometry();
      console.log('[popup-geometry:reopened]', JSON.stringify(reopened));
      assertHeaderVisible(reopened);

      // Regression (2026-09-03, second bundle): dismiss with Escape, delete the
      // `@`, type it again — the popup must come back. Escape only suppresses
      // the token that was showing; deleting the token ends the suppression.
      await textbox.press('Escape');
      await expect(page.getByRole('listbox')).toHaveCount(0);
      await textbox.press('Backspace');
      await textbox.type('@');
      await expect(page.getByRole('listbox')).toBeVisible({ timeout: 5_000 });
      assertHeaderVisible(await readGeometry());

      await closeAbuElectron(launched.app);
    } finally {
      removeElectronDataRoot(dataRoot);
    }
  });
});
