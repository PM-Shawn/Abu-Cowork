import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SidecarStatus } from '../sidecar/sidecarManager';

const { getSidecarStatusMock } = vi.hoisted(() => ({ getSidecarStatusMock: vi.fn<() => SidecarStatus>() }));

vi.mock('../sidecar/sidecarManager', () => ({
  getSidecarStatus: getSidecarStatusMock,
}));

const sidecarChatMock = vi.fn().mockResolvedValue(undefined);
const claudeChatMock = vi.fn().mockResolvedValue(undefined);
const openaiChatMock = vi.fn().mockResolvedValue(undefined);

vi.mock('./sidecarAdapter', () => ({
  SidecarLLMAdapter: vi.fn().mockImplementation(function SidecarLLMAdapter(kind: string) {
    return { kind, chat: sidecarChatMock };
  }),
}));
vi.mock('./claude', () => ({
  ClaudeAdapter: vi.fn().mockImplementation(function ClaudeAdapter() { return { chat: claudeChatMock }; }),
}));
vi.mock('./openai-compatible', () => ({
  OpenAICompatibleAdapter: vi.fn().mockImplementation(function OpenAICompatibleAdapter() { return { chat: openaiChatMock }; }),
}));

import { selectChatAdapter } from './selectChatAdapter';
import { SidecarLLMAdapter } from './sidecarAdapter';
import { ClaudeAdapter } from './claude';
import { OpenAICompatibleAdapter } from './openai-compatible';

describe('selectChatAdapter', () => {
  beforeEach(() => {
    getSidecarStatusMock.mockReset();
    sidecarChatMock.mockClear();
    claudeChatMock.mockClear();
    openaiChatMock.mockClear();
    vi.mocked(SidecarLLMAdapter).mockClear();
    vi.mocked(ClaudeAdapter).mockClear();
    vi.mocked(OpenAICompatibleAdapter).mockClear();
  });

  it('routes to SidecarLLMAdapter when the sidecar is running', () => {
    getSidecarStatusMock.mockReturnValue('running');
    const adapter = selectChatAdapter('claude');
    expect(adapter).toBeDefined();
    expect(SidecarLLMAdapter).toHaveBeenCalledWith('claude');
    expect(ClaudeAdapter).not.toHaveBeenCalled();
  });

  it.each<[SidecarStatus]>([['stopped'], ['starting'], ['restarting'], ['failed']])(
    'falls back to the local adapter when sidecar status is %s',
    (status) => {
      getSidecarStatusMock.mockReturnValue(status);
      selectChatAdapter('claude');
      expect(ClaudeAdapter).toHaveBeenCalledTimes(1);
      expect(SidecarLLMAdapter).not.toHaveBeenCalled();
    },
  );

  it('maps "claude" to ClaudeAdapter locally', () => {
    getSidecarStatusMock.mockReturnValue('stopped');
    selectChatAdapter('claude');
    expect(ClaudeAdapter).toHaveBeenCalledTimes(1);
    expect(OpenAICompatibleAdapter).not.toHaveBeenCalled();
  });

  it('maps "openai-compatible" to OpenAICompatibleAdapter locally', () => {
    getSidecarStatusMock.mockReturnValue('stopped');
    selectChatAdapter('openai-compatible');
    expect(OpenAICompatibleAdapter).toHaveBeenCalledTimes(1);
    expect(ClaudeAdapter).not.toHaveBeenCalled();
  });

  it('maps "openai-compatible" to SidecarLLMAdapter("openai-compatible") when running', () => {
    getSidecarStatusMock.mockReturnValue('running');
    selectChatAdapter('openai-compatible');
    expect(SidecarLLMAdapter).toHaveBeenCalledWith('openai-compatible');
  });

  it('the returned adapter still delegates chat() to the underlying implementation (instrumentation wrapper is transparent)', async () => {
    getSidecarStatusMock.mockReturnValue('running');
    const adapter = selectChatAdapter('claude');
    await adapter.chat([], { model: 'm', apiKey: 'k' }, () => {});
    expect(sidecarChatMock).toHaveBeenCalledTimes(1);
  });

  it('records first-token latency without swallowing onEvent forwarding (local path)', async () => {
    getSidecarStatusMock.mockReturnValue('stopped');
    claudeChatMock.mockImplementation(async (_m, _o, onEvent: (e: unknown) => void) => {
      onEvent({ type: 'text', text: 'hi' });
    });
    const adapter = selectChatAdapter('claude');
    const received: unknown[] = [];
    await adapter.chat([], { model: 'm', apiKey: 'k' }, (e) => received.push(e));
    expect(received).toEqual([{ type: 'text', text: 'hi' }]);
  });
});
