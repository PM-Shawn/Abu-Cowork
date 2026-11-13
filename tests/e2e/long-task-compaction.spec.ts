/**
 * Real-Electron coverage for compaction inside one long task: a single user
 * message followed by many tool steps fills the window, the loop summarizes
 * the earlier steps before the request that would pass 90 % of the input
 * budget, and the task goes on to its answer. The user's message is sent
 * verbatim after the summary; the earlier steps are not.
 *
 * Deterministic: a loopback mock provider answers with a fixed sequence of
 * read_file calls and a final reply, and every summary request with a fixed
 * summary.
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
} from './electronHelpers';
import {
  CHAT_PLACEHOLDER,
  READY_TIMEOUT,
  compressionRequests,
  startOpenAiMock,
  taskRequests,
  waitForApp,
  type OpenAiMock,
} from './openAiMock';

const SUMMARY = 'Abu E2E long-task summary: the first files were read.';

let app: ElectronApplication | undefined;
let mock: OpenAiMock | undefined;
let dataRoot: ElectronDataRoot | undefined;
let fixtureDirectory: string | undefined;

test.afterEach(async () => {
  if (app) await closeAbuElectron(app);
  app = undefined;
  if (mock) await mock.close();
  mock = undefined;
  if (dataRoot) removeElectronDataRoot(dataRoot);
  dataRoot = undefined;
  if (fixtureDirectory) fs.rmSync(fixtureDirectory, { recursive: true });
  fixtureDirectory = undefined;
});

function findLedgers(dir: string): string[] {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  return entries.flatMap((entry) => {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) return findLedgers(entryPath);
    return entry.name === 'messages.jsonl' ? [entryPath] : [];
  });
}

/** Every row of every ledger under the data root, last revision first-seen order kept. */
function ledgerRows(rootDir: string): Array<Record<string, unknown>> {
  return findLedgers(rootDir).flatMap((ledger) => fs.readFileSync(ledger, 'utf8')
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as Record<string, unknown>));
}

function createFixtureDirectory(runId: string): string {
  fixtureDirectory = path.join(process.cwd(), '.agent', 'context-e2e-fixtures', runId);
  fs.mkdirSync(fixtureDirectory, { recursive: true });
  return fixtureDirectory;
}

function createLongTaskFiles(runId: string) {
  // Eight files of about 9 000 tokens each: under the long-result threshold,
  // so each step lands whole and the history grows step by step.
  const fixtureDir = createFixtureDirectory(runId);
  return Array.from({ length: 8 }, (_, index) => {
    const marker = `abu-e2e-long-task-file-${index}-${runId}`;
    const filePath = path.join(fixtureDir, `file-${index}.txt`);
    fs.writeFileSync(filePath, [
      marker,
      ...Array.from({ length: 79 }, (_, line) => `file ${index} line ${line}: ${'z'.repeat(440)}`),
    ].join('\n'));
    return { marker, filePath };
  });
}

/** Reading never asks, not even for a folder outside the workspace: the run goes on with no dialog. */
async function expectNoReadDialog(page: Page) {
  await expect(page.getByRole('alertdialog')).toHaveCount(0);
}

function toolResultText(body: unknown, toolName: string): string {
  const { messages } = body as {
    messages: Array<{
      role: string;
      content: string | null;
      tool_call_id?: string;
      tool_calls?: Array<{ id: string; function: { name: string } }>;
    }>;
  };
  const call = messages.flatMap((message) => message.tool_calls ?? []).find((entry) => entry.function.name === toolName);
  const result = messages.find((message) => message.role === 'tool' && message.tool_call_id === call?.id);
  if (typeof result?.content !== 'string') throw new Error(`No result was sent for ${toolName}`);
  return result.content;
}

