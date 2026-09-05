// The single namespaced-tool-name parse shared by the authorization layer and
// the dispatcher (U9 / C1). Before this module existed the two disagreed:
// `classifyBrowserTool` sliced from the FIRST `__` (so
// `abu-browser__execute_js__x` was classified as the unknown tool
// `execute_js__x` and fell back to the gated-but-weaker 'interactive'), while
// `registry.ts`'s dispatcher used `split('__', 2)`, whose limit-2 TRUNCATION
// discards the suffix and yields `execute_js` — which then really ran.
import { describe, expect, it } from 'vitest';
import { parseNamespacedToolName } from './toolName';

describe('parseNamespacedToolName', () => {
  it('splits a well-formed `server__tool` name', () => {
    expect(parseNamespacedToolName('abu-browser__execute_js')).toEqual({
      serverName: 'abu-browser',
      toolName: 'execute_js',
    });
    expect(parseNamespacedToolName('abu-browser-bridge__get_tabs')).toEqual({
      serverName: 'abu-browser-bridge',
      toolName: 'get_tabs',
    });
  });

  it('returns null for a bare (builtin-shaped) name with no separator', () => {
    expect(parseNamespacedToolName('read_file')).toBeNull();
    expect(parseNamespacedToolName('execute_js')).toBeNull();
    expect(parseNamespacedToolName('')).toBeNull();
  });

  it('REFUSES a name that does not round-trip — an extra separator is not a suffix to ignore', () => {
    // This is the whole defect: `split('__', 2)` silently drops `__x` and
    // dispatches the truncated `execute_js`. A name that cannot be rebuilt
    // from its two halves is a name no server registered.
    expect(parseNamespacedToolName('abu-browser__execute_js__x')).toBeNull();
    expect(parseNamespacedToolName('abu-browser__execute_js__a__b')).toBeNull();
    expect(parseNamespacedToolName('abu-browser-bridge__execute_js__x')).toBeNull();
  });

  it('refuses an empty tool half (a trailing separator)', () => {
    expect(parseNamespacedToolName('abu-browser__')).toBeNull();
    expect(parseNamespacedToolName('abu-browser__execute_js__')).toBeNull();
  });

  it('refuses an empty server half', () => {
    expect(parseNamespacedToolName('__execute_js')).toBeNull();
    expect(parseNamespacedToolName('__')).toBeNull();
  });

  it('every accepted parse rebuilds the exact input — the round-trip invariant itself', () => {
    const names = [
      'abu-browser__click',
      'abu-browser-bridge__screenshot',
      'some-server__some_tool',
      'a__b',
      // Rejected shapes: the invariant holds vacuously, but assert they ARE
      // rejected rather than silently rebuilt from truncated halves.
      'abu-browser__execute_js__x',
      'abu-browser__',
      'no-separator',
    ];
    for (const name of names) {
      const parsed = parseNamespacedToolName(name);
      if (parsed === null) continue;
      expect(`${parsed.serverName}__${parsed.toolName}`).toBe(name);
    }
    expect(parseNamespacedToolName('abu-browser__execute_js__x')).toBeNull();
  });
});
