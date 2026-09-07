/**
 * `upload_file` at the REAL gate (T5), under the 2026-09-07 ruling.
 *
 * The ruling in one line: 「不区分什么有人无人值守，只要用户授权，就算自动，
 * 不授权就要申请。」 So this file proves two things that pull in opposite
 * directions and must both hold:
 *
 *  - **The SITE question is `interactive`'s question, verbatim.** Same three
 *    row states, same site grant, same conversation grant, same
 *    「以后都允许该网站」, same IM round-trip when nobody is watching. The
 *    09-05 口径 (no 「允许」 tier, unattended always refused, no grant may be
 *    spent) is gone, and the parity sweep at the bottom is what would notice
 *    a piece of it growing back.
 *  - **The FILE question did not move.** Outside the authorized workspaces, a
 *    symbolic link, over the ceiling, or a call the gate never stamped: all
 *    refused, on EVERY release path — including the silent one where the row
 *    says 「允许」 and the site is 「始终允许」, which is the path that did not
 *    exist before the ruling and is therefore the one worth pinning hardest.
 *
 * Everything below enters through `checkToolApproval`, the real tool gate
 * (TESTING §13.3): no callback is driven directly, and the approval seam used
 * for the unattended cases is the shipped one.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { lstat } from '@tauri-apps/plugin-fs';
import { checkToolApproval } from './registry';
import { mcpManager } from '../mcp/client';
import { useChatStore } from '../../stores/chatStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { testSiteVerdicts } from '../../test/browserSiteVerdicts';
import {
  DEFAULT_BROWSER_OPERATION_POLICY,
  __resetBrowserGrantsForTests,
  type BrowserOperationPolicy,
} from '../permissions/browserToolPolicy';
import {
  __resetUnattendedConfirmationForTests,
  setUnattendedConfirmationResolver,
} from '../permissions/unattendedConfirmation';
import { MAX_UPLOAD_FILE_BYTES } from '../permissions/browserUploadFiles';

/**
 * Only `checkReadPath` is faked, and by default it says yes — so a refusal
 * below is the gate's own doing and not a stub's. The individual file-safety
 * cases override it (or `lstat`) one at a time.
 */
const fsMocks = vi.hoisted(() => ({
  checkReadPath: vi.fn(async (candidate: string) => ({
    allowed: true as boolean,
    resolvedPath: candidate as string | undefined,
  })),
}));

vi.mock('./pathSafety', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./pathSafety')>()),
  checkReadPath: (...args: unknown[]) => fsMocks.checkReadPath(args[0] as string),
}));

vi.mock('@/core/enterprise/policy/enforcer', () => ({
  getCurrentPolicy: () => ({ mode: 'test-policy' }),
}));
vi.mock('@/core/enterprise/policy/matcher', () => ({
  checkTool: () => ({ decision: 'allow' as const }),
}));

const ALLOWED_SITE = 'https://allowed.com';
const ALLOWED_URL = `${ALLOWED_SITE}/oa/form`;
const UNKNOWN_URL = 'https://unknown.com/oa/form';
const HIGH_RISK_URL = 'https://www.paypal.com/pay';
const OWNER = 'upload-owner';
const OWNED_TAB_ID = 77;

const FILE_PATH = '/ws/reports/排班表.xlsx';
const FILE_SIZE = 2048;
/**
 * What `lstat` reports about the approved file, and therefore what the gate
 * freezes (review F1): the identity has to cross the confirmation, not just
 * the length. `mtime` is a `Date` because that is `FileInfo`'s shape.
 */
const FILE_MTIME_MS = 1_757_000_000_123;
const FILE_INO = 4242;
const FILE_DEV = 66;
const DISK_INFO = {
  isFile: true,
  isSymlink: false,
  size: FILE_SIZE,
  mtime: new Date(FILE_MTIME_MS),
  ino: FILE_INO,
  dev: FILE_DEV,
};

const uploadInput = (path = FILE_PATH) => ({
  tabId: OWNED_TAB_ID,
  target: '{"css":"input[type=file]"}',
  files: JSON.stringify([{ path }]),
});
const clickInput = { tabId: OWNED_TAB_ID, ref: 'ref_1' };

const attended = { conversationId: OWNER } as never;
const unattended = { conversationId: OWNER, interactionMode: 'background' } as never;

let mockCallTool: ReturnType<typeof vi.fn>;

