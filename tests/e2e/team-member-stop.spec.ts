/**
 * Real-Electron acceptance for stopping ONE member of a run_agent_batch while
 * the batch keeps running. Deterministic: a loopback mock provider scripts the
 * leader (tool_search → run_agent_batch → final text) and holds every member's
 * reply open until the spec releases it.
 *
 * Pins:
 * 1. the stopped member's process tab, opened from the team tab, reads 已停止
 *    and offers no Stop, while its sibling is still running;
 * 2. the running sibling's tab reads 运行中 and offers Stop;
 * 3. once the sibling finishes, its tab reads 已成功 and Stop is gone.
 */
import { expect, test } from '@playwright/test';
import type { Page } from 'playwright';
import { createServer, type ServerResponse } from 'node:http';
import {
  closeAbuElectron,
  configureLocalMockProvider,
  createElectronDataRoot,
  dismissFirstRunOverlays,
  launchAbuElectron,
  removeElectronDataRoot,
} from './electronHelpers';

const TEAM_NAME = 'E2E停止小队';
const STOPPED_MEMBER = '高级开发工程师';
const RUNNING_MEMBER = '网页设计师';
const MEMBERS = [STOPPED_MEMBER, RUNNING_MEMBER] as const;
const TASK_MARKER = 'E2E长任务';
const FINAL_TEXT = 'E2E团队收尾完毕';

type MockMessage = { role: string; content?: string | Array<{ text?: string }> | null };

function textOf(message: MockMessage): string {
  if (typeof message.content === 'string') return message.content;
  return message.content?.map((block) => block.text ?? '').join('\n') ?? '';
}

function chunk(delta: Record<string, unknown>, finish: string | null): string {
  return `data: ${JSON.stringify({ id: 'team-stop', object: 'chat.completion.chunk', created: 0, model: 'mock', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
}

function toolCall(id: string, name: string, args: unknown): string[] {
  return [
    chunk({ role: 'assistant', tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }, null),
    chunk({}, 'tool_calls'),
  ];
}

async function startMock() {
  const requests: Array<{ messages?: MockMessage[] }> = [];
  /** Member replies held open: the member is "running" for as long as its reply is here. */
  const held = new Set<ServerResponse>();
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const part of req) raw += part;
    const body = JSON.parse(raw || '{}') as { messages?: MockMessage[] };
    requests.push(body);
    const messages = body.messages ?? [];
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    if (messages.some((m) => m.role === 'user' && textOf(m).includes(TASK_MARKER))) {
      res.write(chunk({ role: 'assistant', content: '' }, null));
      held.add(res);
      res.on('close', () => held.delete(res));
      return;
    }
    const toolResults = messages.filter((m) => m.role === 'tool').length;
    let frames: string[];
    if (toolResults === 0) {
      frames = toolCall('call_search', 'tool_search', { query: 'run_agent_batch', max_results: 1 });
    } else if (toolResults === 1) {
      frames = toolCall('call_batch', 'run_agent_batch', {
        tasks: MEMBERS.map((agent_name) => ({ agent_name, task: `${TASK_MARKER}：请写一段较长的方案。` })),
      });
    } else {
      frames = [chunk({ role: 'assistant', content: FINAL_TEXT }, null), chunk({}, 'stop')];
    }
    for (const frame of frames) res.write(frame);
    res.end('data: [DONE]\n\n');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing loopback address');
  return {
    requests,
    heldCount: () => held.size,
    /** Let every member still running finish with a plain-text reply. */
    release: () => {
      for (const res of held) {
        res.write(chunk({ content: '方案写完了。' }, null));
        res.write(chunk({}, 'stop'));
        res.end('data: [DONE]\n\n');
      }
    },
    baseUrl: `http://2130706433:${address.port}/v1`,
    close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}

async function showSidebar(page: Page) {
  const toggle = page.getByRole('button', { name: '显示侧栏', exact: true });
  if (await toggle.isVisible()) await toggle.click();
}

test('a stopped batch member reads as stopped in its own tab while the batch keeps running', async () => {
  test.setTimeout(240_000);
  const dataRoot = createElectronDataRoot();
  const mock = await startMock();
  const launched = await launchAbuElectron(dataRoot);
  try {
    const page = await launched.app.firstWindow();
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
            id: 't-stop',
            name,
            description: '停止单个成员验收',
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
    await composer.fill('让两位专家各写一段方案');
    await composer.press('Enter');
    await expect.poll(mock.heldCount, { timeout: 90_000 }).toBe(MEMBERS.length);

    const bar = page.getByTestId('team-member-bar');
    // A running member has two buttons in the bar (its chip and its stop); the chip carries the status.
    const chipOf = (member: string) => bar.locator('[data-status]').filter({ hasText: member });
    for (const member of MEMBERS) {
      await expect(chipOf(member)).toHaveAttribute('data-status', 'running');
    }
    await bar.getByRole('button', { name: '产品经理' }).click();
    const teamTab = page.getByTestId('team-tab');
    await expect(teamTab).toBeVisible();
    const rowOf = (member: string) => teamTab.getByTestId('team-member-row').filter({ hasText: member });
    const stopOf = (member: string) => page.getByRole('button', { name: `停止 ${member} 这次的活` });

    // Stop one member; the batch and its sibling keep running.
    await rowOf(STOPPED_MEMBER).getByRole('button', { name: `停止 ${STOPPED_MEMBER} 这次的活` }).click();
    await expect(rowOf(STOPPED_MEMBER).getByRole('button', { name: `停止 ${STOPPED_MEMBER} 这次的活` })).toHaveCount(0);
    await expect(chipOf(RUNNING_MEMBER)).toHaveAttribute('data-status', 'running');
    await expect.poll(mock.heldCount).toBe(1);

    const activePanel = page.locator('[role="tabpanel"]:not([hidden])');
    await rowOf(STOPPED_MEMBER).getByRole('button', { name: /^查看第 1 次/ }).click();
    const stoppedHeader = activePanel.locator('header');
    await expect(stoppedHeader).toContainText(STOPPED_MEMBER);
    await expect(stoppedHeader).toContainText('已停止');
    await expect(stoppedHeader).not.toContainText('运行中');
    await expect(activePanel.locator('[data-ds-spinner]')).toHaveCount(0);
    await expect(stopOf(STOPPED_MEMBER)).toHaveCount(0);
    await page.screenshot({ path: test.info().outputPath('team-member-stopped.png') });

    await bar.getByRole('button', { name: '产品经理' }).click();
    await rowOf(RUNNING_MEMBER).getByRole('button', { name: /^查看第 1 次/ }).click();
    const runningHeader = activePanel.locator('header');
    await expect(runningHeader).toContainText(RUNNING_MEMBER);
    await expect(runningHeader).toContainText('运行中');
    await expect(runningHeader.getByRole('button', { name: `停止 ${RUNNING_MEMBER} 这次的活` })).toBeVisible();
    await page.screenshot({ path: test.info().outputPath('team-member-running.png') });

    mock.release();
    await expect(page.getByText(FINAL_TEXT)).toBeVisible({ timeout: 90_000 });
    await expect(runningHeader).toContainText('已成功');
    await expect(runningHeader.getByRole('button')).toHaveCount(0);
  } finally {
    if (test.info().status !== test.info().expectedStatus) {
      await test.info().attach('provider-requests', { body: JSON.stringify(mock.requests, null, 2), contentType: 'application/json' });
    }
    await closeAbuElectron(launched.app);
    await mock.close();
    removeElectronDataRoot(dataRoot);
  }
});
