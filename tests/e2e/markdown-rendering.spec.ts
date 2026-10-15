/**
 * Real-Electron journey for how a reply's Markdown is shown: TeX math through KaTeX
 * (loaded on first use), prices left as text, a code block in a language whose
 * Prism grammar loads on first use, and a long reply streamed in many pieces that
 * renders block by block and ends exactly as written.
 *
 * Screenshots are written to this test's output directory as evidence for a reviewer;
 * every assertion reads the DOM.
 */
import { test, expect, type ElectronApplication, type Page } from '@playwright/test';
import {
  closeAbuElectron,
  configureLocalMockProvider,
  createElectronDataRoot,
  dismissFirstRunOverlays,
  launchAbuElectron,
  removeElectronDataRoot,
  type ElectronDataRoot,
} from './electronHelpers';
import { CHAT_PLACEHOLDER, READY_TIMEOUT, startOpenAiMock, waitForApp, type OpenAiMock } from './openAiMock';

const PRICE_LINE = '两件商品分别是 $5 和 $10，合计 $15。';
const LAST_LINE = 'abu-e2e-markdown-reply-end';

const MATH_REPLY = [
  '## 勾股定理',
  '',
  '直角三角形的两条直角边为 $a$、$b$，斜边为 \\(c\\)，满足：',
  '',
  '$$',
  'a^2 + b^2 = c^2',
  '$$',
  '',
  '面积公式：',
  '',
  '\\[S = \\frac{1}{2}ab\\]',
  '',
  PRICE_LINE,
  '',
  '```rust',
  'fn area(a: f64, b: f64) -> f64 {',
  '    a * b / 2.0',
  '}',
  '```',
  '',
  'abu-e2e-markdown-math-end',
].join('\n');

const LONG_REPLY = [
  ...Array.from({ length: 60 }, (_, i) => `第 ${i + 1} 段：这是一段较长的说明文字，带有 **强调**、\`inline code\` 与 [链接](https://example.com)。`),
  '| 列一 | 列二 |\n|---|---|\n| 1 | 2 |',
  '```ts\nconst total: number = 42;\n```',
  LAST_LINE,
].join('\n\n');

let app: ElectronApplication | undefined;
let dataRoot: ElectronDataRoot | undefined;
let mock: OpenAiMock | undefined;

async function send(page: Page, text: string): Promise<void> {
  const input = page.getByPlaceholder(CHAT_PLACEHOLDER);
  await input.fill(text);
  await input.press('Enter');
}

test.describe.serial('Markdown rendering — real Electron', () => {
  test.beforeEach(async () => {
    mock = await startOpenAiMock([
      { kind: 'complete', responseText: MATH_REPLY, chunks: 12 },
      { kind: 'complete', responseText: LONG_REPLY, chunks: 80 },
    ]);
    dataRoot = createElectronDataRoot();
    const launched = await launchAbuElectron(dataRoot);
    app = launched.app;
  });

  test.afterEach(async () => {
    if (app) await closeAbuElectron(app);
    app = undefined;
    if (dataRoot) removeElectronDataRoot(dataRoot);
    dataRoot = undefined;
    await mock?.close();
    mock = undefined;
  });

  test('shows formulas, prices, a lazily highlighted language and a long streamed reply', async () => {
    const testInfo = test.info();
    const page = await app!.firstWindow({ timeout: READY_TIMEOUT });
    await waitForApp(page);
    await configureLocalMockProvider(page, mock!.baseUrl);
    await waitForApp(page);
    await dismissFirstRunOverlays(page);

    await send(page, '讲一下勾股定理');
    await expect(page.getByText('abu-e2e-markdown-math-end', { exact: true })).toBeVisible({ timeout: READY_TIMEOUT });

    // $a$, $b$, \(c\), the $$ block and the \[…\] block.
    await expect(page.locator('.katex')).toHaveCount(5, { timeout: READY_TIMEOUT });
    await expect(page.locator('.katex-display')).toHaveCount(2);
    await expect(page.locator('.katex-error')).toHaveCount(0);

    const price = page.getByText(PRICE_LINE, { exact: true });
    await expect(price).toBeVisible();
    await expect(price.locator('.katex')).toHaveCount(0);

    const keyword = page.locator('span', { hasText: /^fn$/ }).first();
    await expect(keyword).toHaveCSS('color', await page.evaluate(() => {
      const probe = document.createElement('span');
      probe.style.color = 'var(--ds-syntax-keyword)';
      document.body.append(probe);
      const color = getComputedStyle(probe).color;
      probe.remove();
      return color;
    }), { timeout: READY_TIMEOUT });

    await page.screenshot({ path: testInfo.outputPath('math-and-code.png') });

    await send(page, '再写一段长的说明');
    await expect(page.getByText(LAST_LINE, { exact: true })).toBeVisible({ timeout: READY_TIMEOUT });
    for (const n of [1, 30, 60]) {
      await expect(page.getByText(`第 ${n} 段：这是一段较长的说明文字，带有 强调、inline code 与 链接。`, { exact: true })).toBeVisible();
    }
    await expect(page.locator('table')).toHaveCount(1);
    await expect(page.getByText('const total: number = 42;', { exact: false })).toBeVisible();

    await page.screenshot({ path: testInfo.outputPath('long-reply.png') });
  });
});
