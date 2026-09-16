/**
 * Real-Electron guard for the composer toolbar in a narrow center pane.
 *
 * The workspace panel's drag handle can squeeze the chat column to ~415px on a
 * small window (the narrow-panel drag is capped at an absolute 560px, with no
 * chat-side floor). At that width the toolbar used to `flex-wrap`: CSS resolves
 * wrapping against content size *before* it shrinks anything, so the entire
 * right half — permission chip, model picker, context ring, stop button — was
 * thrown onto a second, `ml-auto`-aligned line instead of the model name
 * truncating the way the code intends.
 *
 * The replacement is one row that gives up space in a fixed order, driven by
 * container queries on the toolbar itself. Only a real layout engine can prove
 * that, hence a real Electron window.
 *
 * Widths are reached by resizing the window rather than dragging the panel
 * divider: the divider only exists once the panel has a message or a tab to
 * show, which would drag a model run into a pure layout test. The toolbar's
 * container queries do not care *why* their container is narrow, and every
 * width walked here is one the panel drag can produce on a ~1000px window.
 * `setMinimumSize` is lowered for the same reason — it is the window chrome's
 * floor, not the composer's.
 *
 * Deterministic: no model run, no network — the team is seeded into
 * localStorage and pinned through the `@` picker.
 */
import { createServer, type Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { expect, test } from '@playwright/test';
import type { Page } from 'playwright';
import {
  closeAbuElectron,
  configureLocalMockProvider,
  createElectronDataRoot,
  dismissFirstRunOverlays,
  launchAbuElectron,
  removeElectronDataRoot,
} from './electronHelpers';

const READY_TIMEOUT = 45_000;
const CHAT_PLACEHOLDER = '想让阿布帮你做点什么？';
const MOCK_MODEL_ID = 'abu-e2e-local-model';

/**
 * The smallest loopback OpenAI-compatible endpoint that answers any request
 * with one short completion. The in-conversation composer only renders once a
 * conversation has a message, and that message has to come from somewhere —
 * this spec needs a turn to have happened, not a particular reply.
 */
async function startOneShotMock(): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const chunk = (delta: Record<string, unknown>, finishReason: string | null) =>
    `data: ${JSON.stringify({
      id: 'chatcmpl-abu-e2e-narrow-toolbar',
      object: 'chat.completion.chunk',
      created: 0,
      model: MOCK_MODEL_ID,
      choices: [{ index: 0, delta, finish_reason: finishReason }],
    })}\n\n`;
  const server: Server = createServer(async (req, res) => {
    for await (const _ of req) { /* drain the body; the reply never varies */ }
    res.writeHead(200, {
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'content-type': 'text/event-stream; charset=utf-8',
    });
    res.end(chunk({ content: '好的。' }, null) + chunk({}, 'stop') + 'data: [DONE]\n\n');
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    // Loopback only: the mock must never listen on an externally reachable interface.
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
/* One toolbar row is h-7 (28px) plus the row's own padding. Two rows clear
   50px, so this separates them with room to spare for font fallbacks. */
const SINGLE_ROW_MAX_HEIGHT = 44;
const TEAM_NAME = 'zz网页开发专家团';

async function seedTeam(page: Page): Promise<void> {
  await page.evaluate(() => {
    window.localStorage.setItem('abu-team', JSON.stringify({
      state: {
        teams: [{
          id: 'team-e2e',
          // Long enough that its name is the first thing forced to give way.
          name: 'zz网页开发专家团',
          leaderRoleId: 'builtin:产品经理',
          memberRoleIds: ['builtin:产品经理'],
          createdAt: 1,
        }],
        tasks: [],
      },
      version: 5,
    }));
  });
  await page.reload();
  await page.waitForLoadState('domcontentloaded');
  await expect(page.getByPlaceholder(CHAT_PLACEHOLDER)).toBeVisible({ timeout: READY_TIMEOUT });
}

test.describe('composer toolbar in a narrow pane', () => {
  test('gives up space one rung at a time instead of wrapping onto a second row', async () => {
    test.setTimeout(180_000);
    const dataRoot = createElectronDataRoot();
    try {
      const launched = await launchAbuElectron(dataRoot);
      const page = await launched.app.firstWindow();
      await page.waitForLoadState('domcontentloaded');
      await expect(page.getByPlaceholder(CHAT_PLACEHOLDER)).toBeVisible({ timeout: READY_TIMEOUT });
      await dismissFirstRunOverlays(page);
      await seedTeam(page);

      // Pin the team so the chip — the first thing that gives way — is present.
      const textbox = page.getByRole('textbox').first();
      await textbox.click();
      await textbox.type('@');
      await expect(page.getByRole('listbox')).toBeVisible();
      await page.getByRole('option', { name: new RegExp(TEAM_NAME) }).click();
      const teamChip = page.getByTestId('composer-team-chip');
      await expect(teamChip).toBeVisible();

      const toolbar = page.getByTestId('composer-toolbar');
      const card = page.locator('[data-chat-composer]')
        .locator('xpath=ancestor::div[contains(@class,"rounded-2xl")][1]');

      async function resizeTo(width: number): Promise<void> {
        await launched.app.evaluate(({ BrowserWindow }, w) => {
          const win = BrowserWindow.getAllWindows()[0];
          win?.setMinimumSize(360, 600);
          win?.setBounds({ width: w, height: 820 });
        }, width);
        // Let the resize reach the renderer and the container queries settle.
        await expect.poll(async () => (await toolbar.boundingBox())?.width ?? 0)
          .toBeGreaterThan(0);
        await page.waitForTimeout(120);
      }

      async function assertOneRow(label: string): Promise<void> {
        const box = await toolbar.boundingBox();
        const cardBox = await card.boundingBox();
        expect(box, `${label}: toolbar has no box`).not.toBeNull();
        expect(cardBox, `${label}: composer card has no box`).not.toBeNull();
        // The regression showed up as height, so measure height.
        expect(box!.height, `${label}: toolbar wrapped onto a second row`)
          .toBeLessThan(SINGLE_ROW_MAX_HEIGHT);
        // ...and nothing may escape the card sideways instead of wrapping.
        expect(box!.x + box!.width, `${label}: toolbar overflows its card`)
          .toBeLessThanOrEqual(cardBox!.x + cardBox!.width + 1);
        // The pin survives every rung; the overflow check above is what keeps
        // `+` and send/stop inside the card.
        await expect(teamChip).toBeVisible();
      }

      // Walk the whole range, asserting at every stop rather than only at the
      // extreme — a ladder that breaks mid-range is still broken.
      for (const width of [1200, 1000, 900, 800, 700, 620, 540, 470, 430]) {
        await resizeTo(width);
        await assertOneRow(`window ${width}px`);
      }

      // The rungs must actually fire, or the row above stays intact only
      // because nothing ever got tight.
      const permissionLabelVisible = await page
        .locator('[data-testid="composer-toolbar"] .\\@max-\\[420px\\]\\:hidden')
        .first()
        .isVisible();
      expect(permissionLabelVisible, 'permission label never collapsed to its icon').toBe(false);
      const teamNameVisible = await teamChip
        .locator('.\\@max-\\[330px\\]\\:hidden')
        .isVisible();
      expect(teamNameVisible, 'team name never collapsed to the avatar').toBe(false);
      // The pin itself stays legible after both collapses.
      await expect(teamChip).toHaveAccessibleName(`👥${TEAM_NAME}`);

      // Back to a comfortable width, everything returns.
      await resizeTo(1200);
      await assertOneRow('restored to 1200px');
      await expect(teamChip.locator('.\\@max-\\[330px\\]\\:hidden')).toBeVisible();

      await closeAbuElectron(launched.app);
    } finally {
      removeElectronDataRoot(dataRoot);
    }
  });

  /* The variant above is the welcome composer. The bug was REPORTED on the
     in-conversation one, along this path: a ~1000px window, the workspace panel
     open, its divider dragged left until the chat column is starved. Window
     resizing cannot substitute — the chat column stops shrinking around 500px
     on its own, and only the panel's flex split reaches the ~300px the report
     came from. Costs one scripted turn, because the in-conversation composer
     and the panel divider both need a conversation with a message.

     Two guards live here, because the fix has two halves. The divider can no
     longer starve the chat past CHAT_MIN_WIDTH (clampNarrowPanelWidth), so the
     toolbar bottoms out around 368px of content rather than the 204px where its
     controls used to collide. And across that whole range it stays one row. */
  test('walks the reported path: panel divider vs the chat column floor', async () => {
    test.setTimeout(180_000);
    const dataRoot = createElectronDataRoot();
    const mock = await startOneShotMock();
    try {
      const launched = await launchAbuElectron(dataRoot);
      const page = await launched.app.firstWindow();
      await page.waitForLoadState('domcontentloaded');
      await expect(page.getByPlaceholder(CHAT_PLACEHOLDER)).toBeVisible({ timeout: READY_TIMEOUT });
      await dismissFirstRunOverlays(page);
      await configureLocalMockProvider(page, mock.baseUrl, { modelId: MOCK_MODEL_ID });
      await page.reload();
      await page.waitForLoadState('domcontentloaded');

      await launched.app.evaluate(({ BrowserWindow }) => {
        BrowserWindow.getAllWindows()[0]?.setBounds({ width: 1000, height: 820 });
      });

      const textbox = page.getByRole('textbox').first();
      await expect(textbox).toBeVisible({ timeout: READY_TIMEOUT });
      await textbox.click();
      await textbox.type('宽度测试');
      await textbox.press('Enter');
      // The in-conversation composer only exists once the turn has landed.
      await expect(page.getByText('好的。')).toBeVisible({ timeout: READY_TIMEOUT });

      // A conversation with no workspace auto-collapses the panel, so open it
      // the way the user does — the title bar toggle.
      await page.locator('[data-window-control="right-panel"]').click();

      const toolbar = page.getByTestId('composer-toolbar');
      const card = page.locator('[data-chat-composer]')
        .locator('xpath=ancestor::div[contains(@class,"rounded-2xl")][1]');
      const permissionLabel = toolbar.locator('.\\@max-\\[420px\\]\\:hidden').first();
      await expect(permissionLabel).toBeVisible();

      const handle = page.locator('div.cursor-col-resize').first();
      const handleBox = await handle.boundingBox();
      expect(handleBox, 'the panel divider never appeared').not.toBeNull();
      await page.mouse.move(handleBox!.x + 2, handleBox!.y + handleBox!.height / 2);
      await page.mouse.down();
      let widest = 0;
      let narrowest = Number.POSITIVE_INFINITY;
      // Drag well past where the clamp bites, and assert at every stop rather
      // than only at the extreme — a ladder that breaks mid-range is still
      // broken, and a clamp that only holds at the end is not a clamp.
      for (const offset of [0, 60, 120, 180, 240, 360, 480]) {
        await page.mouse.move(handleBox!.x + 2 - offset, handleBox!.y + handleBox!.height / 2, { steps: 4 });
        await page.waitForTimeout(150);

        const box = await toolbar.boundingBox();
        const cardBox = await card.boundingBox();
        expect(box, `divider -${offset}px: toolbar has no box`).not.toBeNull();
        expect(cardBox, `divider -${offset}px: composer card has no box`).not.toBeNull();
        // The regression showed up as height, so measure height.
        expect(box!.height, `divider -${offset}px: toolbar wrapped onto a second row`)
          .toBeLessThan(SINGLE_ROW_MAX_HEIGHT);
        // ...and nothing may escape the card sideways instead of wrapping.
        expect(box!.x + box!.width, `divider -${offset}px: toolbar overflows its card`)
          .toBeLessThanOrEqual(cardBox!.x + cardBox!.width + 1);
        // Below ~300px of content the ladder runs out and the controls start
        // sitting on top of each other. That is the state the chat-column floor
        // exists to make unreachable, so check the controls themselves.
        const overlap = await toolbar.evaluate((el) => {
          const boxes = [...el.querySelectorAll('button')].map((b) => b.getBoundingClientRect());
          return boxes.some((a, i) => boxes.slice(i + 1).some((b) => (
            a.right > b.left + 1 && b.right > a.left + 1 && a.bottom > b.top + 1 && b.bottom > a.top + 1
          )));
        });
        expect(overlap, `divider -${offset}px: toolbar controls overlap each other`).toBe(false);

        widest = Math.max(widest, box!.width);
        narrowest = Math.min(narrowest, box!.width);
      }
      await page.mouse.up();

      // Guard the guard: a drag that silently stopped working would pass
      // everything above while proving nothing.
      expect(widest - narrowest, 'the divider drag never moved anything')
        .toBeGreaterThan(100);
      // ...and the floor held. 1000px window, sidebar collapsed: the chat keeps
      // CHAT_MIN_WIDTH (480), leaving the toolbar 368px of content inside its
      // 32px of padding. Before the clamp this bottomed out at 236px total,
      // with `+` sitting under the permission icon.
      expect(narrowest, 'the divider starved the chat column past its floor')
        .toBeGreaterThanOrEqual(400);

      // The permission rung still fired on the way down, and comes back with
      // the space.
      await expect(permissionLabel).toBeHidden();
      await launched.app.evaluate(({ BrowserWindow }) => {
        BrowserWindow.getAllWindows()[0]?.setBounds({ width: 1400, height: 820 });
      });
      await expect(permissionLabel).toBeVisible();

      await closeAbuElectron(launched.app);
    } finally {
      await mock.close();
      removeElectronDataRoot(dataRoot);
    }
  });
});
