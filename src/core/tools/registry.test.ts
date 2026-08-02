import { describe, it, expect, beforeEach } from 'vitest';
import { toolRegistry, FILE_TOOL_PATH_MAP } from './registry';
import { FILE_TOOL_NAMES } from './osPermissionGuide';
import type { ToolDefinition } from '../../types';

// Test tool with required params
const testTool: ToolDefinition = {
  name: 'test_write',
  description: 'Test tool',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path' },
      content: { type: 'string', description: 'File content' },
    },
    required: ['path', 'content'],
  },
  execute: async (input) => {
    return `wrote to ${input.path}`;
  },
};

// Test tool with no required params
const noRequiredTool: ToolDefinition = {
  name: 'test_info',
  description: 'Test tool no required',
  inputSchema: {
    type: 'object',
    properties: {
      verbose: { type: 'boolean', description: 'Verbose output' },
    },
    required: [],
  },
  execute: async () => 'info result',
};

describe('ToolRegistry', () => {
  beforeEach(() => {
    // Clean up test tools
    toolRegistry.remove('test_write');
    toolRegistry.remove('test_info');
  });

  describe('input validation', () => {
    it('returns error when required parameter is undefined', async () => {
      toolRegistry.register(testTool);
      const result = await toolRegistry.execute('test_write', { content: 'hello' });
      expect(result).toContain('missing required parameter(s): path');
      expect(result).toContain('Please retry');
    });

    it('returns error when required parameter is null', async () => {
      toolRegistry.register(testTool);
      const result = await toolRegistry.execute('test_write', { path: null, content: 'hello' });
      expect(result).toContain('missing required parameter(s): path');
    });

    it('returns error listing all missing params', async () => {
      toolRegistry.register(testTool);
      const result = await toolRegistry.execute('test_write', {});
      expect(result).toContain('path, content');
    });

    it('includes schema hint in error message', async () => {
      toolRegistry.register(testTool);
      const result = await toolRegistry.execute('test_write', {});
      expect(result).toContain('path: string');
      expect(result).toContain('File path');
    });

    it('passes validation when all required params present', async () => {
      toolRegistry.register(testTool);
      const result = await toolRegistry.execute('test_write', { path: '/tmp/a.txt', content: 'hello' });
      expect(result).toBe('wrote to /tmp/a.txt');
    });

    it('allows empty string as valid value (not missing)', async () => {
      toolRegistry.register(testTool);
      const result = await toolRegistry.execute('test_write', { path: '', content: 'hello' });
      // Empty string is not undefined/null, so validation passes
      expect(result).toBe('wrote to ');
    });

    it('allows zero and false as valid values', async () => {
      toolRegistry.register(testTool);
      const result = await toolRegistry.execute('test_write', { path: 0, content: false });
      // Truthy check would fail here, but we only check undefined/null
      expect(result).not.toContain('missing required');
    });

    it('skips validation for tools with no required params', async () => {
      toolRegistry.register(noRequiredTool);
      const result = await toolRegistry.execute('test_info', {});
      expect(result).toBe('info result');
    });

    it('detects unparseable tool call JSON (_parse_error) and lists required params', async () => {
      toolRegistry.register(testTool);
      const result = await toolRegistry.execute('test_write', {
        _parse_error: 'Failed to parse tool input: {"path": "/tmp/build.js", "content": "const pptx...',
      });
      expect(result).toContain('不是合法 JSON');
      expect(result).toContain('test_write');
      expect(result).toContain('该工具的必填参数');
      expect(result).toContain('path');
      // Regression: stale write_file/heredoc guidance must not return.
      expect(result).not.toContain('write_file');
      expect(result).not.toContain('heredoc');
      expect(result).not.toContain('SCRIPT_EOF');
    });

    it('still catches thrown errors after validation passes', async () => {
      const throwingTool: ToolDefinition = {
        name: 'test_write',
        description: 'Throws',
        inputSchema: {
          type: 'object',
          properties: { path: { type: 'string', description: 'p' } },
          required: ['path'],
        },
        execute: async () => { throw new Error('boom'); },
      };
      toolRegistry.register(throwingTool);
      const result = await toolRegistry.execute('test_write', { path: '/tmp' });
      expect(result).toContain('Error executing tool');
      expect(result).toContain('boom');
    });
  });

  // Drift guard: osPermissionGuide's FILE_TOOL_NAMES (which file tools get the
  // OS-permission grant-guide) must stay identical to FILE_TOOL_PATH_MAP's keys
  // (which tools go through path-safety checks). They're two separate consts —
  // one lives in the pure module so the sidecar can share it — so a newly-added
  // file tool that's added to one but not the other would silently miss the
  // guide (or the path check). This locks them together.
  describe('FILE_TOOL_NAMES ↔ FILE_TOOL_PATH_MAP sync', () => {
    it('the OS-guide file-tool set matches the path-map keys exactly', () => {
      expect([...FILE_TOOL_NAMES].sort()).toEqual(Object.keys(FILE_TOOL_PATH_MAP).sort());
    });
  });
});
