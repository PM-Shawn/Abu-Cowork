import { beforeEach, describe, it, expect, vi } from 'vitest';
import type { Message, StreamEvent } from '../../types';
import { runAgentLoop } from './agentLoop';
import { ContextBudgetError } from '../context/contextManager';
import { resetCalibration } from '../context/tokenEstimator';
import type { ActiveModel } from '../../types/provider';

// 窗口自救测试：预算门整体 mock 掉，第一次调用按用例抛 FIXED_CONTEXT_TOO_LARGE，
// 其余调用原样放行消息——真实门的估算数字随系统提示漂移，钉不住断言。
const { mockEnforceContextBudget, mockProbeContextWindow } = vi.hoisted(() => ({
  mockEnforceContextBudget: vi.fn(),
  mockProbeContextWindow: vi.fn(),
}));

vi.mock('../llm/contextWindowProbe', () => ({ probeContextWindow: mockProbeContextWindow }));
vi.mock('../context/contextManager', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../context/contextManager')>();
  return { ...actual, enforceContextBudget: mockEnforceContextBudget };
});

beforeEach(() => {
  mockEnforceContextBudget.mockReset();
  mockEnforceContextBudget.mockImplementation((messages: Message[]) => ({
    messages,
    tokensBefore: 1,
    tokensAfter: 1,
    inputBudget: 100000,
    safetyMarginTokens: 1000,
    strategy: 'unchanged',
  }));
  mockProbeContextWindow.mockReset();
  mockProbeContextWindow.mockResolvedValue(undefined);
  // 跑过的用例会按上报的用量校准估算比例（模块级状态），不清掉会让后面用例的估算变小
  resetCalibration();
});

async function setup(opts: { pinned?: number; favorites?: ActiveModel[]; extraModels?: string[] }) {
  const { useChatStore } = await import('../../stores/chatStore');
  const { useSettingsStore } = await import('../../stores/settingsStore');
  const adapters = await import('../llm/selectChatAdapter');
  const settings = useSettingsStore.getState();
  useSettingsStore.setState({
    activeModel: { providerId: 'ollama', modelId: 'llama3.2' },
    providers: settings.providers.map((p) =>
      p.id === 'ollama'
        ? {
            ...p,
            enabled: true,
            models: [
              {
                id: 'llama3.2',
                label: 'llama3.2',
                ...(opts.pinned !== undefined
                  ? { declaredCapabilities: { maxInputTokens: opts.pinned } }
                  : {}),
              },
              ...(opts.extraModels ?? []).map((id) => ({ id, label: id })),
            ],
          }
        : { ...p, enabled: false },
    ),
    favoriteModels: opts.favorites ?? [],
  });
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { callback(0); return 0; });
  const chat = vi.fn().mockImplementation(
    async (_messages: unknown, _options: unknown, onEvent: (event: StreamEvent) => void) => {
      onEvent({ type: 'text', text: 'ok' });
      onEvent({ type: 'done', stopReason: 'end_turn' });
    },
  );
  const selectAdapter = vi.spyOn(adapters, 'selectChatAdapter').mockReturnValue({ chat });
  const restore = () => {
    selectAdapter.mockRestore();
    useSettingsStore.setState({
      activeModel: settings.activeModel,
      providers: settings.providers,
      favoriteModels: settings.favoriteModels,
    });
    vi.unstubAllGlobals();
  };
  return { useChatStore, chat, restore };
}

function throwFixedTooLargeForFailedTurn(needed: number, budget: number) {
  // 同一轮里门跑两次：agentLoop 的预检门（延迟抛出）+ chatFn 内的权威门。
  // 两次都抛，下一轮自救后自然放行。
  const err = () => {
    throw new ContextBudgetError('FIXED_CONTEXT_TOO_LARGE', needed, budget);
  };
  mockEnforceContextBudget.mockImplementationOnce(err).mockImplementationOnce(err);
}

async function assistantText(useChatStore: { getState: () => { conversations: Record<string, { messages: Message[] }> } }, conversationId: string) {
  const conversation = useChatStore.getState().conversations[conversationId];
  return conversation.messages
    .filter((message) => message.role === 'assistant')
    .map((message) => typeof message.content === 'string' ? message.content : '')
    .join('\n');
}

describe('窗口放不下说明时的自救（FIXED_CONTEXT_TOO_LARGE）', () => {
  it('Ollama 未钉死长度：自动调大 num_ctx 继续本任务，重试请求带上调大的长度', async () => {
    const { useChatStore, chat, restore } = await setup({});
    // 32768 的窗口不触发压缩；门 mock 第一次调用就抛
    mockProbeContextWindow.mockResolvedValue(32768);
    throwFixedTooLargeForFailedTurn(31000, 24000);
    try {
      const conversationId = useChatStore.getState().createConversation();
      await runAgentLoop(conversationId, 'hello');

      // 说明约需 31K、预算 24K → headroom 6K → 37K，按 1024 对齐 = 37888
      expect(chat).toHaveBeenCalledTimes(1);
      expect((chat.mock.calls[0][1] as { requestedContextLength?: number }).requestedContextLength).toBe(37888);
      const text = await assistantText(useChatStore, conversationId);
      // 测试环境语言钉在 en-US（TESTING.md：英文工具文案是契约）
      expect(text).toContain('raised it to 37K');
      expect(text).toContain('ok');
    } finally {
      restore();
    }
  });

  it('用户钉死了长度：不碰用户的值，切到下一个候选模型继续', async () => {
    const { useChatStore, chat, restore } = await setup({
      pinned: 32768,
      favorites: [{ providerId: 'ollama', modelId: 'big-model' }],
      extraModels: ['big-model'],
    });
    throwFixedTooLargeForFailedTurn(31000, 24000);
    try {
      const conversationId = useChatStore.getState().createConversation();
      await runAgentLoop(conversationId, 'hello');

      expect(chat).toHaveBeenCalledTimes(1);
      expect((chat.mock.calls[0][1] as { model: string }).model).toBe('big-model');
      const text = await assistantText(useChatStore, conversationId);
      expect(text).toContain('switching to ollama/big-model');
      // 走的是 Escape B，不是 num_ctx 自救
      expect(text).not.toContain('raised it to');
    } finally {
      restore();
    }
  });

  it('没有候选模型时按错误结束，提示带上需要的和现有的数字', async () => {
    const { useChatStore, chat, restore } = await setup({ pinned: 32768 });
    throwFixedTooLargeForFailedTurn(31000, 24000);
    try {
      const conversationId = useChatStore.getState().createConversation();
      const result = await runAgentLoop(conversationId, 'hello');

      // 链是空的：一次 chat 都没有发生，运行按错误结束
      expect(chat).not.toHaveBeenCalled();
      expect(result.reason).toBe('error');
      const text = await assistantText(useChatStore, conversationId);
      // needed 31000 → 31K；window = 31000 + 24000 = 55000 → 55K（en-US 文案）
      expect(text).toContain('about 31K tokens');
      expect(text).toContain('only 55K');
    } finally {
      restore();
    }
  });
});
