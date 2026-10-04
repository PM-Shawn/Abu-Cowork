/**
 * #549 P2b in real Electron: a conversation's permission mode survives a quit
 * and relaunch on the same data root, and an unload from the conversation
 * cache; a persisted value this build cannot accept disappears silently; a new
 * conversation starts from the global default.
 *
 * The mode is read from the composer chip (DOM text) and from behaviour: in
 * 「完全自主」 a destructive command runs with no confirmation dialog, so the
 * model mock receives the tool result without any click and the file is gone,
 * while on the default mode the same kind of command stops at the 「操作确认」
 * dialog with the file still there. The runtime trace carries no permission
 * mode, so it is not used.
 *
 * Every file a tool call here deletes lives inside the launch's own temp data
 * root; the only model endpoint is the loopback mock.
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
  startOpenAiMock,
  taskRequests,
  waitForApp,
  type MockReplyPlan,
  type OpenAiMock,
} from './openAiMock';

/** The global permission mode every launch here starts from. */
const PROVIDER = { permissionMode: 'standard', supportsTools: true } as const;
const MODE_STANDARD = '请求批准';
const MODE_AUTONOMOUS = '完全自主';
/** A phrase only the 「完全自主」 row of the chip's list carries. */
const AUTONOMOUS_ROW_TEXT = '系统红线始终禁止';
const CONFIRM_DIALOG = /^(操作确认|Confirm Action)$/;
const CANCEL_BUTTON = /^(取消|Cancel)$/;
const STOP_BUTTON = /^(停止|Stop)$/;
/**
 * Conversations kept in memory by the store (`MAX_LOADED` in
 * src/stores/chatStore.ts). The unload journey opens this many newer
 * conversations plus one, so the first one is the oldest by `updatedAt` and
 * leaves the cache on the next switch. Change this with `MAX_LOADED`.
 */
const MAX_LOADED = 5;

interface IndexEntry {
  id: string;
  title?: string;
  messageCount?: number;
  permissionMode?: unknown;
}

interface RequestMessage {
  content?: unknown;
  role?: unknown;
  tool_call_id?: unknown;
  tool_calls?: Array<{ id?: unknown; function?: { arguments?: unknown; name?: unknown } }>;
}

/**
 * A request that continues a turn after a command was decided: it carries the
 * assistant's `run_command` call and, keyed to that call, the command's own
 * result. The adapter renumbers tool call ids on the way out (`toolu_<n>_<i>`),
 * so the pairing is read inside the body instead of against the mock's id. The
 * body replays the whole conversation, so the call this turn is about is the
 * last one.
 */
function expectCommandResult(body: unknown, command: string, expectedResult: string): void {
  const messages = (body as { messages?: RequestMessage[] } | null)?.messages ?? [];
  const call = messages
    .filter((message) => message.role === 'assistant' && Array.isArray(message.tool_calls))
    .flatMap((message) => message.tool_calls ?? [])
    .filter((candidate) => candidate.function?.name === 'run_command')
    .at(-1);
  expect(call, 'the turn continued from a run_command call').toBeDefined();
  const args = JSON.parse(String(call?.function?.arguments ?? '{}')) as { command?: unknown };
  expect(args.command, 'the call the result belongs to is this spec\'s command').toBe(command);
  const result = messages.find((message) => message.role === 'tool' && message.tool_call_id === call?.id);
  expect(result, 'the command\'s result is keyed to that call').toBeDefined();
  expect(String(result?.content ?? ''), 'the result the model received').toContain(expectedResult);
}

let app: ElectronApplication | undefined;
let dataRoot: ElectronDataRoot | undefined;
let mock: OpenAiMock | undefined;

function findConversationIndex(dir: string): string | null {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    const entryPath = path.join(dir, entry.name);
    if (entry.isFile() && entry.name === 'index.json' && path.basename(dir) === 'conversations') return entryPath;
    if (entry.isDirectory()) {
      const found = findConversationIndex(entryPath);
      if (found) return found;
    }
  }
  return null;
}

