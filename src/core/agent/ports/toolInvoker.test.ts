import { describe, it, expect, afterEach, vi } from 'vitest';
import type { ToolDefinition, ToolResult } from '@/types';

const mockGetAllTools = vi.fn();
const mockExecuteAnyTool = vi.fn();
const mockToolResultToString = vi.fn();

vi.mock('@/core/tools/registry', () => ({
  getAllTools: (...args: unknown[]) => mockGetAllTools(...args),
  executeAnyTool: (...args: unknown[]) => mockExecuteAnyTool(...args),
  toolResultToString: (...args: unknown[]) => mockToolResultToString(...args),
}));

import {
  createInProcessToolInvoker,
  getToolInvoker,
  setToolInvoker,
  type ToolInvoker,
} from './toolInvoker';

describe('createInProcessToolInvoker', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('getAllTools() forwards call-by-call to registry.getAllTools (no caching)', () => {
    const first: ToolDefinition[] = [{ name: 'a' } as ToolDefinition];
    const second: ToolDefinition[] = [{ name: 'a' } as ToolDefinition, { name: 'b' } as ToolDefinition];
    mockGetAllTools.mockReturnValueOnce(first).mockReturnValueOnce(second);

    const invoker = createInProcessToolInvoker();
    expect(invoker.getAllTools()).toBe(first);
    // A second call re-forwards to the live registry function rather than
    // returning a cached/snapshotted result — e.g. a tool registered mid-loop
    // (a newly connected MCP server) must be observed by the next call.
    expect(invoker.getAllTools()).toBe(second);
    expect(mockGetAllTools).toHaveBeenCalledTimes(2);
  });

  it('executeAnyTool() forwards all parameters positionally to registry.executeAnyTool', async () => {
    const result: ToolResult = 'ok';
    mockExecuteAnyTool.mockResolvedValueOnce(result);
    const onRequireConfirmation = vi.fn();
    const onRequireFilePermission = vi.fn();
    const toolContext = { workspacePath: '/tmp/ws' };

    const invoker = createInProcessToolInvoker();
    const out = await invoker.executeAnyTool(
      'run_command',
      { command: 'ls' },
      onRequireConfirmation,
      onRequireFilePermission,
      toolContext,
      42,
    );

    expect(out).toBe(result);
    expect(mockExecuteAnyTool).toHaveBeenCalledWith(
      'run_command',
      { command: 'ls' },
      onRequireConfirmation,
      onRequireFilePermission,
      toolContext,
      42,
    );
  });

  it('executeAnyTool() works with only the required parameters (rest are optional)', async () => {
    mockExecuteAnyTool.mockResolvedValueOnce('done');
    const invoker = createInProcessToolInvoker();
    const out = await invoker.executeAnyTool('read_file', { path: '/x' });
    expect(out).toBe('done');
    expect(mockExecuteAnyTool).toHaveBeenCalledWith('read_file', { path: '/x' }, undefined, undefined, undefined, undefined);
  });

  it('toolResultToString() forwards to registry.toolResultToString', () => {
    mockToolResultToString.mockReturnValueOnce('stringified');
    const invoker = createInProcessToolInvoker();
    expect(invoker.toolResultToString('raw' as ToolResult)).toBe('stringified');
    expect(mockToolResultToString).toHaveBeenCalledWith('raw');
  });
});

describe('getToolInvoker / setToolInvoker', () => {
  const defaultInvoker = getToolInvoker();

  afterEach(() => {
    // restore the default in-process invoker so other test files aren't affected
    setToolInvoker(defaultInvoker);
  });

  it('getToolInvoker() returns a working in-process invoker by default', () => {
    const invoker = getToolInvoker();
    expect(typeof invoker.getAllTools).toBe('function');
    expect(typeof invoker.executeAnyTool).toBe('function');
    expect(typeof invoker.toolResultToString).toBe('function');
  });

  it('setToolInvoker() swaps the module-level invoker returned by getToolInvoker()', () => {
    const stub: ToolInvoker = {
      getAllTools: () => [],
      executeAnyTool: async () => 'stub-result',
      toolResultToString: () => 'stub-string',
    };
    setToolInvoker(stub);
    expect(getToolInvoker()).toBe(stub);
    expect(getToolInvoker().toolResultToString('x' as ToolResult)).toBe('stub-string');
  });
});
