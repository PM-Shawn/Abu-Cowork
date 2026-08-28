import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useChatStore } from '../stores/chatStore';
import { useSettingsStore } from '../stores/settingsStore';
import { setLoopContext, clearLoopContext } from '../core/agent/permissionBridge';
import { delegateToAgentTool } from '../core/tools/definitions/agentTools';
import { runAgentBatchTool } from '../core/tools/definitions/orchestrationTools';
import { registerBuiltinTools } from '../core/tools/builtins';
import { buildToolRosterUpdateMessage, runAgentLoop } from '../core/agent/agentLoop';
import { rebuildImageAttachments } from '../components/chat/imageAttachmentRebuild';
import { resolveFileSource } from '../core/session/outputSnapshots';
import { readFile } from '@tauri-apps/plugin-fs';
import type { MessageContent } from '../types';

const state = vi.hoisted(() => ({
  runtime: 'local' as 'local' | 'sidecar',
  media: new Map<string, Uint8Array>(),
  chats: [] as unknown[][],
  adapterCalls: [] as Array<{ messages: unknown[]; options: unknown }>,
  sidecarRequests: [] as unknown[],
  modelDelegates: false,
  modelCallCount: 0,
}));

vi.mock('../core/llm/selectChatAdapter', () => ({
  selectChatAdapter: () => ({
    chat: async (messages: unknown[], options: unknown, onEvent: (event: { type: string; text?: string; stopReason?: string; id?: string; name?: string; input?: Record<string, unknown> }) => void) => {
      state.chats.push(messages);
      state.adapterCalls.push({ messages, options });
      state.modelCallCount++;
      if (state.modelDelegates && state.modelCallCount === 1) {
        onEvent({ type: 'tool_use', id: 'delegate-from-model', name: 'delegate_to_agent', input: { type: 'research', task: 'Describe the ordered source content.' } });
        onEvent({ type: 'done', stopReason: 'tool_use' });
        return;
      }
      onEvent({ type: 'text', text: 'child complete' });
      onEvent({ type: 'done', stopReason: 'end_turn' });
    },
  }),
}));

// Keep the real agentLoop direct-delegation branch while making its route
// deterministic. This is intentionally not a subagent-loop or materializer
// mock: agentLoop itself persists the triggering image turn and materializes
// it before dispatching the child.
vi.mock('../core/agent/orchestrator', async () => {
  const actual = await vi.importActual<typeof import('../core/agent/orchestrator')>('../core/agent/orchestrator');
  return {
    ...actual,
    routeInput: vi.fn((input: string) => input.startsWith('@researcher')
      ? { type: 'delegate', cleanInput: 'Describe it.', name: 'researcher', delegateAgent: {
        name: 'researcher', description: 'test', systemPrompt: 'test', filePath: '__preset__',
      } }
      : { type: 'general', cleanInput: input, name: 'abu' }),
  };
});

vi.mock('../core/subagent/delegatedMediaStore', () => ({
  persistDelegatedMedia: vi.fn(async (_conversationId: string, input: { mediaType: string; bytes: Uint8Array }) => {
    const id = `media-${state.media.size + 1}`;
    state.media.set(id, input.bytes);
    return { id, sha256: 'a'.repeat(64), mediaType: input.mediaType, bytes: input.bytes.byteLength };
  }),
  readDelegatedMedia: vi.fn(async (_conversationId: string, ref: { id: string }) => state.media.get(ref.id) ?? null),
}));

vi.mock('../core/session/outputSnapshots', () => ({
  resolveFileSource: vi.fn(),
}));

// This is deliberately a transport-only substitute: when the selector says
// sidecar, the shell serializes through runSubagent and this request enters the
// real sidecar host, which runs the real child loop. No host/loop/materializer
// seam is mocked by this harness.
vi.mock('../core/sidecar/sidecarManager', () => ({
  getSidecarStatus: () => state.runtime === 'sidecar' ? 'running' : 'stopped',
  request: async (method: string, params: unknown) => {
    if (method !== 'subagent.run') throw new Error(`unexpected sidecar request: ${method}`);
    // Model the framed IPC contract, not a convenient in-memory function
    // call: both the request and response must survive JSON round-tripping.
    const wireParams = JSON.parse(JSON.stringify(params));
    state.sidecarRequests.push(wireParams);
    const { handleSubagentRun } = await import('../../sidecar/src/subagentHost');
    return JSON.parse(JSON.stringify(await handleSubagentRun(wireParams)));
  },
  notifySidecar: vi.fn(),
  onSidecarRequest: vi.fn(),
  onSidecarNotification: vi.fn(),
  SidecarRequestError: class SidecarRequestError extends Error {},
}));

