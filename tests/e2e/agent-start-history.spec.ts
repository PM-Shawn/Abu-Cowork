/**
 * #549 P2a real-Electron proof that the conversation's history has left the
 * wire: across turns of equal length `agent.start` stays the same size while
 * the ledger grows, `agent.run` stays under 1 KB, and the model still receives
 * the whole history — read by the sidecar from the ledger. A second journey
 * launches with `ABU_AGENT_START_PROTOCOL=1` and sees `agent.start` grow turn
 * over turn, which proves both that the switch works and that the first
 * journey measures the right thing. The variable reaches the sidecar through
 * the launch itself: `launchAbuElectron` merges `extraEnv` last into the app's
 * environment (`buildLaunchEnv`), the main process spawns the sidecar with its
 * own environment (`mcpSpawn`, electron/mcpBridge.cjs), and the sidecar then
 * answers the handshake without the ledger-history capability.
 */
import { expect, test } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
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
  type OpenAiMock,
} from './openAiMock';
import { createSentRpcLog, readRuntimeEvents } from './runtimeEvents';

/**
 * 10,000 `长` = 30,000 UTF-8 bytes per turn. Five turns are 50,000 characters
 * of history, far enough below the mock model's context that no automatic
 * compaction replaces the early turns before the last request is inspected.
 */
const TURN_CHARS = 10_000;
const TURN_TEXT_BYTES = TURN_CHARS * 3;
const TURNS = 5;
/**
 * The first dispatch is the app's warm-up and is not part of the flatness
 * measurement: the tool registry finishes registering its deferred tools while
 * the first turn runs, so `toolList` — a run constant that has nothing to do
 * with the conversation — is about 29 KB larger from the second dispatch on
 * (measured on macOS, 2026-09-19, by lowering the `mcp_write` limit until each
 * dispatch reported its per-field breakdown: `fieldToolListBytes` 86,549 then
 * 115,958, with `fieldMessagesTextBytes` 0 on both). Every dispatch from here
 * on faces a conversation that grew by another turn, which is what flatness is
 * a claim about.
 */
const MEASURED_FROM_TURN = 1;
/**
 * How far two measured `agent.start` requests of equal-length turns may differ:
 * ids, timestamps, the title, the context-usage numbers a finished turn leaves
 * on the conversation, and the one prompt section that varies per turn.
 * Measured on macOS, 2026-09-19: 514 bytes across this journey's four measured
 * dispatches, and 514 bytes again over the twenty-turn acceptance run
 * (214,423 to 214,937). 4 KiB is eight times that and a small fraction of the
 * 30,000 bytes one turn of history would add, so a start that carried the
 * conversation is caught after a single turn and a leak of a few hundred bytes
 * per turn is caught within a few.
 */
const FLAT_MARGIN_BYTES = 4 * 1024;

let app: ElectronApplication | undefined;
let dataRoots: ElectronDataRoot[] = [];
let mock: OpenAiMock | undefined;

/** Bytes of the largest `messages.jsonl` under `rootDir` — the history on disk. */
function largestLedgerBytes(rootDir: string): number {
  let best = 0;
  const visit = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const entryPath = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(entryPath);
      else if (entry.name === 'messages.jsonl') {
        try {
          best = Math.max(best, fs.statSync(entryPath).size);
        } catch {
          // A file mid-write is re-read by the next call.
        }
      }
    }
  };
  visit(rootDir);
  return best;
}

async function sendTurn(page: Page, text: string, reply: string): Promise<void> {
  const input = page.getByPlaceholder(CHAT_PLACEHOLDER);
  await input.fill(text);
  await input.press('Enter');
  await expect(page.getByText(reply, { exact: true })).toBeVisible({ timeout: READY_TIMEOUT });
}

interface Journey {
  startBytes: number[];
  runBytes: number[];
  markers: string[];
  replies: string[];
  ledgerBytesAfterFirstTurn: number;
  ledgerBytesAtEnd: number;
  mock: OpenAiMock;
}

async function runJourney(extraEnv: Record<string, string>): Promise<Journey> {
  const replies = Array.from({ length: TURNS }, () => `abu-e2e-history-reply-${randomUUID()}`);
  const markers = Array.from({ length: TURNS }, () => `abu-e2e-history-turn-${randomUUID()}`);
  mock = await startOpenAiMock(replies.map((responseText) => ({ kind: 'complete' as const, responseText })));
  const dataRoot = createElectronDataRoot();
  dataRoots.push(dataRoot);
  const launch = await launchAbuElectron(dataRoot, { extraEnv });
  app = launch.app;
  const page = await app.firstWindow({ timeout: READY_TIMEOUT });
  await waitForApp(page);
  await configureLocalMockProvider(page, mock.baseUrl);

  const sent = createSentRpcLog();
  let ledgerBytesAfterFirstTurn = 0;
  for (let turn = 0; turn < TURNS; turn++) {
    await sendTurn(page, `${markers[turn]} ${'长'.repeat(TURN_CHARS)}`, replies[turn]);
    await expect.poll(async () => {
      sent.collect(await readRuntimeEvents(page));
      return { starts: sent.bytes('agent.start').length, runs: sent.bytes('agent.run').length };
    }, { timeout: READY_TIMEOUT }).toEqual({ starts: turn + 1, runs: turn + 1 });
    if (turn === 0) {
      await expect.poll(() => largestLedgerBytes(dataRoot.rootDir), { timeout: READY_TIMEOUT })
        .toBeGreaterThan(TURN_TEXT_BYTES);
      ledgerBytesAfterFirstTurn = largestLedgerBytes(dataRoot.rootDir);
    }
  }
  await expect.poll(() => largestLedgerBytes(dataRoot.rootDir), { timeout: READY_TIMEOUT })
    .toBeGreaterThan((TURNS - 1) * TURN_TEXT_BYTES);
  return {
    startBytes: sent.bytes('agent.start'),
    runBytes: sent.bytes('agent.run'),
    markers,
    replies,
    ledgerBytesAfterFirstTurn,
    ledgerBytesAtEnd: largestLedgerBytes(dataRoot.rootDir),
    mock,
  };
}

