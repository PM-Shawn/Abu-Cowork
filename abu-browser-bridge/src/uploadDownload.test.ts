/**
 * `upload_file` and `download` at the MCP surface (batch-三 T5 / T6).
 *
 * The load-bearing claim for T5 lives here rather than in the gate: the PATHS
 * an upload sends come from `_meta` — the stamp Abu's approval gate puts on a
 * call it approved — and the model-facing `files` argument is validated for
 * shape and then thrown away. So a call that arrives without the stamp sends
 * NOTHING; it does not fall back to the argument, which would be a second,
 * unchecked road to the user's filesystem.
 *
 * For T6 the claim is smaller and still worth pinning: the wait is bounded by
 * something other than a model-authored number, and the transport's own
 * timeout outlives the wait it carries (or a legitimate 30 s download would be
 * reported as a dead browser).
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  clampDownloadWait,
  DEFAULT_DOWNLOAD_WAIT_MS,
  MAX_DOWNLOAD_WAIT_MS,
  parseApprovedUploadFiles,
  validateUploadFilesArgument,
} from './locators.js';
import {
  ABU_APPROVED_UPLOAD_FILES_META_KEY,
  registerTools,
  type BrowserTransport,
  type UploadDelivery,
} from './tools.js';

type ToolHandler = (args: Record<string, unknown>, extra?: Record<string, unknown>) => Promise<{
  content: Array<{ type: string; text: string }>;
}>;
type ServerArg = Parameters<typeof registerTools>[0];

interface Sent {
  action: string;
  payload: Record<string, unknown>;
  timeoutMs?: number;
}

function harness(uploadDelivery?: UploadDelivery) {
  const tools = new Map<string, ToolHandler>();
  const server = {
    tool(name: string, _description: string, schemaOrHandler: unknown, maybeHandler?: ToolHandler) {
      const hasSchema = typeof schemaOrHandler !== 'function';
      tools.set(name, (hasSchema ? maybeHandler : schemaOrHandler) as ToolHandler);
    },
  };
  const sent: Sent[] = [];
  const transport = {
    ...(uploadDelivery ? { uploadDelivery } : {}),
    isConnected: vi.fn(async () => true),
    send: vi.fn(async (action: string, payload: Record<string, unknown>, timeoutMs?: number) => {
      sent.push({ action, payload, timeoutMs });
      return { success: true, data: { ok: true } };
    }),
    getConnectionError: vi.fn(() => 'not connected'),
  } as unknown as BrowserTransport;

  registerTools(server as unknown as ServerArg, transport);
  return { tool: (name: string) => tools.get(name)!, sent, transport };
}

const APPROVED_META = (files: unknown) => ({
  _meta: { [ABU_APPROVED_UPLOAD_FILES_META_KEY]: files },
});

/**
 * The identity the gate freezes alongside path/name/size (review F1).
 *
 * A stamp without it is refused, so every fixture here carries one — and the
 * ones that go near a real file take it from the file, because the sender
 * compares against an `fstat` of the descriptor it reads from.
 */
const PIN = { mtimeMs: 1_757_000_000_123, ino: 4242, dev: 66 };

function pinOf(file: string): { mtimeMs: number; ino: number; dev: number } {
  const stat = fs.lstatSync(file);
  return { mtimeMs: Math.floor(stat.mtimeMs), ino: stat.ino, dev: stat.dev };
}

const UPLOAD_ARGS = {
  tabId: 1,
  target: '{"css":"input[type=file]"}',
  files: '[{"path":"/ws/report.xlsx"}]',
};

