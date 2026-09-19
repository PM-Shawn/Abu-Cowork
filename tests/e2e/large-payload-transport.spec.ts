/**
 * #549 real-Electron proof: a user turn whose text is larger than the old
 * 8 MiB plain-args IPC cap still reaches the sidecar (mcp_write raw body) and
 * lands in the conversation ledger (append_file_text raw body).
 *
 * The plain-args form refuses anything over 8 MiB with payload_too_large, so
 * sidecar-side acceptance of a >9 MiB agent.start line plus a >9 MiB ledger
 * line is only possible through the renderer's raw-body transport. `agent.run`
 * carries three ids and says nothing about transport size — the sidecar reads
 * the turn back from the ledger the renderer just wrote. The model endpoint is
 * a loopback mock; the turn itself then ends with the model-context error,
 * which is outside this transport check.
 */
import { expect, test } from '@playwright/test';
import { createServer, type Server, type ServerResponse } from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import type { ElectronApplication } from 'playwright';
import {
  closeAbuElectron,
  configureLocalMockProvider,
  createElectronDataRoot,
  launchAbuElectron,
  removeElectronDataRoot,
  type ElectronDataRoot,
} from './electronHelpers';
import { parseRuntimeEventLines, readRuntimeEventLines } from './runtimeEvents';

const READY_TIMEOUT = 45_000;
const CHAT_PLACEHOLDER = '想让阿布帮你做点什么？';
const MIB = 1024 * 1024;
const MARKER = 'abu-e2e-549-large-turn';
const REPLY = 'abu-e2e-549-large-reply-ok';
// 3.2 M CJK characters = 9.6 MiB of UTF-8, but only 3.2 M UTF-16 units.
const LARGE_TEXT = `${MARKER}-start ${'中'.repeat(3_200_000)} ${MARKER}-end`;

interface LargeMock {
  baseUrl: string;
  close: () => Promise<void>;
}

function sseChunk(delta: Record<string, unknown>, finishReason: string | null): string {
  return `data: ${JSON.stringify({
    id: 'chatcmpl-e2e-549',
    object: 'chat.completion.chunk',
    created: 0,
    model: 'abu-e2e-549-model',
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  })}\n\n`;
}

async function startLargeMock(): Promise<LargeMock> {
  const active = new Set<ServerResponse>();
  const server = createServer(async (req, res) => {
    active.add(res);
    res.once('close', () => active.delete(res));
    for await (const _chunk of req) {
      // Drain the request before replying.
    }
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (req.method !== 'POST' || url.pathname !== '/v1/chat/completions') {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end('{}');
      return;
    }
    res.writeHead(200, { 'cache-control': 'no-cache', 'content-type': 'text/event-stream; charset=utf-8' });
    res.end(sseChunk({ content: REPLY }, null) + sseChunk({}, 'stop') + 'data: [DONE]\n\n');
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('large-payload mock did not get a TCP port');
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    close: () => closeServer(server, active),
  };
}

function closeServer(server: Server, active: Set<ServerResponse>): Promise<void> {
  for (const res of active) res.destroy();
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
    server.closeAllConnections?.();
  });
}

/** Size of the largest messages.jsonl under `rootDir` that contains the end marker. */
function largestLedgerWithMarker(rootDir: string): number {
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
      if (entry.isDirectory()) {
        visit(entryPath);
      } else if (entry.name === 'messages.jsonl') {
        try {
          const content = fs.readFileSync(entryPath);
          if (content.includes(`${MARKER}-end`)) best = Math.max(best, content.byteLength);
        } catch {
          // A file mid-write is re-read by the next poll.
        }
      }
    }
  };
  visit(rootDir);
  return best;
}

let app: ElectronApplication | undefined;
let dataRoot: ElectronDataRoot | undefined;
let mock: LargeMock | undefined;

test.describe.serial('#549 large payload transport — real Electron', () => {
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

  test('a >9 MiB user turn reaches the sidecar and the ledger over the raw-body channel', async () => {
    test.setTimeout(180_000);
    mock = await startLargeMock();
    dataRoot = createElectronDataRoot();
    const launched = await launchAbuElectron(dataRoot);
    app = launched.app;
    const page = await app.firstWindow({ timeout: READY_TIMEOUT });
    await page.waitForLoadState('domcontentloaded');
    const input = page.getByPlaceholder(CHAT_PLACEHOLDER);
    await expect(input).toBeVisible({ timeout: READY_TIMEOUT });
    await configureLocalMockProvider(page, mock.baseUrl);

    await input.fill(LARGE_TEXT);
    await input.press('Enter');

    // The renderer appended the >9 MiB user line to the ledger (append_file_text raw body).
    await expect.poll(() => largestLedgerWithMarker(dataRoot!.rootDir), { timeout: 60_000 })
      .toBeGreaterThan(9 * MIB);

    // The sidecar parsed the >9 MiB agent.start line (mcp_write raw body) and
    // then ran from the ledger, which is why `agent.run` is a few hundred bytes
    // here. What the loop does next is model-side: a 3.2 M-character turn
    // exceeds the model context, which is the expected, visible outcome here —
    // the point is that it is NOT a transport failure.
    const readEvents = async (): Promise<Array<Record<string, unknown>>> => {
      const lines = await readRuntimeEventLines(page);
      expect(lines.join('\n')).not.toContain('中中中中');
      return parseRuntimeEventLines(lines) as Array<Record<string, unknown>>;
    };
    const bigWrite = (events: Array<Record<string, unknown>>, method: string) => events.find((event) =>
      event.event === 'main.rpc_write_completed'
      && event.method === method
      && typeof event.payloadBytes === 'number'
      && event.payloadBytes > 9 * MIB);
    const runWrite = (events: Array<Record<string, unknown>>) => events.find((event) =>
      event.event === 'main.rpc_write_completed'
      && event.method === 'agent.run'
      && typeof event.payloadBytes === 'number');
    await expect.poll(async () => {
      const events = await readEvents();
      return {
        startWritten: Boolean(bigWrite(events, 'agent.start')),
        runWritten: Boolean(runWrite(events)),
        startAccepted: events.some((event) => event.event === 'sidecar.agent_start_accepted'),
        runParsed: events.some((event) => event.event === 'sidecar.agent_run_received'),
      };
    }, { timeout: 60_000 }).toEqual({ startWritten: true, runWritten: true, startAccepted: true, runParsed: true });

    const events = await readEvents();
    const rendererSent = events.filter((event) => event.event === 'renderer.sidecar_rpc_sent'
      && (event.method === 'agent.start' || event.method === 'agent.run'));
    expect(rendererSent.length).toBeGreaterThanOrEqual(2);
    for (const event of rendererSent) {
      expect(event).toMatchObject({ outcome: 'success' });
      if (event.method === 'agent.start') {
        expect(
          event.payloadBytes as number,
          `agent.start put ${String(event.payloadBytes)} bytes on the wire; the raw-body channel is only`
          + ' proven by a line above the 8 MiB plain-args cap',
        ).toBeGreaterThan(9 * MIB);
      } else {
        expect(
          event.payloadBytes as number,
          `agent.run put ${String(event.payloadBytes)} bytes on the wire; the compact form is three ids`,
        ).toBeLessThan(1024);
      }
    }
    expect(events.some((event) => String(event.event).includes('payload_too_large'))).toBe(false);
    expect(events.some((event) => event.errorType === 'payload_too_large')).toBe(false);
  });
});
