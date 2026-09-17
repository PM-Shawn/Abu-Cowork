/**
 * Real-Electron acceptance: a finished turn's work-process steps survive an
 * app restart.
 *
 * Regression (2026-09-16): the loop ends with finishStreaming (a checkpoint of
 * the final assistant message, still WITHOUT executionSteps) followed by the
 * executionSteps snapshot write. The snapshot write bypassed the
 * conversation's serial persistence queue, landed first, and the stale
 * checkpoint then became the message's last ledger revision — after a
 * restart the steps were gone. The side panel's member view then also looked
 * for that snapshot on the dispatching message (where the batch tool call
 * lives) instead of the loop's last message (where the snapshot lives).
 *
 * A third gap (same day): the shell applies the batch step's addStep frame
 * behind an awaited ledger write, while member progress arrives on its own
 * channel; a member that finished first had its tool calls dropped, so the
 * persisted batch step had no children and the restored member view read
 * "0 tool calls · unverified". The member's web_search must be on disk and in
 * the restored view. That race is timing-dependent here; the deterministic
 * check lives in orchestrationTools.test.ts.
 *
 * Deterministic: a loopback mock provider scripts the loop
 * (tool_search → run_agent_batch → final text) and the batch member
 * (web_search, which fails fast without a search key → text).
 */
import { expect, test } from '@playwright/test';
import type { Page } from 'playwright';
import { createServer } from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import {
  closeAbuElectron,
  configureLocalMockProvider,
  createElectronDataRoot,
  dismissFirstRunOverlays,
  launchAbuElectron,
  removeElectronDataRoot,
} from './electronHelpers';

const PROMPT = 'E2E步骤持久化任务';
const FINAL_TEXT = 'E2E步骤持久化完毕';
const MEMBER_TASK = 'E2E成员子任务';

type MockMessage = { role: string; content?: string | Array<{ text?: string }> | null };

function textOf(message: MockMessage): string {
  if (typeof message.content === 'string') return message.content;
  return message.content?.map((block) => block.text ?? '').join('\n') ?? '';
}

function toolCall(id: string, name: string, args: unknown): string[] {
  return [
    chunk({ role: 'assistant', tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }, null),
    chunk({}, 'tool_calls'),
  ];
}
type LedgerStep = { toolName?: string; childSteps?: Array<{ toolName?: string; batchTask?: { index?: number } }> };
type LedgerRow = { id?: string; role?: string; content?: unknown; executionSteps?: LedgerStep[] };

function chunk(delta: Record<string, unknown>, finish: string | null): string {
  return `data: ${JSON.stringify({ id: 'steps-restart', object: 'chat.completion.chunk', created: 0, model: 'mock', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
}

async function startMock() {
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const part of req) raw += part;
    const body = JSON.parse(raw || '{}') as { messages?: MockMessage[] };
    const messages = body.messages ?? [];
    const toolResults = messages.filter((m) => m.role === 'tool').length;
    const isMember = messages.some((m) => m.role === 'user' && textOf(m).includes(MEMBER_TASK));
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    let frames: string[];
    if (isMember) {
      frames = toolResults === 0
        ? toolCall('call_member_search', 'web_search', { query: 'abu e2e' })
        : [chunk({ role: 'assistant', content: '成员完成' }, null), chunk({}, 'stop')];
    } else if (toolResults === 0) {
      frames = toolCall('call_search', 'tool_search', { query: 'run_agent_batch', max_results: 1 });
    } else if (toolResults === 1) {
      frames = toolCall('call_batch', 'run_agent_batch', { tasks: [{ type: 'research', task: MEMBER_TASK }] });
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
    baseUrl: `http://2130706433:${address.port}/v1`,
    close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}

function findLedgers(dir: string): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.flatMap((entry) => {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) return findLedgers(entryPath);
    return entry.name === 'messages.jsonl' ? [entryPath] : [];
  });
}

/** Last ledger revision (the fold's winner) of the assistant message carrying FINAL_TEXT. */
function lastFinalRevision(rootDir: string): LedgerRow | undefined {
  for (const ledger of findLedgers(rootDir)) {
    const rows = fs.readFileSync(ledger, 'utf8').split('\n').flatMap((line) => {
      try {
        return [JSON.parse(line) as LedgerRow];
      } catch {
        return [];
      }
    });
    const finalId = rows.find((row) => row.role === 'assistant' && JSON.stringify(row.content ?? '').includes(FINAL_TEXT))?.id;
    if (finalId) return rows.filter((row) => row.id === finalId).at(-1);
  }
  return undefined;
}

