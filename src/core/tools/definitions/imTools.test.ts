/**
 * send_file tool — IM outbound file delivery.
 *
 * Covers the guard rails (IM-only, path required, existence/type/size checks)
 * and the happy path delegating to sendIMFile.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { sendFileTool } from './imTools';
import { WECHAT_MAX_OUTBOUND_BYTES } from '../../im/adapters/wechat';
import type { ToolExecutionContext } from '../../../types';

const mockExists = vi.fn();
const mockStat = vi.fn();
vi.mock('../fsBridge', () => ({
  exists: (p: string) => mockExists(p),
  stat: (p: string) => mockStat(p),
}));

const mockSendIMFile = vi.fn();
vi.mock('../../im/streamingReply', () => ({
  sendIMFile: (...args: unknown[]) => mockSendIMFile(...args),
}));

const IM_CTX: ToolExecutionContext = {
  imReplyTarget: { platform: 'wechat', chatId: 'user@im.wechat' },
};

async function run(input: Record<string, unknown>, context?: ToolExecutionContext): Promise<string> {
  const result = await sendFileTool.execute(input, context);
  return typeof result === 'string' ? result : JSON.stringify(result);
}

describe('sendFileTool', () => {
  beforeEach(() => {
    mockExists.mockReset().mockResolvedValue(true);
    mockStat.mockReset().mockResolvedValue({ isFile: true, isDirectory: false, size: 1024 });
    mockSendIMFile.mockReset().mockResolvedValue({ sent: true });
  });

  it('refuses outside an IM channel (no imReplyTarget)', async () => {
    const out = await run({ path: '/tmp/a.png' }, {});
    expect(out).toContain('IM');
    expect(mockSendIMFile).not.toHaveBeenCalled();
  });

  it('requires a path argument', async () => {
    const out = await run({ path: '   ' }, IM_CTX);
    expect(out.toLowerCase()).toContain('path');
    expect(mockSendIMFile).not.toHaveBeenCalled();
  });

  it('errors when the file does not exist', async () => {
    mockExists.mockResolvedValue(false);
    const out = await run({ path: '/tmp/missing.png' }, IM_CTX);
    expect(out).toContain('/tmp/missing.png');
    expect(mockSendIMFile).not.toHaveBeenCalled();
  });

  it('errors when the path is a directory', async () => {
    mockStat.mockResolvedValue({ isFile: false, isDirectory: true, size: 0 });
    const out = await run({ path: '/tmp/dir' }, IM_CTX);
    expect(out).toContain('/tmp/dir');
    expect(mockSendIMFile).not.toHaveBeenCalled();
  });

  it('rejects a file over the size ceiling without attempting to send', async () => {
    mockStat.mockResolvedValue({ isFile: true, isDirectory: false, size: WECHAT_MAX_OUTBOUND_BYTES + 1 });
    const out = await run({ path: '/tmp/big.bin' }, IM_CTX);
    expect(out.toLowerCase()).toContain('large');
    expect(mockSendIMFile).not.toHaveBeenCalled();
  });

  it('sends the file and reports success with the file name', async () => {
    const out = await run({ path: '/tmp/report.pdf', caption: 'hi' }, IM_CTX);
    expect(mockSendIMFile).toHaveBeenCalledWith('wechat', 'user@im.wechat', {
      filePath: '/tmp/report.pdf',
      caption: 'hi',
    });
    expect(out).toContain('report.pdf');
  });

  it('surfaces an unsupported-platform result', async () => {
    mockSendIMFile.mockResolvedValue({ sent: false, error: 'media_unsupported' });
    const out = await run({ path: '/tmp/a.png' }, IM_CTX);
    expect(out).toContain('wechat');
  });

  it('surfaces a generic send failure', async () => {
    mockSendIMFile.mockResolvedValue({ sent: false, error: 'boom' });
    const out = await run({ path: '/tmp/a.png' }, IM_CTX);
    expect(out).toContain('boom');
  });

  it('maps a rate_limited error to the friendly retry message', async () => {
    mockSendIMFile.mockResolvedValue({ sent: false, error: '[WeChat] rate_limited: sendmessage ret=-2 prepare failed' });
    const out = await run({ path: '/tmp/a.png' }, IM_CTX);
    expect(out).not.toContain('ret=-2'); // not the raw error
    expect(out.length).toBeGreaterThan(0);
  });

  it('is not concurrency-safe (network side effect)', () => {
    expect(sendFileTool.isConcurrencySafe).toBe(false);
  });
});
