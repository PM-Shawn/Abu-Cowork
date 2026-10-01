import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolDefinition } from '../../types';
import { resetCalibration } from '../context/tokenEstimator';
import { executeAnyTool } from '../tools/registry';
import { useChatStore } from '../../stores/chatStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { runAgentLoop } from './agentLoop';
import { runSubagentLoop } from './subagentLoop';
import { getToolInvoker, setToolInvoker, type ToolInvoker } from './ports/toolInvoker';

// 本地服务商运行开始会询问窗口；测试里不发真实请求
const { mockProbeContextWindow, mockFetch } = vi.hoisted(() => ({
  mockProbeContextWindow: vi.fn(),
  mockFetch: vi.fn(),
}));
vi.mock('../llm/contextWindowProbe', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../llm/contextWindowProbe')>()),
  probeContextWindow: mockProbeContextWindow,
}));
// Ollama 适配器真实运行（含正文里写出的操作的识别），只替换网络请求
vi.mock('../llm/tauriFetch', () => ({ getTauriFetch: () => Promise.resolve(mockFetch) }));

interface OllamaRequestBody {
  tools?: Array<{ function: { name: string } }>;
  messages: Array<{ role: string; content: string; tool_name?: string }>;
}

const requests: OllamaRequestBody[] = [];

function ndjson(content: string): Response {
  const lines = [
    { model: 'llama3.2', message: { role: 'assistant', content } },
    { model: 'llama3.2', done: true, done_reason: 'stop', prompt_eval_count: 10, eval_count: 5 },
  ];
  return new Response(`${lines.map((line) => JSON.stringify(line)).join('\n')}\n`, {
    status: 200,
    headers: { 'Content-Type': 'application/x-ndjson' },
  });
}

/** 带工具的请求：还没有工具结果时写出操作，拿到工具结果后结束；其余请求（如标题）只回文字。 */
function answerWith(firstTurnContent: string): void {
  mockFetch.mockImplementation(async (url: string, init: { body: string }) => {
    if (!url.endsWith('/api/chat')) throw new Error(`unexpected request: ${url}`);
    const body = JSON.parse(init.body) as OllamaRequestBody;
    requests.push(body);
    if (!body.tools) return ndjson('title');
    if (body.messages.some((message) => message.role === 'tool')) return ndjson('done');
    return ndjson(firstTurnContent);
  });
}

function textCall(name: string, args: Record<string, unknown>): string {
  return `<tool_call>{"name": "${name}", "arguments": ${JSON.stringify(args)}}</tool_call>`;
}

function toolResult(name: string): string | undefined {
  for (const body of requests) {
    const message = body.messages.find((m) => m.role === 'tool' && m.tool_name === name);
    if (message) return message.content;
  }
  return undefined;
}

function sentToolNames(): string[] {
  const first = requests.find((body) => body.tools);
  return (first?.tools ?? []).map((tool) => tool.function.name).sort();
}

function makeTool(name: string): ToolDefinition {
  return {
    name,
    description: name,
    inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
    execute: async () => 'ok',
  };
}

const available = (names: string) =>
  `Available tools: ${names}. Call one of them again with its exact name.`;

describe('an unknown tool name answers with the tools this run offered', () => {
  const originalInvoker = getToolInvoker();
  let settings: ReturnType<typeof useSettingsStore.getState>;
  let invoker: ToolInvoker;

  beforeAll(async () => {
    await import('./subagentRunner');
  });

  beforeEach(() => {
    mockProbeContextWindow.mockReset();
    mockProbeContextWindow.mockResolvedValue(undefined);
    mockFetch.mockReset();
    requests.length = 0;
    // 跑过的用例会按上报的用量校准估算比例（模块级状态），不清掉会影响后面的用例
    resetCalibration();
    settings = useSettingsStore.getState();
    useSettingsStore.setState({
      activeModel: { providerId: 'ollama', modelId: 'llama3.2' },
      providers: settings.providers.map((p) =>
        p.id === 'ollama'
          ? { ...p, enabled: true, models: [...p.models.filter((m) => m.id !== 'llama3.2'), { id: 'llama3.2', label: 'llama3.2', contextWindow: 65536 }] }
          : p),
    });
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { callback(0); return 0; });
    // 工具结果由真实的 executeAnyTool 生成
    invoker = {
      getAllTools: () => ['read_file', 'write_file', 'ghost_tool'].map(makeTool),
      executeAnyTool: vi.fn(executeAnyTool),
      toolResultToString: String,
    };
    setToolInvoker(invoker);
  });

  afterEach(() => {
    setToolInvoker(originalInvoker);
    useSettingsStore.setState({ activeModel: settings.activeModel, providers: settings.providers });
    vi.unstubAllGlobals();
  });

  it('main loop, operation written into the reply: lists the sent tools and the deferred ones', async () => {
    answerWith(textCall('reed_file', { path: 'a.txt' }));
    const conversationId = useChatStore.getState().createConversation();

    const result = await runAgentLoop(conversationId, 'read a.txt');

    expect(result.reason).toBe('completed');
    // ghost_tool 没有随请求发送，作为延后加载的工具写在系统说明里
    expect(sentToolNames()).toEqual(['read_file', 'write_file']);
    const firstWithTools = requests.find((body) => body.tools)!;
    expect(firstWithTools.messages.find((m) => m.role === 'system')?.content).toContain('ghost_tool');
    expect(toolResult('reed_file')).toBe(`Error: Unknown tool "reed_file". ${available('ghost_tool, read_file, write_file')}`);
  });

  it('main loop leaves out the tools this run blocked', async () => {
    answerWith(textCall('reed_file', { path: 'a.txt' }));
    const conversationId = useChatStore.getState().createConversation();

    const result = await runAgentLoop(conversationId, 'read a.txt', { blockedTools: ['write_file', 'ghost_tool'] });

    expect(result.reason).toBe('completed');
    expect(sentToolNames()).toEqual(['read_file']);
    expect(toolResult('reed_file')).toBe(`Error: Unknown tool "reed_file". ${available('read_file')}`);
  });

  it('subagent loop lists only the tools offered to that agent', async () => {
    answerWith(textCall('reed_file', { path: 'a.txt' }) + textCall('ghost_tool', { path: 'a.txt' }));
    const agent = { name: 'helper', description: 'helps', systemPrompt: 'help', tools: ['read_file', 'ghost_tool'], filePath: '__preset__' };

    const result = await runSubagentLoop({ agent, task: 'read a.txt', toolInvoker: invoker });

    expect(result.stopReason).toBe('completed');
    expect(sentToolNames()).toEqual(['ghost_tool', 'read_file']);
    // 没给过的名字在进入工具注册表之前就被拒绝
    expect(toolResult('reed_file')).toBe(
      `Error: tool "reed_file" is outside this agent's fixed tool boundary. ${available('ghost_tool, read_file')}`,
    );
    // 给过但注册表里找不到的名字由注册表回答，名单来自子代理自己的工具
    expect(toolResult('ghost_tool')).toBe(`Error: Unknown tool "ghost_tool". ${available('ghost_tool, read_file')}`);
  });
});
