/**
 * Real-Electron acceptance: what the chat page shows for a conversation whose record on disk is
 * whole, has a damaged line, is empty, is missing, or cannot be read at all (F13).
 *
 * "Cannot be read" is a record that exists and whose read fails as a whole. It is produced the
 * same way on every platform: a directory stands where `messages.jsonl` was. A damaged line is
 * skipped and a missing record is an empty conversation, as before. On POSIX a second case keeps
 * the record a file and takes its read permission away, which is the case that can show a write.
 *
 * Deterministic: a loopback mock provider answers each prompt with a fixed reply.
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
  pressWhenSettled,
  removeElectronDataRoot,
  type ElectronDataRoot,
  type LaunchedApp,
} from './electronHelpers';

const READY_TIMEOUT = 45_000;
const PROMPT = 'E2E记录读取任务';
const REPLY = 'E2E记录读取答复';
const OTHER_PROMPT = 'E2E另一个任务';
const OTHER_REPLY = 'E2E另一个答复';
const WELCOME_TITLE = '交给阿布就行啦';
const UNREADABLE = '无法读取这个任务的记录';
const DELETE_QUESTION = '删除这个任务？';
const DELETE_WARNING = `「${PROMPT}」的记录目前读不出来，删除后无法恢复。`;

type MockMessage = { role: string; content?: string | Array<{ text?: string }> | null };

function textOf(message: MockMessage): string {
  if (typeof message.content === 'string') return message.content;
  return message.content?.map((block) => block.text ?? '').join('\n') ?? '';
}

function chunk(delta: Record<string, unknown>, finish: string | null): string {
  return `data: ${JSON.stringify({ id: 'load-error', object: 'chat.completion.chunk', created: 0, model: 'mock', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
}

async function startMock() {
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const part of req) raw += part;
    const body = JSON.parse(raw || '{}') as { messages?: MockMessage[] };
    const lastUser = (body.messages ?? []).filter((m) => m.role === 'user').at(-1);
    const reply = lastUser && textOf(lastUser).includes(OTHER_PROMPT) ? OTHER_REPLY : REPLY;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(chunk({ role: 'assistant', content: reply }, null));
    res.write(chunk({}, 'stop'));
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

/** The record of the conversation that holds `text`. */
function ledgerHolding(rootDir: string, text: string): string {
  const found = findLedgers(rootDir).filter((ledger) => fs.readFileSync(ledger, 'utf8').includes(text));
  if (found.length !== 1) throw new Error(`Expected one record holding the prompt, found ${found.length}`);
  return found[0];
}

/**
 * True once the turn that began with `prompt` is whole on disk: its reply is in the record and
 * the last revision of its user row says the run completed. A record read back before that
 * shows the turn as a failed send.
 */
function turnSettledOnDisk(rootDir: string, prompt: string, reply: string): boolean {
  return findLedgers(rootDir).some((ledger) => {
    const text = fs.readFileSync(ledger, 'utf8');
    if (!text.includes(reply)) return false;
    const userRows = text.split('\n').flatMap((line) => {
      try {
        const row = JSON.parse(line) as { role?: string; content?: unknown; runState?: string };
        return row.role === 'user' && JSON.stringify(row.content ?? '').includes(prompt) ? [row] : [];
      } catch {
        return [];
      }
    });
    return userRows.at(-1)?.runState === 'completed';
  });
}

async function showSidebar(page: Page) {
  const toggle = page.getByRole('button', { name: '显示侧栏', exact: true });
  if (await toggle.isVisible()) await toggle.click();
}

async function ask(page: Page, prompt: string, reply: string) {
  const composer = page.getByRole('textbox').first();
  await composer.fill(prompt);
  await composer.press('Enter');
  await expect(page.getByText(reply)).toBeVisible({ timeout: 60_000 });
}

/** Two finished conversations on disk, the app closed. Answers the record of the first. */
async function seedTwoConversations(dataRoot: ElectronDataRoot, baseUrl: string): Promise<string> {
  const launched = await launchAbuElectron(dataRoot);
  try {
    const page = await launched.app.firstWindow();
    await page.waitForLoadState('domcontentloaded');
    await expect(page.locator('[data-chat-composer]').first()).toBeVisible({ timeout: READY_TIMEOUT });
    await dismissFirstRunOverlays(page);
    await configureLocalMockProvider(page, baseUrl);
    await ask(page, PROMPT, REPLY);
    await showSidebar(page);
    await page.getByLabel('Main navigation').getByRole('button', { name: '新任务', exact: true }).click();
    await expect(page.getByText(REPLY)).toHaveCount(0);
    await ask(page, OTHER_PROMPT, OTHER_REPLY);
    // The reply is on the page before the end of the turn is on disk.
    await expect.poll(() => turnSettledOnDisk(dataRoot.rootDir, PROMPT, REPLY), { timeout: 30_000 }).toBe(true);
    await expect.poll(() => turnSettledOnDisk(dataRoot.rootDir, OTHER_PROMPT, OTHER_REPLY), { timeout: 30_000 }).toBe(true);
  } finally {
    await closeAbuElectron(launched.app);
  }
  return ledgerHolding(dataRoot.rootDir, PROMPT);
}

