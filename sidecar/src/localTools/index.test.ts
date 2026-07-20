/**
 * Tests for the sidecar local tool registry (P1-3d-1). Runs against the
 * REAL show_widget/read_me/http_fetch/web_search implementations (not
 * mocked) — this is the contract `agentLoopHost.test.ts`'s "local tool
 * dispatch" describe block assumes when it mocks THIS module to test only
 * the dispatcher's branch/fallback wiring in isolation.
 */
import { describe, it, expect } from 'vitest';
import { hasLocalTool, isLocalToolReadOnly, executeLocalTool } from './index';

const REGISTERED_TOOL_NAMES = ['show_widget', 'read_me', 'http_fetch', 'web_search'];

describe('localTools registry membership', () => {
  it.each(REGISTERED_TOOL_NAMES)('hasLocalTool("%s") is true', (name) => {
    expect(hasLocalTool(name)).toBe(true);
  });

  it('hasLocalTool is false for an unregistered/unknown name', () => {
    expect(hasLocalTool('write_file')).toBe(false);
    expect(hasLocalTool('nonexistent_tool')).toBe(false);
  });

  it.each(REGISTERED_TOOL_NAMES)('isLocalToolReadOnly("%s") is true (Tier A — safe to fall back on failure)', (name) => {
    expect(isLocalToolReadOnly(name)).toBe(true);
  });

  it('isLocalToolReadOnly is false (fail-closed) for an unregistered name', () => {
    expect(isLocalToolReadOnly('nonexistent_tool')).toBe(false);
  });
});

describe('executeLocalTool — show_widget', () => {
  it('runs locally and returns the success marker for valid input', async () => {
    const result = await executeLocalTool(
      'show_widget',
      { title: 'Sales chart', widget_code: '<div>hi</div>', loading_messages: ['Rendering…'] },
      undefined,
      undefined,
    );
    expect(typeof result).toBe('string');
    expect(result as string).toContain('Sales chart');
  });

  it('catches the tool\'s own thrown validation error and returns it as an error STRING (never throws) — matches registry.ts:ToolRegistry.execute\'s contract', async () => {
    const result = await executeLocalTool(
      'show_widget',
      { title: '', widget_code: '<div>hi</div>', loading_messages: ['x'] },
      undefined,
      undefined,
    );
    expect(typeof result).toBe('string');
    expect(result as string).toContain('Error executing tool "show_widget"');
  });

  it('rejects a call missing a required field BEFORE ever invoking execute() (pre-flight validation)', async () => {
    const result = await executeLocalTool('show_widget', { widget_code: '<div>hi</div>' }, undefined, undefined);
    expect(typeof result).toBe('string');
    expect(result as string).toContain('missing required parameter');
    expect(result as string).toContain('title');
  });
});

describe('executeLocalTool — read_me', () => {
  it('returns the widget guidelines text for a valid (empty) input', async () => {
    const result = await executeLocalTool('read_me', {}, undefined, undefined);
    expect(typeof result).toBe('string');
    expect((result as string).length).toBeGreaterThan(0);
  });
});

describe('executeLocalTool — http_fetch', () => {
  it('runs the tool\'s pre-flight guard locally with no network call (URL too long)', async () => {
    const longUrl = 'https://example.com/' + 'a'.repeat(2100);
    const result = await executeLocalTool('http_fetch', { url: longUrl }, undefined, undefined);
    expect(result).toContain('URL too long');
  });

  it('rejects a call missing the required url field', async () => {
    const result = await executeLocalTool('http_fetch', {}, undefined, undefined);
    expect(result as string).toContain('missing required parameter');
    expect(result as string).toContain('url');
  });
});

describe('executeLocalTool — fail-closed on an unregistered tool name', () => {
  it('throws (dispatch-layer bug signal) rather than silently no-op-ing — caller must check hasLocalTool() first', async () => {
    await expect(executeLocalTool('not_a_real_tool', {}, undefined, undefined)).rejects.toThrow(
      /unregistered tool/,
    );
  });
});
