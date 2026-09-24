/**
 * 专家团「需要你确认」条上的任务级允许，在真实 Electron 里从头走到尾。
 *
 * 对应 docs/2026-09-23-team-authorization-brief.md 的 P1-1、P1-2、P1-4、P2-1：
 *   ① 用户发出请求 A，队长派「行业调研专家」打开本地测试网页并执行脚本；脚本被拦，
 *      确认条出现一条，写明专家、网站、三个允许按钮、范围说明和脚本风险，页面里的脚本没有执行；
 *   ② 点「这个任务里都允许」，阿布自动接着做，同一专家在同一网站执行另一段脚本，
 *      不再出现确认，脚本真的执行，底部「这个任务里已允许」列出这一条；
 *   ③ 用户自己发出请求 B，上一任务的允许失效，同类脚本重新出现在确认条上，没有执行；
 *   ④ 在请求 B 里再点一次「这个任务里都允许」，脚本执行后点「收回」，列表消失。
 * 全程没有出现桌面确认对话框。
 *
 * 模型是本机回环地址上的 OpenAI 兼容 SSE 模拟服务，按请求内容判定角色和阶段：
 * 成员请求的 user 消息里带「【E2E成员任务-阶段】」标记，其余带工具的请求是队长；
 * 不带工具的请求是记忆提取、标题等后台调用，直接回一段文字，不占用脚本。
 * 页面是否执行过脚本，从主进程读对应 webContents 里页面自己的哨兵变量。
 */
import { expect, test } from '@playwright/test';
import { writeFileSync } from 'node:fs';
import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { ElectronApplication, Page } from 'playwright';
import {
  closeAbuElectron,
  configureLocalMockProvider,
  createElectronDataRoot,
  dismissFirstRunOverlays,
  launchAbuElectron,
  removeElectronDataRoot,
} from './electronHelpers';

const READY_TIMEOUT = 45_000;
const RUN_TIMEOUT = 90_000;
const TAB_SETTLE_TIMEOUT = 30_000;

const TEAM_NAME = 'E2E授权小队';
const LEADER = '产品经理';
const MEMBER = '行业调研专家';
const REQUEST_A = 'E2E请求A：请让调研专家打开测试网页并执行脚本';
const REQUEST_B = 'E2E请求B：请让调研专家再打开测试网页执行一次脚本';
/** t.team.confirmationApprovedTaskFollowUp 的开头：点「这个任务里都允许」后阿布自动发出的接续消息。 */
const TASK_FOLLOW_UP = '这个任务里，我同意了刚才请求的这些操作';
const PAGE_TITLE = 'E2E授权测试页';

type Phase = 'A1' | 'A2' | 'B1' | 'B2';
const MEMBER_TASK_MARK = /【E2E成员任务-(A1|A2|B1|B2)】/g;
const leaderFinal = (phase: Phase) => `E2E队长汇报-${phase}`;
const memberFinal = (phase: Phase) => `E2E成员回报-${phase}`;
const scriptFor = (phase: Phase) =>
  `window.__abuE2eScriptSentinel = "RAN-${phase}"; document.title = "RAN-${phase}"; "ok"`;

// ─────────────────────────────────────────────────────────────────────────
// 本地测试网页
// ─────────────────────────────────────────────────────────────────────────

interface FixturePage {
  url: string;
  origin: string;
  close: () => Promise<void>;
}

async function startFixturePage(): Promise<FixturePage> {
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    // 哨兵由页面自己设置，只有加载之后注入的脚本才能改动它。
    res.end(`<!doctype html><html><head><title>${PAGE_TITLE}</title></head><body>
<h1>${PAGE_TITLE}</h1>
<script>window.__abuE2eScriptSentinel = 'untouched';</script>
</body></html>`);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo | null;
  if (!address || typeof address === 'string') throw new Error('测试网页没有拿到端口');
  const url = `http://127.0.0.1:${address.port}/`;
  return {
    url,
    origin: new URL(url).origin,
    close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}

// ─────────────────────────────────────────────────────────────────────────
// 主进程里的真实浏览器标签
// ─────────────────────────────────────────────────────────────────────────

interface NativeTab {
  /** webContents.id，即浏览器工具接受的 tabId。 */
  tabId: number;
  url: string;
}

async function nativeTabs(app: ElectronApplication): Promise<NativeTab[]> {
  return app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    if (!window || window.isDestroyed()) return [];
    const rendererId = window.webContents.id;
    return window.contentView.children.flatMap((child) => {
      const contents = (child as unknown as {
        webContents?: { id: number; getURL: () => string; isDestroyed: () => boolean };
      }).webContents;
      if (!contents || contents.isDestroyed() || contents.id === rendererId) return [];
      return [{ tabId: contents.id, url: contents.getURL() }];
    });
  });
}

