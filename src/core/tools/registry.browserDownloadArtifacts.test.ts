/**
 * What a run PRODUCED, from the tool call to the sentence a person reads
 * (batch-三 T6 · R-1).
 *
 * The gap this closes: `download`已经把文件落到磁盘并把路径写进工具结果，但
 * 结局对象和 IM 摘要里没有「产物」这回事。一个凌晨跑完的导出任务给用户的是
 * 一张绿卡片和一句「已完成」，没有任何一处告诉他文件在哪 —— 他得回去翻聊天
 * 记录里的工具输出。
 *
 * So this walks the whole chain in one test, from the shipped executor:
 *
 *   `executeAnyTool('abu-browser__download')`   ← the real tool gate
 *      → `download_saved` browser signal
 *      → `buildBrowserRunReport` snapshot       ← what the card renders
 *      → `deriveUnattendedRunOutcome`           ← what IM sends
 *      → `formatUnattendedOutcomeSummary`       ← the sentence
 *
 * Pinning it end to end rather than per layer is the point: every one of those
 * hops was individually plausible while the chain as a whole did nothing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { executeAnyTool } from './registry';
import { mcpManager } from '../mcp/client';
import { getI18n } from '../../i18n';
import { useChatStore } from '../../stores/chatStore';
import { useSettingsStore } from '../../stores/settingsStore';
import {
  clearBrowserSignals,
  getBrowserSignalCursor,
  getRecentBrowserSignals,
} from '../observability/browserSignals';
import {
  buildBrowserDownloadsReport,
  buildBrowserRunReport,
} from '../observability/browserRunReport';
import {
  deriveUnattendedRunOutcome,
  formatUnattendedOutcomeSummary,
} from '../observability/unattendedRunOutcome';
import {
  DEFAULT_BROWSER_OPERATION_POLICY,
  __resetBrowserGrantsForTests,
} from '../permissions/browserToolPolicy';
import { testSiteVerdicts } from '../../test/browserSiteVerdicts';

vi.mock('@/core/enterprise/policy/enforcer', () => ({
  getCurrentPolicy: () => ({ mode: 'test-policy' }),
}));
vi.mock('@/core/enterprise/policy/matcher', () => ({
  checkTool: () => ({ decision: 'allow' as const }),
}));

const SITE = 'https://oa.example.com';
const OWNER = 'download-owner';
const TAB = 88;

let mockCallTool: ReturnType<typeof vi.fn>;

/** `get_tabs` answers with the owned tab; `download` answers with a result. */
function serveDownload(result: unknown) {
  mockCallTool.mockImplementation((params: { name: string; _meta?: Record<string, unknown> }) => {
    if (params.name === 'get_tabs') {
      return Promise.resolve({
        content: [{
          type: 'text',
          text: JSON.stringify(
            params._meta?.['abu/conversationId'] === OWNER
              ? { windows: [{ windowId: 1, tabs: [{ tabId: TAB, url: `${SITE}/reports` }] }] }
              : { windows: [] },
          ),
        }],
      });
    }
    return Promise.resolve({ content: [{ type: 'text', text: JSON.stringify(result) }] });
  });
}

const COMPLETED = {
  started: true,
  complete: true,
  download: {
    downloadId: 'dl_abc',
    filename: '排班表.xlsx',
    url: `${SITE}/export.xlsx`,
    state: 'completed',
    time: 1_757_000_000_000,
    path: '/Users/me/Library/Application Support/abu/browser-downloads/conv/main/排班表.xlsx',
    size: 1_258_291,
    mime: 'application/vnd.ms-excel',
  },
  message: 'Saved to …. The file is complete.',
};

/** Run one `download` through the shipped executor and report on the run. */
async function runOneDownload(result: unknown = COMPLETED) {
  const since = getBrowserSignalCursor();
  serveDownload(result);
  await executeAnyTool(
    'abu-browser__download',
    { tabId: TAB, action: 'click', locator: '{"css":"a#export"}' },
    (async () => true) as never,
    undefined,
    { conversationId: OWNER, interactionMode: 'background' } as never,
  );
  const report = buildBrowserRunReport({
    signals: getRecentBrowserSignals(),
    conversationId: OWNER,
    sinceSeq: since,
    outcome: 'completed',
  });
  const outcome = deriveUnattendedRunOutcome({
    reason: 'completed', abortedByBrowserDenials: false, report,
  });
  return { report, outcome };
}