test.describe.serial('#549 P2a agent.start history — real Electron', () => {
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

  test('agent.start stays flat across long turns and agent.run stays under 1 KB', async () => {
    test.setTimeout(240_000);
    const journey = await runJourney({});

    expect(journey.startBytes).toHaveLength(TURNS);
    // The history on disk grew by a turn's text each round while the sizes below did not.
    expect(
      journey.ledgerBytesAtEnd - journey.ledgerBytesAfterFirstTurn,
      `the ledger went from ${journey.ledgerBytesAfterFirstTurn} to ${journey.ledgerBytesAtEnd} bytes;`
      + ' a journey whose history stops growing proves nothing about a flat agent.start',
    ).toBeGreaterThan((TURNS - 2) * TURN_TEXT_BYTES);

    const measured = journey.startBytes.slice(MEASURED_FROM_TURN);
    const spread = Math.max(...measured) - Math.min(...measured);
    expect(
      spread,
      `agent.start sizes ${journey.startBytes.join(', ')} (measuring from turn ${MEASURED_FROM_TURN + 1})`
      + ` differ by ${spread} bytes across equal turns while the conversation grew by`
      + ` ${journey.ledgerBytesAtEnd - journey.ledgerBytesAfterFirstTurn} bytes. Lower the mcp_write limit`
      + ' (ABU_E2E_MCP_WRITE_LIMIT_BYTES) until each dispatch reports its per-field breakdown and name the'
      + ' field that grew before touching FLAT_MARGIN_BYTES.',
    ).toBeLessThan(FLAT_MARGIN_BYTES);
    // Each start carries its own turn (as `userMessage` and as the route's clean input), nothing older.
    expect(
      Math.min(...journey.startBytes),
      `the smallest agent.start was ${Math.min(...journey.startBytes)} bytes, below the two copies of the`
      + ' turn it is expected to carry — the turn stopped reaching the sidecar',
    ).toBeGreaterThan(2 * TURN_TEXT_BYTES);
    expect(
      Math.max(...journey.startBytes),
      `the largest agent.start was ${Math.max(...journey.startBytes)} bytes, above the turn plus the run's`
      + ' constants — something conversation-sized is back on the wire',
    ).toBeLessThan(3 * TURN_TEXT_BYTES + 256 * 1024);
    for (const bytes of journey.runBytes) {
      expect(bytes, `agent.run sizes ${journey.runBytes.join(', ')}; the compact form is three ids`)
        .toBeLessThan(1024);
    }

    // The history reached the model all the same: the last request holds every turn and every earlier reply.
    const lastRequest = JSON.stringify(taskRequests(journey.mock).at(-1)?.body);
    for (const marker of journey.markers) expect(lastRequest).toContain(marker);
    for (const reply of journey.replies.slice(0, -1)) expect(lastRequest).toContain(reply);
  });

  test('ABU_AGENT_START_PROTOCOL=1 sends the form that carries the messages, and it grows', async () => {
    test.setTimeout(240_000);
    const journey = await runJourney({ ABU_AGENT_START_PROTOCOL: '1' });

    expect(journey.startBytes).toHaveLength(TURNS);
    for (let turn = 1; turn < TURNS; turn++) {
      const growth = journey.startBytes[turn] - journey.startBytes[turn - 1];
      // Every step has to clear the whole spread the ledger form is allowed, so
      // the two journeys can never be read as the same measurement.
      expect(
        growth,
        `agent.start sizes ${journey.startBytes.join(', ')}: turn ${turn + 1} grew by ${growth} bytes,`
        + ` within the spread the ledger form stays inside (${FLAT_MARGIN_BYTES}) — the switch no longer`
        + ' withholds the capability, so this journey is measuring the ledger form too',
      ).toBeGreaterThan(FLAT_MARGIN_BYTES);
    }
    // In this form agent.run repeats the start's params.
    journey.runBytes.forEach((bytes, turn) => {
      expect(
        Math.abs(bytes - journey.startBytes[turn]),
        `agent.run ${bytes} bytes against agent.start ${journey.startBytes[turn]} bytes on turn ${turn + 1}`,
      ).toBeLessThan(64);
    });
    const lastRequest = JSON.stringify(taskRequests(journey.mock).at(-1)?.body);
    for (const marker of journey.markers) expect(lastRequest).toContain(marker);
  });
});