async function waitForNativeTab(
  app: ElectronApplication,
  matches: (tab: NativeTab) => boolean,
  wanted: string,
): Promise<NativeTab> {
  const deadline = Date.now() + TAB_SETTLE_TIMEOUT;
  for (;;) {
    const seen = await nativeTabs(app);
    const found = seen.find(matches);
    if (found) return found;
    if (Date.now() >= deadline) throw new Error(`等不到${wanted}；当前标签：${JSON.stringify(seen)}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/** 在指定标签的页面里求值。这是测试从主进程读页面，不经过被测的工具。 */
async function evaluateInTab(app: ElectronApplication, tabId: number, expression: string): Promise<unknown> {
  return app.evaluate(async ({ webContents }, payload) => {
    const contents = webContents.fromId(payload.tabId);
    if (!contents || contents.isDestroyed()) {
      const alive = webContents.getAllWebContents().map((item) => ({ id: item.id, url: item.getURL() }));
      throw new Error(`标签 ${payload.tabId} 不存在；现有 webContents：${JSON.stringify(alive)}`);
    }
    return await contents.executeJavaScript(payload.expression);
  }, { tabId, expression });
}

// ─────────────────────────────────────────────────────────────────────────
// 模拟模型服务
// ─────────────────────────────────────────────────────────────────────────

interface RequestMessage {
  role?: string;
  content?: unknown;
  tool_call_id?: string;
  tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }>;
}

interface RequestBody {
  messages?: RequestMessage[];
  tools?: unknown[];
  stream?: boolean;
}

interface Exchange {
  id: string;
  name: string;
  args: Record<string, unknown>;
  result?: string;
}

type Reply =
  | { kind: 'tool'; name: string; args: Record<string, unknown> }
  | { kind: 'text'; text: string };

function textOf(message: RequestMessage): string {
  if (typeof message.content === 'string') return message.content;
  if (Array.isArray(message.content)) {
    return message.content.map((block) => (block as { text?: string }).text ?? '').join('\n');
  }
  return '';
}

/** 模型发出的每个工具调用及其结果，按 tool_call_id 配对。 */
function exchangesOf(messages: RequestMessage[]): Exchange[] {
  const results = new Map<string, string>();
  for (const message of messages) {
    if (message.role === 'tool' && typeof message.tool_call_id === 'string') results.set(message.tool_call_id, textOf(message));
  }
  return messages
    .filter((message) => message.role === 'assistant' && Array.isArray(message.tool_calls))
    .flatMap((message) => message.tool_calls ?? [])
    .flatMap((call) => {
      if (typeof call.id !== 'string' || typeof call.function?.name !== 'string') return [];
      const args = JSON.parse(call.function.arguments || '{}') as Record<string, unknown>;
      const result = results.get(call.id);
      return [result === undefined ? { id: call.id, name: call.function.name, args } : { id: call.id, name: call.function.name, args, result }];
    });
}

function isMemoryExtraction(messages: RequestMessage[]): boolean {
  return messages.some((m) => m.role === 'system' && textOf(m).includes('你是一个记忆提取助手'));
}

function sseChunk(delta: Record<string, unknown>, finish: string | null): string {
  return `data: ${JSON.stringify({ id: 'team-auth', object: 'chat.completion.chunk', created: 0, model: 'mock', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
}

let callSequence = 0;

function writeReply(res: ServerResponse, reply: Reply, streaming: boolean): void {
  const callId = `call-team-auth-${++callSequence}`;
  if (!streaming) {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    const message = reply.kind === 'tool'
      ? { role: 'assistant', content: null, tool_calls: [{ id: callId, type: 'function', function: { name: reply.name, arguments: JSON.stringify(reply.args) } }] }
      : { role: 'assistant', content: reply.text };
    res.end(JSON.stringify({ id: 'team-auth', object: 'chat.completion', created: 0, model: 'mock', choices: [{ index: 0, message, finish_reason: reply.kind === 'tool' ? 'tool_calls' : 'stop' }] }));
    return;
  }
  res.writeHead(200, { 'cache-control': 'no-cache', connection: 'keep-alive', 'content-type': 'text/event-stream; charset=utf-8' });
  if (reply.kind === 'tool') {
    res.write(sseChunk({ role: 'assistant', tool_calls: [{ index: 0, id: callId, type: 'function', function: { name: reply.name, arguments: JSON.stringify(reply.args) } }] }, null));
    res.write(sseChunk({}, 'tool_calls'));
  } else {
    res.write(sseChunk({ role: 'assistant', content: reply.text }, null));
    res.write(sseChunk({}, 'stop'));
  }
  res.end('data: [DONE]\n\n');
}

interface TeamMock {
  baseUrl: string;
  requests: RequestBody[];
  /**
   * 每个阶段 execute_js 返回之后、专家这次派活结束之前，从主进程读到的页面状态。
   * 派活结束时专家打开的标签可能被收起关闭，所以在这里当场读取。
   */
  pages: Partial<Record<Phase, { sentinel: unknown; title: unknown }>>;
  /** 每个阶段里 execute_js 返回给专家的结果。 */
  scriptResults: Partial<Record<Phase, string>>;
  /** 专家每一步的记录，失败时附在报告里。 */
  trace: string[];
  /** 模拟服务无法按脚本继续时的原因，出现后测试立即失败。 */
  failure: () => string | undefined;
  close: () => Promise<void>;
}

/** 队长：看最近一条用户自己发出的请求，以及之后有没有自动接续消息。 */
function leaderReply(messages: RequestMessage[]): Reply {
  const userTexts = messages.map((m, index) => ({ index, role: m.role, text: textOf(m) })).filter((m) => m.role === 'user');
  const typed = [...userTexts].reverse().find((m) => m.text.includes(REQUEST_A) || m.text.includes(REQUEST_B));
  if (!typed) throw new Error(`队长请求里没有用户请求 A 或 B：${JSON.stringify(userTexts.map((m) => m.text.slice(0, 80)))}`);
  const continued = userTexts.some((m) => m.index > typed.index && m.text.includes(TASK_FOLLOW_UP));
  const phase = `${typed.text.includes(REQUEST_A) ? 'A' : 'B'}${continued ? '2' : '1'}` as Phase;
  const lastUserIndex = userTexts[userTexts.length - 1]!.index;
  const delegated = exchangesOf(messages.slice(lastUserIndex)).filter((e) => e.name === 'delegate_to_agent');
  if (delegated.length === 0) {
    return {
      kind: 'tool',
      name: 'delegate_to_agent',
      args: { agent_name: MEMBER, task: `【E2E成员任务-${phase}】打开测试网页并在页面上执行脚本，完成后报告结果。` },
    };
  }
  if (delegated.at(-1)!.result === undefined) throw new Error(`队长阶段 ${phase} 的派活还没有结果`);
  return { kind: 'text', text: leaderFinal(phase) };
}

async function memberReply(
  app: () => ElectronApplication,
  fixture: FixturePage,
  mock: Pick<TeamMock, 'pages' | 'scriptResults' | 'trace'>,
  messages: RequestMessage[],
  phase: Phase,
): Promise<Reply> {
  const exchanges = exchangesOf(messages);
  const last = exchanges.at(-1);
  if (!last) return { kind: 'tool', name: 'abu-browser__get_tabs', args: {} };
  if (last.result === undefined) throw new Error(`专家阶段 ${phase} 的 ${last.name} 没有结果`);
  if (last.name === 'abu-browser__get_tabs') {
    const match = /"currentTabId":\s*(\d+)/.exec(last.result);
    if (!match) throw new Error(`get_tabs 没有给出当前标签：${last.result.slice(0, 400)}`);
    const tabId = Number(match[1]);
    mock.trace.push(`${phase} get_tabs：${last.result.slice(0, 300)}`);
    await waitForNativeTab(app(), (tab) => tab.tabId === tabId, `get_tabs 给出的标签 ${tabId}`);
    return { kind: 'tool', name: 'abu-browser__navigate', args: { tabId, url: fixture.url } };
  }
  if (last.name === 'abu-browser__navigate') {
    if (/^Error:/.test(last.result)) throw new Error(`navigate 失败：${last.result.slice(0, 400)}`);
    const tabId = Number(last.args.tabId);
    // 页面真的加载到测试网页之后才执行脚本，否则拒绝原因会变成「无法确认网站」。
    await waitForNativeTab(app(), (tab) => tab.tabId === tabId && tab.url === fixture.url, `标签 ${tabId} 打开 ${fixture.url}`);
    return { kind: 'tool', name: 'abu-browser__execute_js', args: { tabId, code: scriptFor(phase) } };
  }
  if (last.name === 'abu-browser__execute_js') {
    mock.scriptResults[phase] = last.result;
    const tabId = Number(last.args.tabId);
    mock.pages[phase] = {
      sentinel: await evaluateInTab(app(), tabId, 'window.__abuE2eScriptSentinel'),
      title: await evaluateInTab(app(), tabId, 'document.title'),
    };
    mock.trace.push(`${phase} execute_js 结果：${last.result.slice(0, 300)}；页面：${JSON.stringify(mock.pages[phase])}`);
    return { kind: 'text', text: memberFinal(phase) };
  }
  throw new Error(`专家阶段 ${phase} 出现了意外的工具调用 ${last.name}`);
}

async function startTeamMock(app: () => ElectronApplication, fixture: FixturePage): Promise<TeamMock> {
  const requests: RequestBody[] = [];
  const open = new Set<ServerResponse>();
  let failure: string | undefined;
  const state: Pick<TeamMock, 'pages' | 'scriptResults' | 'trace'> = { pages: {}, scriptResults: {}, trace: [] };
  const server: Server = createServer(async (req, res) => {
    open.add(res);
    res.once('close', () => open.delete(res));
    let raw = '';
    for await (const part of req) raw += String(part);
    if (req.method !== 'POST' || !(req.url ?? '').endsWith('/chat/completions')) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'unexpected route' }));
      return;
    }
    const body = JSON.parse(raw || '{}') as RequestBody;
    requests.push(body);
    const messages = body.messages ?? [];
    const streaming = body.stream !== false;
    // 记忆提取、标题等后台调用不带工具，不占用脚本。
    if (!Array.isArray(body.tools) || body.tools.length === 0) {
      writeReply(res, { kind: 'text', text: isMemoryExtraction(messages) ? '[]' : 'E2E后台回复' }, streaming);
      return;
    }
    try {
      const userText = messages.filter((m) => m.role === 'user').map(textOf).join('\n');
      const phases = new Set([...userText.matchAll(MEMBER_TASK_MARK)].map((match) => match[1] as Phase));
      if (phases.size > 1) throw new Error(`一条成员请求里出现了多个阶段标记：${[...phases].join(', ')}`);
      const reply = phases.size === 1
        ? await memberReply(app, fixture, state, messages, [...phases][0]!)
        : leaderReply(messages);
      writeReply(res, reply, streaming);
    } catch (error) {
      failure ??= error instanceof Error ? error.message : String(error);
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: failure }));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo | null;
  if (!address || typeof address === 'string') throw new Error('模拟模型服务没有拿到端口');
  return {
    // 127.0.0.1 的数字写法，避开适配器把字面回环地址当作 Ollama 的判定。
    baseUrl: `http://2130706433:${address.port}/v1`,
    requests,
    pages: state.pages,
    scriptResults: state.scriptResults,
    trace: state.trace,
    failure: () => failure,
    close: () => new Promise<void>((resolve) => {
      for (const response of open) response.destroy();
      server.closeAllConnections();
      server.close(() => resolve());
    }),
  };
}

// ─────────────────────────────────────────────────────────────────────────
// 界面辅助
// ─────────────────────────────────────────────────────────────────────────

/** 桌面确认对话框（CommandConfirmDialog）可能出现的全部标题。 */
const CONFIRM_DIALOG_TITLES = ['浏览器操作确认', '新增能力确认', '操作确认', '危险操作确认', '操作已阻止'];

/** 从现在起记录出现过的每个 <h2>，页面重新加载前一直有效。 */
async function watchDialogTitles(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __abuE2eDialogTitles?: string[] };
    const seen: string[] = [];
    w.__abuE2eDialogTitles = seen;
    const scan = (root: Element): void => {
      const headings = root.tagName === 'H2' ? [root] : [...root.querySelectorAll('h2')];
      for (const heading of headings) {
        const text = (heading.textContent ?? '').trim();
        if (text) seen.push(text);
      }
    };
    scan(document.body);
    new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) if (node.nodeType === 1) scan(node as Element);
      }
    }).observe(document.body, { childList: true, subtree: true });
  });
}