async function reopen(dataRoot: ElectronDataRoot): Promise<{ launched: LaunchedApp; page: Page }> {
  const launched = await launchAbuElectron(dataRoot);
  const page = await launched.app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  await expect(page.getByRole('textbox').first()).toBeVisible({ timeout: READY_TIMEOUT });
  await showSidebar(page);
  return { launched, page };
}

/** The page forgets every conversation it had read; the next opening reads the record again. */
async function reloadPage(page: Page) {
  await Promise.all([page.waitForEvent('load'), page.evaluate(() => { window.location.reload(); })]);
  await expect(page.getByRole('textbox').first()).toBeVisible({ timeout: READY_TIMEOUT });
  await showSidebar(page);
}

const row = (page: Page, prompt: string) => page.getByText(prompt).first();

test('a record that is whole, has a damaged line, is empty or is missing opens as it did before', async () => {
  test.setTimeout(240_000);
  const dataRoot = createElectronDataRoot();
  const mock = await startMock();
  let launched: LaunchedApp | undefined;
  try {
    const ledger = await seedTwoConversations(dataRoot, mock.baseUrl);
    const whole = fs.readFileSync(ledger, 'utf8');
    const opened = await reopen(dataRoot);
    launched = opened.launched;
    const page = opened.page;

    // Whole.
    await row(page, PROMPT).click();
    await expect(page.getByText(REPLY)).toBeVisible();
    await expect(page.getByRole('alert')).toHaveCount(0);

    // One damaged line among the others: it is skipped, the rest is shown.
    const lines = whole.split('\n');
    fs.writeFileSync(ledger, [lines[0], '{"id":"e2e-damaged","role":"assis', ...lines.slice(1)].join('\n'));
    await reloadPage(page);
    await row(page, PROMPT).click();
    await expect(page.getByText(REPLY)).toBeVisible();
    await expect(page.getByRole('alert')).toHaveCount(0);

    // Empty: an empty conversation.
    fs.writeFileSync(ledger, '');
    await reloadPage(page);
    await row(page, PROMPT).click();
    await expect(page.getByText(WELCOME_TITLE)).toBeVisible();
    await expect(page.getByText(REPLY)).toHaveCount(0);
    await expect(page.getByRole('alert')).toHaveCount(0);

    // Missing: an empty conversation.
    fs.rmSync(ledger);
    await reloadPage(page);
    await row(page, PROMPT).click();
    await expect(page.getByText(WELCOME_TITLE)).toBeVisible();
    await expect(page.getByText(REPLY)).toHaveCount(0);
    await expect(page.getByRole('alert')).toHaveCount(0);
  } finally {
    if (launched) await closeAbuElectron(launched.app);
    await mock.close();
    removeElectronDataRoot(dataRoot);
  }
});

