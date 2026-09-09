import { expect, test } from '@playwright/test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { closeAbuElectron, dismissFirstRunOverlays, launchAbuElectron, removeElectronDataRoot } from './electronHelpers';

test('released skill cards keep switches, detail actions and creation', async () => {
  const launched = await launchAbuElectron();
  try {
    const page = await launched.app.firstWindow();
    await expect(page.getByPlaceholder('想让阿布帮你做点什么？')).toBeVisible({ timeout: 45_000 });
    await dismissFirstRunOverlays(page);
    await page.getByLabel('Main navigation').getByRole('button', { name: '扩展', exact: true }).click();
    await page.getByRole('button', { name: '技能', exact: true }).click();
    await expect(page.getByTestId('extensions-source-market')).toHaveCount(0);
    await expect(page.getByText('技能通过插件获取', { exact: true })).toHaveCount(0);
    const card = page.getByRole('button', { name: /^Abu-Browser / });
    await expect(card).toBeVisible();
    const bounds = await card.boundingBox();
    expect(bounds!.height).toBe(120);
    expect(bounds!.width).toBeLessThan(500);
    await card.getByRole('switch').click();
    await expect(page.getByTestId('skill-detail')).toHaveCount(0);
    await card.click();
    const detail = page.locator('[data-electron-no-drag]').filter({ has: page.getByTestId('skill-detail') }).last();
    await expect(detail).toBeVisible();
    await expect(detail.getByRole('switch')).toHaveAttribute('aria-checked', 'false');
    await detail.getByRole('switch').click();
    await detail.getByTestId('skill-detail-menu').click();
    await expect(detail.getByText('导出', { exact: false })).toBeVisible();
    await expect(detail.getByText('查看历史', { exact: true })).toBeVisible();
    await page.screenshot({ animations: 'disabled', path: 'test-results/extensions-skills-detail.png' });
    await page.keyboard.press('Escape');
    await page.screenshot({ animations: 'disabled', path: 'test-results/extensions-skills-cards.png' });
    await page.getByTestId('skill-create-trigger').click();
    await page.getByText('手动创建', { exact: true }).click();
    await expect(page.getByPlaceholder('my-skill')).toBeVisible();
  } finally {
    await closeAbuElectron(launched.app);
    removeElectronDataRoot(launched);
  }
});

test('released connector cards keep template install and connection actions', async () => {
  // A real loopback MCP endpoint keeps the UI flow local and credential-free.
  const server = createServer(async (req, res) => {
    if (req.method !== 'POST') { res.writeHead(405); res.end(); return; }
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const message = JSON.parse(Buffer.concat(chunks).toString());
    if (message.id === undefined) { res.writeHead(202); res.end(); return; }
    const result = message.method === 'initialize'
      ? { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'ui-layout-fixture', version: '1.0.0' } }
      : { tools: [] };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No fixture port');
  let launched: Awaited<ReturnType<typeof launchAbuElectron>> | undefined;
  try {
    launched = await launchAbuElectron();
    const page = await launched.app.firstWindow();
    await expect(page.getByPlaceholder('想让阿布帮你做点什么？')).toBeVisible({ timeout: 45_000 });
    await dismissFirstRunOverlays(page);
    await page.getByLabel('Main navigation').getByRole('button', { name: '扩展', exact: true }).click();
    await page.getByRole('button', { name: '连接器', exact: true }).click();
    await expect(page.getByText('精选连接器', { exact: true })).toHaveCount(0);
    await expect(page.getByTestId('extensions-source-market')).toHaveCount(0);
    const template = page.getByRole('button', { name: /^github / });
    await expect(template).toBeVisible();
    const templateBounds = await template.boundingBox();
    expect(templateBounds!.height).toBe(120);
    expect(templateBounds!.width).toBeLessThan(500);
    await template.click();
    await expect(page.getByRole('button', { name: '安装', exact: true })).toBeVisible();
    await page.keyboard.press('Escape');
    await page.screenshot({ animations: 'disabled', path: 'test-results/extensions-connectors-market.png' });
    await page.getByRole('button', { name: '添加', exact: true }).first().click();
    await page.getByPlaceholder('服务器名称').fill('ui-layout-fixture');
    await page.getByRole('button', { name: '远程服务 (HTTP)', exact: true }).click();
    await page.getByPlaceholder('http://localhost:3000/mcp').fill(`http://127.0.0.1:${address.port}/mcp`);
    await page.getByRole('button', { name: '添加', exact: true }).last().click();
    await expect(page.getByRole('heading', { name: 'ui-layout-fixture 连接器', exact: true })).toBeVisible();
    await page.keyboard.press('Escape');
    const ownCard = page.getByRole('button', { name: /^ui-layout-fixture / });
    await expect(ownCard.getByRole('switch')).toHaveAttribute('aria-checked', 'true', { timeout: 30_000 });
    const ownBounds = await ownCard.boundingBox();
    expect(ownBounds!.height).toBe(120);
    expect(Math.abs(ownBounds!.width - templateBounds!.width)).toBeLessThan(2);
    await page.screenshot({ animations: 'disabled', path: 'test-results/extensions-connectors-cards.png' });
    await ownCard.focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('heading', { name: 'ui-layout-fixture 连接器', exact: true })).toBeVisible();
    const connection = page.getByTestId('mcp-server-toggle-connection');
    await connection.click();
    await expect(connection).toHaveAttribute('data-connected', 'false');
    await connection.click();
    await expect(connection).toHaveAttribute('data-connected', 'true');
    await page.screenshot({ animations: 'disabled', path: 'test-results/extensions-connectors-detail.png' });
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: '添加', exact: true }).first().click();
    await expect(page.getByPlaceholder('服务器名称')).toBeVisible();
  } finally {
    if (launched) {
      await closeAbuElectron(launched.app);
      removeElectronDataRoot(launched);
    }
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
