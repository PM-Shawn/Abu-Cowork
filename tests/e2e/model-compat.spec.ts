/**
 * 本地与第三方模型的可用性（D 批）。模型服务只有 ./openAiMock 的本机模拟，
 * 不接收真实凭据或用户内容。
 */
import { expect, test } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { ElectronApplication, Page } from 'playwright';
import {
  closeAbuElectron,
  configureLocalMockProvider,
  createElectronDataRoot,
  launchAbuElectron,
  removeElectronDataRoot,
  type ElectronDataRoot,
  type LocalMockProviderOptions,
} from './electronHelpers';
import {
  CHAT_PLACEHOLDER,
  READY_TIMEOUT,
  startOpenAiMock,
  taskRequests,
  waitForApp,
  type MockReplyPlan,
  type OpenAiMock,
} from './openAiMock';

let app: ElectronApplication | undefined;
let dataRoot: ElectronDataRoot | undefined;
let mock: OpenAiMock | undefined;

async function openChat(plans: readonly MockReplyPlan[], options: LocalMockProviderOptions): Promise<Page> {
  mock = await startOpenAiMock(plans);
  dataRoot ??= createElectronDataRoot();
  const launch = await launchAbuElectron(dataRoot);
  app = launch.app;
  const page = await app.firstWindow({ timeout: READY_TIMEOUT });
  await waitForApp(page);
  await configureLocalMockProvider(page, mock.baseUrl, options);
  return page;
}

async function send(page: Page, text: string): Promise<void> {
  const input = page.getByPlaceholder(CHAT_PLACEHOLDER);
  await input.fill(text);
  await input.press('Enter');
}

test.describe.serial('Electron local and third-party model compatibility', () => {
  test.afterEach(async () => {
    if (app) {
      await closeAbuElectron(app);
      app = undefined;
    }
    if (mock) {
      await mock.close();
      mock = undefined;
    }
    if (dataRoot) {
      removeElectronDataRoot(dataRoot);
      dataRoot = undefined;
    }
  });

  test('learns the real context size from a llama.cpp overflow, tidies up and finishes', async () => {
    const runId = randomUUID();
    const answer = `abu-e2e-context-recovered-${runId}`;
    const page = await openChat([
      {
        kind: 'http-error',
        status: 400,
        body: {
          error: {
            code: 400,
            message: 'request (40000 tokens) exceeds the available context size (30720 tokens), try increasing it',
            type: 'exceed_context_size_error',
            n_prompt_tokens: 40000,
            n_ctx: 30720,
          },
        },
      },
      { kind: 'complete', responseText: answer },
    ], { contextWindowSize: null });

    await send(page, `abu-e2e-context-overflow-${runId}`);
    await expect(page.getByText(answer, { exact: true })).toBeVisible({ timeout: READY_TIMEOUT });
    await expect(page.getByText('对话较长，正在整理前面的内容…')).toBeVisible();
    // 提示按斜体显示，星号不作为文字出现
    await expect(page.getByText('*对话较长')).toHaveCount(0);
    await expect(page.getByText('exceeds the available context size')).toHaveCount(0);

    const requests = taskRequests(mock!);
    expect(requests).toHaveLength(2);
    // 本机地址按名字估计封顶 32768，回答预留 25% = 8192；学到 30720 后预留 7680
    expect((requests[0].body as { max_tokens?: number }).max_tokens).toBe(8192);
    expect((requests[1].body as { max_tokens?: number }).max_tokens).toBe(7680);

    await page.getByTestId('context-indicator').click();
    await expect(page.getByTestId('context-breakdown-header')).toContainText('/ 30.7k');
  });

  test('runs an operation the model wrote as <invoke> text and never shows that text', async () => {
    const runId = randomUUID();
    const answer = `abu-e2e-invoke-answer-${runId}`;
    const marker = `abu-e2e-invoke-fixture-${runId}`;
    dataRoot = createElectronDataRoot();
    const fixtureDir = path.join(dataRoot.rootDir, 'owned-invoke-fixtures');
    const fixturePath = path.join(fixtureDir, 'invoke-fixture.txt');
    fs.mkdirSync(fixtureDir, { recursive: true });
    fs.writeFileSync(fixturePath, marker);

    const page = await openChat([
      {
        kind: 'complete',
        responseText: [
          '我先读一下文件。',
          '<function_calls>',
          '<invoke name="read_file">',
          `<parameter name="path">${fixturePath}</parameter>`,
          '</invoke>',
          '</function_calls>',
        ].join('\n'),
      },
      { kind: 'complete', responseText: answer },
    ], { supportsTools: true, permissionMode: 'standard' });

    await send(page, `请读取 ${fixturePath}`);
    await expect(page.getByText(answer, { exact: true })).toBeVisible({ timeout: READY_TIMEOUT });
    await expect(page.getByText('我先读一下文件。')).toBeVisible();
    await expect(page.getByText('<invoke')).toHaveCount(0);
    await expect(page.getByText('function_calls')).toHaveCount(0);
    // 工作过程里是普通的一步
    await page.getByRole('button', { name: /^用时/ }).click();
    await expect(page.getByText('读取了文件')).toBeVisible();

    const requests = taskRequests(mock!);
    expect(requests).toHaveLength(2);
    // 文件内容作为这次操作的结果交回模型
    const retryMessages = (requests[1].body as { messages: Array<{ role: string; content: unknown }> }).messages;
    const toolResult = retryMessages.find((message) => message.role === 'tool');
    expect(JSON.stringify(toolResult?.content)).toContain(marker);
  });

  test('gives a model that cannot see images no screenshot entry', async () => {
    const answer = `abu-e2e-structured-answer-${randomUUID()}`;
    const page = await openChat([{ kind: 'complete', responseText: answer }], {
      supportsTools: true,
      supportsImages: false,
      computerUseEnabled: true,
      permissionMode: 'standard',
    });

    await send(page, '帮我看看记事本里写了什么');
    await expect(page.getByText(answer, { exact: true })).toBeVisible({ timeout: READY_TIMEOUT });

    const body = taskRequests(mock!)[0].body as {
      messages: Array<{ role: string; content: unknown }>;
      tools?: Array<{ function: { name: string } }>;
    };
    const system = String(body.messages.find((message) => message.role === 'system')?.content ?? '');
    expect(system).toContain('The current model cannot see images');
    // 窗口文字里找不到需要的内容时，停下并建议换一个能看图的模型
    expect(system).toContain('switch to a model that can see images and try again');
    expect(system).not.toContain('computer(action="screenshot")');
    expect(system).not.toContain('After each action, a screenshot is automatically returned');

    const computer = body.tools?.find((tool) => tool.function.name === 'computer');
    expect(computer).toBeDefined();
    expect(JSON.stringify(computer).toLowerCase()).not.toContain('screenshot');
  });
});
