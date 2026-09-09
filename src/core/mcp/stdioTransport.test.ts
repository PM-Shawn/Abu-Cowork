import { beforeEach, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { TauriStdioTransport } from './client';

beforeEach(() => {
  vi.mocked(invoke).mockReset().mockResolvedValue(undefined);
  vi.mocked(listen).mockReset().mockResolvedValue(vi.fn());
});

it.each([1, 2, 3])('never spawns after close during listener registration %i', async step => {
  let finish!: (unlisten: () => void) => void;
  for (let i = 1; i < step; i++) vi.mocked(listen).mockResolvedValueOnce(vi.fn());
  vi.mocked(listen).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const transport = new TauriStdioTransport({ command: 'fixture', args: [], env: {} });
  const starting = transport.start();
  for (let i = 1; i < step; i++) await Promise.resolve();
  await transport.close();
  const release = vi.fn();
  finish(release);
  await expect(starting).rejects.toThrow();
  expect(release).toHaveBeenCalledOnce();
  expect(vi.mocked(invoke).mock.calls.some(([method]) => method === 'mcp_spawn')).toBe(false);
  await expect(transport.send({ jsonrpc: '2.0', method: 'late' })).rejects.toThrow();
  expect(vi.mocked(invoke).mock.calls.some(([method]) => method === 'mcp_write')).toBe(false);
});

it('kills a spawn that completes after close, and never writes to it', async () => {
  let spawned!: () => void;
  let finish!: () => void;
  const spawning = new Promise<void>(resolve => { spawned = resolve; });
  const operations: string[] = [];
  vi.mocked(invoke).mockImplementation(async method => {
    operations.push(method);
    if (method === 'mcp_spawn') {
      spawned();
      await new Promise<void>(resolve => { finish = resolve; });
    }
  });
  const transport = new TauriStdioTransport({ command: 'fixture', args: [], env: {} });
  const starting = transport.start();
  await spawning;
  const closing = transport.close();
  finish();
  await expect(starting).rejects.toThrow();
  await closing;
  await transport.close();
  expect(operations).toEqual(['mcp_spawn', 'mcp_kill']);
});
