/**
 * 用量账本走真实的 renderer → preload → 主进程 → SQLite 这条链（期 1 第 2 至 4 步）。
 *
 * 任务书：`docs/2026-09-15-usage-accounting-fix-brief.md`。
 *
 * 单元测试各自只盯一段：归一化、账本、帧、页面。这条用例把整条链连起来跑一遍——
 * 本次故障正是断在两段之间，而两边各自的测试都是绿的。
 */
import { expect, test } from '@playwright/test';
import { createServer, type Server, type ServerResponse } from 'node:http';
import type { ElectronApplication, Page } from 'playwright';
import {
  closeAbuElectron,
  configureLocalMockProvider,
  createElectronDataRoot,
  dismissFirstRunOverlays,
  launchAbuElectron,
  removeElectronDataRoot,
  type ElectronDataRoot,
} from './electronHelpers';

const READY_TIMEOUT = 45_000;
const CHAT_PLACEHOLDER = '想让阿布帮你做点什么？';
const MOCK_REPLY = 'USAGE-LEDGER-MOCK-REPLY';

interface UsageMock {
  baseUrl: string;
  close: () => Promise<void>;
  /** 每个请求的 user-agent：用来看这次请求是 sidecar 发的还是 renderer 发的。 */
  userAgents: string[];
}

function sseLine(payload: Record<string, unknown>): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

/**
 * 回环上的 OpenAI 兼容假模型。主对话的请求带尾部 usage；其余请求（记忆提取等）
 * 不带，这样页面上的输入输出数字只来自主对话那一次，断言才对得上。
 */
async function startUsageMock(): Promise<UsageMock> {
  const userAgents: string[] = [];
  const open = new Set<ServerResponse>();
  const server: Server = createServer(async (req, res) => {
    open.add(res);
    res.once('close', () => open.delete(res));
    let raw = '';
    for await (const chunk of req) raw += String(chunk);
    const body = JSON.parse(raw) as { messages?: Array<{ role?: unknown; content?: unknown }>; stream?: unknown };
    userAgents.push(String(req.headers['user-agent'] ?? ''));
    const system = (body.messages ?? [])
      .filter((m) => m.role === 'system')
      .map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? '')))
      .join('\n');
    const isMainChat = !system.includes('记忆提取助手');
    const chunkBase = { id: 'chatcmpl-usage-e2e', object: 'chat.completion.chunk', created: 0, model: 'usage-mock-served' };

    res.writeHead(200, {
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'content-type': 'text/event-stream; charset=utf-8',
    });
    res.write(sseLine({ ...chunkBase, choices: [{ index: 0, delta: { content: isMainChat ? MOCK_REPLY : '[]' }, finish_reason: null }] }));
    res.write(sseLine({ ...chunkBase, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }));
    if (isMainChat) {
      res.write(sseLine({
        ...chunkBase,
        choices: [],
        usage: { prompt_tokens: 1200, completion_tokens: 300, prompt_tokens_details: { cached_tokens: 400 } },
      }));
    }
    res.end('data: [DONE]\n\n');
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); });
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('usage mock got no TCP port');
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    userAgents,
    close: () => new Promise<void>((resolve) => {
      for (const response of open) response.destroy();
      server.close(() => resolve());
      server.closeAllConnections?.();
    }),
  };
}

async function waitForApp(page: Page): Promise<void> {
  await page.waitForLoadState('domcontentloaded');
  await expect(page.getByPlaceholder(CHAT_PLACEHOLDER)).toBeVisible({ timeout: READY_TIMEOUT });
}

