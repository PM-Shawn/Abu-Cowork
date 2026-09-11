// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest';
import { setLanguage } from '@/i18n';
import { useTriggerStore } from '@/stores/triggerStore';
import type { TriggerAction } from '@/types/trigger';
import { manageTriggerTool } from './automationTools';
import { resolveTriggerCallbacks } from '@/core/trigger/triggerPermission';
import { createAuthorizationScope, disposeAuthorizationScope } from '@/core/tools/pathSafety';

function resetTriggerStore() {
  useTriggerStore.setState({
    triggers: {},
    selectedTriggerId: null,
    showEditor: false,
    editingTriggerId: null,
    editorTemplateDefaults: null,
  });
}

describe('manageTriggerTool', () => {
  beforeEach(() => {
    setLanguage('en-US');
    resetTriggerStore();
  });

  it('does not expose capability in the tool schema', () => {
    expect(manageTriggerTool.inputSchema.properties).not.toHaveProperty('capability');
  });

  it('ignores malicious capability on create and reports the safe default', async () => {
    const result = await manageTriggerTool.execute({
      action: 'create',
      name: 'Malicious trigger',
      prompt: 'Handle $EVENT_DATA',
      capability: 'full',
      allowed_paths: ['', '   ', '/Users/example/project'],
    });

    const created = Object.values(useTriggerStore.getState().triggers)[0];

    expect(created.action.capability).toBeUndefined();
    expect(created.action.permissions).toBeUndefined();
    expect(String(result)).toContain('New triggers use Read Only; updates keep the existing level and allowlists.');
  });

  it('ignores malicious capability on update while preserving existing capability and permissions', async () => {
    const triggerId = useTriggerStore.getState().createTrigger({
      name: 'Existing trigger',
      source: { type: 'http' },
      filter: { type: 'always' },
      action: {
        prompt: 'Before',
        capability: 'custom',
        permissions: {
          allowedCommands: ['npm run test'],
          allowedPaths: ['/Users/example/project'],
          allowedTools: ['read_file'],
        },
      },
      debounce: { enabled: true, windowSeconds: 300 },
    });

    const result = await manageTriggerTool.execute({
      action: 'update',
      trigger_id: triggerId,
      prompt: 'After',
      capability: 'full',
    });

    const updated = useTriggerStore.getState().triggers[triggerId];

    expect(updated.action.prompt).toBe('After');
    expect(updated.action.capability).toBe('custom');
    expect(updated.action.permissions).toEqual({
      allowedCommands: ['npm run test'],
      allowedPaths: ['/Users/example/project'],
      allowedTools: ['read_file'],
    });
    expect(String(result)).toContain('New triggers use Read Only; updates keep the existing level and allowlists.');
  });

  it('does not mutate action when update only receives capability', async () => {
    const originalAction: TriggerAction = {
      prompt: 'Keep me',
      skillName: 'alert-sop',
      workspacePath: '/Users/example/project',
      capability: 'safe_tools',
      permissions: {
        allowedPaths: ['/Users/example/project'],
      },
    };
    const triggerId = useTriggerStore.getState().createTrigger({
      name: 'Existing trigger',
      source: { type: 'http' },
      filter: { type: 'always' },
      action: originalAction,
      debounce: { enabled: true, windowSeconds: 300 },
    });

    const result = await manageTriggerTool.execute({
      action: 'update',
      trigger_id: triggerId,
      capability: 'full',
    });

    expect(useTriggerStore.getState().triggers[triggerId].action).toEqual(originalAction);
    expect(String(result)).toContain('New triggers use Read Only; updates keep the existing level and allowlists.');
  });

  it('does not expose the custom allowlists in the tool schema', () => {
    const props = manageTriggerTool.inputSchema.properties!;
    expect(props).not.toHaveProperty('allowed_commands');
    expect(props).not.toHaveProperty('allowed_paths');
    expect(props).not.toHaveProperty('allowed_tools');
  });

  it('cannot widen a legacy custom trigger allowlist, so its run ceiling is unchanged', async () => {
    const narrowPermissions = {
      allowedCommands: ['git pull'],
      allowedPaths: ['/Users/example/project'],
      allowedTools: ['read_file'],
    };
    const triggerId = useTriggerStore.getState().createTrigger({
      name: 'narrow legacy custom',
      source: { type: 'http' },
      filter: { type: 'always' },
      action: {
        prompt: 'Before',
        workspacePath: '/Users/example/project',
        capability: 'custom',
        permissions: narrowPermissions,
      },
      debounce: { enabled: true, windowSeconds: 300 },
    });

    // The tier is already locked, so the only remaining lever the model had
    // was the allowlist *inside* the custom tier — which IS the run ceiling.
    await manageTriggerTool.execute({
      action: 'update',
      trigger_id: triggerId,
      prompt: 'After',
      allowed_tools: ['*'],
      allowed_commands: ['*'],
      allowed_paths: ['/'],
    });

    const action = useTriggerStore.getState().triggers[triggerId].action;
    expect(action.prompt).toBe('After');
    expect(action.capability).toBe('custom');
    expect(action.permissions).toEqual(narrowPermissions);

    // The authority the trigger actually runs under is derived from
    // action.permissions, so pin the resolved callbacks rather than the
    // stored record alone.
    const scopeId = createAuthorizationScope();
    try {
      const callbacks = resolveTriggerCallbacks(action, { authorizationScopeId: scopeId });
      expect(callbacks.allowedTools).toEqual(['read_file']);
      await expect(
        callbacks.commandConfirmCallback!({ command: 'rm -rf /Users/example/other', level: 'warn' }),
      ).resolves.toBe(false);
    } finally {
      disposeAuthorizationScope(scopeId);
    }
  });

  it('leaves action untouched when update carries only the removed allowlist fields', async () => {
    const originalAction: TriggerAction = {
      prompt: 'Keep me',
      capability: 'custom',
      permissions: { allowedPaths: ['/Users/example/old'] },
    };
    const triggerId = useTriggerStore.getState().createTrigger({
      name: 'Existing trigger',
      source: { type: 'http' },
      filter: { type: 'always' },
      action: originalAction,
      debounce: { enabled: true, windowSeconds: 300 },
    });

    await manageTriggerTool.execute({
      action: 'update',
      trigger_id: triggerId,
      allowed_paths: ['/'],
    });

    expect(useTriggerStore.getState().triggers[triggerId].action).toEqual(originalAction);
  });
});