vi.mock('../../sidecar/src/rpcClient', () => ({ sendRequest: vi.fn(), sendNotification: vi.fn() }));
vi.mock('../../sidecar/src/agentLoopHost', () => ({ findActiveRunDeltaForConversation: vi.fn() }));

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLkwwAAAABJRU5ErkJggg==';
function installSourceTurn() {
  const conversationId = useChatStore.getState().createConversation();
  const loopId = `loop-${conversationId}`;
  useChatStore.getState().addMessage(conversationId, {
    id: `user-${conversationId}`,
    role: 'user',
    loopId,
    timestamp: 0,
    content: [
      { type: 'text', text: 'Inspect this image.' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG } },
      { type: 'text', text: 'Keep ordering.' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG } },
    ],
  });
  useChatStore.getState().addMessage(conversationId, buildToolRosterUpdateMessage({
    id: `roster-${conversationId}`,
    loopId,
    timestamp: 1,
    addedToolNames: ['delegate_to_agent'],
    removedToolNames: ['run_agent_batch'],
  }));
  setLoopContext(loopId, {
    loopId, conversationId, signal: new AbortController().signal,
    commandConfirmCallback: async () => true, filePermissionCallback: async () => true,
    eventRouter: { getCurrentStepId: () => undefined, addChildStepToDelegate: () => undefined, completeChildStep: () => undefined, route: vi.fn() } as never,
    toolCallToStepId: new Map(),
  });
  return { conversationId, loopId };
}

function childUserContent(index = 0) {
  const first = state.chats[index] as Array<{ role: string; content: unknown }>;
  const user = first.find((message) => message.role === 'user');
  expect(Array.isArray(user?.content)).toBe(true);
  return user?.content as Array<{ type: string; text?: string; source?: { media_type?: string } }>;
}

function expectOrderedChildContent(task: string, index = 0) {
  expect(childUserContent(index).map((block) => (
    block.type === 'image' ? `image:${block.source?.media_type}` : `text:${block.text}`
  ))).toEqual([
    'text:Inspect this image.',
    'image:image/png',
    'text:Keep ordering.',
    'image:image/png',
    `text:${task}`,
  ]);
}

function childContentForTask(task: string) {
  const childCall = state.adapterCalls.find(({ options }) => (
    (options as { systemPrompt?: string }).systemPrompt?.includes('professional research assistant')
  ));
  expect(childCall).toBeDefined();
  const user = (childCall?.messages as Array<{ role: string; content: unknown }>).find((message) => message.role === 'user');
  expect(Array.isArray(user?.content)).toBe(true);
  expect(user?.content.at(-1)).toMatchObject({ type: 'text', text: task });
  return user?.content as Array<{ type: string; text?: string; source?: { media_type?: string } }>;
}

