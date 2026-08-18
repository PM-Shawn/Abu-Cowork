import { describe, expect, it, vi } from 'vitest';
import type { CapabilitySnapshot } from '../capabilitySnapshot';

const mocks = vi.hoisted(() => ({
  computeCapabilitySnapshot: vi.fn<() => CapabilitySnapshot>(),
}));

vi.mock('../capabilitySnapshot', () => ({
  computeCapabilitySnapshot: mocks.computeCapabilitySnapshot,
}));

import { capabilitySnapshotTool } from './capabilitySnapshotTool';
import { TOOL_NAMES } from '../toolNames';

describe('capabilitySnapshotTool', () => {
  it('is a read-only, concurrency-safe, no-input tool', () => {
    expect(capabilitySnapshotTool.name).toBe(TOOL_NAMES.CAPABILITY_SNAPSHOT);
    expect(capabilitySnapshotTool.isConcurrencySafe).toBe(true);
    expect(capabilitySnapshotTool.inputSchema.required ?? []).toEqual([]);
  });

  it('renders active and unavailable sections with per-tool reasons', async () => {
    mocks.computeCapabilitySnapshot.mockReturnValue({
      permissionMode: 'standard',
      computerUseEnabled: false,
      entries: [
        {
          name: 'read_file',
          source: { kind: 'builtin' },
          unavailableReasons: [],
          concurrencySafety: 'safe',
          policy: { decision: 'allow' },
        },
        {
          name: 'run_command',
          source: { kind: 'builtin' },
          unavailableReasons: [],
          concurrencySafety: 'input-dependent',
          policy: { decision: 'allow' },
        },
        {
          name: 'computer',
          source: { kind: 'builtin' },
          unavailableReasons: [],
          concurrencySafety: 'unsafe',
          policy: { decision: 'allow' },
        },
        {
          name: 'create_todo',
          source: { kind: 'builtin' },
          unavailableReasons: [{ kind: 'labs-gated', experimentId: 'todos-inbox' }],
          concurrencySafety: 'safe',
          policy: { decision: 'allow' },
        },
        {
          name: 'slack__post_message',
          source: { kind: 'mcp', server: 'slack' },
          unavailableReasons: [{ kind: 'mcp-disabled', server: 'slack' }],
          concurrencySafety: 'unsafe',
          policy: { decision: 'allow' },
        },
      ],
    });

    const result = await capabilitySnapshotTool.execute({});
    expect(typeof result).toBe('string');
    const text = result as string;

    // Active tools present with the right annotations.
    expect(text).toContain('read_file');
    expect(text).toContain('run_command');
    expect(text).toContain('computer');
    // run_command's concurrency safety is input-dependent — flagged inline.
    expect(text).toMatch(/run_command[\s\S]*input/i);
    // computer tool notes that Computer Use isn't enabled yet.
    expect(text).toMatch(/computer[\s\S]*(启用|enable)/i);

    // Unavailable tools present with their real reasons.
    expect(text).toContain('create_todo');
    expect(text).toContain('todos-inbox');
    expect(text).toContain('slack__post_message');
    expect(text).toMatch(/slack[\s\S]*(禁用|disabled)/i);

    // Counts in the header match the entry split (3 active, 2 unavailable).
    expect(text).toMatch(/3/);
    expect(text).toMatch(/2/);
  });

  it('surfaces an enterprise-policy "confirm" decision as a note on an otherwise active tool', async () => {
    mocks.computeCapabilitySnapshot.mockReturnValue({
      permissionMode: 'standard',
      computerUseEnabled: true,
      entries: [
        {
          name: 'sensitive_tool',
          source: { kind: 'builtin' },
          unavailableReasons: [],
          concurrencySafety: 'safe',
          policy: { decision: 'confirm', reason: 'requires manager approval' },
        },
      ],
    });

    const result = await capabilitySnapshotTool.execute({});
    const text = result as string;

    expect(text).toContain('sensitive_tool');
    expect(text).toContain('requires manager approval');
  });

  it('shows a "none" placeholder for an empty unavailable list', async () => {
    mocks.computeCapabilitySnapshot.mockReturnValue({
      permissionMode: 'standard',
      computerUseEnabled: true,
      entries: [
        {
          name: 'read_file',
          source: { kind: 'builtin' },
          unavailableReasons: [],
          concurrencySafety: 'safe',
          policy: { decision: 'allow' },
        },
      ],
    });

    const result = await capabilitySnapshotTool.execute({});
    const text = result as string;
    expect(text).toMatch(/无|none/i);
  });
});
