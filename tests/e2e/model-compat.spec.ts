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
  pressWhenSettled,
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
let recoveryMock: OpenAiMock | undefined;
let ollama: OllamaMock | undefined;
let readingFixtureDirectory: string | undefined;

function createReadingFixtureDirectory(runId: string): string {
  readingFixtureDirectory = path.join(process.cwd(), '.agent', 'model-compat-fixtures', runId);
  fs.mkdirSync(readingFixtureDirectory, { recursive: true });
  return readingFixtureDirectory;
}

async function allowFileRead(page: Page, filePath: string): Promise<void> {
  const dialog = page.getByRole('alertdialog', { name: '文件读取权限' });
  await expect(dialog).toBeVisible({ timeout: READY_TIMEOUT });
  await expect(dialog).toContainText(filePath);
  await pressWhenSettled(dialog.getByRole('button', { name: '允许本次会话', exact: true }));
  await expect(dialog).toBeHidden();
}

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
    if (recoveryMock) {
      await recoveryMock.close();
      recoveryMock = undefined;
    }
    if (ollama) {
      await ollama.close();
      ollama = undefined;
    }
    if (dataRoot) {
      removeElectronDataRoot(dataRoot);
      dataRoot = undefined;
    }
    if (readingFixtureDirectory) {
      fs.rmSync(readingFixtureDirectory, { recursive: true });
      readingFixtureDirectory = undefined;
    }
  });

  test('learns the real context size from a llama.cpp overflow, tidies up and finishes', async () => {
    const runId = randomUUID();
    const answer = `abu-e2e-context-recovered-${runId}`;
    const nextAnswer = `abu-e2e-context-next-round-${runId}`;
    const seedAnswers = [`abu-e2e-context-first-${runId}`, `abu-e2e-context-second-${runId}`];
    const page = await openChat([
      ...seedAnswers.map((responseText) => ({ kind: 'complete' as const, responseText })),
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

    for (const [index, seedAnswer] of seedAnswers.entries()) {
      await send(page, `abu-e2e-context-seed-${index}-${runId}`);
      await expect(page.getByText(seedAnswer, { exact: true })).toBeVisible({ timeout: READY_TIMEOUT });
      await expectRunEnded(page);
    }
    await send(page, `abu-e2e-context-overflow-${runId}`);
    await expect(page.getByText(answer, { exact: true })).toBeVisible({ timeout: READY_TIMEOUT });
    await expect(page.locator('[data-compact-status="done"]')).toHaveCount(1);
    expect(compressionRequests(mock!)).toHaveLength(1);
    await expect(page.getByText('exceeds the available context size')).toHaveCount(0);

    const requests = taskRequests(mock!);
    expect(requests).toHaveLength(4);
    // 本机地址按名字估计封顶 32768，回答预留 25% = 8192；学到 30720 后预留 7680
    expect((requests[2].body as { max_tokens?: number }).max_tokens).toBe(8192);
    expect((requests[3].body as { max_tokens?: number }).max_tokens).toBe(7680);

    await page.getByTestId('context-indicator').click();
    await expect(page.getByTestId('context-breakdown-header')).toContainText('/ 30.7k');
    await page.keyboard.press('Escape');
    await expectRunEnded(page);

    // The next request uses the learned window and keeps the existing divider.
    await send(page, `abu-e2e-context-next-${runId}`);
    await expect(page.getByText(nextAnswer, { exact: true })).toBeVisible({ timeout: READY_TIMEOUT });
    await expectRunEnded(page);
    const allRequests = taskRequests(mock!);
    expect(allRequests).toHaveLength(5);
    expect((allRequests[4].body as { max_tokens?: number }).max_tokens)
      .toBe((allRequests[3].body as { max_tokens?: number }).max_tokens);
    expect((allRequests[4].body as { max_tokens?: number }).max_tokens).toBe(7680);
    await expect(page.locator('[data-compact-status="done"]')).toHaveCount(1);
    await expect(page.getByText('Error:')).toHaveCount(0);
  });

  test('runs an operation the model wrote as <invoke> text and never shows that text', async () => {
    const runId = randomUUID();
    const answer = `abu-e2e-invoke-answer-${runId}`;
    const marker = `abu-e2e-invoke-fixture-${runId}`;
    dataRoot = createElectronDataRoot();
    const fixtureDir = createReadingFixtureDirectory(runId);
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
    await allowFileRead(page, fixturePath);
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
    // Six completed turns supply the history for the long file-reading task.
    const turnAnswers = Array.from({ length: 6 }, (_, index) => `abu-e2e-lmstudio-turn-${index}-${runId}`);
    const finalAnswer = `abu-e2e-lmstudio-after-tidy-${runId}`;
    dataRoot = createElectronDataRoot();
    const fixtureDir = createReadingFixtureDirectory(runId);
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
    for (const fixture of fixtures) await allowFileRead(page, fixture.path);
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

  test('waits for model selection before sending when LM Studio has insufficient context', async () => {
    const page = await openLmStudioChat([{ kind: 'complete', responseText: 'abu-e2e-never-sent' }], 8192);

    await send(page, `abu-e2e-lmstudio-too-small-${randomUUID()}`);
    await expect(page.getByText('当前模型无法容纳任务内容，任务进度已保留。', { exact: true })).toBeVisible({ timeout: READY_TIMEOUT });
    await expect(page.getByRole('button', { name: '选择模型并继续', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '停止', exact: true })).toBeVisible();

    expect(mock!.getRequests).toContain('/api/v0/models');
    expect(mock!.requests).toHaveLength(0);
    await expect(page.getByText('abu-e2e-never-sent')).toHaveCount(0);
    await page.getByRole('button', { name: '停止', exact: true }).click();
    await expectRunEnded(page);
    await expect(page.getByRole('button', { name: '选择模型并继续', exact: true })).toHaveCount(0);
  });

  const OLLAMA_MODEL = 'qwen3:0.6b';

  /** 内置 Ollama 服务商指向模拟服务；Ollama 已按 loadedContextLength 加载了模型。 */
  async function openOllamaChat(answer: string, contextWindowSize: number | null): Promise<Page> {
    ollama = await startOllamaMock({ loadedContextLength: 16384, modelId: OLLAMA_MODEL, replies: [answer] });
    return launchChat(ollama.baseUrl, {
      apiKey: '',
      contextWindowSize,
      modelId: OLLAMA_MODEL,
      modelLabel: OLLAMA_MODEL,
      providerId: 'ollama',
      providerName: 'Ollama',
      providerSource: 'builtin',
      keepOtherProviders: true,
    });
  }

  type OllamaChatBody = { options?: { num_ctx?: unknown }; shift?: unknown; truncate?: unknown };

  test('P1-3 follows the context length Ollama loaded the model with and lets nothing be trimmed quietly', async () => {
    const answer = `abu-e2e-ollama-answer-${randomUUID()}`;
    const page = await openOllamaChat(answer, null);

    await send(page, `abu-e2e-ollama-question-${randomUUID()}`);
    await expect(page.getByText(answer, { exact: true })).toBeVisible({ timeout: READY_TIMEOUT });
    await expectRunEnded(page);

    // 运行开始问了 /api/ps，水位上限就是 Ollama 报告的已加载长度
    expect(ollama!.psRequests).toBeGreaterThan(0);
    const taskCalls = ollama!.chatRequests.filter((request) => request.purpose === 'task');
    expect(taskCalls).toHaveLength(1);
    for (const request of ollama!.chatRequests) {
      const body = request.body as OllamaChatBody;
      // 用户没填「上下文长度」：不带 num_ctx，Ollama 按自己的设置运行
      expect(body.options ?? {}).not.toHaveProperty('num_ctx');
      expect(body.truncate).toBe(false);
      expect(body.shift).toBe(false);
    }
    await expect(contextIndicator(page)).toHaveAttribute('aria-label', /\/ 16\.4k tokens$/);
  });

  test('P1-3 lets Ollama run at the context length the user filled in', async () => {
    const answer = `abu-e2e-ollama-answer-${randomUUID()}`;
    const page = await openOllamaChat(answer, 24576);

    await send(page, `abu-e2e-ollama-question-${randomUUID()}`);
    await expect(page.getByText(answer, { exact: true })).toBeVisible({ timeout: READY_TIMEOUT });
    await expectRunEnded(page);

    expect(ollama!.chatRequests.filter((request) => request.purpose === 'task')).toHaveLength(1);
    for (const request of ollama!.chatRequests) {
      const body = request.body as OllamaChatBody;
      expect(body.options?.num_ctx).toBe(24576);
      expect(body.truncate).toBe(false);
      expect(body.shift).toBe(false);
    }
    await expect(contextIndicator(page)).toHaveAttribute('aria-label', /\/ 24\.6k tokens$/);
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

  test('continues the preserved task after the user selects a model with sufficient context', async () => {
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
    const page = await openChat([tooSmall, tooSmall, tooSmall, tooSmall], { contextWindowSize: null });
    const answer = `abu-e2e-context-selection-${randomUUID()}`;
    recoveryMock = await startOpenAiMock([{ kind: 'complete', responseText: answer }]);
    await configureLocalMockProvider(page, recoveryMock.baseUrl, {
      providerId: 'context-recovery-provider', providerName: 'Context recovery provider',
      modelId: 'context-recovery-model', modelLabel: '上下文恢复模型', keepOtherProviders: true,
    });
    await configureLocalMockProvider(page, mock!.baseUrl, { contextWindowSize: null, keepOtherProviders: true });
    const prompt = `abu-e2e-too-small-${randomUUID()}`;
    await send(page, prompt);
    await expect(page.getByText('当前模型无法容纳任务内容，任务进度已保留。', { exact: true })).toBeVisible({ timeout: READY_TIMEOUT });
    const choose = page.getByRole('button', { name: '选择模型并继续', exact: true });
    await expect(choose).toBeVisible();
    await expect(page.getByText('exceeds the available context size')).toHaveCount(0);
    expect(taskRequests(mock!)).toHaveLength(1);
    expect(taskRequests(recoveryMock)).toHaveLength(0);
    await choose.click();
    await page.getByRole('button', { name: '上下文恢复模型', exact: true }).last().click();
    await expect(page.getByText(answer, { exact: true })).toBeVisible({ timeout: READY_TIMEOUT });
    await expect(choose).toHaveCount(0);
    await expectRunEnded(page);
    expect(taskRequests(mock!)).toHaveLength(1);
    const resumed = taskRequests(recoveryMock);
    expect(resumed).toHaveLength(1);
    expect(resumed[0].body).toMatchObject({ model: 'context-recovery-model' });
    expect((resumed[0].body as ChatRequestBody).messages).toContainEqual(expect.objectContaining({ role: 'user', content: prompt }));
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
    await pressWhenSettled(page.getByRole('button', { name: /^(取消|Cancel)$/ }));

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

  test('shows supported and current context lengths, saves 1M, and restores the default in model settings', async () => {
    const models = [
      { id: 'context-large', contextLength: 1_000_000 },
      { id: 'context-small', contextLength: 128000 },
    ];
    const page = await openChat([], { keepOtherProviders: true }, {
      getRoutes: {
        '/v1/models': { object: 'list', data: models.map(({ id }) => ({ id, object: 'model' })) },
        '/api/v0/models': {
          object: 'list',
          data: models.map(({ id, contextLength }) => ({
            id, object: 'model', type: 'llm', state: 'loaded',
            max_context_length: contextLength, loaded_context_length: contextLength,
          })),
        },
      },
    });
    await app!.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0].setContentSize(900, 720);
    });
    const sidebarToggle = page.locator('[data-window-control="sidebar"]').first();
    if (/^显示/.test((await sidebarToggle.getAttribute('aria-label')) ?? '')) await sidebarToggle.click();
    await page.getByRole('button', { name: /^(我|登录 \/ 注册)$/ }).first().click();
    await page.getByText('设置', { exact: true }).last().click();
    const settings = page.locator('[data-abu-settings-dialog]');
    await expect(settings).toBeVisible({ timeout: READY_TIMEOUT });
    await settings.getByText('模型', { exact: true }).first().click();
    await settings.getByRole('button', { name: '添加', exact: true }).first().click();
    await page.getByRole('button', { name: '选择供应商' }).click();
    await page.getByRole('button', { name: 'LM Studio', exact: true }).click();
    await page.getByPlaceholder('http://127.0.0.1:1234/v1').fill(mock!.baseUrl);
    await page.getByRole('button', { name: '获取模型列表' }).click();
    await expect(page.getByText('获取到 2 个模型')).toBeVisible({ timeout: READY_TIMEOUT });
    const largeRow = page.getByText('context-large', { exact: true }).locator('../..');
    await largeRow.getByRole('button', { name: '高级配置', exact: true }).click();
    const input = largeRow.getByRole('textbox', { name: '上下文长度', exact: true });
    await expect(input).toHaveValue('');
    await expect(largeRow.getByText('模型支持 1M', { exact: true })).toBeVisible();
    await expect(largeRow.getByText('当前使用 200K（默认）', { exact: true })).toBeVisible();
    await largeRow.getByRole('button', { name: '1M', exact: true }).click();
    await expect(input).toHaveValue('1000000');
    await expect(largeRow.getByText('当前使用 1M', { exact: true })).toBeVisible();
    await expect(largeRow.getByRole('button', { name: '1M', exact: true })).toHaveAttribute('aria-pressed', 'true');
    expect(await largeRow.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
    const inputBox = await input.boundingBox();
    const outputBox = await largeRow.getByRole('textbox', { name: '最大输出 Token', exact: true }).boundingBox();
    expect(inputBox).not.toBeNull();
    expect(outputBox).not.toBeNull();
    expect(inputBox!.y).toBe(outputBox!.y);
    await largeRow.screenshot({ path: path.join(process.cwd(), '.agent', 'context-settings-1m.png') });
    const smallRow = page.getByText('context-small', { exact: true }).locator('../..');
    await smallRow.getByRole('button', { name: '高级配置', exact: true }).click();
    await expect(smallRow.getByText('模型支持 128K', { exact: true })).toBeVisible();
    await expect(smallRow.getByText('当前使用 128K（默认）', { exact: true })).toBeVisible();
    await expect(smallRow.getByRole('textbox', { name: '上下文长度', exact: true })).toHaveValue('');
    await page.getByRole('button', { name: '保存', exact: true }).click();

    const providerCard = settings.getByRole('switch', { name: 'LM Studio', exact: true }).locator('../../..');
    await providerCard.hover();
    await providerCard.getByRole('button', { name: '编辑', exact: true }).click();
    await largeRow.getByRole('button', { name: '高级配置', exact: true }).click();
    await expect(input).toHaveValue('1000000');
    await expect(largeRow.getByText('模型支持 1M', { exact: true })).toBeVisible();
    await expect(largeRow.getByText('当前使用 1M', { exact: true })).toBeVisible();
    await input.fill('500000');
    await expect(largeRow.getByText('当前使用 500K', { exact: true })).toBeVisible();
    await input.clear();
    await expect(largeRow.getByText('当前使用 200K（默认）', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: '保存', exact: true }).click();
    await providerCard.hover();
    await providerCard.getByRole('button', { name: '编辑', exact: true }).click();
    await largeRow.getByRole('button', { name: '高级配置', exact: true }).click();
    await expect(input).toHaveValue('');
    await expect(largeRow.getByText('当前使用 200K（默认）', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: '保存', exact: true }).click();
    await page.locator('[data-abu-settings-close]').click();
    await expect(settings).toHaveCount(0);

    await Promise.all([page.waitForEvent('load'), page.evaluate(async () => {
      await navigator.locks.request('abu-browser-permission-config-v2', () => {
        const persisted = JSON.parse(localStorage.getItem('abu-settings')!) as { state: Record<string, unknown>; version: number };
        persisted.state.language = 'en-US';
        persisted.state.theme = 'dark';
        localStorage.setItem('abu-settings', JSON.stringify(persisted));
        location.reload();
      });
    })]);
    await expect(page.locator('html')).toHaveAttribute('lang', 'en-US', { timeout: READY_TIMEOUT });
    await expect(page.locator('html')).toHaveClass(/dark/);
    await page.getByRole('button', { name: /^(Me|Sign in \/ Sign up)$/ }).first().click();
    await page.getByRole('menuitem', { name: 'Settings', exact: true }).click();
    await settings.getByText('Models', { exact: true }).first().click();
    await providerCard.hover();
    await providerCard.getByRole('button', { name: 'Edit', exact: true }).click();
    await largeRow.getByRole('button', { name: 'Advanced', exact: true }).click();
    await expect(largeRow.getByText('Model supports 1M', { exact: true })).toBeVisible();
    await expect(largeRow.getByText('Currently using 200K (default)', { exact: true })).toBeVisible();
    await expect(largeRow.getByRole('textbox', { name: 'Context length', exact: true })).toHaveValue('');
    expect(await largeRow.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
    await largeRow.getByRole('button', { name: '1M', exact: true }).focus();
    await page.keyboard.press('Enter');
    await expect(largeRow.getByText('Currently using 1M', { exact: true })).toBeVisible();
    await largeRow.screenshot({ path: path.join(process.cwd(), '.agent', 'context-settings-en-dark.png') });
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