test('a record that cannot be read says so with 重试, keeps the rest of the app usable, and opens once it can be read', async () => {
  test.setTimeout(240_000);
  const dataRoot = createElectronDataRoot();
  const mock = await startMock();
  let launched: LaunchedApp | undefined;
  try {
    const ledger = await seedTwoConversations(dataRoot, mock.baseUrl);
    const whole = fs.readFileSync(ledger);
    // A directory where the record was: it exists and reading it fails, on every platform.
    fs.rmSync(ledger);
    fs.mkdirSync(ledger);

    const opened = await reopen(dataRoot);
    launched = opened.launched;
    const page = opened.page;

    await row(page, PROMPT).click();
    const alert = page.getByRole('alert');
    const retry = alert.getByRole('button', { name: '重试', exact: true });
    await expect(alert).toBeVisible();
    await expect(alert).toContainText(UNREADABLE);
    await expect(retry).toBeVisible();
    await expect(page.getByText(WELCOME_TITLE)).toHaveCount(0);
    await page.screenshot({ path: test.info().outputPath('load-error.png') });

    // Nothing of the host's own error reaches the page: no path, no file name, no error code.
    const markup = await page.evaluate(() => document.documentElement.outerHTML);
    expect(markup).not.toContain(dataRoot.rootDir);
    expect(markup).not.toContain('messages.jsonl');
    expect(markup).not.toContain('EISDIR');
    expect(await alert.textContent()).toBe(`${UNREADABLE}重试`);
    const namedAttributes = await alert.evaluate((node) => [node, ...node.querySelectorAll('*')].flatMap((element) =>
      [...element.attributes]
        .filter((attribute) => attribute.name === 'title' || attribute.name === 'aria-label' || attribute.name.startsWith('data-'))
        .map((attribute) => `${attribute.name}=${attribute.value}`)));
    expect(namedAttributes).toEqual([]);

    // The rest of the app is usable: a new task, another conversation, and back.
    await page.getByLabel('Main navigation').getByRole('button', { name: '新任务', exact: true }).click();
    await expect(alert).toHaveCount(0);
    await expect(page.getByText(WELCOME_TITLE)).toBeVisible();
    await row(page, OTHER_PROMPT).click();
    await expect(page.getByText(OTHER_REPLY)).toBeVisible();
    await expect(alert).toHaveCount(0);
    await row(page, PROMPT).click();
    await expect(alert).toBeVisible();
    await expect(page.getByText(OTHER_REPLY)).toHaveCount(0);

    // 重试 while the record still cannot be read: the explanation stays and the button can be pressed again.
    await retry.click();
    await expect(retry).not.toHaveAttribute('aria-disabled', 'true');
    await expect(alert).toContainText(UNREADABLE);
    // Nothing was written where the record is.
    expect(fs.statSync(ledger).isDirectory()).toBe(true);
    expect(fs.readdirSync(ledger)).toEqual([]);

    // The record can be read again: 重试 shows the conversation, and the message field has the focus.
    fs.rmdirSync(ledger);
    fs.writeFileSync(ledger, whole);
    await retry.click();
    await expect(page.getByText(REPLY)).toBeVisible();
    await expect(alert).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => document.activeElement?.hasAttribute('data-chat-composer') ?? false)).toBe(true);

    await closeAbuElectron(launched.app);
    launched = undefined;
    // The record is byte for byte what it was before it could not be read.
    expect(fs.readFileSync(ledger).equals(whole)).toBe(true);
  } finally {
    if (launched) await closeAbuElectron(launched.app);
    await mock.close();
    removeElectronDataRoot(dataRoot);
  }
});

/** Every file and folder under `dir`, with each file's bytes: what a cancelled delete must leave as it is. */
function snapshot(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) return [`${entryPath}/`, ...snapshot(entryPath)];
    return [`${entryPath} ${fs.readFileSync(entryPath).toString('base64')}`];
  });
}

// Nothing an undo could bring back: the delete of such a task asks first, by name.
test('deleting a task whose record cannot be read asks first: 取消 keeps the record as it is, a held Enter answers nothing, 删除 removes it', async () => {
  test.setTimeout(240_000);
  const dataRoot = createElectronDataRoot();
  const mock = await startMock();
  let launched: LaunchedApp | undefined;
  try {
    const ledger = await seedTwoConversations(dataRoot, mock.baseUrl);
    const recordDir = path.dirname(ledger);
    fs.rmSync(ledger);
    fs.mkdirSync(ledger);
    const before = snapshot(recordDir);

    const opened = await reopen(dataRoot);
    launched = opened.launched;
    const page = opened.page;
    const taskRow = page.locator('[data-conversation-row]').filter({ hasText: PROMPT });
    const more = taskRow.getByRole('button', { name: '更多操作', exact: true });
    const question = page.getByRole('alertdialog', { name: DELETE_QUESTION });
    const cancel = question.getByRole('button', { name: '取消', exact: true });
    const notices = page.getByRole('region', { name: '通知' });

    // By pointer, never opened: the delete reads the record, cannot, and asks.
    await taskRow.hover();
    await more.click();
    await page.getByRole('menuitem', { name: '删除会话', exact: true }).click();
    await expect(question).toBeVisible();
    await expect(question).toContainText(DELETE_WARNING);
    await expect(cancel).toBeFocused();
    await expect(question.getByRole('button')).toHaveText(['取消', '删除']);
    await page.screenshot({ path: test.info().outputPath('delete-question.png') });
    expect(snapshot(recordDir)).toEqual(before);

    await pressWhenSettled(cancel);
    await expect(question).toHaveCount(0);
    await expect(taskRow).toHaveCount(1);
    await expect(more).toBeFocused();
    expect(snapshot(recordDir)).toEqual(before);
    await expect(notices.getByText('会话已删除')).toHaveCount(0);

    // From the keyboard, with the Enter that chooses 删除会话 held down: the question waits.
    await page.keyboard.press('Enter');
    await expect(page.getByRole('menu')).toBeVisible();
    await page.keyboard.press('End');
    await expect(page.getByRole('menuitem', { name: '删除会话', exact: true })).toBeFocused();
    await page.keyboard.down('Enter');
    try {
      await expect(question).toBeVisible();
      for (let i = 0; i < 30; i += 1) {
        await page.keyboard.down('Enter');
        await page.waitForTimeout(30);
      }
      await expect(question).toBeVisible();
      await expect(cancel).toBeFocused();
    } finally {
      await page.keyboard.up('Enter');
    }
    await expect(question).toBeVisible();
    await expect(taskRow).toHaveCount(1);
    expect(snapshot(recordDir)).toEqual(before);

    // 删除: the row leaves, the record is removed, no undo is offered, and the focus is on a row.
    await pressWhenSettled(question.getByRole('button', { name: '删除', exact: true }));
    await expect(question).toHaveCount(0);
    await expect(taskRow).toHaveCount(0);
    await expect.poll(() => fs.existsSync(recordDir), { timeout: 30_000 }).toBe(false);
    await expect(notices.getByText('会话已删除')).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => {
      const active = document.activeElement;
      return active?.hasAttribute('data-conversation-row') || active?.getAttribute('data-sidebar-action') === 'new-task';
    })).toBe(true);
    // The other task is untouched and opens.
    await row(page, OTHER_PROMPT).click();
    await expect(page.getByText(OTHER_REPLY)).toBeVisible();
  } finally {
    if (launched) await closeAbuElectron(launched.app);
    await mock.close();
    removeElectronDataRoot(dataRoot);
  }
});

