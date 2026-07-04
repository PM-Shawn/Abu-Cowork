import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { registerBuiltinTools } from './builtins';
import { getAllTools, executeAnyTool } from './registry';
import { useSettingsStore } from '@/stores/settingsStore';
import { LABS_TODOS_INBOX } from '../labs/registry';
import { TOOL_NAMES } from './toolNames';

// create_todo is registered unconditionally but gated on the 'todos-inbox'
// Labs flag at BOTH advertisement (getAllTools) and execution (executeAnyTool).
// todos-inbox is HELD BACK this release (commented out of LABS_EXPERIMENTS), so
// resolveLabsFlag returns false for it even if a stale stored flag is set — the
// tool stays off for everyone. These lock in that the whole feature is dormant.
// (When todos-inbox is re-exposed, restore the flag-on ↔ tool-on assertions.)
beforeAll(() => {
  registerBuiltinTools();
});

describe('Labs-gated tool availability (create_todo / todos-inbox held back)', () => {
  beforeEach(() => {
    useSettingsStore.setState({ labs: {} });
  });

  it('withholds create_todo from the advertised schema by default', () => {
    expect(getAllTools().some((t) => t.name === TOOL_NAMES.CREATE_TODO)).toBe(false);
  });

  it('still withholds create_todo even with a stale todos-inbox flag set (held back)', () => {
    useSettingsStore.setState({ labs: { [LABS_TODOS_INBOX]: true } });
    expect(getAllTools().some((t) => t.name === TOOL_NAMES.CREATE_TODO)).toBe(false);
  });

  it('rejects create_todo execution as Unknown even with a stale flag set (fail-safe)', async () => {
    useSettingsStore.setState({ labs: { [LABS_TODOS_INBOX]: true } });
    const result = await executeAnyTool(TOOL_NAMES.CREATE_TODO, { title: 'x' });
    expect(String(result)).toContain('Unknown tool');
  });
});
