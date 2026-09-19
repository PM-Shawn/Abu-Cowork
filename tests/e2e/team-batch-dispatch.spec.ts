/**
 * Real-Electron acceptance for a team turn whose members are dispatched in one
 * run_agent_batch and finish without a single tool call (pure-text replies, as
 * in "让每个专家都出来做个自我介绍"). Deterministic: a loopback mock provider
 * scripts the leader (tool_search → run_agent_batch → final text) and answers
 * every member with plain text.
 *
 * Pins:
 * 1. the member bar and the team tab count the batch hand-off for every member
 *    (a member with zero tool calls was shown as 还没派过活);
 * 2. the same holds after a restart (persisted snapshots, no live execution);
 * 3. no follow-up chips (可以直接说：…) appear under the finished team turn.
 */
import { expect, test } from '@playwright/test';
import type { Page } from 'playwright';
import { createServer } from 'node:http';
import {
  closeAbuElectron,
  configureLocalMockProvider,
  createElectronDataRoot,
  dismissFirstRunOverlays,
  launchAbuElectron,
  removeElectronDataRoot,
} from './electronHelpers';

const TEAM_NAME = 'E2E批量小队';
const MEMBERS = ['高级开发工程师', '网页设计师'] as const;
const TASK_MARKER = 'E2E自我介绍任务';
const FINAL_TEXT = 'E2E团队介绍完毕';

type MockMessage = { role: string; content?: string | Array<{ text?: string }> | null };

function textOf(message: MockMessage): string {
  if (typeof message.content === 'string') return message.content;
  return message.content?.map((block) => block.text ?? '').join('\n') ?? '';
}

function chunk(delta: Record<string, unknown>, finish: string | null): string {
  return `data: ${JSON.stringify({ id: 'team-batch', object: 'chat.completion.chunk', created: 0, model: 'mock', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
}

function toolCall(id: string, name: string, args: unknown): string[] {
  return [
    chunk({ role: 'assistant', tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }, null),
    chunk({}, 'tool_calls'),
  ];
}

async function startMock() {
  const requests: Array<{ messages?: MockMessage[] }> = [];
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const part of req) raw += part;
    const body = JSON.parse(raw || '{}') as { messages?: MockMessage[] };
    requests.push(body);
    const messages = body.messages ?? [];
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    let frames: string[];
    if (messages.some((m) => m.role === 'user' && textOf(m).includes(TASK_MARKER))) {
      // A member: plain text, no tool call.
      frames = [chunk({ role: 'assistant', content: '大家好，这是我的自我介绍。' }, null), chunk({}, 'stop')];
    } else {
      const toolResults = messages.filter((m) => m.role === 'tool').length;
      if (toolResults === 0) {
        frames = toolCall('call_search', 'tool_search', { query: 'run_agent_batch', max_results: 1 });
      } else if (toolResults === 1) {
        frames = toolCall('call_batch', 'run_agent_batch', {
          tasks: MEMBERS.map((agent_name) => ({ agent_name, task: `${TASK_MARKER}：请用第一人称做自我介绍。` })),
        });
      } else {
        frames = [chunk({ role: 'assistant', content: FINAL_TEXT }, null), chunk({}, 'stop')];
      }
    }
    for (const frame of frames) res.write(frame);
    res.end('data: [DONE]\n\n');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing loopback address');
  return {
    requests,
    baseUrl: `http://2130706433:${address.port}/v1`,
    close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}

async function showSidebar(page: Page) {
  const toggle = page.getByRole('button', { name: '显示侧栏', exact: true });
  if (await toggle.isVisible()) await toggle.click();
}

async function expectEveryMemberDispatchedOnce(page: Page) {
  const bar = page.getByTestId('team-member-bar');
  for (const member of MEMBERS) {
    await expect(bar.getByRole('button', { name: member })).toHaveAttribute('data-status', 'completed');
  }
  await bar.getByRole('button', { name: '产品经理' }).click();
  const tab = page.getByTestId('team-tab');
  await expect(tab).toBeVisible();
  for (const member of MEMBERS) {
    const row = tab.getByTestId('team-member-row').filter({ hasText: member });
    await expect(row).toContainText('派活 1 次');
    await expect(row).not.toContainText('还没派过活');
  }
}

test('batch hand-offs with zero tool calls count for every member, before and after restart', async () => {
  test.setTimeout(240_000);
  const dataRoot = createElectronDataRoot();
  const mock = await startMock();
  let launched = await launchAbuElectron(dataRoot);
  try {
    let page = await launched.app.firstWindow();
    await page.waitForLoadState('domcontentloaded');
    await expect(page.getByRole('textbox').first()).toBeVisible({ timeout: 45_000 });
    await dismissFirstRunOverlays(page);
    await page.evaluate(({ name, members }) => {
      const previous = JSON.parse(localStorage.getItem('abu-team') ?? '{}');
      localStorage.setItem('abu-team', JSON.stringify({
        ...previous,
        state: {
          ...previous.state,
          teams: [{
            id: 't-batch',
            name,
            description: '批量派活验收',
            leaderRoleId: 'builtin:产品经理',
            memberRoleIds: ['builtin:产品经理', ...members.map((m) => `builtin:${m}`)],
            requirePlanApproval: false,
            createdAt: 1,
          }],
        },
      }));
    }, { name: TEAM_NAME, members: [...MEMBERS] });
    await configureLocalMockProvider(page, mock.baseUrl, { supportsTools: true, permissionMode: 'standard' });

    await expect(page.getByRole('textbox').first()).toBeVisible({ timeout: 45_000 });
    await showSidebar(page);
    await page.getByTestId('sidebar-team').click();
    await page.getByTestId('top-tab-nav').getByRole('button', { name: '专家团', exact: true }).click();
    await page.getByTestId('team-source-mine').click();
    await page.getByTestId(`team-row-${TEAM_NAME}`).click();
    await page.getByTestId('team-detail-start-chat').click();

    const composer = page.getByRole('textbox');
    await composer.fill('让每个专家都出来做个自我介绍');
    await composer.press('Enter');
    await expect(page.getByText(FINAL_TEXT)).toBeVisible({ timeout: 90_000 });

    await expectEveryMemberDispatchedOnce(page);
    await expect(page.getByTestId('team-follow-up-chips')).toHaveCount(0);
    await expect(page.getByText('可以直接说：')).toHaveCount(0);
    await page.screenshot({ path: test.info().outputPath('team-batch-live.png') });

    await closeAbuElectron(launched.app);
    launched = await launchAbuElectron(dataRoot);
    page = await launched.app.firstWindow();
    await page.waitForLoadState('domcontentloaded');
    await expect(page.getByRole('textbox').first()).toBeVisible({ timeout: 45_000 });
    await showSidebar(page);
    await page.getByText('让每个专家都出来做个自我介绍').first().click();
    await expect(page.getByText(FINAL_TEXT)).toBeVisible();
    await expectEveryMemberDispatchedOnce(page);
    await page.screenshot({ path: test.info().outputPath('team-batch-restored.png') });
  } finally {
    if (test.info().status !== test.info().expectedStatus) {
      await test.info().attach('provider-requests', { body: JSON.stringify(mock.requests, null, 2), contentType: 'application/json' });
    }
    await closeAbuElectron(launched.app);
    await mock.close();
    removeElectronDataRoot(dataRoot);
  }
});
