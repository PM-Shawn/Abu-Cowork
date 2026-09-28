import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetCalibration } from '../context/tokenEstimator';
import { computerTool } from '../tools/definitions/computerTools';
import { STRUCTURED_COMPUTER_DESCRIPTION } from '../tools/definitions/computerToolText';
import { useChatStore } from '../../stores/chatStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { runAgentLoop } from './agentLoop';
import { getToolInvoker, setToolInvoker } from './ports/toolInvoker';

// 本地服务商运行开始会询问窗口；测试里不发真实请求
const { mockProbeContextWindow, mockFetch } = vi.hoisted(() => ({
  mockProbeContextWindow: vi.fn(),
  mockFetch: vi.fn(),
}));
vi.mock('../llm/contextWindowProbe', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../llm/contextWindowProbe')>()),
  probeContextWindow: mockProbeContextWindow,
}));
// Ollama 适配器真实运行，只替换网络请求
vi.mock('../llm/tauriFetch', () => ({ getTauriFetch: () => Promise.resolve(mockFetch) }));

interface OllamaTool {
  function: { name: string; description: string; parameters: { properties: Record<string, unknown> } };
}

interface OllamaRequestBody {
  tools?: OllamaTool[];
  messages: Array<{ role: string; content: string }>;
}

const requests: OllamaRequestBody[] = [];

function ndjson(content: string): Response {
  const lines = [
    { model: 'm', message: { role: 'assistant', content } },
    { model: 'm', done: true, done_reason: 'stop', prompt_eval_count: 10, eval_count: 5 },
  ];
  return new Response(`${lines.map((line) => JSON.stringify(line)).join('\n')}\n`, {
    status: 200,
    headers: { 'Content-Type': 'application/x-ndjson' },
  });
}

function firstToolRequest(): OllamaRequestBody {
  const body = requests.find((request) => request.tools);
  if (!body) throw new Error('no request carried tools');
  return body;
}

function sentComputerTool(): OllamaTool['function'] {
  const tool = firstToolRequest().tools?.find((candidate) => candidate.function.name === 'computer');
  if (!tool) throw new Error('computer tool was not sent');
  return tool.function;
}

function systemPrompt(): string {
  return firstToolRequest().messages.find((message) => message.role === 'system')?.content ?? '';
}

describe('computer tool and guidance follow whether the model can see images', () => {
  const originalInvoker = getToolInvoker();
  let settings: ReturnType<typeof useSettingsStore.getState>;

  function useOllamaModel(modelId: string): void {
    useSettingsStore.setState({
      computerUseEnabled: true,
      activeModel: { providerId: 'ollama', modelId },
      providers: settings.providers.map((p) =>
        p.id === 'ollama'
          ? { ...p, enabled: true, models: [...p.models.filter((m) => m.id !== modelId), { id: modelId, label: modelId, contextWindow: 65536 }] }
          : p),
    });
  }

  beforeEach(() => {
    mockProbeContextWindow.mockReset();
    mockProbeContextWindow.mockResolvedValue(undefined);
    mockFetch.mockReset();
    mockFetch.mockImplementation(async (url: string, init: { body: string }) => {
      if (!url.endsWith('/api/chat')) throw new Error(`unexpected request: ${url}`);
      requests.push(JSON.parse(init.body) as OllamaRequestBody);
      return ndjson('done');
    });
    requests.length = 0;
    // 跑过的用例会按上报的用量校准估算比例（模块级状态），不清掉会影响后面的用例
    resetCalibration();
    settings = useSettingsStore.getState();
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { callback(0); return 0; });
    setToolInvoker({
      getAllTools: () => [computerTool],
      executeAnyTool: vi.fn(),
      toolResultToString: String,
    });
  });

  afterEach(() => {
    setToolInvoker(originalInvoker);
    useSettingsStore.setState({
      computerUseEnabled: settings.computerUseEnabled,
      activeModel: settings.activeModel,
      providers: settings.providers,
    });
    vi.unstubAllGlobals();
  });

  it('a model that cannot see images gets the text-only tool and guidance', async () => {
    useOllamaModel('qwen3:8b');
    const conversationId = useChatStore.getState().createConversation();

    const result = await runAgentLoop(conversationId, 'open Notes');

    expect(result.reason).toBe('completed');
    const sent = sentComputerTool();
    expect(sent.description).toBe(STRUCTURED_COMPUTER_DESCRIPTION);
    expect(JSON.stringify(sent).toLowerCase()).not.toContain('screenshot');
    for (const key of ['x', 'y', 'startX', 'startY', 'endX', 'endY', 'path', 'screenshot_id']) {
      expect(sent.parameters.properties).not.toHaveProperty(key);
    }
    expect(systemPrompt()).toContain('The current model cannot see images');
    expect(systemPrompt()).not.toContain('computer(action="screenshot")');
  });

  it('a model that can see images keeps the screenshot tool and guidance', async () => {
    useOllamaModel('llama3.2');
    const conversationId = useChatStore.getState().createConversation();

    const result = await runAgentLoop(conversationId, 'open Notes');

    expect(result.reason).toBe('completed');
    const sent = sentComputerTool();
    expect(sent.description).toBe(computerTool.description);
    expect(sent.parameters.properties).toHaveProperty('screenshot_id');
    expect(systemPrompt()).toContain('To view the screen you must use computer(action="screenshot")');
  });
});
