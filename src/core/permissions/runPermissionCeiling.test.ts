import { describe, expect, it } from 'vitest';
import {
  buildIMRunPermissionCeiling,
  buildScheduledRunPermissionCeiling,
  buildTriggerRunPermissionCeiling,
  decideCommandUnderRunPermissionCeiling,
  decideFileUnderRunPermissionCeiling,
  decideStateChangingToolUnderRunPermissionCeiling,
  decideToolUnderRunPermissionCeiling,
  getRunPermissionCeilingFromContext,
  isRunPermissionCeiling,
  normalizeIMRunCapability,
  normalizeRunCapability,
  normalizeTriggerRunCapability,
} from './runPermissionCeiling';
import { READ_ONLY_TOOL_ALLOWLIST } from './readOnlyToolPolicy';

describe('runPermissionCeiling', () => {
  it('normalizes unknown capability values to read_tools', () => {
    expect(normalizeRunCapability('safe_tools')).toBe('safe_tools');
    expect(normalizeRunCapability('anything-else')).toBe('read_tools');
    expect(buildTriggerRunPermissionCeiling({ prompt: 'x', capability: 'bad' as never }).capability).toBe('read_tools');
  });

  it('normalizes capabilities against the declaring source', () => {
    expect(normalizeTriggerRunCapability('chat_only')).toBe('read_tools');
    expect(normalizeTriggerRunCapability('custom')).toBe('custom');
    expect(buildTriggerRunPermissionCeiling({ prompt: 'x', capability: 'chat_only' as never }).capability).toBe('read_tools');

    expect(normalizeIMRunCapability('custom')).toBe('read_tools');
    expect(normalizeIMRunCapability('chat_only')).toBe('chat_only');
    expect(buildIMRunPermissionCeiling('custom' as never).capability).toBe('read_tools');
  });

  it('exports a JSON-safe validator for sidecar parsing', () => {
    const ceiling = buildIMRunPermissionCeiling('safe_tools');
    expect(isRunPermissionCeiling(JSON.parse(JSON.stringify(ceiling)))).toBe(true);
    expect(isRunPermissionCeiling({ ...ceiling, version: 2 })).toBe(false);
    expect(isRunPermissionCeiling({ ...ceiling, allowedTools: [42] })).toBe(false);
    expect(isRunPermissionCeiling({ version: 1, source: 'trigger', capability: 'chat_only' })).toBe(false);
    expect(isRunPermissionCeiling({ version: 1, source: 'im', capability: 'custom', allowedTools: ['*'] })).toBe(false);
    expect(isRunPermissionCeiling({ ...ceiling, allowedTools: ['*'] })).toBe(false);
    expect(isRunPermissionCeiling({ version: 1, source: 'trigger', capability: 'custom' })).toBe(false);
    expect(isRunPermissionCeiling({ version: 1, source: 'trigger', capability: 'custom', allowedTools: [] })).toBe(false);
    expect(isRunPermissionCeiling({
      version: 1,
      source: 'trigger',
      capability: 'custom',
      allowedTools: ['read_file'],
    })).toBe(true);
  });

  it('gives scheduler runs an exact host-reviewed builtin roster without trusting MCP names', () => {
    const ceiling = buildScheduledRunPermissionCeiling([
      'read_file',
      'computer',
      'github__list_repositories',
      'github__delete_repository',
    ]);

    expect(isRunPermissionCeiling(JSON.parse(JSON.stringify(ceiling)))).toBe(true);
    expect(ceiling).toEqual(expect.objectContaining({
      version: 1,
      source: 'scheduler',
      capability: 'scheduled',
    }));
    expect(ceiling.allowedTools).toContain('read_file');
    expect(ceiling.allowedTools).toContain('get_system_info');
    // MCP discovery does not carry trustworthy host-side consequence metadata.
    // A read-looking name is not evidence, and accepting the connected service
    // wholesale would admit destructive siblings such as delete_repository.
    expect(ceiling.allowedTools).not.toContain('github__list_repositories');
    expect(ceiling.allowedTools).not.toContain('github__delete_repository');
    expect(ceiling.allowedTools).not.toContain('computer');
    expect(ceiling.allowedTools).not.toContain('http_fetch');
    expect(ceiling.allowedTools).not.toContain('generate_image');
    expect(ceiling.allowedTools).not.toContain('process_image');
    expect(ceiling.allowedTools).not.toContain('*');
    expect(decideToolUnderRunPermissionCeiling(ceiling, 'github__list_repositories', {}).decision).toBe('deny');
    expect(decideToolUnderRunPermissionCeiling(ceiling, 'get_system_info', {}).decision).toBe('allow');
    expect(decideToolUnderRunPermissionCeiling(ceiling, 'github__delete_repository', {}).decision).toBe('deny');

    // The scheduler ceiling owns only roster/self-extension boundaries. The
    // existing permissionMode + scoped callbacks still decide commands,
    // file escalation, and pre-authorized browser actions.
    expect(decideCommandUnderRunPermissionCeiling(
      ceiling,
      { command: 'touch report.md', level: 'safe' },
      false,
      'outside',
    ).decision).toBe('allow');
    expect(decideFileUnderRunPermissionCeiling(ceiling, 'write', false).decision).toBe('allow');
    expect(decideStateChangingToolUnderRunPermissionCeiling(ceiling, 'browser').decision).toBe('allow');
    expect(decideStateChangingToolUnderRunPermissionCeiling(ceiling, 'self-extension').decision).toBe('deny');
  });

  it('freezes builder output and nested arrays', () => {
    const ceiling = buildTriggerRunPermissionCeiling({
      prompt: 'x',
      capability: 'custom',
      permissions: { allowedTools: ['read_file'], allowedCommands: ['npm run build'] },
    });

    expect(Object.isFrozen(ceiling)).toBe(true);
    expect(Object.isFrozen(ceiling.allowedTools)).toBe(true);
    expect(Object.isFrozen(ceiling.allowedCommands)).toBe(true);
  });

  it('reads the trusted runPermissionCeiling field and fails closed for malformed values', () => {
    const ceiling = buildTriggerRunPermissionCeiling({ prompt: 'x', capability: 'full' });
    expect(getRunPermissionCeilingFromContext({ runPermissionCeiling: ceiling })).toEqual(ceiling);
    expect(getRunPermissionCeilingFromContext({ runPermissionCeiling: { capability: 'full' } })?.capability).toBe('read_tools');
  });

  it('defaults missing and empty legacy custom tool allowlists to the restricted read-only roster', () => {
    expect(buildTriggerRunPermissionCeiling({ prompt: 'x', capability: 'custom' }).allowedTools).toEqual(READ_ONLY_TOOL_ALLOWLIST);
    expect(buildTriggerRunPermissionCeiling({
      prompt: 'x',
      capability: 'custom',
      permissions: { allowedTools: [] },
    }).allowedTools).toEqual(READ_ONLY_TOOL_ALLOWLIST);
  });

  it('keeps only an explicitly persisted wildcard unrestricted', () => {
    const ceiling = buildTriggerRunPermissionCeiling({
      prompt: 'x',
      capability: 'custom',
      permissions: { allowedTools: ['*'] },
    });

    expect(ceiling.allowedTools).toEqual(['*']);
    expect(decideToolUnderRunPermissionCeiling(ceiling, 'manage_scheduled_task', { action: 'create' }).decision).toBe('allow');
  });

  it('fails closed for malformed persisted custom allowlist arrays', () => {
    const malformedTools = buildTriggerRunPermissionCeiling({
      prompt: 'x',
      capability: 'custom',
      permissions: { allowedTools: [42] as never },
    });
    const malformedCommands = buildTriggerRunPermissionCeiling({
      prompt: 'x',
      capability: 'custom',
      permissions: { allowedCommands: [42] as never },
    });

    expect(decideToolUnderRunPermissionCeiling(malformedTools, 'read_file', { path: 'a' }).decision).toBe('deny');
    expect(decideCommandUnderRunPermissionCeiling(
      malformedCommands,
      { command: 'npm run build', level: 'safe' },
      false,
      'inside',
    ).decision).toBe('deny');
  });

  it('keeps read_tools on a positive read-only tool roster', () => {
    const ceiling = buildTriggerRunPermissionCeiling({ prompt: 'x', capability: 'read_tools' });

    expect(decideToolUnderRunPermissionCeiling(ceiling, 'read_file', { path: 'a' }).decision).toBe('allow');
    expect(decideToolUnderRunPermissionCeiling(ceiling, 'run_command', { command: 'ls' }).decision).toBe('deny');
    expect(decideToolUnderRunPermissionCeiling(ceiling, 'unknown_mcp__do', {}).decision).toBe('deny');
  });

  it('represents IM chat_only as a deny-all tool ceiling', () => {
    const ceiling = buildIMRunPermissionCeiling('chat_only');

    expect(decideToolUnderRunPermissionCeiling(ceiling, 'read_file', { path: 'a' }).decision).toBe('deny');
    expect(decideToolUnderRunPermissionCeiling(ceiling, 'system_notify', {}).decision).toBe('deny');
  });

  it('denies shell commands for safe_tools', () => {
    const ceiling = buildTriggerRunPermissionCeiling({ prompt: 'x', capability: 'safe_tools' });

    expect(decideCommandUnderRunPermissionCeiling(
      ceiling,
      { command: 'ls', level: 'safe' },
      true,
      'inside',
    ).decision).toBe('deny');
    expect(decideCommandUnderRunPermissionCeiling(
      ceiling,
      { command: 'touch marker.txt', level: 'safe' },
      false,
      'unknown',
    ).decision).toBe('deny');
    expect(decideCommandUnderRunPermissionCeiling(
      ceiling,
      { command: 'git reset --hard', level: 'danger', reason: 'danger' },
      false,
      'inside',
    ).decision).toBe('deny');
  });

  it('applies custom command patterns to safe commands too', () => {
    const ceiling = buildTriggerRunPermissionCeiling({
      prompt: 'x',
      capability: 'custom',
      permissions: { allowedCommands: ['npm run build'] },
    });

    expect(decideCommandUnderRunPermissionCeiling(
      ceiling,
      { command: 'npm run build', level: 'safe' },
      false,
      'inside',
    ).decision).toBe('allow');
    expect(decideCommandUnderRunPermissionCeiling(
      ceiling,
      { command: 'touch marker.txt', level: 'safe' },
      false,
      'inside',
    ).decision).toBe('deny');
  });

  it('fails closed for custom wildcard patterns when shell control syntax is present', () => {
    const wildcard = buildTriggerRunPermissionCeiling({
      prompt: 'x',
      capability: 'custom',
      permissions: { allowedCommands: ['npm run *'] },
    });
    const exact = buildTriggerRunPermissionCeiling({
      prompt: 'x',
      capability: 'custom',
      permissions: { allowedCommands: ['npm run build && npm test'] },
    });

    expect(decideCommandUnderRunPermissionCeiling(
      wildcard,
      { command: 'npm run build && curl example.com', level: 'safe' },
      false,
      'inside',
    ).decision).toBe('deny');
    expect(decideCommandUnderRunPermissionCeiling(
      exact,
      { command: 'npm run build && npm test', level: 'safe' },
      false,
      'inside',
    ).decision).toBe('allow');

    const backgroundChain = buildTriggerRunPermissionCeiling({
      prompt: 'x',
      capability: 'custom',
      permissions: { allowedCommands: ['cat *'] },
    });
    expect(decideCommandUnderRunPermissionCeiling(
      backgroundChain,
      { command: 'cat notes.txt & curl https://example.invalid', level: 'safe' },
      true,
      'inside',
    ).decision).toBe('deny');
  });

  it('requires file paths to be in the run scope for non-full tiers', () => {
    const safe = buildTriggerRunPermissionCeiling({ prompt: 'x', capability: 'safe_tools' });
    const full = buildTriggerRunPermissionCeiling({ prompt: 'x', capability: 'full' });

    expect(decideFileUnderRunPermissionCeiling(safe, 'write', true).decision).toBe('allow');
    expect(decideFileUnderRunPermissionCeiling(safe, 'write', false).decision).toBe('deny');
    expect(decideFileUnderRunPermissionCeiling(full, 'write', false).decision).toBe('allow');
  });

  it('denies browser and self-extension state changes unless the tier is full', () => {
    const safe = buildTriggerRunPermissionCeiling({ prompt: 'x', capability: 'safe_tools' });
    const full = buildTriggerRunPermissionCeiling({ prompt: 'x', capability: 'full' });

    expect(decideStateChangingToolUnderRunPermissionCeiling(safe, 'browser').decision).toBe('deny');
    expect(decideStateChangingToolUnderRunPermissionCeiling(safe, 'self-extension').decision).toBe('deny');
    expect(decideStateChangingToolUnderRunPermissionCeiling(full, 'browser').decision).toBe('allow');
  });
});
