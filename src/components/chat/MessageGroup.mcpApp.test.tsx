// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />

/**
 * MCP Apps dispatch — from the surface that actually renders assistant turns.
 *
 * These cases used to live on `ToolCallsGroup`, where they all passed while the
 * feature was invisible in the product: a model's tool steps reach the
 * transcript through `MessageGroup`, and `MessageGroup` only ever renders
 * `MessageBubble` in `actionsOnly` mode for an assistant message — which
 * returns before the `ToolCallsGroup` branch. So the block is wired here, and
 * the tests that guard it have to render THIS component.
 *
 * Two properties beyond "a block appears" are load-bearing and pinned below:
 *   - the block sits OUTSIDE the work fold, because auto-collapse unmounts the
 *     fold's process segments and would take the iframe, the bridge and the
 *     app's own state with them;
 *   - resolution re-runs when a connector connects later, because
 *     `resolveToolCallAppUi` asks the live MCP client.
 */
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { initLanguage } from '@/i18n';
import { useChatStore } from '@/stores/chatStore';
import { useMCPStore } from '@/stores/mcpStore';
import { useTaskExecutionStore } from '@/stores/taskExecutionStore';
import { makeWorkProcessFoldKey, useWorkProcessFoldStore } from '@/stores/workProcessFoldStore';
import type { Conversation, Message, ToolCall, ToolDefinition } from '@/types';
import type { ExecutionStepSnapshot } from '@/types/execution';

const mcp = vi.hoisted(() => ({
  getConnectedServers: vi.fn<() => string[]>(() => []),
  getServerTools: vi.fn<(s: string) => ToolDefinition[]>(() => []),
  getAppTool: vi.fn<(s: string, t: string) => ToolDefinition | undefined>(() => undefined),
  isConnected: vi.fn((_s: string) => false),
  readResource: vi.fn(async () => ({
    mimeType: 'text/html;profile=mcp-app',
    text: '<html><head></head><body>app</body></html>',
    isMcpApp: true,
  })),
  callTool: vi.fn(async () => ''),
  takeRawAppResult: vi.fn(() => undefined),
  readServerResource: vi.fn(async () => ({})),
  listServerResources: vi.fn(async () => ({ resources: [] })),
}));
vi.mock('@/core/mcp/client', () => ({ mcpManager: mcp }));

/** Props every mounted block received, in mount order — the real component
 *  still renders, this only taps the wiring on its way in. */
const blockProps = vi.hoisted(() => [] as Record<string, unknown>[]);
vi.mock('./McpAppBlock', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./McpAppBlock')>();
  return {
    ...actual,
    default: (props: Record<string, unknown>) => {
      blockProps.push(props);
      return createElement(actual.default, props as never);
    },
  };
});

import MessageGroup from './MessageGroup';
import { resolveToolCallAppUi } from '@/core/mcp/appHost';

const CONV_ID = 'conv-mcp-app';
const LOOP_ID = 'loop-mcp-app';

function toolDef(name: string, ui?: ToolDefinition['ui']): ToolDefinition {
  return {
    name,
    description: '',
    inputSchema: { type: 'object', properties: {} },
    execute: async () => '',
    ...(ui ? { ui } : {}),
  };
}

const appCall: ToolCall = {
  id: 'tc-app',
  name: 'weather__forecast',
  input: { city: 'Beijing' },
  result: '25C',
};
const plainCall: ToolCall = { id: 'tc-plain', name: 'read_file', input: {}, result: 'ok' };

const PERSISTED_STEPS: ExecutionStepSnapshot[] = [
  {
    id: 'step-1',
    toolCallId: 'tc-plain',
    type: 'file-read',
    label: 'Read notes.txt',
    status: 'completed',
    toolName: 'read_file',
    duration: 2,
    detailBlocks: [],
  },
];

/**
 * A settled turn in its on-disk shape: tool calls on one assistant message, a
 * final text answer on the next. The trailing answer is what gives the group a
 * work fold at all (`workFoldEnd != null`), which the collapse case needs.
 */
function buildMessages(toolCalls: ToolCall[]): Message[] {
  return [
    {
      id: 'user-1',
      role: 'user',
      content: 'show me the table',
      timestamp: 1_000,
      loopId: LOOP_ID,
      runState: 'completed',
      runEndedAt: 3_000,
    },
    {
      id: 'a-tools',
      role: 'assistant',
      content: '',
      timestamp: 1_500,
      loopId: LOOP_ID,
      toolCalls,
    },
    {
      id: 'a-final',
      role: 'assistant',
      content: 'done',
      timestamp: 2_000,
      loopId: LOOP_ID,
      // A persisted step is what gives the group a process segment, and a
      // process segment plus the trailing answer is what creates the work fold.
      executionSteps: PERSISTED_STEPS,
    },
  ];
}