describe('parseApprovedUploadFiles', () => {
  it('reads the gate\'s list, as an array or as the JSON string a transport may carry', () => {
    const one = [{ path: '/ws/a.txt', name: 'a.txt', size: 4, ...PIN }];
    expect(parseApprovedUploadFiles(one)).toEqual(one);
    expect(parseApprovedUploadFiles(JSON.stringify(one))).toEqual(one);
  });

  /**
   * Null is a REFUSAL at every call site, never "upload nothing". Each of
   * these is a way the chain could break, and none of them may end with the
   * model's own paths being used instead.
   */
  it.each([
    ['absent', undefined],
    ['null', null],
    ['an empty list', []],
    ['not a list', { path: '/ws/a.txt' }],
    ['unparseable JSON', '[{'],
    ['an entry that is not an object', ['/ws/a.txt']],
    ['an entry with no path', [{ name: 'a.txt', size: 4 }]],
    ['an entry with an empty path', [{ path: '', name: 'a.txt', size: 4 }]],
    ['an entry with no name', [{ path: '/ws/a.txt', size: 4 }]],
    ['an entry with a non-numeric size', [{ path: '/ws/a.txt', name: 'a.txt', size: '4' }]],
    ['an entry with a negative size', [{ path: '/ws/a.txt', name: 'a.txt', size: -1 }]],
    ['one good entry and one bad', [{ path: '/ws/a.txt', name: 'a.txt', size: 1, ...PIN }, { path: '/ws/b' }]],
    // Review F1 — a stamp with no identity in it reads as no stamp at all:
    // the only comparison it leaves is the one a same-size swap defeats.
    ['an entry with no identity pin', [{ path: '/ws/a.txt', name: 'a.txt', size: 4 }]],
    ['an entry whose mtime is not a number', [{ path: '/ws/a.txt', name: 'a.txt', size: 4, mtimeMs: 'x' }]],
    ['an entry pinned by nothing but a zero mtime', [{ path: '/ws/a.txt', name: 'a.txt', size: 4, mtimeMs: 0 }]],
  ])('returns null for %s', (_label, raw) => {
    expect(parseApprovedUploadFiles(raw)).toBeNull();
  });
});

describe('validateUploadFilesArgument', () => {
  it('accepts the shapes the tool description teaches', () => {
    expect(() => validateUploadFilesArgument('[{"path":"/ws/a.txt"}]')).not.toThrow();
    expect(() => validateUploadFilesArgument('["/ws/a.txt"]')).not.toThrow();
  });

  it('rejects a call whose files argument could not have produced a correct confirmation', () => {
    expect(() => validateUploadFilesArgument('[]')).toThrow(/non-empty JSON array/);
    expect(() => validateUploadFilesArgument('nope')).toThrow(/non-empty JSON array/);
    expect(() => validateUploadFilesArgument('[{"name":"a.txt"}]')).toThrow(/non-empty `path`/);
    expect(() => validateUploadFilesArgument('[{"path":"   "}]')).toThrow(/non-empty `path`/);
  });
});

describe('clampDownloadWait', () => {
  it('defaults a missing or nonsensical wait rather than blocking forever', () => {
    for (const bad of [undefined, null, 'soon', Number.NaN, 0, -5, Infinity]) {
      expect(clampDownloadWait(bad)).toBe(DEFAULT_DOWNLOAD_WAIT_MS);
    }
  });

  it('caps a model-authored wait — a wait that can outlast the run is one nobody can stop', () => {
    expect(clampDownloadWait(MAX_DOWNLOAD_WAIT_MS * 10)).toBe(MAX_DOWNLOAD_WAIT_MS);
    expect(clampDownloadWait(5_000)).toBe(5_000);
    expect(clampDownloadWait(5_000.7)).toBe(5_000);
  });
});

