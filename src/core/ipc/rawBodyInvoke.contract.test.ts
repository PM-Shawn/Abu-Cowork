// @vitest-environment node
import { createRequire } from 'node:module';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { invokeTextCommand } from './rawBodyInvoke';
import { IPC_MAX_ARGS_BYTES, IPC_MAX_RAW_BODY_BYTES, PayloadTooLargeError } from './payloadTooLarge';

const require_ = createRequire(import.meta.url);
const { validateInvokePayload } = require_('../../../electron/securityBoundary.cjs') as {
  validateInvokePayload: (record: unknown, payload: unknown) => {
    cmd: string;
    args: Record<string, unknown>;
    body?: Buffer;
    headers?: Record<string, string>;
  };
};
const invokeMock = invoke as unknown as ReturnType<typeof vi.fn>;
const record = { label: 'main', allowedFilePage: 'x', allowExternalOpen: false };
type Shell = { __ABU_SHELL__?: { mainSupervisesSidecar?: boolean } };
type RawCall = [string, unknown, { headers: Record<string, string> }];

function enterElectron(): void {
  (globalThis as Shell).__ABU_SHELL__ = { mainSupervisesSidecar: true };
}

describe('invokeTextCommand wire contract', () => {
  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockResolvedValue(undefined);
  });
  afterEach(() => {
    delete (globalThis as Shell).__ABU_SHELL__;
  });

  it('Electron: sends UTF-8 bytes + schema headers that the main process accepts', async () => {
    enterElectron();
    await invokeTextCommand('mcp_write', { id: 'abu-sidecar' }, '{"m":"中"}', {
      method: 'agent.start',
      meta: { method: 'agent.start', rpcId: '4', runId: 'r' },
    });
    await invokeTextCommand('append_file_text', { path: '/tmp/a b/messages.jsonl' }, '{"x":1}\n');
    await invokeTextCommand('atomic_write_text', { path: '/tmp/a.json' }, '{}');
    const calls = invokeMock.mock.calls as RawCall[];
    expect(calls.map((c) => c[0])).toEqual(['mcp_write', 'append_file_text', 'atomic_write_text']);
    for (const [cmd, body, options] of calls) {
      expect(body).toBeInstanceOf(Uint8Array);
      expect(Object.keys(options)).toEqual(['headers']);
      const normalized = validateInvokePayload(record, { cmd, body, headers: options.headers });
      expect(normalized.body?.toString('utf8')).toBe(new TextDecoder().decode(body as Uint8Array));
    }
    expect(calls[0][2].headers).toEqual({ id: 'abu-sidecar', method: 'agent.start', rpcId: '4', runId: 'r' });
    expect(calls[1][2].headers).toEqual({ path: encodeURIComponent('/tmp/a b/messages.jsonl') });
    expect(
      validateInvokePayload(record, { cmd: calls[1][0], body: calls[1][1], headers: calls[1][2].headers }).args,
    ).toEqual({ path: '/tmp/a b/messages.jsonl' });
  });

  it('Electron: reuses the caller-provided encoded buffer instead of re-encoding', async () => {
    enterElectron();
    const encoded = new TextEncoder().encode('{"a":1}');
    await invokeTextCommand('mcp_write', { id: 'abu-sidecar' }, '{"a":1}', { encoded });
    expect((invokeMock.mock.calls[0] as RawCall)[1]).toBe(encoded);
  });

  it('Electron: meta can never override the routing id and unusable header values are dropped', async () => {
    enterElectron();
    await invokeTextCommand('mcp_write', { id: 'abu-sidecar' }, '{}', {
      meta: {
        id: 'other-process',
        path: '/etc/passwd',
        method: 'agent.start',
        runId: '中'.repeat(100), // 300 UTF-8 bytes > 256
        clientMessageId: 'a\u0000b',
        payloadDigest: '',
        rpcId: '7',
      },
    });
    const [cmd, body, options] = invokeMock.mock.calls[0] as RawCall;
    expect(options.headers).toEqual({ id: 'abu-sidecar', method: 'agent.start', rpcId: '7' });
    expect(() => validateInvokePayload(record, { cmd, body, headers: options.headers })).not.toThrow();
  });

  it('non-Electron (Tauri legacy, web, sidecar shim): keeps the plain-args shape', async () => {
    await invokeTextCommand('mcp_write', { id: 'x' }, 'm', { meta: { method: 'agent.start' } });
    await invokeTextCommand('append_file_text', { path: '/p' }, 'd');
    await invokeTextCommand('atomic_write_text', { path: '/p' }, 'c');
    expect(invokeMock.mock.calls).toEqual([
      ['mcp_write', { id: 'x', message: 'm' }],
      ['append_file_text', { path: '/p', data: 'd' }],
      ['atomic_write_text', { path: '/p', content: 'c' }],
    ]);
  });

  it('pre-checks limits locally and relabels main-process oversize errors', async () => {
    await expect(
      invokeTextCommand('mcp_write', { id: 'x' }, 'a'.repeat(IPC_MAX_ARGS_BYTES + 1), { method: 'agent.start' }),
    ).rejects.toMatchObject({ name: 'PayloadTooLargeError', method: 'agent.start', limit: IPC_MAX_ARGS_BYTES });
    expect(invokeMock).not.toHaveBeenCalled();

    enterElectron();
    invokeMock.mockRejectedValueOnce(
      new Error('payload_too_large {"code":"payload_too_large","bytes":20,"limit":10,"method":"mcp_write"}'),
    );
    const err = await invokeTextCommand('mcp_write', { id: 'x' }, 'm', { method: 'llm.chat' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PayloadTooLargeError);
    expect(err).toMatchObject({ method: 'llm.chat', bytes: 20, limit: 10 });

    invokeMock.mockRejectedValueOnce(new Error('no live process'));
    await expect(invokeTextCommand('mcp_write', { id: 'x' }, 'm')).rejects.toThrow('no live process');
  });

  it('Electron: a body over 128 MiB is refused before invoke, and 9 MiB is sent', async () => {
    enterElectron();
    const over = new Uint8Array(IPC_MAX_RAW_BODY_BYTES + 1);
    const err = await invokeTextCommand('append_file_text', { path: '/p' }, '', { encoded: over }).catch((e: unknown) => e);
    expect(err).toMatchObject({
      name: 'PayloadTooLargeError',
      method: 'append_file_text',
      bytes: IPC_MAX_RAW_BODY_BYTES + 1,
      limit: IPC_MAX_RAW_BODY_BYTES,
    });
    expect(invokeMock).not.toHaveBeenCalled();

    await invokeTextCommand('append_file_text', { path: '/p' }, '中'.repeat(3 * 1024 * 1024));
    expect(((invokeMock.mock.calls[0] as RawCall)[1] as Uint8Array).byteLength).toBe(9 * 1024 * 1024);
  });

  it('an unencodable path rejects instead of throwing synchronously', async () => {
    enterElectron();
    const pending = invokeTextCommand('atomic_write_text', { path: '/tmp/\uD800' }, 'x');
    await expect(pending).rejects.toThrow();
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it('calls invoke synchronously so callers can observe the write immediately', () => {
    void invokeTextCommand('mcp_write', { id: 'x' }, 'm');
    enterElectron();
    void invokeTextCommand('mcp_write', { id: 'x' }, 'm');
    expect(invokeMock).toHaveBeenCalledTimes(2);
  });
});
