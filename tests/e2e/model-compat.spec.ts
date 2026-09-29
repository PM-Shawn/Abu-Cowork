/**
 * 本地与第三方模型的可用性（D 批）。模型服务只有 ./openAiMock 与 ./ollamaMock
 * 的本机模拟，不接收真实凭据或用户内容。
 */
import { expect, test } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { ElectronApplication, Locator, Page } from 'playwright';
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
  compressionRequests,
  startOpenAiMock,
  taskRequests,
  waitForApp,
  type MockReplyPlan,
  type OpenAiMock,
  type OpenAiMockOptions,
} from './openAiMock';
import { startOllamaMock, type OllamaMock } from './ollamaMock';

let app: ElectronApplication | undefined;
let dataRoot: ElectronDataRoot | undefined;
let mock: OpenAiMock | undefined;
let ollama: OllamaMock | undefined;

interface ChatRequestBody {
  max_tokens?: number;
  messages: Array<{ role: string; content: unknown }>;
  model?: string;
  tools?: Array<{ function: { name: string } }>;
}

async function launchChat(baseUrl: string, options: LocalMockProviderOptions): Promise<Page> {
  dataRoot ??= createElectronDataRoot();
  const launch = await launchAbuElectron(dataRoot);
  app = launch.app;
  const page = await app.firstWindow({ timeout: READY_TIMEOUT });
  await waitForApp(page);
  await configureLocalMockProvider(page, baseUrl, options);
  return page;
}

async function openChat(
  plans: readonly MockReplyPlan[],
  options: LocalMockProviderOptions,
  mockOptions: OpenAiMockOptions = {},
): Promise<Page> {
  mock = await startOpenAiMock(plans, mockOptions);
  return launchChat(mock.baseUrl, options);
}

const LM_STUDIO_MODEL = 'qwen3-8b';

/** 内置 LM Studio 服务商指向模拟服务，模型带工具，「上下文长度」留空，LM Studio 报告已加载长度。 */
async function openLmStudioChat(plans: readonly MockReplyPlan[], loadedContextLength: number): Promise<Page> {
  return openChat(plans, {
    apiKey: '',
    contextWindowSize: null,
    keepOtherProviders: true,
    modelId: LM_STUDIO_MODEL,
    modelLabel: LM_STUDIO_MODEL,
    providerId: 'lmstudio',
    providerName: 'LM Studio',
    providerSource: 'builtin',
    supportsTools: true,
  }, {
    getRoutes: {
      // 字段按 contextWindowProbe.ts 的 fetchLmStudioContextWindows 读取的写
      '/api/v0/models': {
        object: 'list',
        data: [{
          id: LM_STUDIO_MODEL,
          object: 'model',
          type: 'llm',
          state: 'loaded',
          max_context_length: 131072,
          loaded_context_length: loadedContextLength,
        }],
      },
    },
  });
}

async function send(page: Page, text: string): Promise<void> {
  const input = page.getByPlaceholder(CHAT_PLACEHOLDER);
  await input.fill(text);
  await input.press('Enter');
}

/** 这一轮结束：停止按钮消失，输入框可以再输入。 */
async function expectRunEnded(page: Page): Promise<void> {
  await expect(page.getByRole('button', { name: '停止' })).toHaveCount(0, { timeout: READY_TIMEOUT });
  await expect(page.getByPlaceholder(CHAT_PLACEHOLDER)).toBeEditable({ timeout: READY_TIMEOUT });
}

/** 给用户的一句普通说明：显示出来，所在段落前面不带「Error:」。 */
async function expectPlainNotice(page: Page, sentence: string): Promise<void> {
  const paragraph = page.getByRole('paragraph').filter({ hasText: sentence });
  await expect(paragraph).toBeVisible({ timeout: READY_TIMEOUT });
  await expect(paragraph).not.toContainText('Error:');
}

function contextIndicator(page: Page): Locator {
  return page.getByTestId('context-indicator').first();
}

/** 正文里写成 <tool_call> 文字的一次操作（Qwen / Hermes 的写法）。 */
function textToolCall(name: string, args: Record<string, unknown>): string {
  return `<tool_call>${JSON.stringify({ name, arguments: args })}</tool_call>`;
}

