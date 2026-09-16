// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />

/**
 * The approval half of the MCP App bridge, exercised through the REAL
 * `permissionBridge` → `approvalBridge` queue (only `checkToolApproval` is
 * stubbed, so the classifier graph stays out of a component test).
 *
 * What is being protected here: the command queue is single-active + FIFO and
 * its dialog is filtered by conversation. Anything an app leaves in that queue
 * that nobody can answer blocks every later confirmation — in every
 * conversation — behind an invisible dialog.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { initLanguage } from '@/i18n';
import { useMCPStore } from '@/stores/mcpStore';
import * as approvalBridge from '@/core/agent/ports/approvalBridge';
import type { AppBridgeHandlers } from '@/core/mcp/appBridgeHandlers';
import type { ToolDefinition } from '@/types';
import McpAppBlock, { resetMcpAppSlots, type McpAppBlockProps } from './McpAppBlock';

/** Stubbed so the test drives the confirmation callback directly instead of
 *  reproducing a plugin/browser/enterprise classification that would make it
 *  fire. Everything downstream of the callback is the real thing. */
vi.mock('@/core/tools/registry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/core/tools/registry')>();
  return {
    ...actual,
    checkToolApproval: async (
      name: string,
      _input: Record<string, unknown>,
      _ctx: unknown,
      onRequireConfirmation?: (info: { command: string; level: string; reason: string }) => Promise<boolean>,
    ) => {
      if (!onRequireConfirmation) {
        return { decision: 'deny', reason: 'Error: command confirmation is unavailable for this run' };
      }
      const confirmed = await onRequireConfirmation({ command: name, level: 'warn', reason: 'test' });
      return confirmed ? { decision: 'allow' } : { decision: 'deny', reason: 'Error: 用户已取消' };
    },
  };
});

const tool: ToolDefinition = {
  name: 'weather__search',
  description: 'search',
  inputSchema: { type: 'object', properties: { q: { type: 'string', description: 'q' } } },
  execute: async () => 'unused',
};

function renderBlock(over: Partial<McpAppBlockProps>, sink: { handlers?: Partial<AppBridgeHandlers> }) {
  const props: McpAppBlockProps = {
    toolCallId: 'tc-1',
    server: 'weather',
    resourceUri: 'ui://weather/view.html',
    input: {},
    result: 'ok',
    conversationId: 'conv-1',
    ...over,
    deps: {
      readResource: async () => ({ mimeType: 'text/html;profile=mcp-app', text: '<p>x</p>', isMcpApp: true }),
      isConnected: () => true,
      handshakeTimeoutMs: 0,
      isDark: () => false,
      findTool: () => tool,
      callTool: async () => 'executed',
      createSession: (options) => {
        sink.handlers = options.handlers;
        return {
          bridge: {} as never,
          isInitialized: () => true,
          whenInitialized: async () => true,
          sendToolInput: async () => {},
          sendToolResult: async () => {},
          sendToolCancelled: async () => {},
          sendHostContextChange: async () => {},
          teardown: async () => {},
        };
      },
      ...over.deps,
    },
  };
  return render(<McpAppBlock {...props} />);
}

async function settle() {
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
}

describe('McpAppBlock approvals', () => {
  beforeEach(() => {
    initLanguage('zh-CN');
    resetMcpAppSlots();
    useMCPStore.setState({ servers: {} });
  });
  afterEach(() => {
    cleanup();
    approvalBridge.drainAll('command');
    resetMcpAppSlots();
    useMCPStore.setState({ servers: {} });
  });

  it('cancels its outstanding confirmation on teardown, leaving the queue empty', async () => {
    const sink: { handlers?: Partial<AppBridgeHandlers> } = {};
    const callTool = vi.fn(async () => 'executed');
    const view = renderBlock({ deps: { callTool } }, sink);
    await settle();

    let pending!: Promise<unknown>;
    await act(async () => {
      pending = sink.handlers!.oncalltool!({ name: 'search', arguments: { q: 'a' } } as never);
      pending.catch(() => {});
      await Promise.resolve();
      await Promise.resolve();
    });

    // The dialog is up and addressed to this conversation.
    expect(approvalBridge.getSnapshot('command')).toMatchObject({ conversationId: 'conv-1' });

    await act(async () => { view.unmount(); await Promise.resolve(); });

    // Nothing left behind: the next confirmation, in any conversation, is free
    // to become active immediately.
    expect(approvalBridge.getSnapshot('command')).toBeNull();
    await expect(pending).rejects.toThrow('用户已取消');
    expect(callTool).not.toHaveBeenCalled();
  });

  it('never enqueues at all when the block has no conversation (fail closed)', async () => {
    const sink: { handlers?: Partial<AppBridgeHandlers> } = {};
    const callTool = vi.fn(async () => 'executed');
    renderBlock({ conversationId: undefined, deps: { callTool } }, sink);
    await settle();

    await expect(
      sink.handlers!.oncalltool!({ name: 'search', arguments: { q: 'a' } } as never),
    ).rejects.toThrow(/confirmation is unavailable/);
    expect(approvalBridge.getSnapshot('command')).toBeNull();
    expect(callTool).not.toHaveBeenCalled();
  });

  it('executes normally when the user confirms', async () => {
    const sink: { handlers?: Partial<AppBridgeHandlers> } = {};
    const callTool = vi.fn(async () => 'executed');
    renderBlock({ deps: { callTool } }, sink);
    await settle();

    let pending!: Promise<unknown>;
    await act(async () => {
      pending = sink.handlers!.oncalltool!({ name: 'search', arguments: { q: 'a' } } as never);
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => {
      approvalBridge.resolveActive('command', true);
      await pending;
    });
    expect(callTool).toHaveBeenCalledWith('weather', 'search', { q: 'a' });
  });
});