async function renderGroup(toolCalls: ToolCall[]) {
  const messages = buildMessages(toolCalls);
  const conversation: Conversation = {
    id: CONV_ID,
    title: 'MCP Apps',
    messages,
    createdAt: 1_000,
    updatedAt: 3_000,
    status: 'idle',
  };
  useChatStore.setState({
    activeConversationId: CONV_ID,
    conversations: { [CONV_ID]: conversation },
    agentStates: new Map(),
  });
  let view!: ReturnType<typeof render>;
  await act(async () => {
    view = render(<MessageGroup conversationId={CONV_ID} messages={messages} isLastGroup />);
    await Promise.resolve();
  });
  await act(async () => { await Promise.resolve(); });
  return view;
}

/** Arm the MCP client + store so `weather` looks freshly connected. */
function connectWeather(ui = 'ui://weather/view.html') {
  mcp.getConnectedServers.mockReturnValue(['weather']);
  mcp.getServerTools.mockReturnValue([
    toolDef('weather__forecast', { resourceUri: ui, visibility: ['model', 'app'] }),
  ]);
  mcp.isConnected.mockReturnValue(true);
  useMCPStore.setState({ servers: { weather: { config: { name: 'weather' }, status: 'connected', tools: [] } } });
}

describe('MessageGroup · MCP Apps dispatch', () => {
  beforeEach(() => {
    initLanguage('zh-CN');
    vi.clearAllMocks();
    blockProps.length = 0;
    mcp.getConnectedServers.mockReturnValue([]);
    mcp.getServerTools.mockReturnValue([]);
    mcp.getAppTool.mockReturnValue(undefined);
    mcp.isConnected.mockReturnValue(false);
    useMCPStore.setState({ servers: {} });
    useWorkProcessFoldStore.getState().reset();
    useTaskExecutionStore.setState({ executions: new Map() } as never);
  });
  afterEach(() => {
    cleanup();
    useMCPStore.setState({ servers: {} });
    useWorkProcessFoldStore.getState().reset();
  });

  it('renders nothing extra for a plain tool step', async () => {
    await renderGroup([plainCall]);
    expect(screen.queryByTestId('mcp-app-block')).toBeNull();
  });

  it('renders exactly one block for the app step and none for the plain one', async () => {
    connectWeather();
    await renderGroup([appCall, plainCall]);

    const blocks = screen.getAllByTestId('mcp-app-block');
    expect(blocks).toHaveLength(1);
    // Every mount/render that happened was for the app step; the plain step
    // never produced one. (The wrapper records per render, not per mount.)
    expect(new Set(blockProps.map((p) => p['toolCallId']))).toEqual(new Set(['tc-app']));
  });

  it('hands the block the active conversation id and its owning message', async () => {
    connectWeather();
    await renderGroup([appCall]);

    expect(blockProps[0]).toMatchObject({
      conversationId: CONV_ID,
      messageId: 'a-tools',
      toolCallId: 'tc-app',
      server: 'weather',
      resourceUri: 'ui://weather/view.html',
      toolName: 'weather__forecast',
    });
  });

  it('files the block against the group’s OWN conversation, not the active one', async () => {
    connectWeather();
    const messages = buildMessages([appCall]);
    const conversation: Conversation = {
      id: CONV_ID,
      title: 'MCP Apps',
      messages,
      createdAt: 1_000,
      updatedAt: 3_000,
      status: 'idle',
    };
    // The store points somewhere else. Approvals, `modelContext` and the
    // persisted `ui` must all follow the PROP — the conversation this group
    // actually belongs to.
    useChatStore.setState({
      activeConversationId: 'conv-elsewhere',
      conversations: { [CONV_ID]: conversation },
      agentStates: new Map(),
    });
    await act(async () => {
      render(<MessageGroup conversationId={CONV_ID} messages={messages} isLastGroup />);
      await Promise.resolve();
    });
    await act(async () => { await Promise.resolve(); });

    expect(blockProps[0]).toMatchObject({ conversationId: CONV_ID, toolCallId: 'tc-app' });
    const stored = useChatStore.getState().conversations[CONV_ID]
      .messages.find((m) => m.id === 'a-tools')?.toolCalls?.[0];
    expect(stored?.ui).toEqual({ server: 'weather', resourceUri: 'ui://weather/view.html' });
  });

  it('persists the resolved ui onto the step so replay does not need the server', async () => {
    connectWeather();
    await renderGroup([appCall]);

    const stored = useChatStore.getState().conversations[CONV_ID]
      .messages.find((m) => m.id === 'a-tools')?.toolCalls?.[0];
    expect(stored?.ui).toEqual({ server: 'weather', resourceUri: 'ui://weather/view.html' });
  });

  it('replays from the persisted ui without asking a disconnected server', async () => {
    await renderGroup([{ ...appCall, ui: { server: 'weather', resourceUri: 'ui://weather/view.html' } }]);

    expect(screen.getByTestId('mcp-app-block')).toBeInTheDocument();
    expect(screen.getByTestId('mcp-app-status')).toHaveTextContent('连接 weather 以显示界面');
    expect(mcp.getServerTools).not.toHaveBeenCalled();
  });

  // 🔴 The reason the block is not rendered inside the work fold: auto-collapse
  // drops every process segment from the tree, which would destroy the iframe,
  // the bridge and whatever state the app had built up.
  it('survives the work fold collapsing, as the same DOM node', async () => {
    connectWeather();
    await renderGroup([appCall, plainCall]);

    const before = screen.getByTestId('mcp-app-block');
    const foldHeader = screen.getByRole('button', { name: /用时/ });
    const foldKey = makeWorkProcessFoldKey(CONV_ID, LOOP_ID, 'user-1', 'a-tools');

    // A settled group auto-collapses on mount (`autoCollapseHandled`), which is
    // precisely the state that used to take the interface down with it: the
    // process segment is not merely hidden, it is unmounted.
    expect(foldHeader).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('读取了文件')).toBeNull();
    expect(screen.getByTestId('mcp-app-block')).toBe(before);

    await act(async () => {
      useWorkProcessFoldStore.getState().setMode(CONV_ID, foldKey, 'expanded');
      await Promise.resolve();
    });
    // The expanded fold shows the task card for the plain step ("读取了文件").
    expect(screen.getByText('读取了文件')).toBeInTheDocument();
    expect(screen.getByTestId('mcp-app-block')).toBe(before);

    await act(async () => {
      useWorkProcessFoldStore.getState().setMode(CONV_ID, foldKey, 'collapsed');
      await Promise.resolve();
    });
    expect(foldHeader).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('读取了文件')).toBeNull();
    // Same node across both fold transitions: React never unmounted it, so the
    // iframe, the bridge and the app's state are all still the originals.
    expect(screen.getByTestId('mcp-app-block')).toBe(before);
  });

  // 🟠 The bug this pins: `resolveToolCallAppUi` reads the live MCP client, so a
  // memo keyed only on the tool calls never re-runs when the connector finishes
  // connecting after the conversation was opened — the interface would stay
  // absent forever.
  it('picks the interface up when the connector connects after the group rendered', async () => {
    mcp.getConnectedServers.mockReturnValue([]);
    useMCPStore.setState({ servers: { weather: { config: { name: 'weather' }, status: 'connecting', tools: [] } } });
    await renderGroup([appCall]);
    expect(screen.queryByTestId('mcp-app-block')).toBeNull();

    await act(async () => {
      connectWeather();
      await Promise.resolve();
    });
    await act(async () => { await Promise.resolve(); });

    expect(screen.getByTestId('mcp-app-block')).toBeInTheDocument();
    expect(blockProps.at(-1)).toMatchObject({ server: 'weather', resourceUri: 'ui://weather/view.html' });
  });

  describe('resolveToolCallAppUi', () => {
    it('falls back to app-only tools, which never appear in getServerTools', () => {
      mcp.getConnectedServers.mockReturnValue(['weather']);
      mcp.getServerTools.mockReturnValue([]);
      mcp.getAppTool.mockReturnValue(
        toolDef('weather__panel', { resourceUri: 'ui://weather/panel.html', visibility: ['app'] }),
      );
      expect(resolveToolCallAppUi({ id: 'x', name: 'weather__panel', input: {} })).toEqual({
        server: 'weather',
        resourceUri: 'ui://weather/panel.html',
      });
    });

    it('returns undefined when the server is gone', () => {
      mcp.getConnectedServers.mockReturnValue([]);
      expect(resolveToolCallAppUi({ id: 'x', name: 'weather__panel', input: {} })).toBeUndefined();
    });

    it('returns undefined for an MCP tool without an interface', () => {
      mcp.getConnectedServers.mockReturnValue(['weather']);
      mcp.getServerTools.mockReturnValue([toolDef('weather__forecast')]);
      expect(resolveToolCallAppUi({ id: 'x', name: 'weather__forecast', input: {} })).toBeUndefined();
    });
  });
});