describe('a download this run produced reaches the card and the IM summary', () => {
  beforeEach(() => {
    clearBrowserSignals();
    mockCallTool = vi.fn();
    serveDownload(COMPLETED);
    (mcpManager as unknown as { servers: Map<string, unknown> }).servers.set('abu-browser', {
      config: { name: 'abu-browser' },
      client: { callTool: mockCallTool },
      transport: {},
      appTools: new Map(),
      tools: new Map(),
    });
    useChatStore.setState({ conversations: {}, conversationIndex: {}, activeConversationId: null });
    useSettingsStore.setState({
      permissionMode: 'standard',
      browserSitePermissions: testSiteVerdicts({ [SITE]: 'allowed' }),
      browserOperationPolicy: DEFAULT_BROWSER_OPERATION_POLICY,
      allowUnattendedBrowser: true,
      browserSiteGrantViaEmbed: {},
    });
    __resetBrowserGrantsForTests();
  });

  afterEach(() => {
    (mcpManager as unknown as { servers: Map<string, unknown> }).servers.delete('abu-browser');
    __resetBrowserGrantsForTests();
    clearBrowserSignals();
  });

  it('files the finished download on the run report as an artifact', async () => {
    const { report } = await runOneDownload();

    expect(report?.artifacts).toEqual([{
      downloadId: 'dl_abc',
      name: '排班表.xlsx',
      path: COMPLETED.download.path,
      bytes: 1_258_291,
      mime: 'application/vnd.ms-excel',
    }]);
    expect(report?.omitted.artifacts).toBe(0);
  });

  it('carries it onto the outcome object both surfaces read', async () => {
    const { outcome } = await runOneDownload();

    expect(outcome.code).toBe('succeeded');
    expect(outcome.artifacts.map((a) => a.name)).toEqual(['排班表.xlsx']);
  });

  /**
   * The sentence. Name, size and where it is — and NOT the file itself: IM
   * carries a pointer, never the bytes.
   */
  it('names the file, its size and its path in the message IM sends', async () => {
    const { outcome } = await runOneDownload();
    const summary = formatUnattendedOutcomeSummary(outcome, getI18n());

    expect(summary).toContain('排班表.xlsx');
    expect(summary).toContain('1.2 MB');
    expect(summary).toContain(COMPLETED.download.path);
  });

  /**
   * A path to a file that is not finished is worse than no path: the user
   * opens it and gets half a spreadsheet.
   */
  it('says nothing about a download that has not finished', async () => {
    const { report, outcome } = await runOneDownload({
      started: true,
      complete: false,
      download: { ...COMPLETED.download, state: 'progressing' },
      message: 'Still downloading.',
    });

    expect(report?.artifacts).toEqual([]);
    expect(outcome.artifacts).toEqual([]);
    expect(formatUnattendedOutcomeSummary(outcome, getI18n())).not.toContain('排班表.xlsx');
  });

  it('says nothing about a click that produced no download at all', async () => {
    const { report } = await runOneDownload({
      started: false,
      message: 'That click produced no download.',
    });

    expect(report?.artifacts).toEqual([]);
  });

  /**
   * A big export is reported twice — once by the click that started it, once
   * by the `wait` that saw it finish — and the user downloaded one file.
   */
  /**
   * N3 (round-2 review). The path used to be run through the card's
   * untrusted-text clamp, which collapses `\s+` to a single space — so the
   * `a  b.pdf` that the host's own sanitizer deliberately keeps arrived as
   * `a b.pdf`, and 「点开」/「在文件夹中显示」 addressed a file that is not
   * there. The path is composed by the host under Abu's own download root; it
   * is not page text and must travel byte for byte.
   */
  it('carries a path with a double space in it exactly as it is on disk', async () => {
    const onDisk = '/Users/me/Library/Application Support/abu/browser-downloads/conv/main/a  b.pdf';
    const { report, outcome } = await runOneDownload({
      ...COMPLETED,
      download: { ...COMPLETED.download, filename: 'a  b.pdf', path: onDisk },
    });

    expect(report?.artifacts?.[0]?.path).toBe(onDisk);
    expect(outcome.artifacts[0]?.path).toBe(onDisk);
    expect(formatUnattendedOutcomeSummary(outcome, getI18n())).toContain(onDisk);
  });

  /**
   * The other half of N3: a path we cannot carry intact is reported as
   * omitted, never truncated. A 240-character cap plus an ellipsis produced a
   * path that opens nothing, and the failure was silent.
   */
  it('omits a file whose path is too long to carry, rather than listing a truncated one', async () => {
    const tooLong = `/Users/me/Library/Application Support/abu/browser-downloads/${'x'.repeat(300)}.xlsx`;
    const { report, outcome } = await runOneDownload({
      ...COMPLETED,
      download: { ...COMPLETED.download, path: tooLong },
    });

    expect(report?.artifacts).toEqual([]);
    expect(report?.omitted.artifacts).toBe(1);
    expect(outcome.artifacts).toEqual([]);
    // Nothing that LOOKS like the path may reach the reader either.
    expect(formatUnattendedOutcomeSummary(outcome, getI18n())).not.toContain('…');
  });

  it('counts one file once, however many calls reported it', async () => {
    const since = getBrowserSignalCursor();
    serveDownload(COMPLETED);
    for (const action of ['click', 'wait']) {
      await executeAnyTool(
        'abu-browser__download',
        { tabId: TAB, action, ...(action === 'click' ? { locator: '{"css":"a#export"}' } : { downloadId: 'dl_abc' }) },
        (async () => true) as never,
        undefined,
        { conversationId: OWNER, interactionMode: 'background' } as never,
      );
    }
    const report = buildBrowserRunReport({
      signals: getRecentBrowserSignals(), conversationId: OWNER, sinceSeq: since, outcome: 'completed',
    });

    expect(report?.artifacts).toHaveLength(1);
  });
});

