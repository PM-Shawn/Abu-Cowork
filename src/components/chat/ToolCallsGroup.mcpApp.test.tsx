// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { initLanguage } from '@/i18n';
import type { ToolCall, ToolDefinition } from '@/types';

const mcp = vi.hoisted(() => ({
  getConnectedServers: vi.fn<() => string[]>(() => []),
  getServerTools: vi.fn<(s: string) => ToolDefinition[]>(() => []),
  getAppTool: vi.fn<(s: string, t: string) => ToolDefinition | undefined>(() => undefined),
  isConnected: vi.fn(() => false),
  readResource: vi.fn(async () => ({ mimeType: 'text/html;profile=mcp-app', text: '<html></html>', isMcpApp: true })),
}));
vi.mock('@/core/mcp/client', () => ({ mcpManager: mcp }));

const setToolCallAppUi = vi.hoisted(() => vi.fn());
vi.mock('@/stores/chatStore', () => ({
  useChatStore: Object.assign(
    (selector: (s: unknown) => unknown) => selector({ setToolCallAppUi }),
    { getState: () => ({ setToolCallAppUi, appendPendingInput: vi.fn() }) },
  ),
}));

import ToolCallsGroup, { resolveToolCallAppUi } from './ToolCallsGroup';

function toolDef(name: string, ui?: ToolDefinition['ui']): ToolDefinition {
  return {
    name,
    description: '',
    inputSchema: { type: 'object', properties: {} },
    execute: async () => '',
    ...(ui ? { ui } : {}),
  };
}

const step: ToolCall = {
  id: 'tc-app',
  name: 'weather__forecast',
  input: { city: 'Beijing' },
  result: '25C',
};

describe('ToolCallsGroup · MCP Apps dispatch', () => {
  beforeEach(() => {
    initLanguage('zh-CN');
    vi.clearAllMocks();
    mcp.getConnectedServers.mockReturnValue([]);
    mcp.getServerTools.mockReturnValue([]);
    mcp.getAppTool.mockReturnValue(undefined);
    mcp.isConnected.mockReturnValue(false);
  });
  afterEach(cleanup);

  it('renders nothing extra for a plain tool step', async () => {
    await act(async () => {
      render(<ToolCallsGroup toolCalls={[{ id: 't', name: 'read_file', input: {}, result: 'ok' }]} conversationId="c" messageId="m" />);
    });
    expect(screen.queryByTestId('mcp-app-block')).toBeNull();
  });

  it('renders an app block for a step whose MCP tool declares a ui:// resource', async () => {
    mcp.getConnectedServers.mockReturnValue(['weather']);
    mcp.getServerTools.mockReturnValue([
      toolDef('weather__forecast', { resourceUri: 'ui://weather/view.html', visibility: ['model', 'app'] }),
    ]);
    await act(async () => {
      render(<ToolCallsGroup toolCalls={[step]} conversationId="c" messageId="m" />);
    });
    expect(screen.getByTestId('mcp-app-block')).toBeInTheDocument();
  });

  it('persists the resolved ui onto the step so replay does not need the server', async () => {
    mcp.getConnectedServers.mockReturnValue(['weather']);
    mcp.getServerTools.mockReturnValue([
      toolDef('weather__forecast', { resourceUri: 'ui://weather/view.html', visibility: ['model', 'app'] }),
    ]);
    await act(async () => {
      render(<ToolCallsGroup toolCalls={[step]} conversationId="c" messageId="m" />);
    });
    expect(setToolCallAppUi).toHaveBeenCalledWith('c', 'm', 'tc-app', {
      server: 'weather',
      resourceUri: 'ui://weather/view.html',
    });
  });

  it('replays from the persisted ui without asking a disconnected server', async () => {
    await act(async () => {
      render(
        <ToolCallsGroup
          toolCalls={[{ ...step, ui: { server: 'weather', resourceUri: 'ui://weather/view.html' } }]}
          conversationId="c"
          messageId="m"
        />,
      );
    });
    expect(screen.getByTestId('mcp-app-block')).toBeInTheDocument();
    expect(screen.getByTestId('mcp-app-status')).toHaveTextContent('连接 weather 以显示界面');
    expect(setToolCallAppUi).not.toHaveBeenCalled();
    expect(mcp.getServerTools).not.toHaveBeenCalled();
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