async function expectNoConfirmDialogEver(page: Page): Promise<void> {
  const titles = await page.evaluate(() => {
    const w = window as unknown as { __abuE2eDialogTitles?: string[] };
    if (!w.__abuE2eDialogTitles) throw new Error('对话框记录没有安装，或页面重新加载过');
    return [...w.__abuE2eDialogTitles];
  });
  expect(titles.filter((title) => CONFIRM_DIALOG_TITLES.includes(title)), `出现过桌面确认对话框：${JSON.stringify(titles)}`).toEqual([]);
}

/**
 * 内置浏览器运行时连上之后再开始：成员的工具清单在派活时确定，
 * 运行时还没连上时清单里没有浏览器工具。做法同 browser-unattended.spec.ts。
 */
async function waitForBuiltinBrowserRuntime(page: Page): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT;
  for (;;) {
    await page.getByRole('button', { name: /^(我|登录 \/ 注册)$/ }).click();
    await page.getByRole('menuitem', { name: '设置', exact: true }).click();
    const capabilitiesTab = page.getByRole('button', { name: '能力', exact: true });
    await expect(capabilitiesTab).toBeVisible({ timeout: READY_TIMEOUT });
    await capabilitiesTab.click();
    const ready = await page
      .getByRole('button', { name: '阿布内置浏览器 · 已就绪', exact: true })
      .waitFor({ state: 'visible', timeout: 2_000 })
      .then(() => true, () => false);
    await page.locator('[data-abu-settings-close]').click();
    await expect(page.locator('[data-abu-settings-dialog]')).toHaveCount(0);
    if (ready) return;
    if (Date.now() >= deadline) throw new Error('内置浏览器运行时一直没有在「设置 › 能力」里显示已就绪');
  }
}

