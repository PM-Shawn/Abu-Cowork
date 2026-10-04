/**
 * #549 real-Electron journey for the oversize conversation path.
 *
 * The 128 MiB production limit cannot be reached with a turn a test can type,
 * so the main process is launched with `ABU_E2E_MCP_WRITE_LIMIT_BYTES`, the
 * unpackaged-only hook that can lower (never raise) the `mcp_write` raw-body
 * limit. The limit is derived, not invented: a first launch with no override
 * runs an ordinary turn and reads the bytes that turn actually put on the
 * wire from the runtime trace, and the second launch is capped a fixed margin
 * above that measurement. So an ordinary turn still succeeds under the cap and
 * only the deliberately long turn trips `payload_too_large`.
 *
 * What the long turn must then look like on screen (controller ruling,
 * 2026-09-17): the failure line under the user's message reads
 * 「这段对话太长，无法继续。」 with a 「新建对话」 button, no 「重试」 button and
 * no toast; clicking 「新建对话」 opens a new conversation whose composer holds
 * the text that failed.
 */
import { expect, test } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import type { ElectronApplication } from 'playwright';
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
  type OpenAiMock,
} from './openAiMock';
import { readRuntimeEvents, sentPayloadBytes } from './runtimeEvents';

/** The ordinary turn both launches send, kept identical so the measurement transfers. */
const NORMAL_TURN_TEXT = 'short warm-up';

/**
 * The separator turn, built from code points so the source names the two
 * characters it sends instead of hiding them as invisible bytes in a literal:
 * U+2028 LINE SEPARATOR and U+2029 PARAGRAPH SEPARATOR.
 */
const LINE_SEPARATOR = String.fromCodePoint(0x2028);
const PARAGRAPH_SEPARATOR = String.fromCodePoint(0x2029);
const SEPARATOR_TURN_TEXT = `line${LINE_SEPARATOR}separator${PARAGRAPH_SEPARATOR}paragraph`;

/**
 * Headroom added to the measured normal turn before capping the second launch.
 * It absorbs the run-to-run differences between two launches of the same
 * profile (fresh ids, timestamps) and the smaller `state.*` notifications that
 * share the same `mcp_write` channel but are not measured by
 * `renderer.sidecar_rpc_sent`.
 */
const WRITE_LIMIT_MARGIN_BYTES = 256 * 1024;

/**
 * The long turn: 250,000 `长` = 750,000 UTF-8 bytes of message text, still
 * small enough to type, store and read back within the test budget. It was
 * sized against the measurement this spec was written on (macOS, 2026-09-18):
 * a normal first turn's largest RPC put 124,692 bytes on the wire, giving a
 * 386,836-byte limit, so the long turn cleared it about twice over. The
 * journey re-measures on every run and the check below keeps the long turn
 * above whatever the current measurement produces.
 */
const OVERSIZE_TURN_CHARS = 250_000;
const OVERSIZE_TURN_TEXT_BYTES = OVERSIZE_TURN_CHARS * 3;

let app: ElectronApplication | undefined;
let dataRoots: ElectronDataRoot[] = [];
let mock: OpenAiMock | undefined;