function persistedToolNames(rootDir: string): string[] | 'final message not on disk' {
  const row = lastFinalRevision(rootDir);
  if (!row) return 'final message not on disk';
  return row.executionSteps?.map((step) => step.toolName ?? '') ?? [];
}


/** The member's child steps recorded under the persisted run_agent_batch step. */
function persistedMemberSteps(rootDir: string): Array<[string | undefined, number | undefined]> {
  const batchStep = lastFinalRevision(rootDir)?.executionSteps?.find((step) => step.toolName === 'run_agent_batch');
  return (batchStep?.childSteps ?? []).map((child) => [child.toolName, child.batchTask?.index]);
}

/** The finished turn's work process is collapsed; expand it and return the member row. */
async function openMemberRow(page: Page) {
  const row = page.getByRole('button', { name: new RegExp(`^打开 ${MEMBER_TASK}.*已成功`) });
  if (!(await row.isVisible())) await page.getByRole('button', { name: /^用时/ }).first().click();
  await expect(row).toBeVisible();
  return row;
}

async function showSidebar(page: Page) {
  const toggle = page.getByRole('button', { name: '显示侧栏', exact: true });
  if (await toggle.isVisible()) await toggle.click();
}

test('a finished batch turn keeps its work-process steps and member process across a restart', async () => {
  test.setTimeout(180_000);
  const dataRoot = createElectronDataRoot();
  const mock = await startMock();
  let launched = await launchAbuElectron(dataRoot);
  try {
    let page = await launched.app.firstWindow();
    await page.waitForLoadState('domcontentloaded');
    await expect(page.getByRole('textbox').first()).toBeVisible({ timeout: 45_000 });
    await dismissFirstRunOverlays(page);
    await configureLocalMockProvider(page, mock.baseUrl, { supportsTools: true, permissionMode: 'standard' });
    await expect(page.getByRole('textbox').first()).toBeVisible({ timeout: 45_000 });

    const composer = page.getByRole('textbox').first();
    await composer.fill(PROMPT);
    await composer.press('Enter');
    await expect(page.getByText(FINAL_TEXT)).toBeVisible({ timeout: 90_000 });
    await openMemberRow(page);
    await page.screenshot({ path: test.info().outputPath('steps-live.png') });

    // closeAbuElectron flushes the ledger queue; afterwards the fold winner
    // for the final message must be a revision that carries the snapshot.
    await closeAbuElectron(launched.app);
    expect(persistedToolNames(dataRoot.rootDir)).toEqual(['tool_search', 'run_agent_batch']);
    // The member's web_search is recorded under the batch step even when the
    // member finished before the shell applied that step's addStep frame.
    expect(persistedMemberSteps(dataRoot.rootDir)).toEqual([['web_search', 0]]);

    launched = await launchAbuElectron(dataRoot);
    page = await launched.app.firstWindow();
    await page.waitForLoadState('domcontentloaded');
    await expect(page.getByRole('textbox').first()).toBeVisible({ timeout: 45_000 });
    await showSidebar(page);
    await page.getByText(PROMPT).first().click();
    await expect(page.getByText(FINAL_TEXT)).toBeVisible();
    // No live batch after a restart: the member view is rebuilt from the
    // persisted batch step. Without it the tab falls back to the
    // "only retained during this app run" notice.
    await (await openMemberRow(page)).click();
    await expect(page.getByText('已结束 · 过程记录')).toBeVisible();
    await expect(page.getByTestId('subagent-persisted-steps')).toBeVisible();
    await expect(page.getByTestId('subagent-persisted-steps').getByRole('button')).toHaveCount(1);
    await expect(page.getByText('1 次工具调用')).toBeVisible();
    await expect(page.getByTestId('dispatch-unverified')).toHaveCount(0);
    await page.screenshot({ path: test.info().outputPath('steps-restored.png') });
  } finally {
    await closeAbuElectron(launched.app);
    await mock.close();
    removeElectronDataRoot(dataRoot);
  }
});