function withTabOrigin(url: string) {
  mockCallTool.mockImplementation((params: { _meta?: Record<string, unknown> }) =>
    Promise.resolve(
      params._meta?.['abu/conversationId'] === OWNER
        ? {
            content: [{
              type: 'text',
              text: JSON.stringify({
                windows: [{ windowId: 1, tabs: [{ tabId: OWNED_TAB_ID, url }] }],
              }),
            }],
          }
        : { content: [{ type: 'text', text: JSON.stringify({ windows: [] }) }] },
    ),
  );
}

function policyWith(cell: keyof BrowserOperationPolicy, state: 'allow' | 'deny' | 'ask') {
  return { ...DEFAULT_BROWSER_OPERATION_POLICY, [cell]: state };
}

/** What a confirmation dialog was shown, if one was shown at all. */
interface Asked {
  command: string;
  reason?: string;
  allowPersistentGrant?: boolean;
  browserOrigin?: string;
  deniedNotice?: string;
}

function dialogRecorder(answer = true) {
  const asks: Asked[] = [];
  const confirm = vi.fn(async (info: Asked) => {
    // A denial NOTICE is not a question — the unattended paths hand the
    // callback their decision so a run can report it.
    if (info.deniedNotice === undefined) asks.push(info);
    return answer;
  });
  return { asks, confirm: confirm as never };
}