test('summarizes earlier steps in the middle of one task and finishes it', async () => {
  test.setTimeout(240_000);
  const runId = randomUUID();
  const prompt = `abu-e2e-long-task-${runId}: read the eight files one by one`;
  const finalAnswer = `abu-e2e-long-task-done-${runId}`;
  dataRoot = createElectronDataRoot();
  const fixtures = createLongTaskFiles(runId);
  const fixtureDir = path.dirname(fixtures[0].filePath);

  mock = await startOpenAiMock([
    { kind: 'tool-call', toolCallId: `call-list-${runId}`, toolName: 'list_directory', arguments: { path: fixtureDir } },
    ...fixtures.map((fixture, index) => ({
      kind: 'tool-call' as const,
      toolCallId: `call-long-task-${index}-${runId}`,
      toolName: 'read_file',
      arguments: { path: fixture.filePath },
    })),
    { kind: 'complete', responseText: finalAnswer },
  ], { compressionResponseText: SUMMARY });

  const launch = await launchAbuElectron(dataRoot);
  app = launch.app;
  const page = await app.firstWindow({ timeout: READY_TIMEOUT });
  await waitForApp(page);
  await configureLocalMockProvider(page, mock.baseUrl, {
    contextWindowSize: 50_000,
    maxOutputTokens: 4_096,
    supportsTools: true,
    permissionMode: 'standard',
  });

  const input = page.getByPlaceholder(CHAT_PLACEHOLDER);
  await input.fill(prompt);
  await input.press('Enter');
  await expect(page.getByText(finalAnswer, { exact: true })).toBeVisible({ timeout: 120_000 });
  await expectNoReadDialog(page);
  await expect(input).toBeEditable({ timeout: READY_TIMEOUT });

  const divider = page.locator('[data-compact-status="done"]').last();
  await expect(divider).toBeVisible();
  await divider.getByRole('button', { name: /已整理前面的内容/ }).click();
  await expect(divider.getByText(SUMMARY, { exact: true })).toBeVisible();
  await divider.getByRole('button', { name: '复制', exact: true }).click();
  await expect(divider.getByRole('button', { name: '已复制', exact: true })).toBeVisible();
  expect(await app.evaluate(({ clipboard }) => clipboard.readText())).toBe(SUMMARY);

  // At least one summary request happened inside the run, and the run kept going.
  const summaries = compressionRequests(mock);
  expect(summaries.length).toBeGreaterThan(0);
  const tasks = taskRequests(mock);
  expect(tasks).toHaveLength(fixtures.length + 2);

  // The summary request condenses the earliest file; the request after it
  // carries the user's own message verbatim and the summary, not that file.
  expect(JSON.stringify(summaries[0].body)).toContain(fixtures[0].marker);
  const lastBody = JSON.stringify(tasks.at(-1)!.body);
  expect(lastBody).toContain(prompt);
  expect(lastBody).toContain(SUMMARY);
  expect(lastBody).not.toContain(fixtures[0].marker);
  expect(lastBody).toContain(fixtures.at(-1)!.marker);

  // The divider is stored in the run that compacted, as a version-2 marker.
  await expect.poll(() => ledgerRows(dataRoot!.rootDir).some((row) => (
    typeof row.id === 'string'
    && row.id.startsWith('compact-boundary-')
    && (row.compactBoundary as { version?: number; status?: string } | undefined)?.version === 2
    && (row.compactBoundary as { status?: string }).status === 'done'
    && typeof row.loopId === 'string'
  )), { timeout: 30_000 }).toBe(true);
});

for (const ending of ['stopped', 'failed'] as const) {
  test(`clears the running compaction when it is ${ending}`, async () => {
    test.setTimeout(180_000);
    const runId = randomUUID();
    dataRoot = createElectronDataRoot();
    const fixtures = createLongTaskFiles(runId);
    const fixtureDir = path.dirname(fixtures[0].filePath);
    mock = await startOpenAiMock([
      { kind: 'tool-call', toolCallId: `call-list-${runId}`, toolName: 'list_directory', arguments: { path: fixtureDir } },
      ...fixtures.map((fixture, index) => ({
        kind: 'tool-call' as const,
        toolCallId: `call-${ending}-${index}-${runId}`,
        toolName: 'read_file',
        arguments: { path: fixture.filePath },
      })),
    ], {
      compressionReply: ending === 'stopped'
        ? { kind: 'hold-open', partialText: '' }
        : { kind: 'complete', responseText: '' },
    });

    const launch = await launchAbuElectron(dataRoot);
    app = launch.app;
    const page = await app.firstWindow({ timeout: READY_TIMEOUT });
    await waitForApp(page);
    await configureLocalMockProvider(page, mock.baseUrl, {
      contextWindowSize: 50_000,
      maxOutputTokens: 4_096,
      supportsTools: true,
      permissionMode: 'standard',
    });
    const input = page.getByPlaceholder(CHAT_PLACEHOLDER);
    await input.fill(`abu-e2e-compaction-${ending}-${runId}: read the eight files one by one`);
    await input.press('Enter');
    await expect.poll(() => compressionRequests(mock!).length, { timeout: 120_000 }).toBeGreaterThan(0);
    await expectNoReadDialog(page);

    const stopButton = page.getByLabel(/^(停止|Stop)$/);
    if (ending === 'stopped') {
      const pending = page.locator('.task-block [data-step-list] [data-compact-status="pending"]');
      await expect(pending).toBeVisible();
      await expect(pending).toHaveText('正在整理前面的内容');
      await stopButton.click();
      await expect.poll(() => compressionRequests(mock!).some((request) => request.responseAborted)).toBe(true);
    }
    await expect(stopButton).toBeHidden({ timeout: READY_TIMEOUT });
    await expect(input).toBeEditable();
    await expect(page.locator('[data-compact-status="pending"]')).toHaveCount(0);
    await expect(page.locator('[data-compact-status="done"]')).toHaveCount(0);

    if (ending === 'failed') {
      const failed = page.locator('[data-compact-status="failed"]');
      await expect(failed).toBeVisible();
      await expect(failed).toHaveText('整理前面的内容没有完成');
      await expect(failed.getByRole('button')).toHaveCount(0);
    } else {
      await expect(page.locator('[data-compact-divider]')).toHaveCount(0);
      expect(ledgerRows(dataRoot.rootDir).some((row) => row.compactBoundary !== undefined)).toBe(false);
    }
  });
}