/**
 * The ORDINARY-conversation half of the same chain (acceptance F3).
 *
 * The report card above only ever existed for runs nobody watched — the
 * scheduler, a trigger, the file watcher. A person who typed 「导出月度报表」
 * into the chat window got the file onto disk and then nothing: no row, no
 * 「打开」, no 「在文件夹中显示」. The real model in acceptance went and
 * `read_file`'d the file back just to have something clickable to show.
 *
 * So the same signals feed a second, downloads-only form of the snapshot, and
 * this pins it from the same real tool gate: `executeAnyTool('…download')` in
 * an attended run → `buildBrowserDownloadsReport` → the rows the card renders.
 * What it must NOT carry matters as much as what it does: an attended card
 * that quietly persisted a site list or an approval tally would be an
 * unattended run report wearing a different renderer.
 */
describe('a download in an ordinary conversation becomes the downloads-only card', () => {
  beforeEach(() => {
    clearBrowserSignals();
    mockCallTool = vi.fn();
    serveDownload(COMPLETED);
    (mcpManager as unknown as { servers: Map<string, unknown> }).servers.set('abu-browser', {
      config: { name: 'abu-browser' },
      client: { callTool: mockCallTool },
      transport: {},
      appTools: new Map(),
      tools: new Map(),
    });
    useChatStore.setState({ conversations: {}, conversationIndex: {}, activeConversationId: null });
    useSettingsStore.setState({
      permissionMode: 'standard',
      browserSitePermissions: testSiteVerdicts({ [SITE]: 'allowed' }),
      browserOperationPolicy: DEFAULT_BROWSER_OPERATION_POLICY,
      allowUnattendedBrowser: true,
      browserSiteGrantViaEmbed: {},
    });
    __resetBrowserGrantsForTests();
  });

  afterEach(() => {
    (mcpManager as unknown as { servers: Map<string, unknown> }).servers.delete('abu-browser');
    __resetBrowserGrantsForTests();
    clearBrowserSignals();
  });

  /** One attended `download` through the shipped executor, then the chat card. */
  async function runAttendedDownload(result: unknown = COMPLETED) {
    const since = getBrowserSignalCursor();
    serveDownload(result);
    await executeAnyTool(
      'abu-browser__download',
      { tabId: TAB, action: 'click', locator: '{"css":"a#export"}' },
      (async () => true) as never,
      undefined,
      { conversationId: OWNER, interactionMode: 'foreground' } as never,
    );
    return buildBrowserDownloadsReport({
      signals: getRecentBrowserSignals(), conversationId: OWNER, sinceSeq: since,
    });
  }

  it('hands back the file the run downloaded', async () => {
    const report = await runAttendedDownload();

    expect(report?.variant).toBe('downloads');
    expect(report?.artifacts).toEqual([{
      downloadId: 'dl_abc',
      name: '排班表.xlsx',
      path: COMPLETED.download.path,
      bytes: 1_258_291,
      mime: 'application/vnd.ms-excel',
    }]);
  });

  it('carries the files and nothing else — no sites, no approvals, no next steps', async () => {
    const report = await runAttendedDownload();

    expect(report?.sites).toEqual([]);
    expect(report?.denials).toEqual([]);
    expect(report?.problems).toEqual([]);
    expect(report?.nextSteps).toEqual([]);
    expect(report?.actions).toEqual({ total: 0, failed: 0 });
    expect(report?.scriptRuns).toBe(0);
    expect(report?.approvals).toEqual({ approved: 0, declined: 0, timedOut: 0, unreachable: 0 });
    expect(report?.blockedPages).toBe(0);
    expect(report?.skippedByMasterSwitch).toBe(false);
  });

  /** A chat run that fetched nothing gets no card at all, not an empty one. */
  it('produces no card for a run that downloaded nothing', async () => {
    expect(await runAttendedDownload({
      started: false,
      message: 'That click produced no download.',
    })).toBeNull();
  });

  it('produces no card for a download that never finished', async () => {
    expect(await runAttendedDownload({
      started: true,
      complete: false,
      download: { ...COMPLETED.download, state: 'progressing' },
      message: 'Still downloading.',
    })).toBeNull();
  });

  /**
   * The file exists even when its path was too long to carry (N3 above). The
   * card must still say so — "downloaded nothing" is the one wrong answer.
   */
  it('still produces a card when the only file was dropped for an unusable path', async () => {
    const report = await runAttendedDownload({
      ...COMPLETED,
      download: {
        ...COMPLETED.download,
        path: `/Users/me/Library/Application Support/abu/browser-downloads/${'x'.repeat(300)}.xlsx`,
      },
    });

    expect(report?.artifacts).toEqual([]);
    expect(report?.omitted.artifacts).toBe(1);
  });
});