/** 等某个阶段的队长汇报出现；模拟服务先报错时直接带着原因失败。 */
async function waitForLeaderFinal(page: Page, mock: TeamMock, phase: Phase): Promise<void> {
  const final = page.getByText(leaderFinal(phase), { exact: true });
  const deadline = Date.now() + RUN_TIMEOUT;
  for (;;) {
    const failure = mock.failure();
    if (failure) throw new Error(`模拟服务无法继续：${failure}`);
    if (await final.count() > 0) break;
    if (Date.now() >= deadline) throw new Error(`阶段 ${phase} 的队长汇报在 ${RUN_TIMEOUT}ms 内没有出现`);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  await expect(final).toBeVisible();
}

async function sendRequest(page: Page, text: string): Promise<void> {
  // 浏览器面板打开后还有一个地址栏输入框，按输入框自己的标记定位。
  const composer = page.locator('[data-chat-composer="true"]');
  await composer.fill(text);
  await composer.press('Enter');
}

async function screenshot(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: test.info().outputPath(name) });
}

// ─────────────────────────────────────────────────────────────────────────

test('专家团里「这个任务里都允许」只在本任务内生效，可以收回，全程不弹桌面确认框', async () => {
  test.setTimeout(420_000);
  const fixture = await startFixturePage();
  const dataRoot = createElectronDataRoot();
  let app: ElectronApplication | undefined;
  const mock = await startTeamMock(() => app!, fixture);
  const scopeLine = `${MEMBER}再在 ${fixture.origin} 上执行脚本时不再问`;
  try {
    app = (await launchAbuElectron(dataRoot)).app;
    const page = await app.firstWindow({ timeout: READY_TIMEOUT });
    await page.waitForLoadState('domcontentloaded');
    await expect(page.getByRole('textbox').first()).toBeVisible({ timeout: READY_TIMEOUT });
    await dismissFirstRunOverlays(page);
    await configureLocalMockProvider(page, mock.baseUrl, { supportsTools: true, supportsReasoning: null, permissionMode: 'standard' });

    // 种专家团与浏览器权限：测试网页允许浏览，脚本保持默认的「每次询问」。
    await Promise.all([page.waitForEvent('load'), page.evaluate(async ({ origin, teamName, leader, member }) => {
      await navigator.locks.request('abu-browser-permission-config-v2', () => {
        const rawSettings = window.localStorage.getItem('abu-settings');
        if (!rawSettings) throw new Error('abu-settings 尚未初始化');
        const settings = JSON.parse(rawSettings) as { state: Record<string, unknown>; version: number };
        settings.state.browserPermissionConfigV2 = {
          schemaVersion: 2,
          defaults: { browse: 'ask', upload: 'ask', script: 'ask' },
          sites: { [origin]: { blocked: false, browse: 'allow', upload: 'inherit', script: 'inherit' } },
          embeddedSites: {},
        };
        window.localStorage.setItem('abu-settings', JSON.stringify(settings));
        const previousTeam = JSON.parse(window.localStorage.getItem('abu-team') ?? '{}');
        window.localStorage.setItem('abu-team', JSON.stringify({
          ...previousTeam,
          state: {
            ...previousTeam.state,
            teams: [{
              id: 't-task-auth',
              name: teamName,
              description: '任务级授权验收',
              leaderRoleId: `builtin:${leader}`,
              memberRoleIds: [`builtin:${leader}`, `builtin:${member}`],
              requirePlanApproval: false,
              createdAt: 1,
            }],
          },
        }));
        window.location.reload();
      });
    }, { origin: fixture.origin, teamName: TEAM_NAME, leader: LEADER, member: MEMBER })]);
    await expect(page.getByPlaceholder('想让阿布帮你做点什么？')).toBeVisible({ timeout: READY_TIMEOUT });

    await waitForBuiltinBrowserRuntime(page);
    await watchDialogTitles(page);

    const sidebarToggle = page.getByRole('button', { name: '显示侧栏', exact: true });
    if (await sidebarToggle.isVisible()) await sidebarToggle.click();
    await page.getByTestId('sidebar-team').click();
    await page.getByTestId('top-tab-nav').getByRole('button', { name: '专家团', exact: true }).click();
    await page.getByTestId('team-source-mine').click();
    await page.getByTestId(`team-row-${TEAM_NAME}`).click();
    await page.getByTestId('team-detail-start-chat').click();

    const strip = page.getByTestId('team-confirmations-strip');
    const items = strip.getByTestId('team-confirmation-item');
    const taskRulesTitle = strip.getByText('这个任务里已允许', { exact: true });

    // ① 请求 A：脚本被拦，确认条出现这一条
    await sendRequest(page, REQUEST_A);
    await waitForLeaderFinal(page, mock, 'A1');
    await expect(items).toHaveCount(1);
    const itemA = items.first();
    await expect(strip.getByText('需要你确认（1）', { exact: true })).toBeVisible();
    await expect(itemA.getByText(MEMBER, { exact: true })).toBeVisible();
    await expect(itemA.getByText(fixture.origin, { exact: true })).toBeVisible();
    await expect(itemA.getByRole('button', { name: /^只允许这一次/ })).toBeVisible();
    const approveTaskA = itemA.getByRole('button', { name: /^这个任务里都允许/ });
    await expect(approveTaskA).toBeVisible();
    await expect(approveTaskA).toHaveAttribute('data-primary', 'true');
    await expect(itemA.getByRole('button', { name: '以后在此网站允许执行脚本', exact: true })).toBeVisible();
    await expect(itemA.getByRole('button', { name: /^拒绝/ })).toBeVisible();
    await expect(itemA.getByText(scopeLine, { exact: true })).toBeVisible();
    await expect(itemA.getByText('在页面里运行一段脚本', { exact: true })).toBeVisible();
    await expect(itemA).not.toContainText('abu-browser__');
    // 风险说明只在请求原因里出现一次
    expect((await itemA.textContent())?.match(/以你的身份在页面上操作/g)).toHaveLength(1);
    // 只有一条请求时不出现「全部允许」。
    await expect(strip.getByRole('button', { name: '全部允许', exact: true })).toHaveCount(0);
    await expect(taskRulesTitle).toHaveCount(0);
    expect(mock.scriptResults.A1, 'A1 的 execute_js 没有返回结果').toBeDefined();
    // 专家被告知这一步在等用户处理，不会误以为用户拒绝了
    expect(mock.scriptResults.A1).toContain('需要用户确认');
    expect(mock.pages.A1).toEqual({ sentinel: 'untouched', title: PAGE_TITLE });
    await screenshot(page, 'step1-confirmation.png');

    // ② 这个任务里都允许 → 自动接续，同一专家同一网站执行另一段脚本，不再确认
    await approveTaskA.click();
    await waitForLeaderFinal(page, mock, 'A2');
    expect(mock.scriptResults.A2, 'A2 的 execute_js 没有返回结果').toBeDefined();
    expect(mock.scriptResults.A2).not.toMatch(/^Error:|需要用户确认|用户取消/);
    expect(mock.pages.A2).toEqual({ sentinel: 'RAN-A2', title: 'RAN-A2' });
    await expect(items).toHaveCount(0);
    await expect(taskRulesTitle).toBeVisible();
    await expect(strip.getByText(scopeLine, { exact: true })).toBeVisible();
    await expect(strip.getByRole('button', { name: `收回: ${scopeLine}`, exact: true })).toBeVisible();
    await expectNoConfirmDialogEver(page);
    await screenshot(page, 'step2-task-rules.png');

    // ③ 用户自己发出请求 B：上一任务的允许失效，脚本重新被拦
    await sendRequest(page, REQUEST_B);
    await waitForLeaderFinal(page, mock, 'B1');
    await expect(taskRulesTitle).toHaveCount(0);
    await expect(items).toHaveCount(1);
    const itemB = items.first();
    await expect(itemB.getByText(MEMBER, { exact: true })).toBeVisible();
    await expect(itemB.getByText(fixture.origin, { exact: true })).toBeVisible();
    await expect(itemB.getByText(scopeLine, { exact: true })).toBeVisible();
    expect(mock.scriptResults.B1, 'B1 的 execute_js 没有返回结果').toBeDefined();
    expect(mock.scriptResults.B1).toContain('需要用户确认');
    expect(mock.pages.B1).toEqual({ sentinel: 'untouched', title: PAGE_TITLE });
    await screenshot(page, 'step3-confirmation-again.png');

    // ④ 在请求 B 里再允许一次，执行后收回：列表与确认条一起消失
    await itemB.getByRole('button', { name: /^这个任务里都允许/ }).click();
    await waitForLeaderFinal(page, mock, 'B2');
    expect(mock.scriptResults.B2).not.toMatch(/^Error:|需要用户确认|用户取消/);
    expect(mock.pages.B2).toEqual({ sentinel: 'RAN-B2', title: 'RAN-B2' });
    await expect(taskRulesTitle).toBeVisible();
    await strip.getByRole('button', { name: `收回: ${scopeLine}`, exact: true }).click();
    await expect(taskRulesTitle).toHaveCount(0);
    await expect(strip).toHaveCount(0);
    await screenshot(page, 'step4-revoked.png');

    await expectNoConfirmDialogEver(page);
  } finally {
    // finally 里还拿不到本次的失败状态，所以无条件附上，失败时从报告里查看。
    writeFileSync(test.info().outputPath('provider-requests.json'), JSON.stringify(mock.requests, null, 2));
    writeFileSync(test.info().outputPath('member-trace.txt'), mock.trace.join('\n'));
    if (app) await closeAbuElectron(app);
    await mock.close();
    await fixture.close();
    removeElectronDataRoot(dataRoot);
  }
});
