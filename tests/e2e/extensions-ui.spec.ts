import { expect, test } from '@playwright/test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { closeAbuElectron, dismissFirstRunOverlays, launchAbuElectron, removeElectronDataRoot } from './electronHelpers';

test('skills market has no promotion and can open manual creation', async () => {
  const launched = await launchAbuElectron();
  try {
    const page = await launched.app.firstWindow();
    await expect(page.getByPlaceholder('想让阿布帮你做点什么？')).toBeVisible({ timeout: 45_000 });
    await dismissFirstRunOverlays(page);
    await page.getByLabel('Main navigation').getByRole('button', { name: '扩展', exact: true }).click();
    await page.getByRole('button', { name: '技能', exact: true }).click();
    await expect(page.getByTestId('extensions-source-market')).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByText('技能通过插件获取', { exact: true })).toHaveCount(0);
    await expect(page.getByTestId('skills-market-go-plugins')).toHaveCount(0);
    await expect(page.getByTestId('skill-create-trigger')).toBeVisible();
    await page.screenshot({ animations: 'disabled', path: 'test-results/extensions-skills-market.png' });
    await page.getByTestId('skill-create-trigger').click();
    await page.getByText('手动创建', { exact: true }).click();
    await expect(page.getByTestId('extensions-source-mine')).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByPlaceholder('my-skill')).toBeVisible();
  } finally {
    await closeAbuElectron(launched.app);
    removeElectronDataRoot(launched);
  }
});

test('connectors share row layout and allow adding from either source', async () => {
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
    const marketRow = page.getByTestId('connector-row').first();
    await expect(marketRow).toBeVisible();
    const marketBounds = await marketRow.boundingBox();
    const marketNameBounds = await marketRow.getByText('github', { exact: true }).boundingBox();
    await expect(marketRow.getByTestId('connector-add-button')).toHaveAttribute('data-variant', 'ghost');
    await page.screenshot({ animations: 'disabled', path: 'test-results/extensions-connectors-market.png' });
    await page.getByRole('button', { name: '添加', exact: true }).first().click();
    await expect(page.getByTestId('extensions-source-mine')).toHaveAttribute('aria-selected', 'true');
    await page.getByPlaceholder('服务器名称').fill('ui-layout-fixture');
    await page.getByRole('button', { name: '远程服务 (HTTP)', exact: true }).click();
    await page.getByPlaceholder('http://localhost:3000/mcp').fill(`http://127.0.0.1:${address.port}/mcp`);
    await page.getByRole('button', { name: '添加', exact: true }).last().click();
    await expect(page.getByRole('heading', { name: 'ui-layout-fixture', exact: true })).toBeVisible();
    await page.keyboard.press('Escape');
    const mineRow = page.getByTestId('connector-row').filter({ hasText: 'ui-layout-fixture' });
    await expect(mineRow.locator('[title="connected"]')).toBeVisible({ timeout: 30_000 });
    const mineBounds = await mineRow.boundingBox();
    const mineNameBounds = await mineRow.getByText('ui-layout-fixture', { exact: true }).boundingBox();
    expect(marketNameBounds).not.toBeNull();
    expect(mineNameBounds).not.toBeNull();
    expect(Math.abs(mineNameBounds!.x - marketNameBounds!.x)).toBeLessThan(2);
    expect(marketBounds).not.toBeNull();
    expect(mineBounds).not.toBeNull();
    expect(Math.abs(mineBounds!.width - marketBounds!.width)).toBeLessThan(2);
    expect(Math.abs(mineBounds!.height - marketBounds!.height)).toBeLessThan(2);
    await page.screenshot({ animations: 'disabled', path: 'test-results/extensions-connectors-mine.png' });
    await mineRow.getByRole('button', { name: 'ui-layout-fixture', exact: true }).focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('heading', { name: 'ui-layout-fixture', exact: true })).toBeVisible();
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
