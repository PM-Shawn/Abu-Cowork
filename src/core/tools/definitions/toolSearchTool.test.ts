import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolDefinition } from '../../../types';

const { getAllToolsMock, isWindowsMock } = vi.hoisted(() => ({ getAllToolsMock: vi.fn(), isWindowsMock: vi.fn(() => false) }));
vi.mock('../registry', () => ({ getAllTools: () => getAllToolsMock() }));
vi.mock('../../../utils/platform', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../utils/platform')>()),
  isWindows: () => isWindowsMock(),
}));

import { toolSearchTool } from './toolSearchTool';
import { computerTool } from './computerTools';
import { structuredComputerDescription } from './computerToolText';

function makeTool(name: string, description = `${name} description`): ToolDefinition {
  return {
    name,
    description,
    inputSchema: {
      type: 'object',
      properties: { value: { type: 'string' } },
    },
    execute: async () => 'ok',
  };
}

describe('toolSearchTool deferred-only exposure', () => {
  beforeEach(() => {
    getAllToolsMock.mockReset();
    getAllToolsMock.mockReturnValue([
      makeTool('rare_clipboard', 'read clipboard'),
      makeTool('computer', 'control the desktop'),
      makeTool('private_a'),
    ]);
  });

  it('returns a tool selected as deferred by the trusted turn context', async () => {
    const result = await toolSearchTool.execute(
      { query: 'clipboard' },
      { conversationId: 'conv-1', deferredToolNames: ['rare_clipboard'] },
    );

    expect(result).toContain('rare_clipboard');
    expect(result).toContain('"value"');
  });

  it('does not return an already loaded tool that is absent from deferred tools', async () => {
    const result = await toolSearchTool.execute(
      { query: 'computer' },
      { conversationId: 'conv-1', deferredToolNames: ['rare_clipboard'] },
    );

    expect(result).not.toContain('### computer');
    expect(result).not.toContain('"action"');
  });

  it('fails closed when no conversation-scoped deferred exposure exists', async () => {
    const result = await toolSearchTool.execute({ query: 'computer' });

    expect(result).not.toContain('### computer');
  });

  it('cannot infer another conversation exposure from the shell registry', async () => {
    const result = await toolSearchTool.execute(
      { query: 'private_a' },
      { conversationId: 'conv-b', deferredToolNames: ['rare_clipboard'] },
    );

    expect(result).not.toContain('### private_a');
  });

  it('ignores malformed deferred-name context instead of widening exposure', async () => {
    const result = await toolSearchTool.execute(
      { query: 'computer' },
      { conversationId: 'conv-1', deferredToolNames: 'computer' as unknown as string[] },
    );

    expect(result).not.toContain('### computer');
  });
});

describe('toolSearchTool returns the computer tool for the model tier', () => {
  beforeEach(() => {
    getAllToolsMock.mockReset();
    getAllToolsMock.mockReturnValue([computerTool]);
    isWindowsMock.mockReturnValue(false);
  });

  it.each([true, false])('gives a model that cannot see images the text-only schema (windows=%s)', async (windows) => {
    isWindowsMock.mockReturnValue(windows);
    const result = await toolSearchTool.execute(
      { query: 'computer' },
      { conversationId: 'conv-1', deferredToolNames: ['computer'], computerUseTier: 'structured' },
    );

    expect(result).toContain('### computer');
    expect(result).toContain(structuredComputerDescription(windows));
    expect(String(result).toLowerCase()).not.toContain('screenshot');
  });

  it('keeps the screenshot schema for a model that can see images', async () => {
    const result = await toolSearchTool.execute(
      { query: 'computer' },
      { conversationId: 'conv-1', deferredToolNames: ['computer'], computerUseTier: 'full' },
    );

    expect(result).toContain(computerTool.description);
    expect(result).toContain('"screenshot_id"');
  });
});