/** 本机时区的日历日——页面与账本用的是同一套算法。 */
function localDate(daysBefore = 0): string {
  const d = new Date();
  d.setDate(d.getDate() - daysBefore);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

interface SeedSpec {
  attemptId: string;
  localDate: string;
  requestedModel: string;
  skill: string | null;
  inputTotal: number | null;
  cacheRead: number | null;
  outputTotal: number;
}

async function seedUsage(page: Page, specs: SeedSpec[]): Promise<unknown[]> {
  return page.evaluate(async (rows: SeedSpec[]) => {
    const tauri = (
      window as unknown as {
        __TAURI_INTERNALS__?: { invoke: (cmd: string, args: unknown) => Promise<unknown> };
      }
    ).__TAURI_INTERNALS__;
    if (!tauri) throw new Error('missing __TAURI_INTERNALS__');
    const results: unknown[] = [];
    for (const row of rows) {
      results.push(
        await tauri.invoke('usage_record', {
          attempt: {
            schemaVersion: 1,
            attemptId: row.attemptId,
            logicalCallId: `call-${row.attemptId}`,
            revision: 1,
            providerInstanceId: 'provider-e2e',
            protocol: 'anthropic',
            requestedModel: row.requestedModel,
            servedModel: row.requestedModel,
            source: 'main',
            conversationId: 'conv-e2e',
            skill: row.skill,
            startedAtUtc: 1_789_000_000_000,
            localDate: row.localDate,
            tzId: 'Asia/Shanghai',
            offsetMinutes: 480,
            endedAtUtc: 1_789_000_002_000,
            outcome: 'succeeded',
            usage: {
              inputTotal: row.inputTotal,
              uncachedInput: null,
              cacheRead: row.cacheRead,
              cacheWrite: null,
              outputTotal: row.outputTotal,
              reasoningOutput: null,
              evidence: 'final',
              invalidFields: [],
            },
          },
        }),
      );
    }
    return results;
  }, specs);
}

async function openUsagePage(page: Page): Promise<void> {
  // 用键盘打开菜单：进了会话之后输入区会盖住侧栏底部的这个按钮，指针点不到，
  // 而键盘操作在欢迎页和会话页都走得通。
  const me = page.getByRole('button', { name: /^(我|Me|登录 \/ 注册|Sign in \/ Sign up)$/ }).first();
  await me.focus();
  await me.press('Enter');
  const settings = page.getByRole('menuitem', { name: /^(设置|Settings)$/ });
  await settings.focus();
  await settings.press('Enter');
  await page.getByRole('button', { name: /^(用量|Usage Stats)$/ }).click();
}

let app: ElectronApplication | undefined;
let dataRoot: ElectronDataRoot | undefined;
let mock: UsageMock | undefined;

test.describe.serial('用量账本', () => {
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

  test('真实发一条消息，这次请求的用量进了账本并显示在用量页上', async () => {
    // 这条就是报障的现象本身：正常聊了天，用量页却没有记录。
    // 假模型在回环地址上，其余全部是真的——真实的输入框、真实的 agent 主循环、
    // 真实的适配器与采集器、真实的进程边界、真实的 usage.sqlite。
    test.setTimeout(180_000);
    mock = await startUsageMock();
    dataRoot = createElectronDataRoot();
    const launched = await launchAbuElectron(dataRoot);
    app = launched.app;
    const page = await app.firstWindow({ timeout: READY_TIMEOUT });
    await waitForApp(page);
    await dismissFirstRunOverlays(page);
    await configureLocalMockProvider(page, mock.baseUrl);

    const input = page.getByPlaceholder(CHAT_PLACEHOLDER);
    await input.fill('你好');
    await input.press('Enter');
    await expect(page.getByText(MOCK_REPLY, { exact: true }).last()).toBeVisible({ timeout: READY_TIMEOUT });
    await expect(page.getByRole('button', { name: '停止' })).toHaveCount(0, { timeout: READY_TIMEOUT });

    // 直接问账本：主对话这一路恰好一次请求尝试，数字与假模型报的逐项相同。
    const ledger = await page.evaluate(async () => {
      const tauri = (
        window as unknown as {
          __TAURI_INTERNALS__?: { invoke: (cmd: string, args: unknown) => Promise<unknown> };
        }
      ).__TAURI_INTERNALS__;
      if (!tauri) throw new Error('missing __TAURI_INTERNALS__');
      return tauri.invoke('usage_query_range', { fromLocalDate: '0000-01-01', toLocalDate: '9999-12-31' });
    }) as {
      available: boolean;
      bySource: Array<{ source: string; attempts: number; inputKnownSum: number; outputKnownSum: number; cacheReadKnownSum: number; incompleteAttempts: number }>;
      byModel: Array<{ requestedModel: string }>;
      health: { writeFailures: number; rejectedFrames: number; degradedCode: string | null };
    };

    expect(ledger.available).toBe(true);
    expect(ledger.health).toMatchObject({ writeFailures: 0, rejectedFrames: 0, degradedCode: null });
    const main = ledger.bySource.find((s) => s.source === 'main');
    expect(main).toMatchObject({
      attempts: 1,
      inputKnownSum: 1200,
      outputKnownSum: 300,
      cacheReadKnownSum: 400,
      // 拿到了最终结算，不是流内累计值。
      incompleteAttempts: 0,
    });
    expect(ledger.byModel.map((m) => m.requestedModel)).toContain('abu-e2e-local-model');

    // 这一轮主循环必须是 sidecar 跑的：报障的那条路径就是它。主进程的运行登记表
    // 只登记经 sidecar 启动的运行，renderer 自己跑的那条路径不会出现在这里。
    const bridge = await page.evaluate(async () => {
      const shell = (
        window as unknown as {
          __ABU_SHELL__?: { getSidecarBridgeSnapshot: () => Promise<{ runs: unknown[] }> };
        }
      ).__ABU_SHELL__;
      if (!shell) throw new Error('missing __ABU_SHELL__');
      return shell.getSidecarBridgeSnapshot();
    });
    expect(bridge.runs.length).toBeGreaterThanOrEqual(1);
    expect(mock.userAgents.length).toBeGreaterThanOrEqual(1);

    await openUsagePage(page);
    await expect(page.getByText('1.2k', { exact: true })).toBeVisible({ timeout: READY_TIMEOUT });
    await expect(page.getByText('300', { exact: true })).toBeVisible();
    // 400 / 1200。
    await expect(page.getByText('33%', { exact: true })).toBeVisible();
  });

  test('写进账本的用量在页面上按本地日历日显示出来', async () => {
    dataRoot = createElectronDataRoot();
    const launched = await launchAbuElectron(dataRoot);
    app = launched.app;
    const page = await app.firstWindow({ timeout: READY_TIMEOUT });
    await waitForApp(page);
    await dismissFirstRunOverlays(page);

    const results = await seedUsage(page, [
      {
        attemptId: 'att-e2e-1',
        localDate: localDate(),
        requestedModel: 'claude-opus-5',
        skill: null,
        inputTotal: 2000,
        cacheRead: 800,
        outputTotal: 500,
      },
      {
        attemptId: 'att-e2e-2',
        localDate: localDate(1),
        requestedModel: 'claude-opus-5',
        skill: 'code-review',
        inputTotal: 1000,
        cacheRead: null,
        outputTotal: 200,
      },
      {
        // 用量未知的一次：不能被当成零，页面要如实说有几次没取到。
        attemptId: 'att-e2e-3',
        localDate: localDate(2),
        requestedModel: 'gpt-6-astra',
        skill: null,
        inputTotal: null,
        cacheRead: null,
        outputTotal: 40,
      },
    ]);
    expect(results).toEqual([{ ok: true }, { ok: true }, { ok: true }]);

    await openUsagePage(page);

    // 三次请求尝试，输入合计 3000（未知的那次不参与），输出合计 740。
    await expect(page.getByText('3', { exact: true }).first()).toBeVisible({ timeout: READY_TIMEOUT });
    await expect(page.getByText('3.0k', { exact: true })).toBeVisible();
    await expect(page.getByText('740', { exact: true })).toBeVisible();
    // 命中率只在可比的那一次上算：800 / 2000。
    await expect(page.getByText('40%', { exact: true })).toBeVisible();
    // 起点、未取到用量的次数都在同一行提示里，卡片上不放这些。
    await expect(
      page.getByText(new RegExp(`${localDate(2).replace(/-/g, '\\.')}`)),
    ).toBeVisible();
    await expect(page.getByText(/另有 1 次未取到用量|1 more with no usage/)).toBeVisible();
    // 模型与技能分组读的是同一份账本。
    await expect(page.getByText('claude-opus-5', { exact: true })).toBeVisible();
    await expect(page.getByText('gpt-6-astra', { exact: true })).toBeVisible();
    await expect(page.getByText('code-review', { exact: true })).toBeVisible();
  });

  test('同一条重放多次，请求尝试数不增加', async () => {
    dataRoot = createElectronDataRoot();
    const launched = await launchAbuElectron(dataRoot);
    app = launched.app;
    const page = await app.firstWindow({ timeout: READY_TIMEOUT });
    await waitForApp(page);
    await dismissFirstRunOverlays(page);

    const row: SeedSpec = {
      attemptId: 'att-replay',
      localDate: localDate(),
      requestedModel: 'claude-opus-5',
      skill: null,
      inputTotal: 100,
      cacheRead: null,
      outputTotal: 10,
    };
    await seedUsage(page, Array.from({ length: 20 }, () => row));

    await openUsagePage(page);
    await expect(page.getByText('100', { exact: true })).toBeVisible({ timeout: READY_TIMEOUT });
    await expect(page.getByText('10', { exact: true })).toBeVisible();
    // 20 次重放之后仍然只有一次请求尝试。
    await expect(page.getByText('1', { exact: true }).first()).toBeVisible();
  });
});
