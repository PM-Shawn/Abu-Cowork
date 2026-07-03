import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { registerBuiltinTools } from './builtins';
import { getAllTools, executeAnyTool } from './registry';
import { useSettingsStore } from '@/stores/settingsStore';
import { LABS_TODOS_INBOX } from '../labs/registry';
import { TOOL_NAMES } from './toolNames';

// create_todo is registered unconditionally but gated on the 'todos-inbox'
// Labs flag at BOTH advertisement (getAllTools) and execution (executeAnyTool).
// These regressions lock in the fail-safe parity with the old compile-time gate.
beforeAll(() => {
  registerBuiltinTools();
});

describe('Labs-gated tool availability (create_todo / todos-inbox)', () => {
  beforeEach(() => {
    useSettingsStore.setState({ labs: {} });
  });

  it('withholds create_todo from the advertised schema when the flag is off', () => {
    useSettingsStore.setState({ labs: { [LABS_TODOS_INBOX]: false } });
    expect(getAllTools().some((t) => t.name === TOOL_NAMES.CREATE_TODO)).toBe(false);
  });

  it('advertises create_todo when the flag is on', () => {
    useSettingsStore.setState({ labs: { [LABS_TODOS_INBOX]: true } });
    expect(getAllTools().some((t) => t.name === TOOL_NAMES.CREATE_TODO)).toBe(true);
  });

  it('rejects create_todo execution as Unknown when the flag is off (fail-safe)', async () => {
    useSettingsStore.setState({ labs: { [LABS_TODOS_INBOX]: false } });
    const result = await executeAnyTool(TOOL_NAMES.CREATE_TODO, { title: 'x' });
    expect(String(result)).toContain('Unknown tool');
  });

  it('does not reject create_todo as Unknown when the flag is on', async () => {
    useSettingsStore.setState({ labs: { [LABS_TODOS_INBOX]: true } });
    const result = await executeAnyTool(TOOL_NAMES.CREATE_TODO, { title: 'x' });
    expect(String(result)).not.toContain('Unknown tool');
  });
});