describe('upload_file', () => {
  /**
   * The refusal that makes the whole `_meta` design worth having. Without it
   * the tool would be a file-read primitive addressable by the model.
   */
  it('sends nothing at all when the call carries no approved file list', async () => {
    const { tool, sent } = harness('path');

    const result = await tool('upload_file')(UPLOAD_ARGS, {});

    expect(sent).toHaveLength(0);
    expect(result.content[0].text).toContain('no approved file list');
  });

  it.each([
    ['a forged empty list', []],
    ['a list of bare paths', ['/etc/shadow']],
    ['a list with a missing size', [{ path: '/etc/shadow', name: 'shadow' }]],
    ['a list whose entry carries no identity pin', [{ path: '/etc/shadow', name: 'shadow', size: 1 }]],
  ])('sends nothing when the stamp is %s', async (_label, files) => {
    const { tool, sent } = harness('path');

    const result = await tool('upload_file')(UPLOAD_ARGS, APPROVED_META(files));

    expect(sent).toHaveLength(0);
    expect(result.content[0].text).toContain('no approved file list');
  });

  it('ignores the model\'s own paths and sends the gate\'s', async () => {
    const { tool, sent } = harness('path');

    await tool('upload_file')(
      { ...UPLOAD_ARGS, files: '[{"path":"/etc/shadow"}]' },
      APPROVED_META([{ path: '/ws/report.xlsx', name: 'report.xlsx', size: 5, ...PIN }]),
    );

    expect(sent).toHaveLength(1);
    // The pin travels with the paths: on this channel the tier that OPENS the
    // file is the runtime, so it is the tier that has to re-check the identity.
    expect(sent[0].payload.files).toEqual([
      { path: '/ws/report.xlsx', name: 'report.xlsx', size: 5, ...PIN },
    ]);
    expect(JSON.stringify(sent[0].payload)).not.toContain('/etc/shadow');
  });

  it('still refuses a files argument it cannot read, before it looks at the stamp', async () => {
    const { tool, sent } = harness('path');

    await expect(tool('upload_file')(
      { ...UPLOAD_ARGS, files: 'not json' },
      APPROVED_META([{ path: '/ws/a.txt', name: 'a.txt', size: 1, ...PIN }]),
    )).rejects.toThrow(/non-empty JSON array/);
    expect(sent).toHaveLength(0);
  });

  /**
   * The one genuine difference between the two channels: a Chrome service
   * worker has no filesystem, so THIS process opens the file; the built-in
   * browser's runtime can open it itself (and its HTTP transport caps a
   * request at 1 MiB, so bytes could not go that way anyway).
   */
  it('reads the bytes itself for a bytes channel, and sends only paths for a path channel', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'abu-upload-'));
    const file = path.join(dir, 'report.xlsx');
    fs.writeFileSync(file, 'hello');
    const approved = APPROVED_META([{ path: file, name: 'report.xlsx', size: 5, ...pinOf(file) }]);

    try {
      const bytes = harness('bytes');
      await bytes.tool('upload_file')(UPLOAD_ARGS, approved);
      expect(bytes.sent[0].payload.files).toEqual([
        { name: 'report.xlsx', size: 5, base64: Buffer.from('hello').toString('base64') },
      ]);

      const paths = harness('path');
      await paths.tool('upload_file')(UPLOAD_ARGS, approved);
      expect(paths.sent[0].payload.files).toEqual([
        { path: file, name: 'report.xlsx', size: 5, ...pinOf(file) },
      ]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('treats a transport that declares nothing as a bytes channel — a capability is not assumed', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'abu-upload-'));
    const file = path.join(dir, 'a.txt');
    fs.writeFileSync(file, 'x');
    try {
      const { tool, sent } = harness();
      await tool('upload_file')(UPLOAD_ARGS, APPROVED_META([{ path: file, name: 'a.txt', size: 1, ...pinOf(file) }]));
      expect(Object.keys((sent[0].payload.files as Array<Record<string, unknown>>)[0]))
        .toEqual(['name', 'size', 'base64']);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  /**
   * TOCTOU on the FILE rather than on the page: the confirmation the user
   * answered named a size, and a file that changed since then is not the file
   * they approved.
   */
  it('refuses a file that changed on disk between the confirmation and the send', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'abu-upload-'));
    const file = path.join(dir, 'swapped.txt');
    fs.writeFileSync(file, 'much longer than it was');
    try {
      const { tool, sent } = harness('bytes');
      await expect(tool('upload_file')(
        UPLOAD_ARGS,
        APPROVED_META([{ path: file, name: 'swapped.txt', size: 5, ...pinOf(file) }]),
      )).rejects.toThrow(/changed on disk/);
      expect(sent).toHaveLength(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  // ── The identity pin across the confirmation (review F1) ────────────────

  /**
   * The probe that produced F1, as a test: an 8-byte `report.txt` is approved,
   * and before the bytes are read the path is made a symbolic link to an
   * 8-byte `secret.txt`. Size alone said nothing had changed, and the page got
   * the secret.
   */
  it('refuses a file replaced by a same-size symbolic link after the confirmation', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'abu-upload-'));
    const approvedPath = path.join(dir, 'report.txt');
    const secret = path.join(dir, 'secret.txt');
    fs.writeFileSync(approvedPath, 'PUBLIC!!');
    fs.writeFileSync(secret, 'SECRET!!');
    const stamp = APPROVED_META([
      { path: approvedPath, name: 'report.txt', size: 8, ...pinOf(approvedPath) },
    ]);
    fs.unlinkSync(approvedPath);
    fs.symlinkSync(secret, approvedPath);

    try {
      const { tool, sent } = harness('bytes');
      await expect(tool('upload_file')(UPLOAD_ARGS, stamp))
        .rejects.toThrow(/symbolic link now|changed on disk/);
      expect(sent).toHaveLength(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses a same-size DIFFERENT file put at the approved path', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'abu-upload-'));
    const approvedPath = path.join(dir, 'report.txt');
    fs.writeFileSync(approvedPath, 'PUBLIC!!');
    const stamp = APPROVED_META([
      { path: approvedPath, name: 'report.txt', size: 8, ...pinOf(approvedPath) },
    ]);
    // A new inode at the same path, the same length, different bytes.
    const other = path.join(dir, 'other.txt');
    fs.writeFileSync(other, 'SECRET!!');
    fs.renameSync(other, approvedPath);

    try {
      const { tool, sent } = harness('bytes');
      await expect(tool('upload_file')(UPLOAD_ARGS, stamp)).rejects.toThrow(/changed on disk/);
      expect(sent).toHaveLength(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses a same-size in-place rewrite, which keeps the inode and moves the clock', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'abu-upload-'));
    const approvedPath = path.join(dir, 'report.txt');
    fs.writeFileSync(approvedPath, 'PUBLIC!!');
    const pin = pinOf(approvedPath);
    const stamp = APPROVED_META([
      { path: approvedPath, name: 'report.txt', size: 8, ...pin },
    ]);
    fs.writeFileSync(approvedPath, 'SECRET!!');
    fs.utimesSync(approvedPath, new Date(pin.mtimeMs + 5_000), new Date(pin.mtimeMs + 5_000));

    try {
      const { tool, sent } = harness('bytes');
      await expect(tool('upload_file')(UPLOAD_ARGS, stamp)).rejects.toThrow(/changed on disk/);
      expect(sent).toHaveLength(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('passes a frame handle through so an attachment field inside an OA iframe is reachable', async () => {
    const { tool, sent } = harness('path');

    await tool('upload_file')(
      { ...UPLOAD_ARGS, frameId: 'f3' },
      APPROVED_META([{ path: '/ws/a.txt', name: 'a.txt', size: 1, ...PIN }]),
    );

    expect(sent[0].payload.frameId).toBe('f3');
  });

  it('describes itself without promising a rule the gate no longer has', () => {
    const tools: Array<{ name: string; description: string }> = [];
    const server = {
      tool(name: string, description: string) { tools.push({ name, description }); },
    };
    registerTools(server as unknown as ServerArg, { isConnected: async () => true } as never);
    const description = tools.find((t) => t.name === 'upload_file')!.description;

    // The 2026-09-07 ruling: an authorized upload runs automatically, so the
    // description must not tell the model an automatic task can never upload.
    expect(description).not.toMatch(/cannot upload at all/);
    expect(description).not.toMatch(/no "always allow" for uploads/);
    // What it must still say: aim at the input, not the visible button.
    expect(description).toContain('input[type=file]');
  });
});

describe('download', () => {
  it('needs a locator to press, and an id to keep waiting on', async () => {
    const { tool, sent } = harness();

    await expect(tool('download')({ tabId: 1, action: 'click' }, {})).rejects.toThrow(/`locator`/);
    await expect(tool('download')({ tabId: 1, action: 'wait' }, {})).rejects.toThrow(/`downloadId`/);
    expect(sent).toHaveLength(0);
  });

  it('clamps the wait it sends, and gives the transport room to outlive it', async () => {
    const { tool, sent } = harness();

    await tool('download')(
      { tabId: 1, action: 'click', locator: '{"css":"a#export"}', timeoutMs: 10_000_000 },
      {},
    );

    expect(sent[0].payload.timeoutMs).toBe(MAX_DOWNLOAD_WAIT_MS);
    // A legitimate long download must not be reported as a dead browser.
    expect(sent[0].timeoutMs).toBeGreaterThan(MAX_DOWNLOAD_WAIT_MS);
  });

  it('carries the download id through on a wait, and no locator with it', async () => {
    const { tool, sent } = harness();

    await tool('download')({ tabId: 1, action: 'wait', downloadId: 'dl_1' }, {});

    expect(sent[0].payload).toMatchObject({ action: 'wait', downloadId: 'dl_1' });
    expect(sent[0].payload.locator).toBeUndefined();
  });

  it('tells the model this is a per-task folder and that nothing is adopted or retried', () => {
    const tools: Array<{ name: string; description: string }> = [];
    const server = {
      tool(name: string, description: string) { tools.push({ name, description }); },
    };
    registerTools(server as unknown as ServerArg, { isConnected: async () => true } as never);
    const description = tools.find((t) => t.name === 'download')!.description;

    expect(description).toMatch(/no "Save as" window appears/);
    expect(description).toMatch(/not visible to another/);
    expect(description).toMatch(/Nothing is retried automatically/);
  });

  it('says get_downloads reports only this task\'s files', () => {
    const tools: Array<{ name: string; description: string }> = [];
    const server = {
      tool(name: string, description: string) { tools.push({ name, description }); },
    };
    registerTools(server as unknown as ServerArg, { isConnected: async () => true } as never);
    const description = tools.find((t) => t.name === 'get_downloads')!.description;

    expect(description).toMatch(/Downloads made by other tasks are not listed/);
  });
});