test.describe.serial('#549 IPC payload guardrails — real Electron', () => {
  test.afterEach(async () => {
    if (app) {
      await closeAbuElectron(app);
      app = undefined;
    }
    if (mock) {
      await mock.close();
      mock = undefined;
    }
    for (const dataRoot of dataRoots) removeElectronDataRoot(dataRoot);
    dataRoots = [];
  });

  test('an oversize turn fails visibly, offers a new conversation and keeps its text', async () => {
    test.setTimeout(180_000);

    // Step A — measure. One plain launch, no override: run an ordinary turn and
    // read back how many bytes it put on the wire.
    const warmupReply = `abu-e2e-baseline-${randomUUID()}`;
    mock = await startOpenAiMock([{ kind: 'complete', responseText: warmupReply }]);
    const baselineRoot = createElectronDataRoot();
    dataRoots.push(baselineRoot);
    const baselineLaunch = await launchAbuElectron(baselineRoot);
    app = baselineLaunch.app;
    const baselinePage = await app.firstWindow({ timeout: READY_TIMEOUT });
    await waitForApp(baselinePage);
    await configureLocalMockProvider(baselinePage, mock.baseUrl);
    const baselineInput = baselinePage.getByPlaceholder(CHAT_PLACEHOLDER);
    await baselineInput.fill(NORMAL_TURN_TEXT);
    await baselineInput.press('Enter');
    await expect(baselinePage.getByText(warmupReply, { exact: true }))
      .toBeVisible({ timeout: READY_TIMEOUT });

    await expect.poll(
      async () => sentPayloadBytes(await readRuntimeEvents(baselinePage), 'agent.start').length,
      { timeout: READY_TIMEOUT },
    ).toBeGreaterThan(0);
    const baselineEvents = await readRuntimeEvents(baselinePage);
    const agentStartBytes = Math.max(...sentPayloadBytes(baselineEvents, 'agent.start'));
    // The cap applies to every mcp_write, not just agent.start, so take the
    // largest RPC the normal turn sent as the number the limit has to clear.
    // `agent.start` is that RPC: it carries the turn plus the run's constants,
    // while `agent.run` carries three ids.
    const normalTurnBytes = Math.max(...sentPayloadBytes(baselineEvents));
    const writeLimitBytes = normalTurnBytes + WRITE_LIMIT_MARGIN_BYTES;
    // The long turn below has to clear the cap this run actually computed.
    expect(
      writeLimitBytes,
      `An ordinary first turn now sends ${normalTurnBytes} bytes (agent.start: ${agentStartBytes}),`
      + ` putting the derived cap at ${writeLimitBytes} — at or above the long turn's`
      + ` ${OVERSIZE_TURN_TEXT_BYTES} bytes, so it would no longer trip the limit.`
      + ' Raise OVERSIZE_TURN_CHARS above the new cap.',
    ).toBeLessThan(OVERSIZE_TURN_TEXT_BYTES);
    await closeAbuElectron(app);
    app = undefined;
    await mock.close();
    mock = undefined;

    // Step B — the journey, on a fresh profile so the ordinary turn below is
    // the same first turn that was just measured.
    const reply = `abu-e2e-ok-${randomUUID()}`;
    mock = await startOpenAiMock([{ kind: 'complete', responseText: reply }]);
    const journeyRoot = createElectronDataRoot();
    dataRoots.push(journeyRoot);
    const launch = await launchAbuElectron(journeyRoot, {
      extraEnv: { ABU_E2E_MCP_WRITE_LIMIT_BYTES: String(writeLimitBytes) },
    });
    app = launch.app;
    const page = await app.firstWindow({ timeout: READY_TIMEOUT });
    await waitForApp(page);
    await configureLocalMockProvider(page, mock.baseUrl);

    const input = page.getByPlaceholder(CHAT_PLACEHOLDER);
    await input.fill(NORMAL_TURN_TEXT);
    await input.press('Enter');
    await expect(page.getByText(reply, { exact: true })).toBeVisible({ timeout: READY_TIMEOUT });

    const oversizeTurnMarker = `abu-e2e-oversize-${randomUUID()}`;
    const oversizeTurn = `${oversizeTurnMarker} ${'长'.repeat(OVERSIZE_TURN_CHARS)}`;
    await input.fill(oversizeTurn);
    await input.press('Enter');

    // The failure line sits next to its button inside one flex row under the
    // user's message (MessageBubble.tsx), so the row is the text node's parent.
    const failedRow = page.getByText('这段对话太长，无法继续。').locator('..');
    await expect(failedRow).toBeVisible({ timeout: READY_TIMEOUT });
    await expect(failedRow.getByRole('button', { name: '新建对话' })).toBeVisible();
    await expect(failedRow.getByRole('button', { name: '重试' })).toHaveCount(0);
    // ToastContainer renders nothing while the toast store is empty; the only
    // other live-region status in the app is screen-reader-only.
    await expect(page.locator('[role="status"][aria-live="polite"]:not(.sr-only)')).toHaveCount(0);
    // The oversize turn never reached the model: only the ordinary turn did.
    expect(taskRequests(mock)).toHaveLength(1);

    const events = await readRuntimeEvents(page);
    const oversize = events.filter((event) => event.event === 'renderer.sidecar_rpc_payload_too_large');
    expect(oversize.length).toBeGreaterThan(0);
    for (const event of oversize) {
      expect(event.errorType).toBe('payload_too_large');
      expect(event.limitBytes).toBe(writeLimitBytes);
      expect(event.payloadBytes as number).toBeGreaterThan(writeLimitBytes);
      // Numbers only: the per-field breakdown reports the long turn's size and
      // never carries any of its text.
      const fields = Object.entries(event).filter(([key]) => key.startsWith('field'));
      expect(fields.length).toBeGreaterThan(0);
      for (const [, value] of fields) expect(typeof value).toBe('number');
      // The turn's text travels as the top-level `userMessage` and again as the
      // route's clean input, so both name the long turn's size; the history is
      // not on the wire at all, so the messages of the conversation snapshot
      // measure nothing.
      expect(
        event.fieldUserMessageBytes as number,
        `the oversize turn's text no longer reaches userMessage (${String(event.fieldUserMessageBytes)} bytes)`,
      ).toBeGreaterThanOrEqual(OVERSIZE_TURN_TEXT_BYTES);
      expect(
        event.fieldRouteBytes as number,
        `the oversize turn's text no longer reaches the route's clean input (${String(event.fieldRouteBytes)} bytes)`,
      ).toBeGreaterThanOrEqual(OVERSIZE_TURN_TEXT_BYTES);
      expect(
        event.fieldMessagesTextBytes as number,
        `the conversation snapshot carried ${String(event.fieldMessagesTextBytes)} bytes of message text;`
        + ' on the ledger form it carries none',
      ).toBe(0);
    }
    // Neither the filler nor the turn's unique opening words reach the trace.
    const serializedEvents = JSON.stringify(events);
    expect(serializedEvents).not.toContain('长长长长');
    expect(serializedEvents).not.toContain(oversizeTurnMarker);

    await failedRow.getByRole('button', { name: '新建对话' }).click();
    await expect.poll(async () => {
      const value = await page.getByPlaceholder(CHAT_PLACEHOLDER).inputValue();
      return { length: value.length, matchesFailedTurn: value === oversizeTurn };
    }, { timeout: READY_TIMEOUT }).toEqual({
      length: oversizeTurn.length,
      matchesFailedTurn: true,
    });
    // Carrying the turn into a new conversation raises no toast either.
    await expect(page.locator('[role="status"][aria-live="polite"]:not(.sr-only)')).toHaveCount(0);
  });

  test('a turn carrying U+2028 and U+2029 is answered', async () => {
    test.setTimeout(120_000);

    // `JSON.stringify` leaves U+2028 and U+2029 raw inside a string, so both
    // travel to the sidecar in the middle of the `agent.start` line. The
    // sidecar has to frame that line on the newline byte alone; any reader
    // that also ends a line on these two characters sees fragments instead of
    // the request and never answers it.
    const reply = `abu-e2e-separators-${randomUUID()}`;
    mock = await startOpenAiMock([{ kind: 'complete', responseText: reply }]);
    const dataRoot = createElectronDataRoot();
    dataRoots.push(dataRoot);
    const launch = await launchAbuElectron(dataRoot);
    app = launch.app;
    const page = await app.firstWindow({ timeout: READY_TIMEOUT });
    await waitForApp(page);
    await configureLocalMockProvider(page, mock.baseUrl);

    const input = page.getByPlaceholder(CHAT_PLACEHOLDER);
    await input.fill(SEPARATOR_TURN_TEXT);
    await input.press('Enter');

    await expect(page.getByText(reply, { exact: true })).toBeVisible({ timeout: READY_TIMEOUT });
  });
});
