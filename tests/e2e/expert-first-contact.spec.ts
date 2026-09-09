import { expect, test } from '@playwright/test';
import type { Page } from 'playwright';
import { createServer } from 'node:http';
import { closeAbuElectron, configureLocalMockProvider, createElectronDataRoot, dismissFirstRunOverlays, launchAbuElectron, removeElectronDataRoot } from './electronHelpers';

async function startMock() {
  const requests: Array<{ messages?: Array<{ role: string; content?: string | Array<{ text?: string }> }> }> = [];
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    requests.push(JSON.parse(raw || '{}'));
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const [content, finish] of [['已收到你的目标。', null], ['', 'stop']]) {
      res.write(`data: ${JSON.stringify({ id: 'first-contact', object: 'chat.completion.chunk', created: 0, model: 'mock', choices: [{ index: 0, delta: { content }, finish_reason: finish }] })}\n\n`);
    }
    res.end('data: [DONE]\n\n');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing loopback address');
  return { requests, baseUrl: `http://2130706433:${address.port}/v1`, close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }) };
}

async function openIdentity(page: Page, team: boolean) {
  await expect(page.getByRole('textbox').first()).toBeVisible({ timeout: 45_000 });
  if (await page.getByRole('button', { name: '显示侧栏', exact: true }).isVisible()) await page.getByRole('button', { name: '显示侧栏', exact: true }).click();
  await page.getByTestId('sidebar-team').click();
  await page.getByTestId('top-tab-nav').getByRole('button', { name: team ? '专家团' : '专家', exact: true }).click();
  if (team) await page.getByTestId('team-row-E2E专家团').click();
  else await page.getByText('产品经理', { exact: true }).first().click();
  if (team) await page.getByTestId('team-detail-start-chat').click();
  else await page.getByRole('button', { name: '开始对话', exact: true }).click();
}

for (const team of [false, true]) {
  test(`first contact persists only after sending and stays completed across restart (${team ? 'team' : 'expert'})`, async () => {
    test.setTimeout(180_000);
    const dataRoot = createElectronDataRoot();
    const mock = await startMock();
    let launched = await launchAbuElectron(dataRoot);
    try {
      let page = await launched.app.firstWindow();
      await page.waitForLoadState('domcontentloaded');
      await expect(page.getByRole('textbox').first()).toBeVisible({ timeout: 45_000 });
      await dismissFirstRunOverlays(page);
      await page.evaluate(() => {
        const previous = JSON.parse(localStorage.getItem('abu-team') ?? '{}');
        localStorage.setItem('abu-team', JSON.stringify({ ...previous, state: { ...previous.state, teams: [{ id: 't-first', name: 'E2E专家团', description: '整理目标并给出方案', intro: '这份方案是给谁用的？', leaderRoleId: 'builtin:产品经理', memberRoleIds: ['builtin:产品经理'], requirePlanApproval: false, createdAt: 1 }] } }));
      });
      await configureLocalMockProvider(page, mock.baseUrl, { supportsTools: true, permissionMode: 'standard' });
      await openIdentity(page, team);
      const greeting = page.getByTestId('expert-introduction');
      await expect(greeting).toBeVisible();
      await expect(page.getByRole('textbox')).toHaveValue('');
      await expect(page.getByRole('button', { name: /选择工作区/ })).toBeVisible();
      const greetingText = await greeting.locator('.select-text').innerText();
      expect(greetingText.trim().length).toBeGreaterThan(0);
      expect(await page.evaluate(() => Object.keys(JSON.parse(localStorage.getItem('abu-chat') ?? '{}').state.conversationIndex))).toHaveLength(0);
      // Leaving without sending does not consume first contact or create history.
      await openIdentity(page, team);
      await expect(page.getByTestId('expert-introduction')).toContainText(greetingText);
      await page.screenshot({ path: test.info().outputPath('first-contact.png') });
      await page.getByRole('textbox').fill('给同事用');
      await page.getByRole('textbox').press('Enter');
      await expect.poll(() => mock.requests.some((request) => request.messages?.some((message) => {
        const content = typeof message.content === 'string' ? message.content : message.content?.map((block) => block.text ?? '').join('\n') ?? '';
        return message.role === 'user' && content.includes(JSON.stringify(greetingText));
      })), { timeout: 45_000 }).toBe(true);
      await expect(page.getByTestId('expert-introduction')).toHaveCount(1);
      await expect.poll(async () => page.evaluate(() => Object.values(JSON.parse(localStorage.getItem('abu-chat') ?? '{}').state.expertContactReceipts).filter((receipt) => (receipt as { confirmed: boolean }).confirmed).length)).toBe(1);
      await closeAbuElectron(launched.app);
      launched = await launchAbuElectron(dataRoot);
      page = await launched.app.firstWindow();
      await openIdentity(page, team);
      await expect(page.getByTestId('expert-introduction')).toHaveCount(0);
      await expect(page.getByRole('textbox')).toBeVisible();
      expect(await page.evaluate(() => Object.values(JSON.parse(localStorage.getItem('abu-chat') ?? '{}').state.expertContactReceipts).some((receipt) => (receipt as { confirmed: boolean }).confirmed))).toBe(true);
      await page.screenshot({ path: test.info().outputPath('subsequent-contact.png') });
      const savedTitle = await page.evaluate(() => (Object.values(JSON.parse(localStorage.getItem('abu-chat') ?? '{}').state.conversationIndex)[0] as { title: string }).title);
      await page.getByText(savedTitle, { exact: true }).first().click();
      await expect(page.getByTestId('expert-introduction')).toContainText(greetingText);
      await expect(page.getByTestId('expert-introduction')).toHaveCount(1);
      await page.screenshot({ path: test.info().outputPath('restored-contact.png') });
    } finally {
      if (test.info().status !== test.info().expectedStatus) await test.info().attach('provider-requests', { body: JSON.stringify(mock.requests, null, 2), contentType: 'application/json' });
      await closeAbuElectron(launched.app);
      await mock.close();
      removeElectronDataRoot(dataRoot);
    }
  });
}