/** The index row whose title starts with `titlePrefix`, as the file on disk holds it right now. */
function indexEntry(root: ElectronDataRoot, titlePrefix: string): IndexEntry | null {
  const indexPath = findConversationIndex(root.appDataDir);
  if (!indexPath) return null;
  let parsed: { entries?: Record<string, IndexEntry> };
  try {
    parsed = JSON.parse(fs.readFileSync(indexPath, 'utf8')) as { entries?: Record<string, IndexEntry> };
  } catch {
    return null; // a poll can land between the writer's temp file and its rename
  }
  return Object.values(parsed.entries ?? {}).find((entry) => entry.title?.startsWith(titlePrefix)) ?? null;
}

/** Patch one index row while the app is closed — the spec's own file, inside its own data root. */
function rewriteIndexEntry(root: ElectronDataRoot, titlePrefix: string, patch: Record<string, unknown>): void {
  const indexPath = findConversationIndex(root.appDataDir);
  if (!indexPath) throw new Error('index.json not found under the data root');
  const parsed = JSON.parse(fs.readFileSync(indexPath, 'utf8')) as { entries: Record<string, IndexEntry> };
  const entry = Object.values(parsed.entries).find((candidate) => candidate.title?.startsWith(titlePrefix));
  if (!entry) throw new Error(`no index entry titled ${titlePrefix}`);
  Object.assign(entry, patch);
  fs.writeFileSync(indexPath, JSON.stringify(parsed, null, 2));
}

/**
 * True once a messages.jsonl under the data root holds `text`. A relaunch and a
 * reload after an unload both read the conversation from disk, so a journey
 * waits for the write before giving up the in-memory copy.
 */
function messagesOnDisk(root: ElectronDataRoot, text: string): boolean {
  const visit = (dir: string): boolean => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return false;
    }
    return entries.some((entry) => {
      const entryPath = path.join(dir, entry.name);
      if (entry.isDirectory()) return visit(entryPath);
      if (entry.name !== 'messages.jsonl') return false;
      try {
        return fs.readFileSync(entryPath, 'utf8').includes(text);
      } catch {
        return false;
      }
    });
  };
  return visit(root.appDataDir);
}

async function launch(root: ElectronDataRoot, configure: boolean): Promise<Page> {
  const launched = await launchAbuElectron(root);
  app = launched.app;
  const page = await app.firstWindow({ timeout: READY_TIMEOUT });
  await waitForApp(page);
  if (configure) await configureLocalMockProvider(page, mock!.baseUrl, PROVIDER);
  return page;
}

/**
 * The composer's permission chip. Its accessible name is exactly the mode's
 * label; the rows of its open list carry the label plus the mode's description,
 * so `exact` keeps the two apart.
 */
function permissionChip(page: Page, label: string) {
  return page.getByTestId('composer-toolbar').getByRole('button', { name: label, exact: true });
}

/** Open the chip's list and pick the row whose description carries `rowText`. */
async function pickPermissionMode(page: Page, currentLabel: string, rowText: string): Promise<void> {
  await permissionChip(page, currentLabel).click();
  await page.locator('button').filter({ hasText: rowText }).click();
}

async function send(page: Page, text: string): Promise<void> {
  const input = page.getByPlaceholder(CHAT_PLACEHOLDER);
  await input.fill(text);
  await input.press('Enter');
}

async function sendAndAwaitReply(page: Page, text: string, reply: string): Promise<void> {
  await send(page, text);
  await expect(page.getByText(reply, { exact: true })).toBeVisible({ timeout: READY_TIMEOUT });
  await expect(page.getByRole('button', { name: STOP_BUTTON })).toHaveCount(0, { timeout: READY_TIMEOUT });
}