test('writes a long tool result and reads its omitted content through read_file', async () => {
  test.setTimeout(180_000);
  const runId = randomUUID();
  const finalAnswer = `abu-e2e-long-result-done-${runId}`;
  dataRoot = createElectronDataRoot();
  const fixtureDir = createFixtureDirectory(runId);
  // 500 matching lines (the most search_files returns) of about 300
  // characters: far above the long-result threshold.
  const needle = `abu-e2e-needle-${runId}`;
  fs.writeFileSync(path.join(fixtureDir, 'haystack.txt'), Array.from(
    { length: 500 },
    (_, line) => `${needle} line ${line} ${'q'.repeat(240)}`,
  ).join('\n'));

  mock = await startOpenAiMock([
    {
      kind: 'tool-call',
      toolCallId: `call-long-result-${runId}`,
      toolName: 'search_files',
      arguments: { pattern: needle, path: fixtureDir, max_results: 500 },
    },
    (request) => {
      const result = toolResultText(request.body, 'search_files');
      const saved = /The full output \(\d+ characters\) is saved at (.+?\.txt)\. Read the part/.exec(result);
      if (!saved) throw new Error('The search result did not provide its saved output path');
      return {
        kind: 'tool-call',
        toolCallId: `call-read-result-${runId}`,
        toolName: 'read_file',
        arguments: { path: saved[1], offset: 249, limit: 10 },
      };
    },
    { kind: 'complete', responseText: finalAnswer },
  ]);

  const launch = await launchAbuElectron(dataRoot);
  app = launch.app;
  const page = await app.firstWindow({ timeout: READY_TIMEOUT });
  await waitForApp(page);
  await configureLocalMockProvider(page, mock.baseUrl, { supportsTools: true, permissionMode: 'standard' });

  const input = page.getByPlaceholder(CHAT_PLACEHOLDER);
  await input.fill(`abu-e2e-long-result-${runId}: search the haystack`);
  await input.press('Enter');
  await expect(page.getByText(finalAnswer, { exact: true })).toBeVisible({ timeout: 120_000 });
  await expectNoReadDialog(page);

  // The request after the search carries a bounded result that names its file.
  const requests = taskRequests(mock);
  expect(requests).toHaveLength(3);
  const boundedResult = toolResultText(requests[1].body, 'search_files');
  const saved = /The full output \(\d+ characters\) is saved at (.+?\.txt)\. Read the part/.exec(boundedResult);
  expect(saved).not.toBeNull();
  expect(boundedResult).toContain('characters omitted');
  expect(boundedResult).toContain(`${needle} line 0 `);
  expect(boundedResult).toContain(`${needle} line 499 `);
  expect(boundedResult).not.toContain(`${needle} line 250 `);
  expect(boundedResult.length).toBeLessThan(20_000);
  const savedPath = saved![1];
  expect(savedPath).toContain(`${path.sep}results${path.sep}`);
  const fullResult = fs.readFileSync(savedPath, 'utf8');
  expect(fullResult).toContain(`${needle} line 0 `);
  expect(fullResult).toContain(`${needle} line 250 `);
  expect(fullResult).toContain(`${needle} line 499 `);
  expect(fullResult).not.toContain('characters omitted');
  const readResult = toolResultText(requests[2].body, 'read_file');
  expect(readResult).toContain(`${needle} line 250 `);
  expect(readResult).not.toContain('characters omitted');
});