// The directory above cannot show a write that slips through: a write onto a directory fails at
// the system and leaves no trace. Here the record stays a file that refuses to be read (mode 000),
// in a folder that takes writes, so a replaced or appended record would differ in bytes, in size
// or in its file identity.
test('a record that refuses to be read (a permission error, POSIX file modes) stays byte for byte the same through the error, a retry and the reopening', async () => {
  test.skip(process.platform === 'win32', 'Windows has no POSIX file modes: chmod 000 does not make a file unreadable there');
  test.skip(process.getuid?.() === 0, 'the superuser reads a file of mode 000');
  test.setTimeout(240_000);
  const dataRoot = createElectronDataRoot();
  const mock = await startMock();
  let launched: LaunchedApp | undefined;
  let ledger: string | undefined;
  let mode = 0o644;
  try {
    ledger = await seedTwoConversations(dataRoot, mock.baseUrl);
    const whole = fs.readFileSync(ledger);
    const before = fs.statSync(ledger);
    mode = before.mode & 0o777;
    fs.chmodSync(ledger, 0o000);
    expect(() => fs.readFileSync(ledger!)).toThrow(/EACCES/);

    const opened = await reopen(dataRoot);
    launched = opened.launched;
    const page = opened.page;

    await row(page, PROMPT).click();
    const alert = page.getByRole('alert');
    const retry = alert.getByRole('button', { name: '重试', exact: true });
    await expect(alert).toBeVisible();
    expect(await alert.textContent()).toBe(`${UNREADABLE}重试`);
    const markup = await page.evaluate(() => document.documentElement.outerHTML);
    expect(markup).not.toContain(dataRoot.rootDir);
    expect(markup).not.toContain('messages.jsonl');
    expect(markup).not.toContain('EACCES');
    // A message cannot be added: the page of this conversation offers no message field.
    await expect(page.locator('[data-chat-composer]')).toHaveCount(0);

    // 重试 while the record still refuses: the explanation stays, and the file is the same file.
    await retry.click();
    await expect(retry).not.toHaveAttribute('aria-disabled', 'true');
    await expect(alert).toContainText(UNREADABLE);
    const during = fs.statSync(ledger);
    expect(during.ino).toBe(before.ino);
    expect(during.size).toBe(before.size);
    expect(during.mtimeMs).toBe(before.mtimeMs);

    // Readable again: the bytes are what they were, and 重试 shows the conversation.
    fs.chmodSync(ledger, mode);
    expect(fs.readFileSync(ledger).equals(whole)).toBe(true);
    await retry.click();
    await expect(page.getByText(REPLY)).toBeVisible();
    await expect(alert).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => document.activeElement?.hasAttribute('data-chat-composer') ?? false)).toBe(true);

    await closeAbuElectron(launched.app);
    launched = undefined;
    expect(fs.readFileSync(ledger).equals(whole)).toBe(true);
  } finally {
    // A failed run leaves nothing unreadable behind.
    if (ledger && fs.existsSync(ledger)) fs.chmodSync(ledger, mode);
    if (launched) await closeAbuElectron(launched.app);
    await mock.close();
    removeElectronDataRoot(dataRoot);
  }
});