/** The sidebar starts collapsed once a conversation is open; expand it if so. */
async function ensureSidebar(page: Page): Promise<void> {
  const showSidebar = page.getByTitle('显示侧栏', { exact: true });
  if (await showSidebar.isVisible()) await showSidebar.click();
  await expect(page.getByTitle('显示侧栏', { exact: true })).toHaveCount(0);
}

async function openConversation(page: Page, title: string): Promise<void> {
  await ensureSidebar(page);
  const row = page.getByRole('button', { name: new RegExp(`^${title}`) }).first();
  await expect(row).toBeVisible({ timeout: READY_TIMEOUT });
  await row.click();
  await expect(page.getByText(title, { exact: true }).first()).toBeVisible({ timeout: READY_TIMEOUT });
}

async function openNewTask(page: Page): Promise<void> {
  await ensureSidebar(page);
  await page.getByRole('button', { name: '新任务', exact: true }).first().click();
  await expect(page.getByPlaceholder(CHAT_PLACEHOLDER)).toBeVisible({ timeout: READY_TIMEOUT });
}

test.describe.serial('#549 P2b per-conversation permission mode — real Electron', () => {
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

  test('the mode survives a restart and an unload, the gate applies it, and a new conversation starts from the default', async () => {
    test.setTimeout(600_000);
    const marker = `p2b-perm-${randomUUID().slice(0, 8)}`;
    const filler = `p2b-fill-${randomUUID().slice(0, 6)}`;
    const fresh = `p2b-new-${randomUUID().slice(0, 8)}`;
    const replyOpen = `p2b-reply-open-${randomUUID()}`;
    const replyAfterRestart = `p2b-reply-restart-${randomUUID()}`;
    const replyAfterUnload = `p2b-reply-unload-${randomUUID()}`;
    const replyDefault = `p2b-reply-default-${randomUUID()}`;
    const fillerReplies = Array.from({ length: MAX_LOADED + 1 }, (_, i) => `p2b-reply-fill-${i}-${randomUUID()}`);
    dataRoot = createElectronDataRoot();
    // Every sentinel lives in this launch's own temp root, next to the app data
    // directory — the same place tests/e2e/tool-approval.spec.ts puts its own.
    const sentinelRestart = path.join(dataRoot.rootDir, `p2b-sentinel-restart-${randomUUID()}.txt`);
    const sentinelUnload = path.join(dataRoot.rootDir, `p2b-sentinel-unload-${randomUUID()}.txt`);
    const sentinelDefault = path.join(dataRoot.rootDir, `p2b-sentinel-default-${randomUUID()}.txt`);
    fs.writeFileSync(sentinelRestart, 'removed by the restored autonomous conversation');
    fs.writeFileSync(sentinelUnload, 'removed by the same conversation after an unload');
    fs.writeFileSync(sentinelDefault, 'kept: the default mode asks first');
    const commandRestart = `rm -- '${sentinelRestart}'`;
    const commandUnload = `rm -- '${sentinelUnload}'`;
    const commandDefault = `rm -- '${sentinelDefault}'`;
    const plans: MockReplyPlan[] = [
      { kind: 'complete', responseText: replyOpen },
      { kind: 'tool-call', toolName: 'run_command', toolCallId: `call-restart-${randomUUID()}`, arguments: { command: commandRestart } },
      { kind: 'complete', responseText: replyAfterRestart },
      ...fillerReplies.map((responseText) => ({ kind: 'complete' as const, responseText })),
      { kind: 'tool-call', toolName: 'run_command', toolCallId: `call-unload-${randomUUID()}`, arguments: { command: commandUnload } },
      { kind: 'complete', responseText: replyAfterUnload },
      { kind: 'tool-call', toolName: 'run_command', toolCallId: `call-default-${randomUUID()}`, arguments: { command: commandDefault } },
      { kind: 'complete', responseText: replyDefault },
    ];
    mock = await startOpenAiMock(plans);

    let page = await launch(dataRoot, true);
    await expect(permissionChip(page, MODE_STANDARD)).toBeVisible({ timeout: READY_TIMEOUT });
    await sendAndAwaitReply(page, marker, replyOpen);

    // Pick 「完全自主」 in this conversation: the chip reads it and the
    // conversation's row of index.json carries it.
    await pickPermissionMode(page, MODE_STANDARD, AUTONOMOUS_ROW_TEXT);
    await expect(permissionChip(page, MODE_AUTONOMOUS)).toBeVisible();
    await expect.poll(
      () => indexEntry(dataRoot!, marker)?.permissionMode,
      { message: 'the picked mode reaches the conversation\'s row of index.json', timeout: READY_TIMEOUT },
    ).toBe('autonomous');
    await expect.poll(
      () => messagesOnDisk(dataRoot!, replyOpen),
      { message: 'the first reply is on disk before the relaunch reads it back', timeout: READY_TIMEOUT },
    ).toBe(true);

    // Quit and relaunch on the same data root.
    await closeAbuElectron(app!);
    app = undefined;
    page = await launch(dataRoot, false);
    // The new-task page follows the global default, which the relaunch did not change.
    await expect(permissionChip(page, MODE_STANDARD)).toBeVisible({ timeout: READY_TIMEOUT });
    await openConversation(page, marker);
    await expect(permissionChip(page, MODE_AUTONOMOUS)).toBeVisible({ timeout: READY_TIMEOUT });
    await expect(page.getByText(replyOpen, { exact: true })).toBeVisible({ timeout: READY_TIMEOUT });

    // The restored mode is the one the gate applies: the command runs with no
    // confirmation dialog, so the tool result reaches the model without a click.
    await sendAndAwaitReply(page, `${marker}-run`, replyAfterRestart);
    await expect(page.getByRole('heading', { name: CONFIRM_DIALOG })).toHaveCount(0);
    await expect.poll(
      () => fs.existsSync(sentinelRestart),
      { message: 'the autonomous conversation deleted its sentinel with nothing to click', timeout: READY_TIMEOUT },
    ).toBe(false);
    expect(taskRequests(mock), 'the message, the tool call and the turn continuing with its result').toHaveLength(3);
    expectCommandResult(taskRequests(mock)[2].body, commandRestart, 'exit code: 0');

    // Unload: the store keeps MAX_LOADED conversations. Open that many newer
    // ones plus one, so this conversation is the oldest by `updatedAt` and the
    // next switch drops it from the cache; reopening it reads the index again.
    await expect.poll(
      () => messagesOnDisk(dataRoot!, replyAfterRestart),
      { message: 'the run\'s reply is on disk before the conversation leaves the cache', timeout: READY_TIMEOUT },
    ).toBe(true);
    for (const [index, reply] of fillerReplies.entries()) {
      await openNewTask(page);
      await expect(permissionChip(page, MODE_STANDARD)).toBeVisible();
      await sendAndAwaitReply(page, `${filler}-${index}`, reply);
    }
    await openConversation(page, `${filler}-0`);
    await openConversation(page, marker);
    await expect(permissionChip(page, MODE_AUTONOMOUS)).toBeVisible({ timeout: READY_TIMEOUT });
    await expect(page.getByText(replyAfterRestart, { exact: true })).toBeVisible({ timeout: READY_TIMEOUT });

    // And the gate still applies it after that reload, with no restart in between.
    await sendAndAwaitReply(page, `${marker}-again`, replyAfterUnload);
    await expect(page.getByRole('heading', { name: CONFIRM_DIALOG })).toHaveCount(0);
    await expect.poll(
      () => fs.existsSync(sentinelUnload),
      { message: 'the reloaded conversation still runs a command without asking', timeout: READY_TIMEOUT },
    ).toBe(false);
    expect(
      taskRequests(mock),
      'three requests for the restored run, one per filler conversation, two for this run',
    ).toHaveLength(5 + fillerReplies.length);
    expectCommandResult(taskRequests(mock).at(-1)!.body, commandUnload, 'exit code: 0');

    // A new conversation follows the global default, and its gate asks.
    await openNewTask(page);
    await expect(permissionChip(page, MODE_STANDARD)).toBeVisible();
    await send(page, fresh);
    await expect(page.getByRole('heading', { name: CONFIRM_DIALOG })).toBeVisible({ timeout: READY_TIMEOUT });
    expect(fs.existsSync(sentinelDefault), 'the default mode holds the command at the dialog').toBe(true);
    await page.getByRole('button', { name: CANCEL_BUTTON }).click();
    await expect(page.getByText(replyDefault, { exact: true })).toBeVisible({ timeout: READY_TIMEOUT });
    expect(fs.existsSync(sentinelDefault), 'cancelling leaves the file where it was').toBe(true);
    expectCommandResult(taskRequests(mock).at(-1)!.body, commandDefault, '[用户取消了此操作]');
    await expect.poll(
      () => {
        const entry = indexEntry(dataRoot!, fresh);
        return entry !== null && !('permissionMode' in entry);
      },
      { message: 'a conversation on the global default carries no mode of its own', timeout: READY_TIMEOUT },
    ).toBe(true);
  });

  test('a persisted mode that cannot be accepted disappears silently and the default applies', async () => {
    test.setTimeout(300_000);
    const marker = `p2b-stale-${randomUUID().slice(0, 8)}`;
    const replies = [`p2b-stale-reply-0-${randomUUID()}`, `p2b-stale-reply-1-${randomUUID()}`];
    mock = await startOpenAiMock(replies.map((responseText) => ({ kind: 'complete' as const, responseText })));
    dataRoot = createElectronDataRoot();

    let page = await launch(dataRoot, true);
    await sendAndAwaitReply(page, marker, replies[0]);
    await expect.poll(
      () => indexEntry(dataRoot!, marker)?.messageCount ?? 0,
      { message: 'the conversation has a row in index.json before it is patched', timeout: READY_TIMEOUT },
    ).toBeGreaterThanOrEqual(2);
    await expect.poll(
      () => messagesOnDisk(dataRoot!, replies[0]),
      { message: 'the reply is on disk before the relaunch reads it back', timeout: READY_TIMEOUT },
    ).toBe(true);
    await closeAbuElectron(app!);
    app = undefined;

    rewriteIndexEntry(dataRoot, marker, { permissionMode: 'strict' });

    page = await launch(dataRoot, false);
    await openConversation(page, marker);
    await expect(permissionChip(page, MODE_STANDARD)).toBeVisible({ timeout: READY_TIMEOUT });
    await expect(page.getByText(replies[0], { exact: true })).toBeVisible({ timeout: READY_TIMEOUT });
    // Silently: no dialog, and no toast. ToastContainer
    // (src/components/common/ToastContainer.tsx) renders its fixed
    // `role="status"` region only while a toast is up, so an absent region is
    // the DOM's way of saying nothing was announced.
    await expect(page.getByRole('heading', { name: CONFIRM_DIALOG })).toHaveCount(0);
    await expect(page.locator('div.fixed[role="status"][aria-live="polite"]')).toHaveCount(0);

    // The conversation works as one that never had a mode of its own, and the
    // next index write leaves the refused value out of the file.
    await sendAndAwaitReply(page, `${marker}-next`, replies[1]);
    await expect(permissionChip(page, MODE_STANDARD)).toBeVisible();
    await expect.poll(
      () => {
        const entry = indexEntry(dataRoot!, marker);
        return entry !== null && (entry.messageCount ?? 0) >= 4 && !('permissionMode' in entry);
      },
      { message: 'the next index write drops the value this build cannot accept', timeout: READY_TIMEOUT },
    ).toBe(true);
  });
});