describe('multimodal delegation route × runtime matrix', () => {
  beforeEach(() => {
    state.chats.length = 0;
    state.adapterCalls.length = 0;
    state.media.clear();
    state.sidecarRequests.length = 0;
    state.modelDelegates = false;
    state.modelCallCount = 0;
    vi.mocked(resolveFileSource).mockReset();
    vi.mocked(readFile).mockReset();
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(0);
      return 0;
    });
    // The direct tool tests invoke definitions themselves. The model-emitted
    // path resolves its tool through the real registry, so register the app
    // roster instead of replacing executeToolBatch or the tool definition.
    registerBuiltinTools();
    // The real agentLoop performs its provider-key gate before it reaches the
    // direct @agent branch. Use its built-in local-provider exemption; the
    // adapter itself remains the deterministic provider double above.
    useSettingsStore.setState({ activeModel: { providerId: 'ollama', modelId: 'llama3.2' } } as never);
  });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  it.each(['local', 'sidecar'] as const)('direct @agent reaches the child adapter with image content (%s)', async (runtime) => {
    state.runtime = runtime;
    const conversationId = useChatStore.getState().createConversation();
    await runAgentLoop(conversationId, '@researcher Describe it.', {
      images: [{ id: 'image-1', data: PNG, mediaType: 'image/png' }],
    });
    // Composer-generated @agent input is routed through the real orchestrator
    // and retains the attached image; the task block remains last.
    expect(childUserContent().map((block) => (
      block.type === 'image' ? `image:${block.source?.media_type}` : `text:${block.text}`
    ))).toEqual([
      'image:image/png',
      'text:Describe it.',
      'text:Describe it.',
    ]);
  });

  it.each(['local', 'sidecar'] as const)('post-restart retry direct @agent rehydrates stripped image before delegation (%s)', async (runtime) => {
    state.runtime = runtime;
    vi.mocked(resolveFileSource).mockResolvedValue({
      status: 'available',
      path: '/Users/tester/.abu/conversations/conv-1/outputs/files/hash/retry.png',
      isFromSnapshot: true,
    });
    vi.mocked(readFile).mockResolvedValue(new Uint8Array([137, 80, 78, 71]));
    const persistedRetryContent: MessageContent[] = [
      {
        type: 'image',
        source: { type: 'base64', media_type: 'image/png', data: '' },
        filePath: '/Users/tester/private/retry.png',
      },
      { type: 'text', text: 'Describe it.' },
    ];
    const retryImages = rebuildImageAttachments(persistedRetryContent, `retry-${runtime}`);
    const conversationId = useChatStore.getState().createConversation();

    const result = await runAgentLoop(conversationId, '@researcher Describe it.', { images: retryImages });

    expect(result).toMatchObject({ reason: 'completed' });
    expect(state.chats).toHaveLength(1);
    const childContent = childUserContent();
    expect(childContent.map((block) => (
      block.type === 'image' ? `image:${block.source?.media_type}` : `text:${block.text}`
    ))).toEqual([
      'image:image/png',
      'text:Describe it.',
      'text:Describe it.',
    ]);
    const childImage = childContent.find((block) => block.type === 'image');
    expect(childImage?.source).toMatchObject({ media_type: 'image/png', data: 'iVBORw==' });
    const rehydrateCall = vi.mocked(resolveFileSource).mock.calls.find((call) => (
      call[0] === conversationId && call[1] === '/Users/tester/private/retry.png'
    ));
    expect(rehydrateCall).toBeDefined();
    expect(rehydrateCall?.slice(0, 2)).toEqual([
      conversationId,
      '/Users/tester/private/retry.png',
    ]);
    expect(rehydrateCall).toHaveLength(3);
    if (runtime === 'sidecar') {
      expect(state.sidecarRequests).toHaveLength(1);
      const serializedRequest = JSON.stringify(state.sidecarRequests[0]);
      expect(serializedRequest).not.toContain(PNG);
      expect(serializedRequest).not.toContain('iVBORw==');
    }
  });

  it.each(['local', 'sidecar'] as const)('delegate_to_agent reaches the child adapter with image content (%s)', async (runtime) => {
    state.runtime = runtime;
    const { conversationId, loopId } = installSourceTurn();
    await delegateToAgentTool.execute({ type: 'research', task: 'Describe it.' }, { conversationId, loopId } as never);
    expectOrderedChildContent('Describe it.');
    if (runtime === 'sidecar') {
      expect(JSON.stringify(state.sidecarRequests[0])).not.toContain(PNG);
    }
    clearLoopContext(loopId);
  });

  it.each(['local', 'sidecar'] as const)('run_agent_batch reaches every child adapter with image content (%s)', async (runtime) => {
    state.runtime = runtime;
    const { conversationId, loopId } = installSourceTurn();
    await runAgentBatchTool.execute({ tasks: [
      { type: 'research', task: 'Describe it.' },
      { type: 'writer', task: 'Summarize it.' },
    ] }, { conversationId, loopId, toolCallId: `batch-${runtime}` } as never);
    expect(state.chats).toHaveLength(2);
    expectOrderedChildContent('Describe it.', 0);
    expectOrderedChildContent('Summarize it.', 1);
    clearLoopContext(loopId);
  });

  it.each(['local', 'sidecar'] as const)('a model-emitted delegate_to_agent tool call reaches the child through the parent loop (%s)', async (runtime) => {
    state.runtime = runtime;
    state.modelDelegates = true;
    const conversationId = useChatStore.getState().createConversation();

    await runAgentLoop(conversationId, 'Inspect this image.', {
      images: [{ id: 'image-1', data: PNG, mediaType: 'image/png' }],
    });

    // Call 0 is the parent model turn, call 1 is the delegate, and call 2 is
    // the parent resuming after real toolExecutor handling.
    // This is intentionally not a direct delegateToAgentTool.execute() call.
    expect(state.chats).toHaveLength(3);
    const delegatedToolResult = useChatStore.getState().conversations[conversationId]?.messages
      .flatMap((message) => message.toolCalls ?? [])
      .find((toolCall) => toolCall.name === 'delegate_to_agent')?.result;
    expect(delegatedToolResult).toBe('child complete');
    expect(childContentForTask('Describe the ordered source content.').map((block) => (
      block.type === 'image' ? `image:${block.source?.media_type}` : `text:${block.text}`
    ))).toEqual([
      'image:image/png',
      'text:Inspect this image.',
      'text:Describe the ordered source content.',
    ]);
    if (runtime === 'sidecar') {
      expect(state.sidecarRequests).toHaveLength(1);
      expect(JSON.stringify(state.sidecarRequests[0])).not.toContain(PNG);
    }
  });
});
