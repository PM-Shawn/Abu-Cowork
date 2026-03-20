import { describe, it, expect, beforeEach } from 'vitest';
import { toolRegistry } from './registry';
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

    it('detects truncated tool call JSON (_parse_error) with recovery hint', async () => {
      toolRegistry.register(testTool);
      const result = await toolRegistry.execute('test_write', {
        _parse_error: 'Failed to parse tool input: {"path": "/tmp/build.js", "content": "const pptx...',
      });
      expect(result).toContain('JSON 被截断');
      expect(result).toContain('run_command');
      expect(result).toContain('heredoc');
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
});