describe('upload_file at the real gate', () => {
  beforeEach(() => {
    fsMocks.checkReadPath.mockReset();
    fsMocks.checkReadPath.mockImplementation(async (candidate: string) => ({
      allowed: true, resolvedPath: candidate,
    }));
    vi.mocked(lstat).mockResolvedValue(
      DISK_INFO as unknown as Awaited<ReturnType<typeof lstat>>,
    );
    mockCallTool = vi.fn(() => Promise.resolve({
      content: [{ type: 'text', text: JSON.stringify({ windows: [] }) }],
    }));
    (mcpManager as unknown as { servers: Map<string, unknown> }).servers.set('abu-browser', {
      config: { name: 'abu-browser' },
      client: { callTool: mockCallTool },
      transport: {},
      tools: new Map(),
    });
    useChatStore.setState({ conversations: {}, conversationIndex: {}, activeConversationId: null });
    useSettingsStore.setState({
      permissionMode: 'standard',
      browserSitePermissions: testSiteVerdicts({ [ALLOWED_SITE]: 'allowed' }),
      browserOperationPolicy: DEFAULT_BROWSER_OPERATION_POLICY,
      allowUnattendedBrowser: true,
    });
    __resetBrowserGrantsForTests();
    __resetUnattendedConfirmationForTests();
    withTabOrigin(ALLOWED_URL);
  });

  afterEach(() => {
    (mcpManager as unknown as { servers: Map<string, unknown> }).servers.delete('abu-browser');
    __resetBrowserGrantsForTests();
    __resetUnattendedConfirmationForTests();
  });

  // ── The site question: authorized means automatic ──────────────────────

  /**
   * The headline of the 2026-09-07 ruling, and the case the 09-05 口径 made
   * impossible: the user set the upload row to 「允许」 and this site to
   * 「始终允许」. That IS the authorization. No dialog.
   */
  it('runs with no dialog at all when the row says 允许 and the site is 始终允许', async () => {
    useSettingsStore.setState({ browserOperationPolicy: policyWith('upload', 'allow') });
    const { asks, confirm } = dialogRecorder();

    const decision = await checkToolApproval(
      'abu-browser__upload_file', uploadInput(), attended, confirm,
    );

    expect(decision.decision).toBe('allow');
    expect(asks).toHaveLength(0);
  });

  it('asks on a site with no standing grant even when the row says 允许 — the grant is per site', async () => {
    withTabOrigin(UNKNOWN_URL);
    useSettingsStore.setState({ browserOperationPolicy: policyWith('upload', 'allow') });
    const { asks, confirm } = dialogRecorder();

    const decision = await checkToolApproval(
      'abu-browser__upload_file', uploadInput(), attended, confirm,
    );

    expect(decision.decision).toBe('allow');
    expect(asks).toHaveLength(1);
    // And it OFFERS 「以后都允许该网站」 — the 09-05 口径 withheld that from
    // uploads, which is exactly what the ruling reversed.
    expect(asks[0].allowPersistentGrant).toBe(true);
  });

  it('asks every single time under 每次询问, and never offers a standing grant', async () => {
    useSettingsStore.setState({ browserOperationPolicy: policyWith('upload', 'ask') });
    const { asks, confirm } = dialogRecorder();

    for (let i = 0; i < 3; i += 1) {
      const decision = await checkToolApproval(
        'abu-browser__upload_file', uploadInput(), attended, confirm,
      );
      expect(decision.decision).toBe('allow');
    }

    expect(asks).toHaveLength(3);
    expect(asks.every((a) => a.allowPersistentGrant !== true)).toBe(true);
  });

  it('refuses when the user answers no, and sends nothing', async () => {
    useSettingsStore.setState({ browserOperationPolicy: policyWith('upload', 'ask') });
    const { confirm } = dialogRecorder(false);

    const decision = await checkToolApproval(
      'abu-browser__upload_file', uploadInput(), attended, confirm,
    );

    expect(decision.decision).not.toBe('allow');
    expect(decision.browserExecution?.approvedUploadFiles).toBeUndefined();
  });

  it('refuses outright when the row says 拒绝', async () => {
    useSettingsStore.setState({ browserOperationPolicy: policyWith('upload', 'deny') });
    const { asks, confirm } = dialogRecorder();

    const decision = await checkToolApproval(
      'abu-browser__upload_file', uploadInput(), attended, confirm,
    );

    expect(decision.decision).toBe('deny');
    expect(asks).toHaveLength(0);
  });

  /**
   * The other half of the reversal. 「无人值守一律拒」 is gone: an unattended
   * 「每次询问」 upload goes to the same approval seam every other browser ask
   * uses, and a yes there runs it.
   */
  it('asks over the unattended approval seam instead of refusing itself', async () => {
    useSettingsStore.setState({ browserOperationPolicy: policyWith('upload', 'ask') });
    const seen: string[] = [];
    setUnattendedConfirmationResolver(async ({ info }) => {
      seen.push(info.command);
      return { approved: true, reason: 'approved in chat' };
    });

    const decision = await checkToolApproval(
      'abu-browser__upload_file', uploadInput(), unattended, (async () => true) as never,
    );

    expect(decision.decision).toBe('allow');
    expect(seen).toHaveLength(1);
    // The remote approver has no browser in front of them, so the question has
    // to name the file — a bare `…__upload_file (origin)` is not consent.
    expect(seen[0]).toContain('排班表.xlsx');
  });

  it('refuses when the remote approver says no', async () => {
    useSettingsStore.setState({ browserOperationPolicy: policyWith('upload', 'ask') });
    setUnattendedConfirmationResolver(async () => ({ approved: false, reason: 'declined' }));

    const decision = await checkToolApproval(
      'abu-browser__upload_file', uploadInput(), unattended, (async () => true) as never,
    );

    expect(decision.decision).not.toBe('allow');
  });

  it('runs an automatic upload with nobody asked when the row says 允许 on an allowed site', async () => {
    useSettingsStore.setState({ browserOperationPolicy: policyWith('upload', 'allow') });
    const asked: string[] = [];
    setUnattendedConfirmationResolver(async ({ info }) => {
      asked.push(info.command);
      return { approved: true, reason: 'approved' };
    });

    const decision = await checkToolApproval(
      'abu-browser__upload_file', uploadInput(), unattended, (async () => true) as never,
    );

    expect(decision.decision).toBe('allow');
    expect(asked).toHaveLength(0);
  });

  it('still fails closed unattended on a site with no standing grant', async () => {
    withTabOrigin(UNKNOWN_URL);
    useSettingsStore.setState({ browserOperationPolicy: policyWith('upload', 'allow') });

    const decision = await checkToolApproval(
      'abu-browser__upload_file', uploadInput(), unattended, (async () => true) as never,
    );

    expect(decision.decision).toBe('deny');
  });

  it('still refuses unattended when the master switch is off', async () => {
    useSettingsStore.setState({
      allowUnattendedBrowser: false,
      browserOperationPolicy: policyWith('upload', 'allow'),
    });

    const decision = await checkToolApproval(
      'abu-browser__upload_file', uploadInput(), unattended, (async () => true) as never,
    );

    expect(decision.decision).toBe('deny');
  });

  it('forces a confirmation on a money-movement page even when the row says 允许 and the site is allowed', async () => {
    useSettingsStore.setState({
      browserSitePermissions: testSiteVerdicts({ 'https://www.paypal.com': 'allowed' }),
      browserOperationPolicy: policyWith('upload', 'allow'),
    });
    withTabOrigin(HIGH_RISK_URL);
    const { asks, confirm } = dialogRecorder();

    const decision = await checkToolApproval(
      'abu-browser__upload_file', uploadInput(), attended, confirm,
    );

    expect(decision.decision).toBe('allow');
    expect(asks).toHaveLength(1);
    expect(asks[0].allowPersistentGrant).not.toBe(true);
  });

  it('refuses an upload to a blocked site whatever the row says', async () => {
    useSettingsStore.setState({
      browserSitePermissions: testSiteVerdicts({ [ALLOWED_SITE]: 'denied' }),
      browserOperationPolicy: policyWith('upload', 'allow'),
    });
    const { asks, confirm } = dialogRecorder();

    const decision = await checkToolApproval(
      'abu-browser__upload_file', uploadInput(), attended, confirm,
    );

    expect(decision.decision).toBe('deny');
    expect(asks).toHaveLength(0);
  });

  // ── The file question: unchanged, and on every release path ────────────

  /**
   * The path the ruling created, and therefore the one worth pinning hardest:
   * nobody is asked anything, so the file checks are the ONLY thing between a
   * model-authored path and somebody else's server.
   */
  describe('the silent path (row=允许, site=始终允许) still refuses a bad file', () => {
    beforeEach(() => {
      useSettingsStore.setState({ browserOperationPolicy: policyWith('upload', 'allow') });
    });

    it('refuses a path outside every authorized workspace', async () => {
      fsMocks.checkReadPath.mockResolvedValue({ allowed: false, resolvedPath: undefined });

      const decision = await checkToolApproval(
        'abu-browser__upload_file', uploadInput('/Users/me/.ssh/id_rsa'), attended,
        (async () => true) as never,
      );

      expect(decision.decision).toBe('deny');
      expect(decision.reason).toContain('id_rsa');
      expect(decision.browserExecution?.approvedUploadFiles).toBeUndefined();
    });

    it('refuses a symbolic link', async () => {
      vi.mocked(lstat).mockResolvedValue(
        { ...DISK_INFO, isSymlink: true, size: 10 } as unknown as Awaited<ReturnType<typeof lstat>>,
      );

      const decision = await checkToolApproval(
        'abu-browser__upload_file', uploadInput('/ws/link.txt'), attended, (async () => true) as never,
      );

      expect(decision.decision).toBe('deny');
      expect(decision.reason).toContain('link.txt');
    });

    it('refuses a file over the ceiling', async () => {
      vi.mocked(lstat).mockResolvedValue(
        { ...DISK_INFO, size: MAX_UPLOAD_FILE_BYTES + 1 } as unknown as Awaited<ReturnType<typeof lstat>>,
      );

      const decision = await checkToolApproval(
        'abu-browser__upload_file', uploadInput('/ws/huge.zip'), attended, (async () => true) as never,
      );

      expect(decision.decision).toBe('deny');
    });

    it('refuses a files argument it cannot read as a list of paths', async () => {
      const decision = await checkToolApproval(
        'abu-browser__upload_file',
        { tabId: OWNED_TAB_ID, target: '{"css":"input"}', files: 'not json' },
        attended,
        (async () => true) as never,
      );

      expect(decision.decision).toBe('deny');
    });
  });

  it('refuses a bad file on the ASKING path too, without asking about it first', async () => {
    useSettingsStore.setState({ browserOperationPolicy: policyWith('upload', 'ask') });
    fsMocks.checkReadPath.mockResolvedValue({ allowed: false, resolvedPath: undefined });
    const { asks, confirm } = dialogRecorder();

    const decision = await checkToolApproval(
      'abu-browser__upload_file', uploadInput('/etc/shadow'), attended, confirm,
    );

    expect(decision.decision).toBe('deny');
    // Nobody was troubled with a question whose answer could not matter.
    expect(asks).toHaveLength(0);
  });

  it('does not touch the filesystem for an upload the gate already refused', async () => {
    useSettingsStore.setState({ browserOperationPolicy: policyWith('upload', 'deny') });

    await checkToolApproval(
      'abu-browser__upload_file', uploadInput(), attended, (async () => true) as never,
    );

    expect(fsMocks.checkReadPath).not.toHaveBeenCalled();
  });

  // ── What the approval carries ──────────────────────────────────────────

  /**
   * The pin is the whole mechanism: the runtime reads THIS list and nothing
   * else, and the bridge refuses a call that arrives without it. So the
   * canonical path — not the string the model wrote — has to be what travels.
   */
  it('freezes the resolved file into the approval, canonical path and all', async () => {
    useSettingsStore.setState({ browserOperationPolicy: policyWith('upload', 'allow') });
    fsMocks.checkReadPath.mockResolvedValue({ allowed: true, resolvedPath: FILE_PATH });

    const decision = await checkToolApproval(
      'abu-browser__upload_file',
      uploadInput('/ws/reports/../reports/排班表.xlsx'),
      attended,
      (async () => true) as never,
    );

    expect(decision.browserExecution?.approvedUploadFiles).toEqual([
      {
        path: FILE_PATH, name: '排班表.xlsx', size: FILE_SIZE,
        // Review F1 — the pin the senders re-check before they read a byte.
        mtimeMs: FILE_MTIME_MS, ino: FILE_INO, dev: FILE_DEV,
      },
    ]);
  });

  it('puts the file name and size in the question, and the directory nowhere', async () => {
    useSettingsStore.setState({ browserOperationPolicy: policyWith('upload', 'ask') });
    const { asks, confirm } = dialogRecorder();

    await checkToolApproval('abu-browser__upload_file', uploadInput(), attended, confirm);

    expect(asks).toHaveLength(1);
    expect(asks[0].command).toContain('排班表.xlsx');
    expect(asks[0].command).toContain('2.0 KB');
    expect(asks[0].command).not.toContain('/ws/reports');
    expect(asks[0].browserOrigin).toBe(ALLOWED_SITE);
    // And it says WHY, in the sentence written for uploads.
    expect(asks[0].reason).toContain('file');
  });

  it('leaves every other browser tool\'s approval without an upload list', async () => {
    const decision = await checkToolApproval(
      'abu-browser__click', clickInput, attended, (async () => true) as never,
    );

    expect(decision.decision).toBe('allow');
    expect(decision.browserExecution?.approvedUploadFiles).toBeUndefined();
  });

  // ── Parity with interactive ────────────────────────────────────────────

  /**
   * The ruling as a property rather than a list: with the two rows set to the
   * same value, an upload and a click are asked about the same number of times
   * and reach the same decision, on every site state and in both run modes.
   *
   * This is what would catch a piece of the 09-05 口径 growing back — a
   * `!uploading` conjunct, a class-specific denial code, a withheld grant —
   * without anyone having to remember which case it lived in.
   */
  describe.each(['allow', 'ask', 'deny'] as const)('row=%s behaves exactly like click', (state) => {
    it.each([
      ['allowed site, attended', ALLOWED_URL, false],
      ['unknown site, attended', UNKNOWN_URL, false],
      ['allowed site, unattended', ALLOWED_URL, true],
      ['unknown site, unattended', UNKNOWN_URL, true],
      ['money-movement page, attended', HIGH_RISK_URL, false],
    ])('%s', async (_label, url, background) => {
      const run = async (tool: string, input: Record<string, unknown>) => {
        __resetBrowserGrantsForTests();
        __resetUnattendedConfirmationForTests();
        withTabOrigin(url);
        let imAsks = 0;
        setUnattendedConfirmationResolver(async () => {
          imAsks += 1;
          return { approved: true, reason: 'approved' };
        });
        const { asks, confirm } = dialogRecorder();
        const decision = await checkToolApproval(
          tool, input, (background ? unattended : attended), confirm,
        );
        return {
          decision: decision.decision,
          dialogAsks: asks.length,
          imAsks,
          persistentGrantOffered: asks.map((a) => a.allowPersistentGrant === true),
        };
      };

      useSettingsStore.setState({
        browserSitePermissions: testSiteVerdicts({
          [ALLOWED_SITE]: 'allowed',
          'https://www.paypal.com': 'allowed',
        }),
        browserOperationPolicy: {
          ...DEFAULT_BROWSER_OPERATION_POLICY,
          interactive: state,
          upload: state,
        },
      });

      const click = await run('abu-browser__click', clickInput);
      const upload = await run('abu-browser__upload_file', uploadInput());

      expect(upload).toEqual(click);
    });
  });
});