function quoteShellArgument(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function commandDialogTitle(page: Page): Locator {
  return page.getByRole('heading', { name: /^(操作确认|Confirm Action)$/ });
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
    if (ollama) {
      await ollama.close();
      ollama = undefined;
    }
    if (dataRoot) {
      removeElectronDataRoot(dataRoot);
      dataRoot = undefined;
    }
  });

  test('learns the real context size from a llama.cpp overflow, tidies up and finishes', async () => {
    const runId = randomUUID();
    const answer = `abu-e2e-context-recovered-${runId}`;
    const nextAnswer = `abu-e2e-context-next-round-${runId}`;
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
      { kind: 'complete', responseText: nextAnswer },
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
    await page.keyboard.press('Escape');
    await expectRunEnded(page);

    // 下一轮直接按学到的上限计算，服务不再报超长，也不再出现整理提示
    await send(page, `abu-e2e-context-next-${runId}`);
    await expect(page.getByText(nextAnswer, { exact: true })).toBeVisible({ timeout: READY_TIMEOUT });
    await expectRunEnded(page);
    const allRequests = taskRequests(mock!);
    expect(allRequests).toHaveLength(3);
    expect((allRequests[2].body as { max_tokens?: number }).max_tokens)
      .toBe((allRequests[1].body as { max_tokens?: number }).max_tokens);
    expect((allRequests[2].body as { max_tokens?: number }).max_tokens).toBe(7680);
    await expect(page.getByText('对话较长，正在整理前面的内容…')).toHaveCount(1);
    await expect(page.getByText('Error:')).toHaveCount(0);
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

  test('P1-1 asks LM Studio for the loaded length and runs a tool-enabled model within it', async () => {
    const answer = `abu-e2e-lmstudio-answer-${randomUUID()}`;
    // 40960 与按名字估计的 32768 不同，用来证明窗口取自 LM Studio 的报告
    const page = await openLmStudioChat([{ kind: 'complete', responseText: answer }], 40960);

    await send(page, `abu-e2e-lmstudio-question-${randomUUID()}`);
    await expect(page.getByText(answer, { exact: true })).toBeVisible({ timeout: READY_TIMEOUT });
    await expectRunEnded(page);

    // 上下文长度留空，窗口来自 LM Studio 报告的已加载长度
    expect(mock!.getRequests).toContain('/api/v0/models');
    // 水位上限就是 40960（formatK 按千位显示为 41.0k）
    await expect(contextIndicator(page)).toHaveAttribute('aria-label', /\/ 41\.0k tokens$/);
    const requests = taskRequests(mock!);
    expect(requests).toHaveLength(1);
    const body = requests[0].body as ChatRequestBody;
    expect(body.model).toBe(LM_STUDIO_MODEL);
    expect(body.tools?.length ?? 0).toBeGreaterThan(0);
    // 回答预留窗口的 25%
    expect(body.max_tokens).toBeLessThanOrEqual(10240);
  });

  // 32768 与按名字估计的值相同；窗口取自 LM Studio 报告这一点由上一条（40960）和 8192 那条用例区分
  test('P1-1 tidies up the earlier conversation before reaching the 32K length and finishes', async () => {
    test.setTimeout(120_000);
    const runId = randomUUID();
    // 语义整理要求保留第一轮与最近四轮之外还有可整理的轮次，所以先聊六轮
    const turnAnswers = Array.from({ length: 6 }, (_, index) => `abu-e2e-lmstudio-turn-${index}-${runId}`);
    const finalAnswer = `abu-e2e-lmstudio-after-tidy-${runId}`;
    dataRoot = createElectronDataRoot();
    const fixtureDir = path.join(dataRoot.rootDir, 'owned-lmstudio-fixtures');
    const fixtures = ['first', 'second'].map((name) => ({
      marker: `abu-e2e-lmstudio-fixture-${name}-${runId}`,
      path: path.join(fixtureDir, `${name}.txt`),
    }));
    fs.mkdirSync(fixtureDir, { recursive: true });
    for (const fixture of fixtures) fs.writeFileSync(fixture.path, fixture.marker);
    const page = await openLmStudioChat([
      ...turnAnswers.map((responseText) => ({ kind: 'complete' as const, responseText })),
      // 最后一个任务要来回好几步：读两个文件，再回答
      ...fixtures.map((fixture, index) => ({
        kind: 'tool-call' as const,
        arguments: { path: fixture.path },
        toolCallId: `call-lmstudio-read-${index}-${runId}`,
        toolName: 'read_file',
      })),
      { kind: 'complete', responseText: finalAnswer },
    ], 32768);

    // 前面几轮每轮带一段较长的内容，让对话逐步接近 32K
    const input = page.getByPlaceholder(CHAT_PLACEHOLDER);
    const longPayload = 'x'.repeat(6_000);
    for (const [index, answer] of turnAnswers.entries()) {
      await send(page, `abu-e2e-lmstudio-step-${index}-${runId}\n${longPayload}`);
      await expect(page.getByText(answer, { exact: true })).toBeVisible({ timeout: READY_TIMEOUT });
      await expect(input).toBeEditable({ timeout: READY_TIMEOUT });
    }
    await send(page, `请依次读取 ${fixtures[0].path} 和 ${fixtures[1].path}`);
    await expect(page.getByText(finalAnswer, { exact: true })).toBeVisible({ timeout: READY_TIMEOUT });
    await expectRunEnded(page);

    // 整理发生在服务报超长之前：服务一次都没有拒绝，最后一步带着整理后的摘要和两次读取的结果发出
    expect(compressionRequests(mock!).length).toBeGreaterThan(0);
    const requests = taskRequests(mock!);
    expect(requests).toHaveLength(turnAnswers.length + fixtures.length + 1);
    const lastBody = JSON.stringify(requests.at(-1)!.body);
    expect(lastBody).toContain('Abu E2E compacted conversation summary.');
    for (const fixture of fixtures) expect(lastBody).toContain(fixture.marker);
    await expect(page.getByText('exceeds the available context size')).toHaveCount(0);
    await expect(contextIndicator(page)).toHaveAttribute('aria-label', /\/ 32\.8k tokens$/);
  });

  test('P1-1 stops before sending when LM Studio loaded the model with too little room for Abu', async () => {
    const page = await openLmStudioChat([{ kind: 'complete', responseText: 'abu-e2e-never-sent' }], 8192);

    await send(page, `abu-e2e-lmstudio-too-small-${randomUUID()}`);
    await expectPlainNotice(
      page,
      '这个模型一次能记住的内容太少，放不下阿布需要的说明。可以换一个能记得更多的模型，或者在 LM Studio 里把上下文长度调大。',
    );
    await expectRunEnded(page);

    expect(mock!.getRequests).toContain('/api/v0/models');
    // 请求发出前就停下：模拟服务一次对话请求都没收到
    expect(mock!.requests).toHaveLength(0);
    await expect(page.getByText('abu-e2e-never-sent')).toHaveCount(0);
  });

  test('P1-3 talks to Ollama natively with the context size and no silent trimming', async () => {
    const modelId = 'qwen3:0.6b';
    const answer = `abu-e2e-ollama-answer-${randomUUID()}`;
    ollama = await startOllamaMock({ architecture: 'qwen3', contextLength: 16384, modelId, replies: [answer] });
    const page = await launchChat(ollama.baseUrl, {
      apiKey: '',
      contextWindowSize: null,
      modelId,
      modelLabel: modelId,
      providerId: 'ollama',
      providerName: 'Ollama',
      providerSource: 'builtin',
      keepOtherProviders: true,
    });

    await send(page, `abu-e2e-ollama-question-${randomUUID()}`);
    await expect(page.getByText(answer, { exact: true })).toBeVisible({ timeout: READY_TIMEOUT });
    await expectRunEnded(page);

    expect(ollama.showRequests).toContain(modelId);
    const taskCalls = ollama.chatRequests.filter((request) => request.purpose === 'task');
    expect(taskCalls).toHaveLength(1);
    for (const request of ollama.chatRequests) {
      const body = request.body as { options?: { num_ctx?: unknown }; shift?: unknown; truncate?: unknown };
      // 训练上限 16384 小于本地封顶 32768，窗口就是 16384
      expect(body.options?.num_ctx).toBe(16384);
      expect(body.truncate).toBe(false);
      expect(body.shift).toBe(false);
    }
    await expect(contextIndicator(page)).toHaveAttribute('aria-label', /\/ 16\.4k tokens$/);
  });

  test('P1-5 asks the model once, quietly, to rewrite a broken operation and then says it could not', async () => {
    const brokenCall = '<tool_call>{"name": "read_file", "arguments": {"path": "/abu-e2e-never-read';
    const page = await openChat([
      { kind: 'complete', responseText: `第一次写坏的操作。\n${brokenCall}` },
      { kind: 'complete', responseText: `第二次仍然写坏。\n${brokenCall}` },
    ], { supportsTools: true, permissionMode: 'standard' });

    await send(page, `abu-e2e-malformed-${randomUUID()}`);
    await expectPlainNotice(page, '这个模型没能正确发出操作，可以重试，或者换一个模型。');
    await expectRunEnded(page);

    // 给模型的纠错消息与写坏的原文都不出现在聊天里
    await expect(page.getByText('could not be parsed')).toHaveCount(0);
    await expect(page.getByText('<tool_call>')).toHaveCount(0);
    await expect(page.getByText('abu-e2e-never-read')).toHaveCount(0);

    const requests = taskRequests(mock!);
    expect(requests).toHaveLength(2);
    expect(JSON.stringify(requests[0].body)).not.toContain('could not be parsed');
    const retryUser = (requests[1].body as ChatRequestBody).messages.filter((message) => message.role === 'user');
    expect(JSON.stringify(retryUser)).toContain('The tool call in your previous reply could not be parsed');
  });

  test('P1-2 says in one Chinese sentence that a model remembering too little cannot hold the instructions', async () => {
    const tooSmall: MockReplyPlan = {
      kind: 'http-error',
      status: 400,
      body: {
        error: {
          code: 400,
          message: 'request (12000 tokens) exceeds the available context size (2048 tokens), try increasing it',
          type: 'exceed_context_size_error',
          n_prompt_tokens: 12000,
          n_ctx: 2048,
        },
      },
    };
    // 服务每次都说超长；多备几次回复，证明阿布不会一直重试
    const page = await openChat([tooSmall, tooSmall, tooSmall, tooSmall], { contextWindowSize: null });

    await send(page, `abu-e2e-too-small-${randomUUID()}`);
    await expectPlainNotice(
      page,
      '这个模型一次能记住的内容太少，放不下阿布需要的说明。可以换一个能记得更多的模型，或者在 LM Studio / Ollama 里把上下文长度调大。',
    );
    await expectRunEnded(page);
    await expect(page.getByText('exceeds the available context size')).toHaveCount(0);

    expect(taskRequests(mock!)).toHaveLength(1);
  });

  test('P1-4 asks before running a command the model wrote as text, and skips it when refused', async () => {
    const answer = `abu-e2e-refused-command-${randomUUID()}`;
    dataRoot = createElectronDataRoot();
    const sentinel = path.join(dataRoot.rootDir, `text-command-sentinel-${randomUUID()}.txt`);
    fs.writeFileSync(sentinel, 'must remain after the refusal');
    const command = `rm -- ${quoteShellArgument(sentinel)}`;
    const page = await openChat([
      { kind: 'complete', responseText: `我来删掉这个文件。\n${textToolCall('run_command', { command })}` },
      { kind: 'complete', responseText: answer },
    ], { supportsTools: true, permissionMode: 'standard' });

    await send(page, `abu-e2e-text-command-${randomUUID()}`);
    await expect(commandDialogTitle(page)).toBeVisible({ timeout: READY_TIMEOUT });
    await expect(page.getByText(command, { exact: true })).toBeVisible();
    expect(fs.existsSync(sentinel)).toBe(true);
    await page.getByRole('button', { name: /^(取消|Cancel)$/ }).click();

    await expect(page.getByText(answer, { exact: true })).toBeVisible({ timeout: READY_TIMEOUT });
    await expect(commandDialogTitle(page)).toBeHidden();
    await expect(page.getByText('<tool_call>')).toHaveCount(0);
    expect(fs.existsSync(sentinel)).toBe(true);

    const requests = taskRequests(mock!);
    expect(requests).toHaveLength(2);
    const toolResult = (requests[1].body as ChatRequestBody).messages.find((message) => message.role === 'tool');
    expect(String(toolResult?.content ?? '')).toContain('[用户取消了此操作]');
  });

  test('P1-4 leaves an operation written inside a code block as an example and does not run it', async () => {
    dataRoot = createElectronDataRoot();
    const sentinel = path.join(dataRoot.rootDir, `code-block-sentinel-${randomUUID()}.txt`);
    fs.writeFileSync(sentinel, 'must remain: the example is never run');
    const example = textToolCall('run_command', { command: `rm -- ${quoteShellArgument(sentinel)}` });
    const intro = `abu-e2e-code-block-intro-${randomUUID()}`;
    const page = await openChat([
      { kind: 'complete', responseText: `${intro}\n\n\`\`\`xml\n${example}\n\`\`\`\n` },
    ], { supportsTools: true, permissionMode: 'standard' });

    await send(page, `abu-e2e-code-block-${randomUUID()}`);
    await expect(page.getByText(intro, { exact: true })).toBeVisible({ timeout: READY_TIMEOUT });
    await expectRunEnded(page);

    // 代码块原样显示
    await expect(page.locator('pre').filter({ hasText: '<tool_call>' })).toContainText(example);
    await expect(commandDialogTitle(page)).toHaveCount(0);
    expect(taskRequests(mock!)).toHaveLength(1);
    expect(fs.existsSync(sentinel)).toBe(true);
  });

  test('P1-7 ticks 能看图 for an LM Studio vision model and gives it the screenshot playbook', async () => {
    const visionModel = 'qwen3-vl-8b';
    const answer = `abu-e2e-vision-answer-${randomUUID()}`;
    const page = await openChat([{ kind: 'complete', responseText: answer }], {
      supportsTools: true,
      computerUseEnabled: true,
      permissionMode: 'standard',
      keepOtherProviders: true,
    }, {
      getRoutes: {
        '/v1/models': { object: 'list', data: [{ id: visionModel, object: 'model', owned_by: 'organization_owner' }] },
        '/api/v0/models': {
          object: 'list',
          data: [{ id: visionModel, object: 'model', type: 'vlm', state: 'loaded', max_context_length: 32768, loaded_context_length: 32768 }],
        },
      },
    });

    // 设置 → 模型 → 添加 AI 服务 → LM Studio，地址指向本机模拟服务
    const sidebarToggle = page.locator('[data-window-control="sidebar"]').first();
    if (/^显示/.test((await sidebarToggle.getAttribute('aria-label')) ?? '')) await sidebarToggle.click();
    await page.getByRole('button', { name: /^(我|登录 \/ 注册)$/ }).first().click();
    await page.getByText('设置', { exact: true }).last().click();
    const settings = page.locator('[data-abu-settings-dialog]');
    await expect(settings).toBeVisible({ timeout: READY_TIMEOUT });
    await settings.getByText('模型', { exact: true }).first().click();
    // 页面标题旁的「添加」在前，服务卡片里的「添加」在后
    await settings.getByRole('button', { name: '添加', exact: true }).first().click();
    await expect(page.getByText('添加 AI 服务', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: '选择供应商' }).click();
    await page.getByRole('button', { name: 'LM Studio', exact: true }).click();
    await page.getByPlaceholder('http://127.0.0.1:1234/v1').fill(mock!.baseUrl);
    await page.getByRole('button', { name: '获取模型列表' }).click();
    await expect(page.getByText('获取到 1 个模型')).toBeVisible({ timeout: READY_TIMEOUT });

    // 展开这个模型（列表里只有它一个）的高级配置：「能看图」默认已勾上
    await expect(page.getByText(visionModel, { exact: true })).toBeVisible();
    const advancedConfig = page.getByRole('button', { name: '高级配置', exact: true });
    await advancedConfig.click();
    await expect(advancedConfig).toHaveAttribute('aria-expanded', 'true');
    await expect(page.getByRole('checkbox', { name: '能看图', exact: true })).toHaveAttribute('aria-checked', 'true');
    await page.getByRole('button', { name: '保存', exact: true }).click();
    await page.locator('[data-abu-settings-close]').click();
    await expect(settings).toHaveCount(0);

    // 在输入框旁的模型选择里换成它；它带着「能看图」标记
    await page.getByTestId('composer-toolbar')
      .getByRole('button', { name: 'Abu E2E deterministic model', exact: true }).click();
    await page.getByRole('button', { name: `${visionModel}，能看图`, exact: true }).click();

    await send(page, '帮我看看记事本里写了什么');
    await expect(page.getByText(answer, { exact: true })).toBeVisible({ timeout: READY_TIMEOUT });

    const body = taskRequests(mock!)[0].body as ChatRequestBody;
    expect(body.model).toBe(visionModel);
    const system = String(body.messages.find((message) => message.role === 'system')?.content ?? '');
    expect(system).toContain('computer(action="screenshot")');
    expect(system).not.toContain('The current model cannot see images');
    const computer = body.tools?.find((tool) => tool.function.name === 'computer');
    expect(computer).toBeDefined();
    expect(JSON.stringify(computer)).toContain('screenshot');
  });
});
